#!/usr/bin/env node
// Same-fixture comparison of the actual Studio archival store in Chromium.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { relative, resolve, dirname } = require('node:path')
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const root = resolve(__dirname, '..')
const output = resolve(root, 'output/playwright/studio-history-performance')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const entry = [
  "export * from './src/renderer/studio-history'",
  "export { resetStudioSessionRequests } from './src/renderer/studio-source'",
].join('\n')

function archivePath(input) {
  const absolute = resolve(root, input)
  const vendor = absolute.lastIndexOf('/node_modules/')
  return vendor >= 0 ? `node_modules/${absolute.slice(vendor + 14)}` : relative(root, absolute)
}

async function buildVariant(name) {
  const directory = resolve(output, name)
  const snapshotRoot = resolve(directory, 'source')
  await mkdir(snapshotRoot, { recursive: true })
  // The first baseline was frozen before optimization. Always rebuild it from that snapshot.
  const prior =
    name === 'baseline'
      ? JSON.parse(await readFile(resolve(directory, 'source-proof.json'), 'utf8'))
      : null
  if (prior) {
    const vendorPackages = new Set()
    for (const [input, identity] of Object.entries(prior.sourceManifest)) {
      const archived = archivePath(input)
      const normalized = resolve(snapshotRoot, archived)
      const bytes = await readFile(normalized).catch(() => readFile(resolve(snapshotRoot, input)))
      assert.equal(digest(bytes), identity.sha256, `Retained baseline changed: ${input}`)
      if (archived.startsWith('node_modules/')) {
        const parts = archived.split('/')
        vendorPackages.add(parts[1].startsWith('@') ? parts.slice(1, 3).join('/') : parts[1])
      }
      await mkdir(dirname(normalized), { recursive: true })
      await writeFile(normalized, bytes)
    }
    // Package manifests resolve the already-retained vendor module entry points.
    for (const name of vendorPackages) {
      const relativePath = `node_modules/${name}/package.json`
      const bytes = await readFile(resolve(snapshotRoot, relativePath)).catch(() =>
        readFile(resolve(root, relativePath)),
      )
      await mkdir(dirname(resolve(snapshotRoot, relativePath)), { recursive: true })
      await writeFile(resolve(snapshotRoot, relativePath), bytes)
    }
  }
  const sourceBeforeBuild = {}
  const knownInputs = prior
    ? Object.keys(prior.sourceManifest).map(archivePath)
    : Object.keys(
        JSON.parse(
          await readFile(resolve(output, 'baseline/performance-source-proof.json'), 'utf8'),
        ).sourceManifest,
      )
  const knownVendorPackages = new Set()
  for (const input of knownInputs) {
    if (!input.startsWith('node_modules/')) continue
    const parts = input.split('/')
    knownVendorPackages.add(parts[1].startsWith('@') ? parts.slice(1, 3).join('/') : parts[1])
  }
  const beforeInputs = new Set([
    ...knownInputs,
    'package.json',
    'package-lock.json',
    ...[...knownVendorPackages].map((name) => `node_modules/${name}/package.json`),
  ])
  for (const input of beforeInputs) {
    const bytes = await readFile(resolve(prior ? snapshotRoot : root, input))
    sourceBeforeBuild[input] = digest(bytes)
  }
  const loadedSources = new Map()
  const result = await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: prior ? snapshotRoot : root,
      sourcefile: 'studio-performance-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'LifeStudioPerformance',
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'retain-exact-production-inputs',
        setup(plugin) {
          plugin.onLoad({ filter: /\.(?:[cm]?js|jsx|ts|tsx|json)$/ }, async (args) => {
            const bytes = await readFile(args.path)
            loadedSources.set(args.path, bytes)
            const suffix = args.path.split('.').pop()
            return {
              contents: bytes.toString('utf8'),
              loader: ['ts', 'tsx', 'jsx', 'json'].includes(suffix) ? suffix : 'js',
              resolveDir: dirname(args.path),
            }
          })
        },
      },
    ],
  })
  const sourceManifest = {}
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.endsWith('studio-performance-entry.ts')) continue
    const absolutePath = resolve(root, input)
    const bytes = loadedSources.get(absolutePath)
    assert.ok(bytes, `Build input was not captured: ${input}`)
    assert.equal(
      digest(await readFile(absolutePath)),
      digest(bytes),
      `Source changed between bundling and snapshot: ${input}`,
    )
    const key = prior ? relative(snapshotRoot, resolve(root, input)) : archivePath(input)
    assert.ok(!key.startsWith('..'), `Input escaped the retained source graph: ${key}`)
    const target = resolve(snapshotRoot, key)
    if (!prior) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    sourceManifest[key] = { sha256: digest(bytes), bytes: bytes.length }
  }
  const vendorPackages = new Set()
  for (const input of Object.keys(sourceManifest)) {
    if (!input.startsWith('node_modules/')) continue
    const parts = input.split('/')
    vendorPackages.add(parts[1].startsWith('@') ? parts.slice(1, 3).join('/') : parts[1])
  }
  for (const input of [
    'package.json',
    'package-lock.json',
    ...[...vendorPackages].map((name) => `node_modules/${name}/package.json`),
  ]) {
    const bytes = await readFile(resolve(prior ? snapshotRoot : root, input))
    if (!prior) {
      await mkdir(dirname(resolve(snapshotRoot, input)), { recursive: true })
      await writeFile(resolve(snapshotRoot, input), bytes)
    }
    sourceManifest[input] = { sha256: digest(bytes), bytes: bytes.length }
  }
  if (!prior) {
    for (const [input, identity] of Object.entries(sourceManifest))
      assert.equal(
        digest(await readFile(resolve(root, input))),
        identity.sha256,
        `Production source changed during candidate capture: ${input}`,
      )
  }
  for (const [input, hash] of Object.entries(sourceBeforeBuild))
    assert.equal(
      digest(await readFile(resolve(prior ? snapshotRoot : root, input))),
      hash,
      `Source changed while bundling: ${input}`,
    )
  const script = result.outputFiles[0].text
  await writeFile(resolve(directory, 'performance-entry.ts'), entry)
  await writeFile(resolve(directory, 'performance-bundle.js'), script)
  const proof = {
    kind: prior ? 'retained correctness baseline' : 'current production candidate',
    capturedAt: new Date().toISOString(),
    entrySha256: digest(entry),
    bundleSha256: digest(script),
    bundleBytes: Buffer.byteLength(script),
    sourceManifest,
    sourceBeforeBuild,
    originalBaselineBundleSha256: prior?.bundleSha256,
    metafile: result.metafile,
  }
  await writeFile(
    resolve(directory, 'performance-source-proof.json'),
    JSON.stringify(proof, null, 2),
  )
  return { name, proof, script }
}

