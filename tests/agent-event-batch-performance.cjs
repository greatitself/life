#!/usr/bin/env node
// Compare the actual renderer projection before/after adjacent delta compaction.
// This local browser fixture does not contact authenticated upstream providers.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('./helpers/browser-build.cjs')
const { chromium } = require('playwright')

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'life-agent-event-batch-'))
  const output = resolve(__dirname, '../output/playwright/agent-event-batch-performance')
  await mkdir(output, { recursive: true })
  const errors = []
  let server
  let browser
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, '..'),
        sourcefile: 'agent-event-batch-fixture.ts',
        loader: 'ts',
        contents: `
          import { applyEvent } from './src/renderer/state'
          import { AgentEventBatch, coalesceAgentEvents } from './src/renderer/agent-event-batch'
          const frozenAt = 1800000000000
          Date.now = () => frozenAt
          const check = (condition, message) => { if (!condition) throw new Error(message) }
          const identical = (first, second) => {
            if (Object.is(first, second)) return true
            if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false
            if (Array.isArray(first) !== Array.isArray(second)) return false
            const keys = Reflect.ownKeys(first)
            return keys.length === Reflect.ownKeys(second).length && keys.every(key =>
              Object.hasOwn(second, key) && identical(first[key], second[key]))
          }
          const probes = { historicalIdReads: 0, fullHistoryScans: 0 }
          const historyCount = 32000
          const turn = 20001
          const exactPrompt = '  Please inspect this code.\\n\\n' + '\\x60\\x60\\x60ts\\nconst value = "  untouched  ";\\n\\x60\\x60\\x60\\n'
          const initialText = 'Initial provider output:\\n'
          const metadata = Object.freeze({ stream: 'native-final-answer', raw: { nested: ['kept'] } })
          const history = Object.freeze(Array.from({ length: historyCount }, (_, index) => {
            const active = index === historyCount - 1
            const id = active ? turn + ':answer:final_answer' : 'history:' + index
            return Object.freeze({
              get id() { if (!active) probes.historicalIdReads++; if (index === 0) probes.fullHistoryScans++; return id },
              role: index === 0 ? 'user' : active ? 'assistant' : index % 2 ? 'assistant' : 'tool',
              text: index === 0 ? exactPrompt : active ? initialText : 'Recovered native history ' + index,
              turn: active || index === 0 ? turn : Math.floor(index / 2) + 1,
              createdAt: frozenAt - 100,
              ...(active ? { phase: 'final_answer', provider: 'codex', details: metadata } : {}),
            })
          }))
          const initial = Object.freeze({
            id: 'thread', profileId: 'machine', workspace: '/srv/project', provider: 'codex',
            title: 'Exact provider conversation', remoteId: 'native-session', messages: history,
            busy: true, turnStatus: 'running', model: 'native-model', mode: 'review',
            updatedAt: frozenAt - 100, turn, pending: Object.freeze([]),
          })
          const plainInitial = Object.freeze({
            ...initial, messages: Object.freeze(history.map(message => Object.freeze({ ...message }))),
          })
          check(identical(initial, plainInitial), 'Plain fixture history differs from instrumented history')
          const fragments = ['  ', '🙂', '\\n', '\\x60code\\x60', '\\t', '漢字', ' token ', '\\uD83D', '\\uDE42', '\\r\\n']
          const events = Object.freeze(Array.from({ length: 100 }, (_, index) => Object.freeze({
            sessionId: 'thread', type: 'text', itemId: 'answer', phase: 'final_answer',
            provider: 'codex', details: metadata, text: fragments[index % fragments.length] + index,
          })))
          const initialSnapshot = JSON.stringify(initial)
          const eventSnapshot = JSON.stringify(events)
          const reset = () => { probes.historicalIdReads = 0; probes.fullHistoryScans = 0 }
          const measure = (optimized, instrumented) => {
            reset()
            const started = performance.now()
            const projected = optimized ? coalesceAgentEvents(events) : events
            const result = projected.reduce(applyEvent, instrumented ? initial : plainInitial)
            const elapsedMs = performance.now() - started
            const counts = { ...probes }
            check(result.messages[0].text === exactPrompt, 'Exact prompt changed')
            check(result.messages.length === historyCount, 'History length changed')
            check(result.messages[historyCount - 1].text === initialText + events.map(event => event.text).join(''), 'Exact token content changed')
            check(result.messages[historyCount - 1].details.raw === metadata.raw, 'Structured provider details changed')
            check(result.remoteId === initial.remoteId && result.workspace === initial.workspace, 'Session or workspace changed')
            return { elapsedMs, ...counts, projectedEvents: projected.length, result }
          }
          const boundaryChecks = () => {
            const base = { ...initial, messages: [{ id: 'user', role: 'user', text: exactPrompt, turn }] }
            const detailA = { scope: 'first' }
            const detailB = { scope: 'second' }
            const event = (type, values = {}) => ({ sessionId: 'thread', type, ...values })
            const adjacent = (values, prefix) => [event('text', { ...values, text: prefix + '  ' }), event('text', { ...values, text: '🙂\\n' })]
            const ordered = [
              ...adjacent({ itemId: 'answer', phase: 'commentary', details: detailA }, 'Checking'),
              ...adjacent({ itemId: 'answer', phase: 'final_answer', details: detailA }, 'Answer'),
              event('text', { itemId: 'answer', phase: 'final_answer', status: 'replace', text: 'Final snapshot\\n' }),
              ...adjacent({ itemId: 'other', phase: 'final_answer', details: detailB }, 'Other item'),
              event('reasoning', { itemId: 'analysis', text: 'Reasoning ' }),
              event('reasoning', { itemId: 'analysis', text: 'continues.\\n' }),
              ...adjacent({ itemId: 'answer', agentId: 'child', agentName: 'Reviewer', parentItemId: 'delegation', provider: 'claude', details: detailA }, 'Child'),
              ...adjacent({ itemId: 'answer', agentId: 'child', agentName: 'Renamed reviewer', parentItemId: 'delegation', provider: 'claude', details: detailB }, 'Child update'),
              event('tool', { itemId: 'command', input: "printf 'line one\\\\n'", status: 'running', details: detailA }),
              event('tool-output', { itemId: 'command', text: 'line ' }),
              event('tool-output', { itemId: 'command', text: 'one\\n' }),
              event('approval', { requestId: 'permission', title: 'Run command', input: 'npm test' }),
              event('request-resolved', { requestId: 'permission', status: 'approved' }),
              event('title', { title: 'Native updated title' }),
              event('session', { remoteId: 'native-updated-session' }),
              event('complete', { status: 'completed' }),
            ]
            const snapshot = JSON.stringify(ordered)
            const compacted = coalesceAgentEvents(ordered)
            const before = ordered.reduce(applyEvent, base)
            const after = compacted.reduce(applyEvent, base)
            check(identical(before, after), 'Wire boundary projection changed')
            check(JSON.stringify(ordered) === snapshot, 'Input events were mutated')
            check(after.messages[0].text === exactPrompt, 'Boundary fixture prompt changed')
            check(after.pending.length === 0 && after.turnStatus === 'completed', 'Native permission or completion state changed')
            check(after.messages.find(message => message.phase === 'commentary').text === 'Checking  🙂\\n', 'Commentary boundary changed')
            check(after.messages.find(message => message.id === turn + ':answer:final_answer').text === 'Final snapshot\\n', 'Replacement snapshot changed')
            const sameContentDetails = [event('text', { text: 'A', details: { value: 1 } }), event('text', { text: 'B', details: { value: 1 } })]
            check(coalesceAgentEvents(sameContentDetails) === sameContentDetails, 'Distinct structured payloads were joined')
            const otherSession = [event('text', { text: 'A' }), { sessionId: 'other-thread', type: 'text', text: 'B' }]
            check(coalesceAgentEvents(otherSession) === otherSession, 'Session boundary was joined')
            const delivered = []
            const batch = new AgentEventBatch(events => delivered.push(events), 60000)
            for (let index = 0; index < 501; index++) batch.push(event('text', { text: String(index) }))
            check(delivered.length === 1 && delivered[0].length === 500, '500-event wire batch bound changed')
            batch.dispose()
            check(delivered.length === 2 && delivered[1][0].text === '500', 'Disposal dropped pending native content')
            return { inputEvents: ordered.length, projectedEvents: compacted.length, wireBatchBound: 500 }
          }
          window.fixture = {
            ready: true,
            run() {
              const modes = {}
              for (const instrumented of [true, false]) {
                // Warm both paths before sampling, then alternate execution order.
                measure(false, instrumented); measure(true, instrumented)
                const baseline = []
                const compacted = []
                for (let index = 0; index < 9; index++) {
                  const pair = index % 2
                    ? [measure(true, instrumented), measure(false, instrumented)]
                    : [measure(false, instrumented), measure(true, instrumented)]
                  const before = pair[index % 2 ? 1 : 0]
                  const after = pair[index % 2 ? 0 : 1]
                  check(identical(before.result, after.result), 'Complete thread projection differs')
                  delete before.result; delete after.result
                  baseline.push(before); compacted.push(after)
                }
                modes[instrumented ? 'instrumented' : 'plain'] = { baseline, compacted }
              }
              check(JSON.stringify(initial) === initialSnapshot, 'Initial immutable history was mutated')
              check(identical(initial, plainInitial), 'Plain immutable history was mutated')
              check(JSON.stringify(events) === eventSnapshot, 'Streaming events were mutated')
              return { ...modes, boundaries: boundaryChecks(), frozenAt }
            }
          }
        `,
      },
      bundle: true,
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      logLevel: 'silent',
    })
    server = createServer(async (request, response) => {
      const script = request.url === '/fixture.js'
      response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html')
      response.end(
        script
          ? await readFile(join(directory, 'fixture.js'))
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><script src="/fixture.js"></script></body></html>',
      )
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 })
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.waitForFunction(() => window.fixture?.ready)
    const measured = await page.evaluate(() => window.fixture.run())
    assert.deepEqual(errors, [])
    for (const sample of measured.instrumented.baseline) {
      assert.equal(sample.historicalIdReads, 31999 * 100)
      assert.equal(sample.fullHistoryScans, 100)
      assert.equal(sample.projectedEvents, 100)
    }
    for (const sample of measured.instrumented.compacted) {
      assert.equal(sample.historicalIdReads, 31999)
      assert.equal(sample.fullHistoryScans, 1)
      assert.equal(sample.projectedEvents, 1)
    }
    for (const sample of [...measured.plain.baseline, ...measured.plain.compacted]) {
      assert.equal(sample.historicalIdReads, 0)
      assert.equal(sample.fullHistoryScans, 0)
    }
    const stats = (samples, instrumented) => {
      const sorted = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
      return {
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        ...(instrumented
          ? {
              historicalIdReads: samples[0].historicalIdReads,
              fullHistoryScans: samples[0].fullHistoryScans,
            }
          : {}),
        projectedEvents: samples[0].projectedEvents,
        samplesMs: samples.map((sample) => +sample.elapsedMs.toFixed(2)),
      }
    }
    const instrumentedBaseline = stats(measured.instrumented.baseline, true)
    const instrumentedCompacted = stats(measured.instrumented.compacted, true)
    const plainBaseline = stats(measured.plain.baseline, false)
    const plainCompacted = stats(measured.plain.compacted, false)
    const proof = {
      fixture: {
        kind: 'local browser fixture; no authenticated upstream provider use',
        historicalMessages: 32000,
        probedUnchangedMessages: 31999,
        appendTokens: 100,
        productionBundle: true,
        cpuThrottle: 2,
        frozenDateNow: measured.frozenAt,
        pairedSamples: 9,
        note: 'Instrumented timings include getter probes: 31999 unchanged message id getters and a first-message counter for each complete findIndex traversal. Plain timings use the exact same immutable history and events with ordinary data properties and no getter probes.',
      },
      instrumented: {
        baseline: instrumentedBaseline,
        compacted: instrumentedCompacted,
        reduction: {
          historyScans:
            instrumentedBaseline.fullHistoryScans / instrumentedCompacted.fullHistoryScans,
          medianTime: +(instrumentedBaseline.medianMs / instrumentedCompacted.medianMs).toFixed(2),
        },
      },
      plain: {
        baseline: plainBaseline,
        compacted: plainCompacted,
        reduction: { medianTime: +(plainBaseline.medianMs / plainCompacted.medianMs).toFixed(2) },
      },
      boundaries: measured.boundaries,
      checks: [
        'Complete baseline and compacted thread projections are identical, including undefined own fields',
        'Exact prompt, token bytes, nested details, provider session and workspace are preserved',
        'Immutable initial history and input events are unchanged',
        'Item, phase, agent, name, parent, provider and structured details preserve boundaries',
        'Replacement, reasoning, tool output, permission response, title, session and completion preserve wire order',
        'Distinct structured payloads and sessions are never joined',
        'Native batching remains bounded at 500 events and disposal retains pending content',
      ],
      errors,
    }
    await writeFile(join(output, 'current.json'), JSON.stringify(proof, null, 2) + '\n')
    console.log(
      JSON.stringify({
        fixture: 'local browser, 32000 messages / 100 tokens; no upstream authentication',
        instrumented: proof.instrumented,
        plain: proof.plain,
        checks: proof.checks.length,
        artifact: 'output/playwright/agent-event-batch-performance/current.json',
      }),
    )
  } finally {
    await browser?.close()
    if (server) await new Promise((ready) => server.close(ready))
    await rm(directory, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
