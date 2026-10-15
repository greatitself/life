const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { build } = require('esbuild')

// Same local 35 MB history as the Electron load fixture. This measures the
// actual bundled native worker; no browser, SSH, or upstream provider is used.
async function main() {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'life-native-history-load-'))
  const artifacts = resolve('output/playwright/native-encoded-load')
  const baselineEngine = process.argv[2] && resolve(process.argv[2])
  const directory = join(temporary, 'history')
  const storePath = join(temporary, 'conversation-store.cjs')
  const entries = [['current', undefined]]
  if (baselineEngine) entries.unshift(['before-cache', baselineEngine])
  const stores = []
  try {
    await fs.mkdir(directory)
    await fs.mkdir(artifacts, { recursive: true })
    await build({
      entryPoints: [resolve('src/main/conversation-store.ts')],
      outfile: storePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    })
    const { ConversationStore } = require(storePath)
    const threads = Array.from({ length: 80 }, (_, index) => ({
      id: 'checkpoint-thread-' + index,
      profileId: 'isolated-fixture-machine',
      provider: index % 2 ? 'claude' : 'codex',
      workspace: '/fixture/workspace-' + index,
      remoteId: 'native-provider-session-' + index,
      title: 'Exact history ' + index,
      model: '',
      mode: 'default',
      busy: false,
      pending: [],
      updatedAt: 1_800_000_000_000 - index,
      turn: 399,
      messages: Array.from({ length: 400 }, (_, messageIndex) => ({
        id: 'checkpoint-message-' + index + '-' + messageIndex,
        role: messageIndex % 2 ? 'assistant' : 'user',
        text: '  Exact  prompt\r\n\tUnicode café e\u0301 漢字 🧪\n' + 'x'.repeat(1009),
        turn: messageIndex,
      })),
    }))
    threads[0] = {
      ...threads[0],
      busy: true,
      turnStatus: 'running',
      futureNativeMetadata: { exact: 'Future field\r\n🧪' },
      queue: [
        {
          id: 'queued-exact',
          text: '  Keep queued input\r\n\t🧪  ',
          createdAt: 123,
          attachments: [],
          paused: false,
        },
      ],
      messages: threads[0].messages.map((message, index) =>
        index === 0
          ? {
              ...message,
              input: '  Native provider input\r\n\t café e\u0301 漢字 🧪  ',
              futureMessageMetadata: { nested: ['exact', 1, null] },
            }
          : index === 1
            ? {
                ...message,
                role: 'tool',
                status: 'running',
                kind: 'subagent',
                agentId: 'stale-child',
              }
            : message,
      ),
    }
    const snapshot = { version: 1, savedAt: 100, threads }
    const serialized = JSON.stringify(snapshot)
    const digest = (value) => createHash('sha256').update(value).digest('hex')
    const expectedDigest = digest(serialized)
    const samples = []
    const measure = async (store, label) => {
      let previous = performance.now(),
        maxLagMs = 0,
        ticks = 0
      const timer = setInterval(() => {
        const now = performance.now()
        maxLagMs = Math.max(maxLagMs, Math.max(0, now - previous - 4))
        previous = now
        ticks++
      }, 4)
      const start = performance.now()
      const pending = store.loadEncoded()
      const callMs = performance.now() - start
      const encoded = await pending
      const elapsedMs = performance.now() - start
      clearInterval(timer)
      assert.ok(encoded instanceof ArrayBuffer)
      assert.equal(digest(Buffer.from(encoded)), expectedDigest)
      const sample = {
        label,
        callMs,
        elapsedMs,
        mainTimerMaxLagMs: maxLagMs,
        mainTimerTicks: ticks,
        encodedBytes: encoded.byteLength,
      }
      samples.push(sample)
      return encoded
    }
    for (const [variant, enginePath] of entries) {
      const workerPath = join(temporary, variant + '-worker.cjs')
      const plugins = enginePath
        ? [
            {
              name: 'baseline-checkpoint-engine',
              setup(builder) {
                builder.onLoad(
                  { filter: /conversation-checkpoint-engine\.ts$/ },
                  async ({ path }) => ({
                    contents: await fs.readFile(enginePath, 'utf8'),
                    loader: 'ts',
                    resolveDir: dirname(path),
                  }),
                )
              },
            },
          ]
        : []
      await build({
        entryPoints: [resolve('src/main/conversation-checkpoint-worker.ts')],
        outfile: workerPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        logLevel: 'silent',
        plugins,
      })
      for (const setup of ['fresh-worker-disk-read', 'existing-worker-after-save']) {
        await fs.writeFile(join(directory, 'conversations.json'), serialized)
        const store = new ConversationStore(directory, { workerPath })
        stores.push(store)
        if (setup === 'existing-worker-after-save') await store.save(threads, 100)
        const first = await measure(store, variant + '/' + setup + '/first')
        assert.deepEqual(JSON.parse(new TextDecoder().decode(first)), snapshot)
        for (let index = 0; index < 4; index++)
          await measure(store, variant + '/' + setup + '/warm-' + index)
        await store.close()
      }
    }
    const report = {
      fixture:
        '80 threads × 400 messages with exact CRLF, Unicode, and opaque metadata; actual bundled native worker',
      upstreamProvidersUsed: false,
      payloadBytes: Buffer.byteLength(serialized),
      exactSha256: expectedDigest,
      nativeOnly: true,
      memoryTradeoff:
        'One current JSON string until first encoded load, then one current UTF-8 cache of payloadBytes. Each response owns a fresh transferable byte copy; successful commits replace the previous cache, failed commits retain it.',
      samples,
    }
    await fs.writeFile(
      join(artifacts, 'native-encoded-load-report.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await Promise.all(stores.map((store) => store.close()))
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
