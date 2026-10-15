#!/usr/bin/env node
// Private deterministic native protocol stand-in. Never an installed CLI or inference API.
const assert = require('node:assert/strict')
const { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { createInterface } = require('node:readline')
const { performance } = require('node:perf_hooks')

const provider = basename(process.argv[1])
assert.ok(['codex', 'claude'].includes(provider), 'Use a fixture-owned provider executable')
assert.ok(process.env.RELAY_TEST_HOME && process.env.RELAY_TEST_LOG)
const root = join(process.env.RELAY_TEST_HOME, 'native-registry-performance')
const controls = join(process.env.RELAY_TEST_HOME, 'active-recovery-control')
mkdirSync(root, { recursive: true })
mkdirSync(controls, { recursive: true })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const record = (entry) =>
  appendFileSync(
    process.env.RELAY_TEST_LOG,
    JSON.stringify({ provider, pid: process.pid, at: Date.now(), ...entry }) + '\n',
  )
const argv = process.argv.slice(2)
record({ kind: 'provider-started', argv, cwd: process.cwd(), inference: false })
if (argv.includes('--version')) {
  record({ kind: 'discovery', operation: 'version' })
  console.log(provider === 'codex' ? 'codex-cli 0.162.1' : '2.1.278 (Claude Code)')
  process.exit(0)
}
if (argv.includes('--help')) {
  record({ kind: 'discovery', operation: 'help' })
  console.log(
    provider === 'codex'
      ? 'Fixture codex app-server --listen stdio'
      : 'Fixture claude --input-format stream-json',
  )
  process.exit(0)
}
assert.equal(provider, 'codex', 'This benchmark never starts a Claude run')
assert.ok(argv.includes('app-server'), 'Use the exact native Codex app-server protocol')

const sessions = new Map()
const releases = new Map()
const outputObservations = []
let initialized = false
let terminating = false
const prefix = '  Native registry response\r\n\tExact café e\u0301 漢字 🧪\r\n'
const base = prefix + 'x'.repeat(8 * 1024 * 1024 - prefix.length)
function tail(index) {
  const value = '  native-tail-' + index + '\r\n\tExact café e\u0301 漢字 🧪  \r\n'
  return value + 'z'.repeat(2048 - value.length)
}
function send(message, phase) {
  const bytes = Buffer.from(JSON.stringify(message) + '\n')
  const started = performance.now()
  return new Promise((resolve, reject) =>
    process.stdout.write(bytes, (error) => {
      if (error) return reject(error)
      if (phase) outputObservations.push({ phase, bytes, elapsedMs: performance.now() - started })
      resolve()
    }),
  )
}
function waitRelease(id, phase, action) {
  const key = id + ':' + phase
  assert.equal(releases.has(key), false)
  releases.set(key, { id, phase, action })
}
const poll = setInterval(() => {
  for (const [key, entry] of releases) {
    const path = join(controls, `release-${encodeURIComponent(entry.id)}-${entry.phase}`)
    if (!existsSync(path)) continue
    unlinkSync(path)
    releases.delete(key)
    record({ kind: 'phase-released', threadId: entry.id, phase: entry.phase })
    Promise.resolve(entry.action()).catch((error) => {
      record({ kind: 'fixture-error', error: String(error) })
      process.exit(1)
    })
  }
}, 10)
function delta(session, text, phase) {
  session.active.text += text
  return send(
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: session.id,
        turnId: session.active.id,
        itemId: session.active.itemId,
        delta: text,
      },
    },
    phase,
  )
}
function finish(session, status = 'completed') {
  const turn = session.active
  assert.ok(turn)
  // Optional hashes and observation log writes follow both measured phases.
  for (const observation of outputObservations.splice(0))
    record({
      kind: 'output-written',
      phase: observation.phase,
      bytes: observation.bytes.length,
      sha256: sha256(observation.bytes),
      providerStdoutWriteCallbackMs: observation.elapsedMs,
    })
  const assistant = {
    id: turn.itemId,
    type: 'agentMessage',
    phase: 'final_answer',
    text: turn.text,
  }
  const saved = session.turns.find((entry) => entry.id === turn.id)
  saved.items.push(assistant)
  saved.status = status
  session.status = { type: 'idle' }
  delete session.active
  // One final archive write, outside all streaming samples. No quadratic fixture-side disk work.
  writeFileSync(join(root, encodeURIComponent(session.id) + '.json'), JSON.stringify(session), {
    mode: 0o600,
  })
  // The native JSON-lines ceiling is 8,000,000 characters. The turn boundary
  // settles the already streamed item; never emit an oversized full replacement.
  send({
    method: 'turn/completed',
    params: {
      threadId: session.id,
      turn: {
        id: turn.id,
        rootTurnId: turn.id,
        items: [],
        itemsView: 'notLoaded',
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  })
  send({
    method: 'thread/status/changed',
    params: { threadId: session.id, status: { type: 'idle' } },
  })
  record({
    kind: 'turn-completed',
    threadId: session.id,
    turnId: turn.id,
    prompt: turn.prompt,
    responseCharacters: turn.text.length,
    responseSha256: sha256(Buffer.from(turn.text)),
    status,
  })
}
function closeProvider(signal) {
  if (terminating) return
  terminating = true
  clearInterval(poll)
  record({
    kind: 'provider-term',
    signal,
    activeThreadIds: [...sessions.values()].filter((s) => s.active).map((s) => s.id),
  })
  record({ kind: 'provider-exited', signal })
  process.exit(0)
}
process.on('SIGTERM', () => closeProvider('SIGTERM'))
process.on('SIGINT', () => closeProvider('SIGINT'))
process.on('exit', (code) => record({ kind: 'process-exit', code }))
process.stdin.on('end', () => record({ kind: 'stdin-ended' }))
process.stdout.on('error', (error) => {
  record({ kind: 'stdout-error', code: error.code })
  closeProvider('stdout-error')
})
const models = [
  {
    id: 'registry-fixture-model',
    model: 'registry-fixture-model',
    displayName: 'Native registry fixture',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fixture only' }],
    defaultReasoningEffort: 'low',
    inputModalities: ['text', 'image'],
  },
]
function reply(message, result) {
  send({ id: message.id, result })
}
function fail(message, error) {
  send({ id: message.id, error: { code: -32601, message: error } })
}
function input(message) {
  const p = message.params || {}
  switch (message.method) {
    case 'initialize':
      assert.equal(initialized, false, 'One native initialization per RPC process')
      initialized = true
      record({ kind: 'provider-initialized', protocol: 'codex-json-rpc' })
      reply(message, { userAgent: 'native-registry-performance-fixture' })
      break
    case 'initialized':
      break
    case 'model/list':
      reply(message, { data: models, nextCursor: null })
      break
    case 'config/read':
      reply(message, {
        config: { model: 'registry-fixture-model', model_reasoning_effort: 'low' },
        origins: {},
        layers: null,
      })
      break
    case 'config/list':
      reply(message, { data: [], nextCursor: null })
      break
    case 'account/rateLimits/read':
      reply(message, { rateLimits: null })
      break
    case 'thread/list':
      reply(message, {
        data: [...sessions.values()].map(({ active, ...session }) => ({ ...session, turns: [] })),
        nextCursor: null,
      })
      break
    case 'thread/start': {
      assert.ok(initialized)
      const session = {
        id: 'registry-codex-' + randomUUID(),
        cwd: p.cwd || process.cwd(),
        name: '',
        model: p.model || 'registry-fixture-model',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
      }
      assert.ok(
        session.cwd.startsWith(process.env.RELAY_TEST_HOME + '/'),
        'Native fixture only owns its disposable workspace',
      )
      sessions.set(session.id, session)
      record({ kind: 'thread-started', threadId: session.id, cwd: session.cwd })
      reply(message, { thread: session, model: session.model })
      break
    }
    case 'thread/read':
    case 'thread/resume': {
      const session = sessions.get(p.threadId)
      assert.ok(session, 'No replacement or invented native session')
      assert.ok(!p.cwd || p.cwd === session.cwd)
      const { active, ...view } = session
      reply(message, {
        thread: { ...view, turns: p.includeTurns === false || p.excludeTurns ? [] : view.turns },
      })
      break
    }
    case 'thread/items/list':
      reply(message, {
        data: sessions.get(p.threadId)?.turns.flatMap((turn) => turn.items) || [],
        nextCursor: null,
      })
      break
    case 'turn/start': {
      const session = sessions.get(p.threadId)
      assert.ok(session && !session.active)
      assert.ok(
        Array.isArray(p.input) && p.input.every((part) => part.type === 'text'),
        'One exact native text prompt',
      )
      const prompt = p.input.map((part) => part.text).join('')
      assert.ok(
        prompt.startsWith('LIFE_NATIVE_REGISTRY_PERFORMANCE:'),
        'Only the benchmark prompt is admitted',
      )
      const id = 'registry-turn-' + randomUUID()
      session.active = { id, itemId: id + '-assistant', prompt, text: '' }
      session.turns.push({
        id,
        status: 'inProgress',
        items: [{ id: id + '-user', type: 'userMessage', content: p.input }],
      })
      session.status = { type: 'active', activeFlags: [] }
      record({
        kind: 'turn-started',
        threadId: session.id,
        turnId: id,
        itemId: session.active.itemId,
        prompt,
        content: p.input,
        cwd: session.cwd,
      })
      reply(message, { turn: { id, status: 'inProgress' } })
      send({ method: 'turn/started', params: { threadId: session.id, turn: { id } } })
      send({
        method: 'thread/status/changed',
        params: { threadId: session.id, status: { type: 'active' } },
      })
      waitRelease(session.id, 'base', async () => {
        for (let index = 0; index < 8; index++)
          await delta(
            session,
            base.slice(index * 1024 * 1024, (index + 1) * 1024 * 1024),
            'base-' + index,
          )
      })
      waitRelease(session.id, 'tail-0', () => delta(session, tail(0), 'tail-0'))
      waitRelease(session.id, 'finish', () => finish(session))
      break
    }
    case 'thread/settings/update':
    case 'turn/settings/update':
      reply(message, { status: 'applied', threadSettings: p })
      break
    case 'thread/unsubscribe':
      reply(message, {})
      break
    case 'turn/interrupt': {
      reply(message, {})
      const session = sessions.get(p.threadId)
      if (session?.active?.id === p.turnId) finish(session, 'interrupted')
      break
    }
    default:
      record({ kind: 'unsupported-input', method: message.method })
      fail(message, 'Unsupported benchmark native request: ' + message.method)
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  record({ kind: 'input', message })
  input(message)
})
