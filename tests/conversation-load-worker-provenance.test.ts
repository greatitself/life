import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ConversationLoadPacket } from '../src/renderer/conversation-load-protocol'

type Mode = 'normal' | 'gate' | 'reject' | 'absent'
type Observation =
  | { kind: 'ready'; threadId: number }
  | { kind: 'digest-start'; threadId: number; algorithm: string; byteLength: number }
  | { kind: 'digest-complete'; threadId: number; hash: string }
  | { kind: 'decode'; threadId: number }
  | { kind: 'packet'; threadId: number; packet: ConversationLoadPacket }

let directory: string
let workerPath: string
const workers = new Set<Worker>()

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'life-history-worker-provenance-'))
  workerPath = join(directory, 'conversation-load-worker.mjs')
  // The production browser worker runs in a real Node worker. Only its browser
  // port and Web Crypto boundary are bridged; parsing and packet production are
  // bundled from the actual source, never imported into the test thread.
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
                observe('digest-start', { algorithm, byteLength: buffer.byteLength });
                if (workerData.mode === 'reject') throw new Error('fixture digest rejected');
                if (workerData.mode === 'gate') await gate;
                const result = await webcrypto.subtle.digest(algorithm, buffer);
                observe('digest-complete', { hash: Buffer.from(result).toString('hex') });
                return result;
              },
            },
          },
        });
        const Decoder = globalThis.TextDecoder;
        globalThis.TextDecoder = class extends Decoder {
          decode(...args) {
            observe('decode');
            return super.decode(...args);
          }
        };
        await import(${JSON.stringify(resolve('src/renderer/conversation-load-worker.ts'))});
        parentPort.on('message', (data) => {
          if (data.type === 'release-digest') releaseDigest();
          else port.onmessage({ data });
        });
        observe('ready');
      `,
      resolveDir: process.cwd(),
      sourcefile: 'history-worker-provenance-fixture.ts',
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
    if (
      observation.kind === 'packet' &&
      observation.packet.type !== 'done' &&
      observation.packet.type !== 'error'
    )
      worker.postMessage({ type: 'ack' })
    for (const waiter of waiters) waiter(observation)
  })
  const waitFor = (predicate: (observation: Observation) => boolean) => {
    const existing = observations.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<Observation>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(observe)
        reject(failure ?? new Error('The off-thread history fixture did not produce its packet.'))
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
    load: (bytes: Uint8Array) => {
      // A fresh transferable view owns precisely the bytes being authenticated.
      const buffer = Uint8Array.from(bytes).buffer
      worker.postMessage({ type: 'load', buffer }, [buffer])
      expect(buffer.byteLength).toBe(0)
    },
    done: () =>
      waitFor(
        (observation) =>
          observation.kind === 'packet' &&
          (observation.packet.type === 'done' || observation.packet.type === 'error'),
      ),
  }
}

const encode = (raw: string) => new TextEncoder().encode(raw)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const raw =
  '{"version":1,"savedAt":17,"threads":[{"id":"native-thread","profileId":"machine","provider":"codex","messages":[]}]}'

describe('off-thread native history byte provenance', () => {
  it('finishes the exact transferred-byte digest before decoding or publishing a baseline', async () => {
    const fixture = await harness('gate')
    const bytes = encode(raw)
    fixture.load(bytes)
    const admitted = await fixture.waitFor((observation) => observation.kind === 'digest-start')
    expect(admitted).toMatchObject({ algorithm: 'SHA-256', byteLength: bytes.byteLength })
    expect(fixture.observations.some((observation) => observation.kind === 'decode')).toBe(false)
    expect(fixture.packets()).toEqual([])
    fixture.worker.postMessage({ type: 'release-digest' })
    await fixture.done()
    expect(fixture.packets()[0]).toMatchObject({ type: 'start', hash: hash(bytes) })
    expect(fixture.packets().at(-1)?.type).toBe('done')
    const completed = fixture.observations.findIndex(
      (observation) => observation.kind === 'digest-complete',
    )
    const decoded = fixture.observations.findIndex((observation) => observation.kind === 'decode')
    expect(completed).toBeGreaterThan(-1)
    expect(decoded).toBeGreaterThan(completed)
  })

  it('distinguishes whitespace and property order even when decoded history is identical', async () => {
    const sources = [
      raw,
      ` \r\n${raw}\t `,
      '{"threads":[{"messages":[],"provider":"codex","profileId":"machine","id":"native-thread"}],"savedAt":17,"version":1}',
    ]
    expect(sources.map((source) => JSON.parse(source))).toEqual(Array(3).fill(JSON.parse(raw)))
    const hashes: string[] = []
    for (const source of sources) {
      const fixture = await harness()
      const bytes = encode(source)
      fixture.load(bytes)
      await fixture.done()
      const expected = hash(bytes)
      hashes.push(expected)
      expect(expected).toMatch(/^[a-f0-9]{64}$/)
      expect(fixture.packets()[0]).toMatchObject({ type: 'start', hash: expected })
    }
    expect(new Set(hashes).size).toBe(3)
  })

  it('hashes raw Unicode and lone-surrogate JSON escapes before preserving their decoded values', async () => {
    const source = raw.replace(
      '"messages":[]',
      '"messages":[{"text":"漢字🧪\\uD800 x \\uDFFF\\r\\n  "}]',
    )
    const bytes = encode(source)
    const fixture = await harness()
    fixture.load(bytes)
    await fixture.done()
    expect(fixture.packets()[0]).toMatchObject({ type: 'start', hash: hash(bytes) })
    expect(
      fixture.packets().flatMap((packet) => (packet.type === 'messages' ? packet.messages : [])),
    ).toEqual([{ text: '漢字🧪\ud800 x \udfff\r\n  ' }])
    // Canonical JSON normalizes escape casing and changes the byte proof.
    expect(hash(encode(JSON.stringify(JSON.parse(source))))).not.toBe(hash(bytes))
  })

  it('authenticates malformed UTF-8 bytes before rejecting them without publishing history', async () => {
    const bytes = new Uint8Array([...encode(raw), 0xff])
    const fixture = await harness()
    fixture.load(bytes)
    await fixture.done()
    expect(
      fixture.observations.find((observation) => observation.kind === 'digest-complete'),
    ).toMatchObject({ hash: hash(bytes) })
    expect(fixture.packets()).toEqual([{ type: 'error', message: expect.any(String) }])
    const completed = fixture.observations.findIndex(
      (observation) => observation.kind === 'digest-complete',
    )
    expect(
      fixture.observations.findIndex((observation) => observation.kind === 'decode'),
    ).toBeGreaterThan(completed)
  })

  it.each(['reject', 'absent'] as const)(
    'fails closed before decode when Web Crypto is %s',
    async (mode) => {
      const fixture = await harness(mode)
      fixture.load(encode(raw))
      await fixture.done()
      expect(fixture.packets()).toEqual([{ type: 'error', message: expect.any(String) }])
      expect(fixture.observations.some((observation) => observation.kind === 'decode')).toBe(false)
      expect(
        fixture.observations.some((observation) => observation.kind === 'digest-complete'),
      ).toBe(false)
    },
  )

  it('terminates the actual off-thread resource while hashing is suspended without decoding', async () => {
    const fixture = await harness('gate')
    fixture.load(encode(raw))
    await fixture.waitFor((observation) => observation.kind === 'digest-start')
    const exit = await fixture.worker.terminate()
    workers.delete(fixture.worker)
    expect(exit).toBe(1)
    expect(fixture.packets()).toEqual([])
    expect(fixture.observations.some((observation) => observation.kind === 'decode')).toBe(false)
    expect(fixture.observations.some((observation) => observation.kind === 'digest-complete')).toBe(
      false,
    )
  })
})
