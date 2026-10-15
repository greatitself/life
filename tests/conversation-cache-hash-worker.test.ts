import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

type Mode = 'normal' | 'gate' | 'reject' | 'absent'
type Packet = { type: 'hash'; hash: string } | { type: 'error'; message: string }
type Observation =
  | { kind: 'ready'; threadId: number }
  | { kind: 'barrier'; threadId: number; id: number }
  | { kind: 'encode'; threadId: number; serialized: string; byteLength: number }
  | {
      kind: 'digest-start'
      threadId: number
      algorithm: string
      byteLength: number
      bytes: string
    }
  | { kind: 'digest-complete'; threadId: number; hash: string }
  | { kind: 'parse'; threadId: number }
  | { kind: 'packet'; threadId: number; packet: Packet }

let directory: string
let workerPath: string
const workers = new Set<Worker>()

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-cache-hash-worker-'))
  workerPath = join(directory, 'conversation-cache-hash-worker.mjs')
  // Bundle the production worker into its own real thread. Only the browser
  // message port and Web Crypto boundary are bridged by this fixture.
  await build({
    stdin: {
      contents: `
        import { parentPort, threadId, workerData } from 'node:worker_threads';
        import { webcrypto } from 'node:crypto';
        const observe = (kind, extra = {}) => parentPort.postMessage({ kind, threadId, ...extra });
        const port = {
          onmessage: null,
          postMessage: (packet) => observe('packet', { packet }),
        };
        let releaseDigest;
        const gate = new Promise((resolve) => { releaseDigest = resolve; });
        Object.defineProperty(globalThis, 'self', { value: port, configurable: true });
        Object.defineProperty(globalThis, 'crypto', {
          configurable: true,
          value: workerData.mode === 'absent' ? undefined : {
            subtle: {
              async digest(algorithm, buffer) {
                const bytes = ArrayBuffer.isView(buffer)
                  ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                  : Buffer.from(buffer);
                observe('digest-start', {
                  algorithm,
                  byteLength: bytes.byteLength,
                  bytes: bytes.toString('hex'),
                });
                if (workerData.mode === 'reject') throw new Error('fixture digest rejected');
                if (workerData.mode === 'gate') await gate;
                const result = await webcrypto.subtle.digest(algorithm, buffer);
                observe('digest-complete', { hash: Buffer.from(result).toString('hex') });
                return result;
              },
            },
          },
        });
        const Encoder = globalThis.TextEncoder;
        globalThis.TextEncoder = class extends Encoder {
          encode(serialized) {
            const bytes = super.encode(serialized);
            observe('encode', { serialized, byteLength: bytes.byteLength });
            return bytes;
          }
        };
        await import(${JSON.stringify(resolve('src/renderer/conversation-cache-hash-worker.ts'))});
        const parse = JSON.parse;
        JSON.parse = function (...args) {
          observe('parse');
          return parse.apply(this, args);
        };
        parentPort.on('message', (data) => {
          if (data.type === 'release-digest') releaseDigest();
          else if (data.type === 'fixture-barrier') observe('barrier', { id: data.id });
          else port.onmessage({ data });
        });
        observe('ready');
      `,
      resolveDir: process.cwd(),
      sourcefile: 'conversation-cache-hash-worker-fixture.ts',
      loader: 'ts',
    },
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  })
})

afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.terminate()))
  workers.clear()
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function harness(mode: Mode = 'normal') {
  const worker = new Worker(workerPath, { workerData: { mode } })
  workers.add(worker)
  const observations: Observation[] = []
  const waiters = new Set<(observation: Observation) => void>()
  let failure: unknown
  worker.on('error', (error) => {
    failure = error
  })
  worker.on('message', (observation: Observation) => {
    observations.push(observation)
    for (const waiter of waiters) waiter(observation)
  })
  const waitFor = (predicate: (observation: Observation) => boolean) => {
    const existing = observations.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<Observation>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(observe)
        reject(failure ?? new Error('The cache hash worker did not produce its response.'))
      }, 5_000)
      const observe = (observation: Observation) => {
        if (!predicate(observation)) return
        clearTimeout(timeout)
        waiters.delete(observe)
        resolve(observation)
      }
      waiters.add(observe)
    })
  }
  const ready = await waitFor((observation) => observation.kind === 'ready')
  expect(ready.threadId).toBeGreaterThan(0)
  return {
    worker,
    observations,
    waitFor,
    packets: () =>
      observations.flatMap((observation) =>
        observation.kind === 'packet' ? [observation.packet] : [],
      ),
    hash: (serialized: string) => worker.postMessage({ type: 'hash', serialized }),
    done: () => waitFor((observation) => observation.kind === 'packet'),
  }
}

const bytes = (serialized: string) => Buffer.from(serialized, 'utf8')
const hash = (serialized: string) => createHash('sha256').update(bytes(serialized)).digest('hex')
const raw = '{"version":1,"savedAt":17,"threads":[{"id":"native-thread","messages":[]}]}'

