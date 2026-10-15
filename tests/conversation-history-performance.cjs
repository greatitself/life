#!/usr/bin/env node
// Measure renderer checkpoint work independently of native IPC and disk I/O.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { resolve } = require('node:path')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')

async function run() {
  const fixture = await build({
    stdin: {
      resolveDir: resolve(__dirname, '..'),
      loader: 'ts',
      contents: `
        import { ConversationHistoryPersistence, readCachedConversationHistory } from './src/renderer/conversation-persistence'
        window.Persistence = ConversationHistoryPersistence
        window.readCache = readCachedConversationHistory
      `,
    },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
  })
  const server = createServer((request, response) => {
    const script = request.url === '/fixture.js'
    response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html')
    response.end(script ? fixture.outputFiles[0].text : '<script src="/fixture.js"></script>')
  })
  let browser
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const result = await page.evaluate(async () => {
      const rows = []
      let stringifyCalls = 0
      let storageCalls = 0
      let nativeCalls = 0
      const originalStringify = JSON.stringify
      for (const megabytes of [0.5, 4, 10, 50]) {
        const text = 'Response content '.repeat(Math.ceil((megabytes * 1024 * 1024) / 1000 / 17))
        const threads = Array.from({ length: 10 }, (_, index) => ({
          id: `thread-${index}`,
          profileId: 'profile',
          provider: 'codex',
          messages: Array.from({ length: 100 }, (_, message) => ({
            id: `${index}-${message}`,
            role: 'assistant',
            text,
            turn: message,
          })),
          title: 'Example',
          updatedAt: Date.now(),
          busy: false,
          turn: 1,
          pending: [],
          model: '',
          mode: 'review',
        }))
        const serializedCharacters = originalStringify(threads).length
        const samples = []
        for (let sample = 0; sample < 5; sample++) {
          const persistence = new window.Persistence({
            getThreads: () => threads,
            getNativeSave: () => async (history) => {
              nativeCalls++
              if (history[9].messages[99].text !== text) throw new Error('History was truncated')
            },
            getStorage: () => {
              storageCalls++
              return localStorage
            },
            onError: (message) => {
              throw new Error(message)
            },
            enabled: () => true,
          })
          JSON.stringify = (...arguments) => {
            stringifyCalls++
            return originalStringify(...arguments)
          }
          try {
            const start = performance.now()
            const checkpoint = persistence.flush()
            samples.push(performance.now() - start)
            if (!(await checkpoint)) throw new Error('Native checkpoint failed')
          } finally {
            JSON.stringify = originalStringify
          }
        }
        samples.sort((left, right) => left - right)
        rows.push({
          serializedCharacters,
          rendererStartMedianMs: +samples[2].toFixed(2),
          rendererStartMaxMs: +samples[4].toFixed(2),
        })
      }

      // Exercise the real browser storage path, including an exact deletion
      // checkpoint, when the primary native destination is unavailable.
      localStorage.clear()
      let history = [
        {
          id: 'fallback',
          profileId: 'profile',
          provider: 'claude',
          messages: [
            { id: 'message', role: 'assistant', text: 'Exact text\n  preserved  \n', turn: 1 },
          ],
          title: 'Fallback',
          updatedAt: 100,
          busy: false,
          turn: 1,
          pending: [],
          model: '',
          mode: 'review',
        },
      ]
      const fallback = new window.Persistence({
        getThreads: () => history,
        getNativeSave: () => async () => {
          throw new Error('Disk unavailable')
        },
        getStorage: () => localStorage,
        onError: () => {},
        enabled: () => true,
      })
      await fallback.flush()
      const exactFallback =
        window.readCache().threads[0].messages[0].text === history[0].messages[0].text
      history = []
      const deletionSaved = await fallback.flush(history)
      const recovered = window.readCache()
      return {
        rows,
        stringifyCalls,
        storageCalls,
        nativeCalls,
        exactFallback,
        deletionSaved,
        recoveredThreads: recovered.threads.length,
        fallbackCheckpointValid: Number.isSafeInteger(recovered.savedAt),
      }
    })
    assert.equal(result.stringifyCalls, 0, 'Healthy native checkpoints avoid browser serialization')
    assert.equal(
      result.storageCalls,
      0,
      'Healthy native checkpoints avoid synchronous browser storage',
    )
    assert.equal(result.nativeCalls, 20, 'All complete native snapshots were checkpointed')
    assert.equal(result.exactFallback, true)
    assert.equal(result.deletionSaved, true)
    assert.equal(result.recoveredThreads, 0)
    assert.equal(result.fallbackCheckpointValid, true)
    console.log(JSON.stringify(result))
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
