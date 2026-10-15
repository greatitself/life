const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

// One fixture runs unchanged against both source trees. No provider process or authentication.
async function main() {
  const sourceRoot = resolve(process.argv[2] || '.')
  const label = process.argv[3] || 'candidate'
  assert.match(label, /^[a-z0-9-]+$/)
  const temporary = await mkdtemp(join(tmpdir(), 'life-recovery-read-performance-'))
  const output = resolve('output/playwright/native-recovery-read-performance')
  try {
    const fixture = `
      import assert from 'node:assert/strict'
      import { performance } from 'node:perf_hooks'
      import { Effect } from '__EFFECT__'
      import { NativeRecoveryStore } from '__SOURCE__'
      export async function run(directory: string) {
        return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const store = yield* NativeRecoveryStore.make({ directory, exclusiveRuntime: true })
          const prompt = '  exact\\r\\nrequest 🌍\\ud800'
          const source = 'source context\\n'.repeat(16_384)
          const owner = {
            ownerId: 'fixture-owner', sessionId: 'fixture-session', generation: 1,
            kind: 'root' as const, workspace: '/fixture', writableRoot: '/fixture',
            state: 'starting' as const,
            input: { sessionId: 'fixture-session', provider: 'codex' as const, prompt,
              mode: 'plan' as const, workspace: '/fixture' },
            clientRecovery: { source, iteration: 0 },
          }
          const transport = {
            id: 'fixture-transport', brokerId: 'fixture-broker', brokerRoot: '/fixture/broker',
            launchCommand: 'codex app-server', provider: 'codex' as const,
            providerVersion: 'fixture', nativeProtocol: 'codex-app-server-stdio',
            brokerProtocolVersion: 2,
            machine: { profileId: 'fixture', host: 'fixture', port: 22, username: 'fixture' },
            controller: { id: 'fixture-controller', epoch: 1 },
            initialization: { status: 'pending' as const, requestId: 1 },
            owners: [owner],
          }
          yield* store.createTransport(transport)
          for (let iteration = 1; iteration <= 48; iteration++) {
            yield* store.updateTransport(transport.id, {
              owners: [{ ...owner, clientRecovery: { source, iteration } }],
            })
          }
          const readMs: number[] = []
          const timerLagMs: number[] = []
          for (let iteration = 0; iteration < 6; iteration++) {
            const started = performance.now()
            const timer = new Promise<number>(done =>
              setTimeout(() => done(performance.now() - started), 0))
            const snapshot = yield* store.readTransport(transport.id)
            readMs.push(performance.now() - started)
            assert.equal(snapshot.records.length, 49)
            assert.equal(snapshot.transport.owners[0].input.prompt, prompt)
            assert.equal((snapshot.transport.owners[0].clientRecovery as any).iteration, 48)
            for (const [index, record] of snapshot.records.entries()) {
              assert.equal(record.revision, index + 1)
              const saved = record.kind === 'create'
                ? record.transport.owners[0] : record.kind === 'transport' && record.patch.owners[0]
              assert.ok(saved)
              assert.equal(saved.input.prompt, prompt)
              assert.equal(saved.clientRecovery.source, source)
              assert.equal(saved.clientRecovery.iteration, index)
            }
            timerLagMs.push(yield* Effect.promise(() => timer))
          }
          return { readMs, timerLagMs, records: 49, sourceBytesPerEntry: Buffer.byteLength(source) }
        })))
      }
    `
      .replace("'__EFFECT__'", JSON.stringify(require.resolve('effect')))
      .replace(
        "'__SOURCE__'",
        JSON.stringify(join(sourceRoot, 'src/main/native-recovery-store.ts')),
      )
    const bundle = join(temporary, 'fixture.cjs')
    buildSync({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: bundle,
      logLevel: 'silent',
    })
    const measurements = await require(bundle).run(join(temporary, 'journal'))
    const proof = {
      fixture:
        '48 owner checkpoints with 224 KiB exact source context; six complete recovery reads',
      fixtureHash: createHash('sha256')
        .update(await readFile(__filename))
        .digest('hex'),
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRoot,
        encoding: 'utf8',
      }).trim(),
      label,
      ...measurements,
      evidence:
        'Deterministic local journal fixture; no upstream provider or end-to-end latency claim.',
    }
    await mkdir(output, { recursive: true })
    await writeFile(join(output, label + '.json'), JSON.stringify(proof, null, 2) + '\n')
    console.log(JSON.stringify(proof))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