function createArchive() {
  const rows = []
  const exact = '  Verbatim café e\u0301 漢字 🧪\r\n\t\ud800 boundary  '
  for (let session = 0; session < 40; session++) {
    const id = `studio-${session}`
    const messages = []
    for (let message = 0; message < 25; message++) {
      messages.push({
        id: `${id}-message-${message}`,
        role: message % 2 ? 'user' : 'assistant',
        text: `${exact}${session}/${message}: ${'x'.repeat(3020)}\r\n  `,
        input: `${exact}native input ${session}/${message}\r\n`,
        turn: Math.floor(message / 2),
        status: 'completed',
        futureMessage: { original: `${session}/${message}`, nested: [null, { retained: true }] },
      })
      if (message === 5) messages.push(null, { opaque: true, text: exact })
      if (message === 8)
        messages.push({ ...messages[messages.length - 1], duplicateOccurrence: true })
    }
    const row = {
      id,
      stage: 'complete',
      request: `${exact}customization ${session}`,
      createdAt: session + 1,
      updatedAt: session + 100,
      futureSession: { archived: true, providerFields: [session, null] },
      thread: {
        id,
        purpose: 'customization',
        profileId: 'ssh-profile',
        provider: session % 2 ? 'claude' : 'codex',
        remoteId: `native-provider-session-${session}`,
        workspace: `/workspace/project-${session}`,
        title: `Studio ${session}`,
        messages,
        turn: 12,
        busy: false,
        pending: [
          {
            type: 'approval',
            sessionId: id,
            requestId: `archived-${session}`,
            unknownNativeScope: exact,
          },
        ],
        turnStatus: 'completed',
        mode: 'review',
        model: 'native-default',
        updatedAt: session + 100,
        futureThread: { unknown: exact, nested: [null, { kept: true }] },
      },
    }
    rows.push(row)
    if (session === 10) rows.push(null, { rejectedStudioRow: true, exact })
    if (session === 20) rows.push({ ...row, duplicateSessionOccurrence: true })
  }
  return JSON.stringify(rows)
}