describe('off-thread cache serialization hashes', () => {
  it('encodes and digests the exact string in the worker before publishing its hash', async () => {
    const fixture = await harness('gate')
    fixture.hash(raw)
    const admitted = await fixture.waitFor((observation) => observation.kind === 'digest-start')
    expect(admitted).toMatchObject({
      algorithm: 'SHA-256',
      byteLength: bytes(raw).byteLength,
      bytes: bytes(raw).toString('hex'),
    })
    expect(fixture.observations.filter((observation) => observation.kind === 'encode')).toEqual([
      {
        kind: 'encode',
        threadId: admitted.threadId,
        serialized: raw,
        byteLength: bytes(raw).byteLength,
      },
    ])
    expect(fixture.observations.some((observation) => observation.kind === 'parse')).toBe(false)
    expect(fixture.packets()).toEqual([])

    fixture.worker.postMessage({ type: 'release-digest' })
    await fixture.done()
    expect(fixture.packets()).toEqual([{ type: 'hash', hash: hash(raw) }])
    expect(
      fixture.observations.filter((observation) => observation.kind === 'digest-start'),
    ).toHaveLength(1)
    const completed = fixture.observations.findIndex(
      (observation) => observation.kind === 'digest-complete',
    )
    const published = fixture.observations.findIndex((observation) => observation.kind === 'packet')
    expect(completed).toBeGreaterThan(-1)
    expect(published).toBeGreaterThan(completed)
  })

  it('preserves whitespace and property order without parsing or canonicalizing JSON', async () => {
    const sources = [
      raw,
      ` \r\n${raw}\t `,
      '{"threads":[{"messages":[],"id":"native-thread"}],"savedAt":17,"version":1}',
    ]
    expect(sources.map((source) => JSON.parse(source))).toEqual(Array(3).fill(JSON.parse(raw)))
    const hashes: string[] = []
    for (const source of sources) {
      const fixture = await harness()
      fixture.hash(source)
      await fixture.done()
      const expected = hash(source)
      hashes.push(expected)
      expect(fixture.packets()).toEqual([{ type: 'hash', hash: expected }])
      expect(fixture.observations.some((observation) => observation.kind === 'parse')).toBe(false)
    }
    expect(new Set(hashes).size).toBe(sources.length)
  })

  it('admits only one request while hashing is pending and after the response is published', async () => {
    const fixture = await harness('gate')
    fixture.hash(raw)
    fixture.hash('{"different":true}')
    fixture.worker.postMessage({ type: 'fixture-barrier', id: 1 })
    await fixture.waitFor((observation) => observation.kind === 'barrier' && observation.id === 1)
    expect(
      fixture.observations.filter((observation) => observation.kind === 'encode'),
    ).toHaveLength(1)
    expect(
      fixture.observations.filter((observation) => observation.kind === 'digest-start'),
    ).toHaveLength(1)
    expect(fixture.packets()).toEqual([])

    fixture.worker.postMessage({ type: 'release-digest' })
    await fixture.done()
    fixture.hash('{"afterCompletion":true}')
    fixture.worker.postMessage({ type: 'fixture-barrier', id: 2 })
    await fixture.waitFor((observation) => observation.kind === 'barrier' && observation.id === 2)
    expect(
      fixture.observations.filter((observation) => observation.kind === 'encode'),
    ).toHaveLength(1)
    expect(
      fixture.observations.filter((observation) => observation.kind === 'digest-start'),
    ).toHaveLength(1)
    expect(fixture.packets()).toEqual([{ type: 'hash', hash: hash(raw) }])
  })

  it.each([
    ['raw Unicode and escaped lone surrogates', '{"text":"漢字🧪\\uD800 x \\uDFFF\\r\\n  "}'],
    ['valid surrogate pairs', '{"text":"\ud800\udc00 x \udbff\udfff 漢字🧪"}'],
    ['literal replacement characters', '{"text":"\ufffd x \ufffd"}'],
    ['unparsed serialized text', 'not JSON: 漢字🧪\r\n  '],
  ])('hashes the exact UTF-8 bytes of %s', async (_name, serialized) => {
    const fixture = await harness()
    fixture.hash(serialized)
    await fixture.done()
    expect(fixture.packets()).toEqual([{ type: 'hash', hash: hash(serialized) }])
    expect(
      fixture.observations.find((observation) => observation.kind === 'digest-start'),
    ).toMatchObject({
      byteLength: bytes(serialized).byteLength,
      bytes: bytes(serialized).toString('hex'),
    })
    expect(fixture.observations.some((observation) => observation.kind === 'parse')).toBe(false)
  })

  it.each([
    ['high', '{"text":"\ud800"}'],
    ['low', '{"text":"\udfff"}'],
  ])(
    'rejects a literal unpaired %s surrogate before encoding or digesting',
    async (_name, serialized) => {
      const replacement = serialized.replace(/[\uD800-\uDFFF]/gu, '\ufffd')
      // TextEncoder would collapse these distinct parsed prompts to the same
      // bytes, so rejecting before encoding prevents a false cache proof.
      expect(bytes(serialized)).toEqual(bytes(replacement))
      expect(JSON.parse(serialized)).not.toEqual(JSON.parse(replacement))
      const fixture = await harness()
      fixture.hash(serialized)
      await fixture.done()
      expect(fixture.packets()).toEqual([{ type: 'error', message: expect.any(String) }])
      expect(fixture.observations.some((observation) => observation.kind === 'encode')).toBe(false)
      expect(fixture.observations.some((observation) => observation.kind === 'digest-start')).toBe(
        false,
      )
      expect(fixture.observations.some((observation) => observation.kind === 'parse')).toBe(false)
    },
  )

  it.each(['reject', 'absent'] as const)('reports an error when Web Crypto is %s', async (mode) => {
    const fixture = await harness(mode)
    fixture.hash(raw)
    await fixture.done()
    expect(fixture.packets()).toEqual([{ type: 'error', message: expect.any(String) }])
    expect(fixture.observations.some((observation) => observation.kind === 'digest-complete')).toBe(
      false,
    )
    expect(fixture.observations.some((observation) => observation.kind === 'parse')).toBe(false)
  })

  it('releases the actual worker while its digest is suspended without publishing a hash', async () => {
    const fixture = await harness('gate')
    fixture.hash(raw)
    await fixture.waitFor((observation) => observation.kind === 'digest-start')
    const exit = await fixture.worker.terminate()
    workers.delete(fixture.worker)
    expect(exit).toBe(1)
    expect(fixture.packets()).toEqual([])
    expect(fixture.observations.some((observation) => observation.kind === 'digest-complete')).toBe(
      false,
    )
  })
})
