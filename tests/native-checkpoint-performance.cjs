const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const perf = require('node:perf_hooks').performance

// A deterministic local disk fixture. This does not authenticate either provider.
async function main() {
  const artifactDirectory = await fs.mkdtemp(join(tmpdir(), 'life-native-checkpoint-benchmark-'))
  const directory = join(artifactDirectory, 'history')
  const suppliedStore = process.argv[2]
  const storePath = suppliedStore
    ? resolve(suppliedStore)
    : join(artifactDirectory, 'conversation-store.cjs')
  const workerPath = join(artifactDirectory, 'conversation-checkpoint-worker.cjs')
  let store
  try {
    if (!suppliedStore) {
      buildSync({
        entryPoints: [resolve('src/main/conversation-store.ts')],
        outfile: storePath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        logLevel: 'silent',
      })
      buildSync({
        entryPoints: [resolve('src/main/conversation-checkpoint-worker.ts')],
        outfile: workerPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        logLevel: 'silent',
      })
    }
    const { ConversationStore } = require(storePath)
    store = new ConversationStore(directory, { workerPath })
    const threads = Array.from({ length: 80 }, (_, index) => ({
      id: `thread-${index}`,
      profileId: 'fixture-machine',
      provider: index % 2 ? 'claude' : 'codex',
      sessionId: `session-${index}`,
      messages: Array.from({ length: 400 }, (_, messageIndex) => ({
        id: `message-${index}-${messageIndex}`,
        role: messageIndex % 2 ? 'assistant' : 'user',
        text: 'Exact  prompt\n  ' + 'x'.repeat(1009),
        turn: messageIndex,
      })),
    }))
    const payloadBytes = Buffer.byteLength(JSON.stringify(threads))
    const originalFinalMessageBytes = Buffer.byteLength(JSON.stringify(threads[79].messages[399]))
    await store.save(threads, 1)
    const incremental = typeof store.saveCheckpoint === 'function'
    const saveCallMs = []
    const timerLagMs = []
    const elapsedMs = []
    const checkpointBytes = []
    for (let index = 0; index < 6; index++) {
      threads[79] = { ...threads[79], messages: [...threads[79].messages] }
      threads[79].messages[399] = {
        ...threads[79].messages[399],
        text: `stream-${index} ` + 'x'.repeat(1010),
      }
      const { messages, ...metadata } = threads[79]
      const input = {
        version: 1,
        baseSavedAt: index + 1,
        savedAt: index + 2,
        order: threads.map((thread) => thread.id),
        upserts: [{ thread: metadata, messages: { mode: 'patch', upserts: [messages[399]] } }],
      }
      checkpointBytes.push(
        incremental
          ? Buffer.byteLength(JSON.stringify(input))
          : payloadBytes +
              Buffer.byteLength(JSON.stringify(messages[399])) -
              originalFinalMessageBytes,
      )
      const scheduled = perf.now()
      let lag = 0
      const timer = new Promise((done) =>
        setTimeout(() => {
          lag = perf.now() - scheduled
          done()
        }, 0),
      )
      const start = perf.now()
      const promise = incremental ? store.saveCheckpoint(input) : store.save(threads, index + 2)
      saveCallMs.push(perf.now() - start)
      await Promise.all([promise, timer])
      elapsedMs.push(perf.now() - start)
      timerLagMs.push(lag)
    }
    const saved = await store.load()
    assert.equal(saved.savedAt, 7)
    assert.deepEqual(saved.threads, threads, 'Every message and thread must retain exact content.')
    console.log(
      JSON.stringify(
        {
          fixture: '80 threads × 400 messages × 1 KiB, six single-message checkpoints',
          mode: incremental ? 'worker incremental checkpoint' : 'legacy full checkpoint',
          payloadBytes,
          checkpointBytes,
          saveCallMs,
          timerLagMs,
          elapsedMs,
        },
        null,
        2,
      ),
    )
  } finally {
    if (store?.close) await store.close()
    await fs.rm(artifactDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