async function installFixture(page, variant, raw) {
  await page.goto('about:blank')
  await page.addScriptTag({ content: variant.script })
  await page.evaluate((raw) => {
    const api = LifeStudioPerformance
    const check = (condition, message) => {
      if (!condition) throw new Error(message)
    }
    const clone = (value) => JSON.parse(JSON.stringify(value))
    const originalRows = JSON.parse(raw)
    const targetId = 'studio-39'
    const rawIndex = originalRows.findIndex((value) => value?.id === targetId)
    const suffixA = '\r\n\tstream A 漢字 🧪 e\u0301 ' + 'a'.repeat(2048) + '\ud83e'
    const suffixB = '\uddea\r\nstream B exact input  ' + 'b'.repeat(2048)
    const rawReplyIndex = originalRows[rawIndex].thread.messages.findIndex(
      (value) => value?.id === 'studio-39-message-24',
    )
    window.studioFixture = {
      raw,
      originalRows,
      targetId,
      rawIndex,
      rawReplyIndex,
      suffixA,
      suffixB,
    }
    window.prepareStudioTrial = () => {
      const getItem = (key) => {
        check(key === api.STUDIO_HISTORY_KEY, 'Wrong read key')
        return raw
      }
      window.studioReadStorage = { getItem }
      window.studioStore = null
      window.studioCurrent = null
      window.studioExpected = clone(originalRows)
      window.studioOutputs = []
    }
    window.readStudioTrial = () => {
      const start = performance.now()
      const store = api.readStudioHistory(window.studioReadStorage)
      const elapsedMs = performance.now() - start
      check(store.canSave && store.sessions.length === 40, 'Incorrect actionable session count')
      window.studioStore = store
      window.studioCurrent = store.sessions
      return { elapsedMs, sessions: store.sessions.length }
    }
    window.prepareStudioAction = (name) => {
      const session = window.studioCurrent.find((value) => value.id === targetId)
      check(Boolean(session), 'Target Studio session missing')
      let next
      const expected = clone(window.studioExpected)
      const archived = expected[rawIndex]
      const replyIndex = session.thread.messages.findIndex(
        (value) => value.id === 'studio-39-message-24',
      )
      const reply = session.thread.messages[replyIndex]
      if (name === 'rename') {
        next = { ...session, thread: { ...session.thread, title: 'Small metadata rename Ω' } }
        archived.thread.title = next.thread.title
      } else if (name === 'stream-first' || name === 'stream-after-ack') {
        const suffix = name === 'stream-first' ? suffixA : suffixB
        next = {
          ...session,
          thread: {
            ...session.thread,
            messages: session.thread.messages.map((message, index) =>
              index === replyIndex ? { ...message, text: reply.text + suffix } : message,
            ),
          },
        }
        archived.thread.messages[rawReplyIndex].text += suffix
      } else if (name === 'permission-reset') {
        next = api.resetStudioSessionRequests(session)
        archived.thread.pending = []
      } else if (name === 'rename-revert') {
        next = {
          ...session,
          thread: { ...session.thread, title: originalRows[rawIndex].thread.title },
        }
        archived.thread.title = next.thread.title
      } else if (name === 'stream-revert') {
        const text = originalRows[rawIndex].thread.messages[rawReplyIndex].text
        next = {
          ...session,
          thread: {
            ...session.thread,
            messages: session.thread.messages.map((message, index) =>
              index === replyIndex ? { ...message, text } : message,
            ),
          },
        }
        archived.thread.messages[rawReplyIndex].text = text
      } else throw new Error(`Unknown action ${name}`)
      window.studioNext = window.studioCurrent.map((value) => (value === session ? next : value))
      window.studioNextExpected = expected
      window.studioEncoded = null
    }
    window.writeStudioAction = (name) => {
      let beforeStorageMs
      let storageEnteredAt
      let storageExitedAt
      const start = performance.now()
      window.studioStore.write(window.studioNext, {
        setItem(key, value) {
          storageEnteredAt = performance.now()
          beforeStorageMs = storageEnteredAt - start
          check(key === api.STUDIO_HISTORY_KEY, 'Wrong write key')
          window.studioEncoded = value
          storageExitedAt = performance.now()
        },
      })
      const end = performance.now()
      window.studioCurrent = window.studioNext
      window.studioExpected = window.studioNextExpected
      return {
        name,
        totalMs: end - start,
        projectionAndEncodeMs: beforeStorageMs,
        storageStandinMs: storageExitedAt - storageEnteredAt,
        acknowledgeMs: end - storageExitedAt,
      }
    }
    window.verifyStudioAction = () => {
      const encoded = window.studioEncoded
      const expected = JSON.stringify(window.studioExpected)
      check(
        encoded === expected,
        'Saved Studio JSON differs from occurrence-preserving expected output',
      )
      window.studioOutputs.push(encoded)
      return encoded
    }
    window.verifyFinalStudioProjection = () => {
      check(
        window.studioStore.encode(window.studioCurrent) === window.studioEncoded,
        'Post-ACK projection differs from the durable write',
      )
    }
    window.clearStudioTrial = () => {
      window.studioStore = null
      window.studioCurrent = null
      window.studioNext = null
      window.studioNextExpected = null
      window.studioExpected = null
      window.studioEncoded = null
      window.studioOutputs = null
    }
  }, raw)
}

async function timed(page, operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const gaps = []
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        gaps.push(now - last)
        last = now
      }, 4)
      try {
        await delay(24)
        gaps.length = 0
        const result = window[operation](argument)
        await delay(16)
        return {
          ...result,
          timerGapsMs: gaps,
          maximumTimerGapMs: Math.max(0, ...gaps),
          maximumTimerOverrunMs: Math.max(0, Math.max(0, ...gaps) - 4),
        }
      } finally {
        clearInterval(timer)
      }
    },
    { operation, argument },
  )
}

async function compare() {
  const baseline = await buildVariant('baseline')
  const candidate = await buildVariant('candidate')
  const raw = createArchive()
  const rawRows = JSON.parse(raw)
  await writeFile(resolve(output, 'archive.json'), raw)
  const actions = [
    'rename',
    'stream-first',
    'stream-after-ack',
    'permission-reset',
    'rename-revert',
    'stream-revert',
  ]
  const errors = []
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const pages = {}
    const sessions = {}
    for (const variant of [baseline, candidate]) {
      const page = await browser.newPage()
      page.on('pageerror', (error) => errors.push(`${variant.name}: ${error.message}`))
      await installFixture(page, variant, raw)
      pages[variant.name] = page
      sessions[variant.name] = await page.context().newCDPSession(page)
    }
    const observations = []
    const outputHashes = {}
    // Fresh ownership and raw JSON per run; order alternates to reduce run-order bias.
    for (let repetition = -1; repetition < 7; repetition++) {
      const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
      for (const name of order) {
        const page = pages[name]
        await page.evaluate(() => window.prepareStudioTrial())
        await sessions[name].send('HeapProfiler.collectGarbage')
        const read = await timed(page, 'readStudioTrial')
        if (repetition >= 0)
          observations.push({ variant: name, repetition, action: 'read', ...read })
        const hashes = []
        for (const action of actions) {
          await page.evaluate((action) => window.prepareStudioAction(action), action)
          const result = await timed(page, 'writeStudioAction', action)
          const encoded = await page.evaluate(() => window.verifyStudioAction())
          const hash = digest(encoded)
          hashes.push({ action, sha256: hash, bytes: Buffer.byteLength(encoded) })
          if (repetition >= 0)
            observations.push({
              variant: name,
              repetition,
              action,
              encodedSha256: hash,
              encodedBytes: Buffer.byteLength(encoded),
              ...result,
            })
        }
        await page.evaluate(() => window.verifyFinalStudioProjection())
        outputHashes[name] ??= hashes
        assert.deepEqual(hashes, outputHashes[name], `${name} changed output between repetitions`)
        await page.evaluate(() => window.clearStudioTrial())
      }
    }
    assert.deepEqual(
      outputHashes.baseline,
      outputHashes.candidate,
      'Optimization changed durable JSON',
    )
    assert.deepEqual(errors, [])
    const summary = ['read', ...actions].map((action) => {
      const rows = Object.fromEntries(
        ['baseline', 'candidate'].map((name) => [
          name,
          observations.filter((row) => row.variant === name && row.action === action),
        ]),
      )
      const metrics =
        action === 'read'
          ? ['elapsedMs', 'maximumTimerGapMs']
          : ['totalMs', 'projectionAndEncodeMs', 'acknowledgeMs', 'maximumTimerGapMs']
      return {
        action,
        ...Object.fromEntries(
          metrics.map((metric) => [
            metric,
            Object.fromEntries(
              Object.entries(rows).map(([name, values]) => [
                name,
                {
                  median: median(values.map((value) => value[metric])),
                  observations: values.map((value) => value[metric]),
                },
              ]),
            ),
          ]),
        ),
      }
    })
    // Candidate source must remain unchanged for the whole actual-browser comparison.
    for (const [input, identity] of Object.entries(candidate.proof.sourceManifest))
      assert.equal(
        digest(await readFile(resolve(root, input))),
        identity.sha256,
        `Production source changed during measurement: ${input}`,
      )
    const report = {
      kind: 'Actual production Studio archival-store Chromium comparison with synchronous in-memory Storage stand-in',
      browserVersion: browser.version(),
      fixture: {
        sha256: digest(raw),
        bytes: Buffer.byteLength(raw),
        sessions: 40,
        archivedRows: rawRows.length,
        archivedMessageRows: rawRows.reduce(
          (count, value) => count + (value?.thread?.messages?.length ?? 0),
          0,
        ),
        baseMessagesPerSession: 25,
        opaqueAndDuplicateOccurrences: true,
        exactUnicodeAndCRLF: true,
        providerKinds: ['codex', 'claude'],
      },
      variants: Object.fromEntries(
        [baseline, candidate].map((variant) => [
          variant.name,
          {
            bundleSha256: variant.proof.bundleSha256,
            sourceManifest: variant.proof.sourceManifest,
          },
        ]),
      ),
      protocol:
        'One full warmup and seven fresh-store measured repetitions per version, alternating version order. Restore/read measured separately. Immutable snapshots, expected JSON and large body strings prepared before write timers. Each write measures production projection+JSON encoding before setItem and acknowledgement after that callback. Four millisecond timer probes surround each operation; read-only fidelity and SHA-256 checks occur outside timers. Forced GC occurs before each fresh restore only.',
      limits:
        'The Storage stand-in synchronously retains a string and measures neither disk nor browser localStorage costs. This isolates renderer archival-store costs; it does not prove Electron IPC, provider authentication, full React UI, native packaging, or universal latency. Timer gaps include scheduler noise. Preparation and correctness checks intentionally allocate outside the measured windows.',
      exactOutputs: outputHashes.baseline,
      summary,
      observations,
      browserErrors: errors,
    }
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify(
        {
          fixture: report.fixture,
          bundles: {
            baseline: baseline.proof.bundleSha256,
            candidate: candidate.proof.bundleSha256,
          },
          summary,
          browserErrors: errors,
        },
        null,
        2,
      ),
    )
  } finally {
    await browser?.close()
  }
}

async function main() {
  await mkdir(output, { recursive: true })
  if (process.argv[2] === 'freeze') {
    const variant = await buildVariant(process.argv[3] || 'baseline')
    console.log(
      JSON.stringify(
        {
          name: variant.name,
          bundleSha256: variant.proof.bundleSha256,
          sourceInputs: Object.keys(variant.proof.sourceManifest).length,
        },
        null,
        2,
      ),
    )
    return
  }
  assert.equal(process.argv[2], 'compare', 'Use freeze baseline, freeze candidate, or compare')
  await compare()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
