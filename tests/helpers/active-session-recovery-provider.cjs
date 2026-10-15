#!/usr/bin/env node
// Dedicated fixture-owned native protocols. No credentials, network or inference.
// The detached broker owns this process; closing a client must not finish its turn.
const { basename, join } = require('node:path')
const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs')
const { randomUUID } = require('node:crypto')
const { createInterface } = require('node:readline')

const provider = basename(process.argv[1])
const argv = process.argv.slice(2)
if (!['codex', 'claude'].includes(provider))
  throw new Error('Invoke this fixture through its dedicated codex or claude symlink')
if (!process.env.RELAY_TEST_HOME || !process.env.RELAY_TEST_LOG)
  throw new Error('Dedicated provider requires RELAY_TEST_HOME and RELAY_TEST_LOG')

const root = join(process.env.RELAY_TEST_HOME, 'active-recovery-provider', provider)
const controlRoot = join(process.env.RELAY_TEST_HOME, 'active-recovery-control')
mkdirSync(root, { recursive: true })
mkdirSync(controlRoot, { recursive: true })

const INITIAL = 'Recovery initial 🧪\n'
const MIDDLE = 'Recovery middle Ω 🧪\n'
const FINAL = 'Recovery final café 漢字 🧪\n'
const CHILD_INITIAL = 'Recovered child '
const CHILD_MIDDLE = 'intermediate Ω '
const CHILD_FINAL = 'Recovered child café 漢字 🧪'
const MODES = new Set([
  'STREAM',
  'STOP',
  'APPROVAL',
  'CHILD',
  'SPLIT',
  'OFFLINE',
  'MULTI_A',
  'MULTI_B',
  'STUDIO_READ',
  'STUDIO_PATCH',
  'STUDIO_REPAIR',
])
const record = (value) =>
  appendFileSync(
    process.env.RELAY_TEST_LOG,
    JSON.stringify({ provider, pid: process.pid, at: Date.now(), ...value }) + '\n',
  )
const sessionPath = (id) => join(root, `${encodeURIComponent(id)}.json`)
const lockPath = (id) => join(root, `${encodeURIComponent(id)}.writer`)
const releasePath = (id, phase) => join(controlRoot, `release-${encodeURIComponent(id)}-${phase}`)
const readSession = (id) => JSON.parse(readFileSync(sessionPath(id), 'utf8'))
const saveSession = (session) => {
  const path = sessionPath(session.id)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 })
  renameSync(temporary, path)
}
const owned = new Set()
const active = new Map()
const permissions = new Map()
const replayGuards = new Map()
const answeredReplayGuards = new Map()
const stopInterrupts = new Map()
const releases = new Map()
let terminating = false
let splitRemainder
const queuedOutput = []

function send(message) {
  const bytes = Buffer.from(JSON.stringify(message) + '\n')
  if (splitRemainder) queuedOutput.push(bytes)
  else process.stdout.write(bytes)
}

function fail(message, text, code = -32005) {
  if (message.id !== undefined) send({ id: message.id, error: { code, message: text } })
  else record({ kind: 'protocol-error', text })
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function acquire(id, message) {
  if (owned.has(id)) return true
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor
    try {
      descriptor = openSync(lockPath(id), 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, provider, threadId: id }))
      owned.add(id)
      record({ kind: 'writer-acquired', threadId: id })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = JSON.parse(readFileSync(lockPath(id), 'utf8'))
      if (!processExists(owner.pid) && attempt === 0) {
        unlinkSync(lockPath(id))
        record({ kind: 'stale-writer-released', threadId: id, ownerPid: owner.pid })
        continue
      }
      record({ kind: 'writer-conflict', threadId: id, ownerPid: owner.pid })
      fail(message || {}, `Native session ${id} still has a writer (${owner.pid}).`)
      return false
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  return false
}

function waitRelease(id, phase, callback, alternativeId) {
  const key = `${id}:${phase}`
  if (releases.has(key)) throw new Error(`Duplicate fixture release waiter: ${key}`)
  releases.set(key, { id, phase, callback, alternativeId })
}

const keepAlive = setInterval(() => {
  for (const [key, waiting] of releases) {
    const path = releasePath(waiting.id, waiting.phase)
    const alternative = waiting.alternativeId && releasePath(waiting.alternativeId, waiting.phase)
    if (!existsSync(path) && !(alternative && existsSync(alternative))) continue
    releases.delete(key)
    unlinkSync(existsSync(path) ? path : alternative)
    record({ kind: 'phase-released', threadId: waiting.id, phase: waiting.phase })
    waiting.callback()
  }
}, 40)

function closeProvider(signal) {
  if (terminating) return
  terminating = true
  record({ kind: 'provider-term', signal, ownedThreadIds: [...owned] })
  clearInterval(keepAlive)
  for (const id of owned) {
    if (!existsSync(lockPath(id))) continue
    const owner = JSON.parse(readFileSync(lockPath(id), 'utf8'))
    if (owner.pid !== process.pid) throw new Error('Fixture native writer ownership changed')
    unlinkSync(lockPath(id))
    record({ kind: 'writer-released', threadId: id })
  }
  record({ kind: 'provider-exited', signal, activeThreadIds: [...active.keys()] })
  process.exit(0)
}
process.on('SIGTERM', () => closeProvider('SIGTERM'))
process.on('SIGINT', () => closeProvider('SIGINT'))
process.on('exit', (code) => record({ kind: 'process-exit', code }))
process.stdout.on('error', (error) => {
  record({ kind: 'stdout-error', code: error.code })
  closeProvider('stdout-error')
})
process.stdin.on('end', () => record({ kind: 'stdin-ended', activeThreadIds: [...active.keys()] }))

record({ kind: 'provider-started', argv, cwd: process.cwd(), inference: false })
if (argv.includes('--version')) {
  record({ kind: 'discovery', operation: 'version' })
  console.log(provider === 'codex' ? 'codex-cli 0.162.1' : '2.1.278 (Claude Code)')
  clearInterval(keepAlive)
  process.exit(0)
}
if (argv.includes('--help')) {
  record({ kind: 'discovery', operation: 'help' })
  console.log(
    provider === 'codex'
      ? 'Fixture codex app-server --listen stdio'
      : 'Fixture claude --input-format stream-json --output-format stream-json --resume',
  )
  clearInterval(keepAlive)
  process.exit(0)
}
if (provider === 'codex' && !argv.includes('app-server'))
  throw new Error('The recovery fixture accepts only the native Codex app-server protocol')
if (provider === 'claude' && !argv.includes('stream-json'))
  throw new Error('The recovery fixture accepts only the native Claude stream-json protocol')

const codexModels = [
  {
    id: 'recovery-fixture-model',
    model: 'recovery-fixture-model',
    displayName: 'Recovery fixture Codex',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fixture only' }],
    defaultReasoningEffort: 'low',
    inputModalities: ['text', 'image'],
  },
]
const claudeModels = [
  {
    value: 'default',
    displayName: 'Recovery fixture Claude',
    description: 'No inference',
    supportsEffort: true,
    supportedEffortLevels: ['low'],
    supportsFastMode: false,
  },
]

function modeFromPrompt(prompt) {
  const match = /^LIFE_RECOVERY_([A-Z_]+):/.exec(prompt)
  return match && MODES.has(match[1]) ? match[1] : undefined
}

function textInput(input) {
  if (!Array.isArray(input)) throw new Error('Expected original native content array')
  return input
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('')
}

function sendReplayGuard(turn, guard, wireId, request, expectedResponses = 1) {
  if (replayGuards.has(wireId) || answeredReplayGuards.has(wireId))
    throw new Error('Fixture replay guard wire ID has already been allocated')
  replayGuards.set(wireId, { turn, guard, request, expectedResponses })
  record({
    kind: 'guard-request',
    guard,
    threadId: turn.threadId,
    turnId: turn.turnId,
    wireId,
    expectedResponses,
    request,
  })
  send(request)
}

function receiveReplayGuard(wireId, message) {
  const pending = replayGuards.get(wireId)
  const previous = answeredReplayGuards.get(wireId)
  if (!pending && !previous) return false
  const source = pending || previous
  const evidence = {
    guard: source.guard,
    threadId: source.turn.threadId,
    turnId: source.turn.turnId,
    wireId,
    originalRequest: source.request,
    expectedResponses: source.expectedResponses,
    message,
  }
  if (previous) {
    record({ kind: 'unexpected-response', ...evidence, reason: 'duplicate-replay-guard-response' })
    return true
  }
  replayGuards.delete(wireId)
  answeredReplayGuards.set(wireId, pending)
  record({ kind: 'guard-response', ...evidence, response: message })
  if (pending.expectedResponses === 0)
    record({ kind: 'unexpected-response', ...evidence, reason: 'undeclared-dialog-was-answered' })
  return true
}

function replayGuardRequests(turn) {
  if (turn.mode !== 'STREAM' || !turn.prompt.includes('replay-guards')) return
  const wireId = (guard) => `recovery-guard:${turn.turnId}:${guard}:α`
  if (provider === 'codex') {
    sendReplayGuard(turn, 'clock', wireId('clock'), {
      id: wireId('clock'),
      method: 'currentTime/read',
      params: { threadId: turn.threadId, fixtureFutureField: { preserved: '漢字' } },
    })
    sendReplayGuard(turn, 'unsupported', wireId('unsupported'), {
      id: wireId('unsupported'),
      method: 'lifeFixture/unsupportedNativeRequest',
      params: { threadId: turn.threadId, turnId: turn.turnId, opaque: ['café', null, 17] },
    })
    sendReplayGuard(turn, 'malformed-elicitation', wireId('malformed-elicitation'), {
      id: wireId('malformed-elicitation'),
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        mode: 'form',
        serverName: 'recovery-fixture',
        message: 'Unsupported nested native schema must be declined once',
        requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
      },
    })
    return
  }
  sendReplayGuard(turn, 'unsupported', wireId('unsupported'), {
    type: 'control_request',
    request_id: wireId('unsupported'),
    session_id: turn.threadId,
    request: { subtype: 'life_fixture_unsupported_native_request', opaque: ['café', null, 17] },
  })
  sendReplayGuard(turn, 'malformed-elicitation', wireId('malformed-elicitation'), {
    type: 'control_request',
    request_id: wireId('malformed-elicitation'),
    session_id: turn.threadId,
    request: {
      subtype: 'elicitation',
      mode: 'form',
      mcp_server_name: 'recovery-fixture',
      message: 'Unsupported nested native schema must be declined once',
      requested_schema: { type: 'object', properties: { nested: { type: 'object' } } },
    },
  })
  sendReplayGuard(
    turn,
    'undeclared-dialog',
    wireId('undeclared-dialog'),
    {
      type: 'control_request',
      request_id: wireId('undeclared-dialog'),
      session_id: turn.threadId,
      request: {
        subtype: 'request_user_dialog',
        dialog_kind: 'future-native-dialog',
        payload: { opaque: 'Preserve this unanswered native dialog café 🧪', number: 17 },
      },
    },
    0,
  )
}

function readStudioContext(session, prompt) {
  const manifest = JSON.parse(readFileSync(join(session.cwd, '.studio-context.json'), 'utf8'))
  const instructions = readFileSync(join(session.cwd, 'AGENTS.md'), 'utf8')
  if (
    instructions !== readFileSync(join(session.cwd, 'CLAUDE.md'), 'utf8') ||
    !instructions.startsWith('# Life Customization Studio') ||
    !['request', 'source-read', 'repair'].includes(manifest.phase)
  )
    throw new Error('The native Studio context does not match its actual staging contract')
  const contextFiles = manifest.files.map((path) => ({
    path,
    content: readFileSync(join(session.cwd, path), 'utf8'),
  }))
  const readJson = (path) =>
    JSON.parse(contextFiles.find((file) => file.path === path)?.content || 'null')
  const context = {
    kind: 'studio-context',
    prompt,
    cwd: session.cwd,
    phase: manifest.phase,
    manifest,
    instructions,
    contextFiles,
    source: readJson('.life/source-context.json'),
    diagnostics: readJson('.life/diagnostics.json'),
  }
  record(context)
  return context
}

function completionText(turn) {
  if (!turn.mode?.startsWith('STUDIO_')) return INITIAL + (turn.middleEmitted ? MIDDLE : '') + FINAL
  const context = turn.studio
  if (context.phase === 'request')
    return '<life-source-read>{"paths":["src/renderer/App.tsx"]}</life-source-read>'
  const app = context.source?.files.find((file) => file.path === 'src/renderer/App.tsx')
  if (!app || !Number.isSafeInteger(context.source.revision))
    throw new Error('The native Studio continuation omitted the complete requested source')
  if (turn.mode === 'STUDIO_READ') {
    if (context.phase !== 'source-read' || !context.diagnostics?.sourceRead)
      throw new Error('The native Studio read continuation omitted source-read diagnostics')
    return '<life-customization>{"theme":"light"}</life-customization>'
  }
  const repairing = context.phase === 'repair'
  if (repairing) {
    const repair = context.diagnostics?.repair
    if (
      turn.mode !== 'STUDIO_REPAIR' ||
      repair?.attempt !== 1 ||
      typeof repair.diagnostics !== 'string' ||
      !repair.diagnostics.includes('Life source build failed') ||
      !repair.diagnostics.includes('App.tsx') ||
      !/closing\s+["']broken-tag["']/i.test(repair.diagnostics)
    )
      throw new Error('The native Studio repair omitted its first actual App.tsx compiler failure')
  }
  if (!repairing && !context.diagnostics?.sourceRead)
    throw new Error('The native Studio source proposal was not preceded by its requested read')
  const anchor = '<main className="main-workspace" id="main-content">'
  if (app.content.split(anchor).length !== 2)
    throw new Error('The native Studio source has no unique workspace insertion point')
  const broken = turn.mode === 'STUDIO_REPAIR' && !repairing
  const label = repairing ? 'Recovery source repaired' : 'Recovery source verified'
  const element = broken
    ? '<div data-testid="life-active-recovery-source">Recovery invalid source</broken-tag>'
    : `<div data-testid="life-active-recovery-source">${label}</div>`
  return `<life-source>${JSON.stringify({
    summary: broken
      ? 'Exercise a compiler failure after restoring native Studio ownership'
      : repairing
        ? 'Repair native Studio source from actual compiler diagnostics'
        : 'Verify a source proposal after restoring native Studio ownership',
    baseRevision: context.source.revision,
    files: [
      {
        path: 'src/renderer/App.tsx',
        edits: [{ find: anchor, replace: `${anchor}\n                ${element}` }],
      },
    ],
  })}</life-source>`
}

function beginTurn(threadId, prompt, content) {
  if (active.has(threadId)) throw new Error(`Fixture turn is already active: ${threadId}`)
  const mode = modeFromPrompt(prompt)
  const turnId = `recovery-turn-${randomUUID()}`
  const turn = {
    threadId,
    turnId,
    itemId: `${turnId}-assistant`,
    userItemId: `${turnId}-user`,
    prompt,
    mode,
    content,
    text: '',
    permissionAnswered: false,
  }
  const session = readSession(threadId)
  if (mode?.startsWith('STUDIO_')) turn.studio = readStudioContext(session, prompt)
  session.status = { type: 'active', activeFlags: [] }
  session.activeTurnId = turnId
  session.turns.push({
    id: turnId,
    status: 'inProgress',
    items: [{ id: turn.userItemId, type: 'userMessage', content }],
    fixturePrompt: prompt,
    fixtureMode: mode,
  })
  saveSession(session)
  active.set(threadId, turn)
  record({
    kind: 'turn-started',
    threadId,
    turnId,
    itemId: turn.itemId,
    prompt,
    content,
    mode,
    cwd: session.cwd,
    ...(turn.studio ? { phase: turn.studio.phase } : {}),
  })
  return turn
}

function rememberText(turn, text) {
  turn.text = text
  const session = readSession(turn.threadId)
  const saved = session.turns.find((item) => item.id === turn.turnId)
  const index = saved.items.findIndex((item) => item.id === turn.itemId)
  const item = { id: turn.itemId, type: 'agentMessage', phase: 'final_answer', text }
  if (index < 0) saved.items.push(item)
  else saved.items[index] = item
  saveSession(session)
}

function finishStoredTurn(turn, status = 'completed') {
  if (active.get(turn.threadId) !== turn) return false
  active.delete(turn.threadId)
  for (const [key, waiting] of releases)
    if (waiting.id === turn.threadId) {
      releases.delete(key)
      const paths = [
        releasePath(waiting.id, waiting.phase),
        ...(waiting.alternativeId ? [releasePath(waiting.alternativeId, waiting.phase)] : []),
      ]
      for (const path of paths) if (existsSync(path)) unlinkSync(path)
    }
  const session = readSession(turn.threadId)
  const saved = session.turns.find((item) => item.id === turn.turnId)
  saved.status = status
  session.status = { type: 'idle' }
  delete session.activeTurnId
  delete session.pendingPermission
  saveSession(session)
  record({
    kind: 'turn-completed',
    threadId: turn.threadId,
    turnId: turn.turnId,
    prompt: turn.prompt,
    mode: turn.mode,
    reply: turn.text,
    status,
  })
  return true
}

function interruptKey(threadId, turnId) {
  return `${threadId}:${turnId}`
}

function stopInterrupt(turn, message, complete) {
  const key = interruptKey(turn.threadId, turn.turnId)
  const previous = stopInterrupts.get(key)
  if (previous) {
    record({
      kind: 'interrupt-duplicate',
      threadId: turn.threadId,
      turnId: turn.turnId,
      message,
      originalMessage: previous.message,
      state: previous.state,
    })
    return
  }
  if (active.get(turn.threadId) !== turn) throw new Error('STOP fixture turn is no longer active')
  const operation = { turn, message, state: 'pending' }
  stopInterrupts.set(key, operation)
  turn.interruptPending = true
  record({ kind: 'interrupt-accepted', threadId: turn.threadId, turnId: turn.turnId, message })
  waitRelease(turn.threadId, 'interrupt-finish', () => {
    if (active.get(turn.threadId) !== turn || operation.state !== 'pending')
      throw new Error('The accepted STOP fixture interrupt lost its original active turn')
    complete()
    operation.state = 'completed'
    record({ kind: 'interrupt-completed', threadId: turn.threadId, turnId: turn.turnId, message })
  })
}

function splitDelta(turn, message, callback) {
  if (splitRemainder) throw new Error('A fixture split frame is already outstanding')
  const bytes = Buffer.from(JSON.stringify(message) + '\n')
  const emoji = bytes.indexOf(Buffer.from('🧪'))
  if (emoji < 0) throw new Error('The split frame must contain the fixture UTF-8 character')
  const cut = emoji + 2
  splitRemainder = bytes.subarray(cut)
  process.stdout.write(bytes.subarray(0, cut))
  record({
    kind: 'split-prefix',
    threadId: turn.threadId,
    turnId: turn.turnId,
    prefixBytes: cut,
    completeFrameBytes: bytes.length,
    utf8BytesWritten: 2,
    newlineWritten: false,
  })
  waitRelease(turn.threadId, 'split', () => {
    process.stdout.write(splitRemainder)
    splitRemainder = undefined
    for (const bytes of queuedOutput.splice(0)) process.stdout.write(bytes)
    record({ kind: 'split-completed', threadId: turn.threadId, turnId: turn.turnId })
    callback()
  })
}

function codexDelta(turn, delta) {
  rememberText(turn, turn.text + delta)
  send({
    method: 'item/agentMessage/delta',
    params: { threadId: turn.threadId, turnId: turn.turnId, itemId: turn.itemId, delta },
  })
}

function waitMiddle(turn, parentToolUseId = null, child = false) {
  const phase = child ? 'child-middle' : 'middle'
  waitRelease(
    turn.threadId,
    phase,
    () => {
      if (active.get(turn.threadId) !== turn || turn.interruptPending) return
      const delta = child
        ? CHILD_MIDDLE
        : turn.studio
          ? completionText(turn).slice(turn.text.length, turn.text.length + 12)
          : MIDDLE
      if (!delta) throw new Error('Fixture middle phase must append a nonempty native segment')
      if (provider === 'codex') codexDelta(turn, delta)
      else claudeDelta(turn, delta, parentToolUseId)
      turn.middleEmitted = true
      record({
        kind: 'middle-emitted',
        phase,
        threadId: turn.threadId,
        turnId: turn.turnId,
        itemId: turn.itemId,
        delta,
        text: turn.text,
      })
    },
    child ? readSession(turn.threadId).parentThreadId : undefined,
  )
}

function childCompletionText(turn) {
  return turn.middleEmitted ? CHILD_INITIAL + CHILD_MIDDLE + 'café 漢字 🧪' : CHILD_FINAL
}

function codexComplete(turn, text = completionText(turn), status = 'completed') {
  if (active.get(turn.threadId) !== turn) return
  if (turn.interruptPending && status !== 'interrupted') return
  if (status === 'completed' && text.startsWith(turn.text))
    codexDelta(turn, text.slice(turn.text.length))
  else rememberText(turn, text)
  if (!finishStoredTurn(turn, status)) return
  send({
    method: 'item/completed',
    params: {
      threadId: turn.threadId,
      turnId: turn.turnId,
      item: { id: turn.itemId, type: 'agentMessage', phase: 'final_answer', text: turn.text },
    },
  })
  send({
    method: 'turn/completed',
    params: { threadId: turn.threadId, turn: { id: turn.turnId, status } },
  })
  send({
    method: 'thread/status/changed',
    params: { threadId: turn.threadId, status: { type: 'idle' } },
  })
}

function codexChild(turn) {
  const childId = `recovery-child-${randomUUID()}`
  const parent = readSession(turn.threadId)
  const child = {
    id: childId,
    parentThreadId: turn.threadId,
    cwd: parent.cwd,
    name: 'Recovery child',
    agentNickname: 'Recovery child',
    model: parent.model,
    source: 'subAgent',
    status: { type: 'active', activeFlags: [] },
    turns: [],
  }
  if (!acquire(childId)) throw new Error('Fixture could not acquire its child writer')
  saveSession(child)
  const childTurn = beginTurn(childId, `LIFE_RECOVERY_CHILD:${turn.prompt}`, [
    { type: 'text', text: 'Child recovery fixture' },
  ])
  send({
    method: 'item/started',
    params: {
      threadId: turn.threadId,
      turnId: turn.turnId,
      item: {
        id: `${turn.turnId}-spawn`,
        type: 'collabAgentToolCall',
        tool: 'spawn_agent',
        prompt: 'Child recovery fixture',
        receiverThreadIds: [childId],
        agentPath: 'Recovery child',
        status: 'running',
      },
    },
  })
  send({ method: 'thread/started', params: { thread: child } })
  send({ method: 'turn/started', params: { threadId: childId, turn: { id: childTurn.turnId } } })
  codexDelta(childTurn, CHILD_INITIAL)
  waitMiddle(childTurn, null, true)
  record({ kind: 'child-started', threadId: turn.threadId, childId, childTurnId: childTurn.turnId })
  // Root completion must not release the transport while the child still owns work.
  codexComplete(turn)
  waitRelease(
    childId,
    'child-finish',
    () => {
      const text = childCompletionText(childTurn)
      codexComplete(childTurn, text)
      record({ kind: 'child-completed', threadId: turn.threadId, childId, reply: text })
    },
    turn.threadId,
  )
}

function codexPermission(turn) {
  // Alternate native number/string IDs across processes without stringifying either.
  const wireId = turn.prompt.includes('string-id') ? 'recovery-native-permission:α' : 870031
  if (permissions.has(wireId)) throw new Error('Fixture permission wire ID is already pending')
  const request = {
    id: wireId,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: turn.threadId,
      turnId: turn.turnId,
      itemId: `${turn.turnId}-command`,
      approvalId: `${turn.turnId}-approval`,
      command: "printf '%s' 'recovery café 🧪'",
      reason: 'Fixture native permission must survive a client restart',
      cwd: readSession(turn.threadId).cwd,
      availableDecisions: ['accept', 'decline'],
      fixtureFutureField: { preserved: true, values: [null, '漢字'] },
    },
  }
  permissions.set(wireId, { turn, request })
  const session = readSession(turn.threadId)
  session.pendingPermission = request
  session.status = { type: 'active', activeFlags: ['waitingOnApproval'] }
  saveSession(session)
  send(request)
  record({ kind: 'permission-requested', threadId: turn.threadId, turnId: turn.turnId, request })
}

function codexTurn(message) {
  const threadId = message.params?.threadId
  if (!owned.has(threadId)) return fail(message, 'This app-server does not own the native writer')
  if (active.has(threadId)) return fail(message, 'Native fixture turn is already active')
  const prompt = textInput(message.params.input)
  const turn = beginTurn(threadId, prompt, message.params.input)
  send({ id: message.id, result: { turn: { id: turn.turnId, status: 'inProgress' } } })
  send({ method: 'turn/started', params: { threadId, turn: { id: turn.turnId } } })
  send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } })
  replayGuardRequests(turn)
  if (!turn.mode) {
    codexComplete(turn, 'Recovery fixture received an unsupported test prompt.')
    return
  }
  if (turn.mode === 'SPLIT') {
    rememberText(turn, INITIAL)
    splitDelta(
      turn,
      {
        method: 'item/agentMessage/delta',
        params: { threadId, turnId: turn.turnId, itemId: turn.itemId, delta: INITIAL },
      },
      () => {
        waitMiddle(turn)
        waitRelease(threadId, 'finish', () => codexComplete(turn))
      },
    )
    return
  }
  codexDelta(turn, turn.studio ? completionText(turn).slice(0, 6) : INITIAL)
  waitMiddle(turn)
  if (turn.mode === 'APPROVAL') codexPermission(turn)
  else if (turn.mode === 'CHILD') codexChild(turn)
  else waitRelease(threadId, 'finish', () => codexComplete(turn))
}

function codexInput(message) {
  if (message.method === undefined && message.id !== undefined) {
    if (receiveReplayGuard(message.id, message)) return
    const pending = permissions.get(message.id)
    if (!pending) {
      record({ kind: 'unexpected-response', message })
      return
    }
    permissions.delete(message.id)
    pending.turn.permissionAnswered = true
    const session = readSession(pending.turn.threadId)
    delete session.pendingPermission
    session.status = { type: 'active', activeFlags: [] }
    saveSession(session)
    record({
      kind: 'permission-response',
      threadId: pending.turn.threadId,
      turnId: pending.turn.turnId,
      wireId: message.id,
      message,
      originalRequest: pending.request,
    })
    send({
      method: 'serverRequest/resolved',
      params: { threadId: pending.turn.threadId, requestId: message.id },
    })
    waitRelease(pending.turn.threadId, 'finish', () => codexComplete(pending.turn))
    return
  }
  const params = message.params || {}
  switch (message.method) {
    case 'initialize':
      record({ kind: 'provider-initialized', protocol: 'codex-json-rpc' })
      send({ id: message.id, result: { userAgent: 'active-recovery-fixture' } })
      break
    case 'initialized':
      break
    case 'model/list':
      send({ id: message.id, result: { data: codexModels, nextCursor: null } })
      break
    case 'config/read':
      send({
        id: message.id,
        result: {
          config: { model: 'recovery-fixture-model', model_reasoning_effort: 'low' },
          origins: {},
          layers: null,
        },
      })
      break
    case 'config/list':
      send({ id: message.id, result: { data: [], nextCursor: null } })
      break
    case 'account/rateLimits/read':
      send({ id: message.id, result: { rateLimits: null } })
      break
    case 'thread/start': {
      const session = {
        id: `recovery-codex-${randomUUID()}`,
        cwd: params.cwd || process.cwd(),
        name: '',
        model: params.model || 'recovery-fixture-model',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
      }
      if (!acquire(session.id, message)) break
      saveSession(session)
      record({ kind: 'thread-started', threadId: session.id, cwd: session.cwd })
      send({ id: message.id, result: { thread: session, model: session.model } })
      break
    }
    case 'thread/resume':
    case 'thread/read': {
      if (!existsSync(sessionPath(params.threadId))) {
        fail(message, 'The native recovery fixture session is missing')
        break
      }
      const session = readSession(params.threadId)
      if (params.cwd && params.cwd !== session.cwd) {
        fail(message, 'The native recovery fixture workspace changed')
        break
      }
      if (message.method === 'thread/resume' && !acquire(params.threadId, message)) break
      const includeTurns =
        message.method === 'thread/read' ? params.includeTurns === true : !params.excludeTurns
      record({ kind: message.method, threadId: session.id, includeTurns })
      send({
        id: message.id,
        result: { thread: { ...session, turns: includeTurns ? session.turns : [] } },
      })
      break
    }
    case 'thread/list': {
      const sessions = readdirSync(root)
        .filter((path) => path.endsWith('.json'))
        .map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')))
        .filter((session) => !params.archived && !session.parentThreadId)
      send({ id: message.id, result: { data: sessions, nextCursor: null } })
      break
    }
    case 'thread/items/list': {
      if (!existsSync(sessionPath(params.threadId))) {
        fail(message, 'The native recovery fixture session is missing')
        break
      }
      const items = readSession(params.threadId).turns.flatMap((turn) => turn.items)
      send({ id: message.id, result: { data: items, nextCursor: null } })
      break
    }
    case 'turn/start':
      codexTurn(message)
      break
    case 'turn/interrupt': {
      const turn = active.get(params.threadId)
      const previous = stopInterrupts.get(interruptKey(params.threadId, params.turnId))
      if (previous || (turn?.mode === 'STOP' && turn.turnId === params.turnId)) {
        const original = previous?.turn || turn
        stopInterrupt(original, message, () => {
          send({ id: message.id, result: {} })
          codexComplete(original, original.text, 'interrupted')
        })
        break
      }
      send({ id: message.id, result: {} })
      if (turn && turn.turnId === params.turnId) codexComplete(turn, turn.text, 'interrupted')
      break
    }
    case 'thread/settings/update':
    case 'turn/settings/update':
      send({ id: message.id, result: { status: 'applied', threadSettings: params } })
      break
    case 'thread/unsubscribe':
      send({ id: message.id, result: {} })
      break
    default:
      fail(message, `Unsupported recovery fixture request: ${message.method}`, -32601)
  }
}

const resumeIndex = argv.indexOf('--resume')
const resumedId =
  argv.find((argument) => argument.startsWith('--resume='))?.slice('--resume='.length) ||
  (resumeIndex >= 0 ? argv[resumeIndex + 1] : undefined)
let claudeSessionId = resumedId || `recovery-claude-${randomUUID()}`
let claudeActive
let claudeLastTurn
let claudeInitialized = false
let claudeNative = false
const claudeSettings = { model: 'default', effortLevel: 'low', fastMode: false }

function claudeState(state) {
  send({ type: 'system', subtype: 'session_state_changed', session_id: claudeSessionId, state })
}

function claudeStream(turn, event, parentToolUseId = null) {
  return {
    type: 'stream_event',
    session_id: claudeSessionId,
    parent_tool_use_id: parentToolUseId,
    event,
  }
}

function claudeDelta(turn, delta, parentToolUseId = null) {
  rememberText(turn, turn.text + delta)
  send(
    claudeStream(
      turn,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } },
      parentToolUseId,
    ),
  )
}

function claudeComplete(turn, text = completionText(turn), parentToolUseId = null) {
  if (active.get(turn.threadId) !== turn) return
  if (turn.interruptPending) return
  if (text.startsWith(turn.text)) claudeDelta(turn, text.slice(turn.text.length), parentToolUseId)
  else rememberText(turn, text)
  if (!finishStoredTurn(turn)) return
  send({
    type: 'assistant',
    uuid: `${turn.itemId}-envelope`,
    session_id: claudeSessionId,
    parent_tool_use_id: parentToolUseId,
    message: { id: turn.itemId, role: 'assistant', content: [{ type: 'text', text: turn.text }] },
  })
  send({
    type: 'result',
    session_id: claudeSessionId,
    parent_tool_use_id: parentToolUseId,
    subtype: 'success',
    is_error: false,
    result: turn.text,
  })
  if (!parentToolUseId) {
    claudeActive = undefined
    claudeState('idle')
  }
}

function claudePermission(turn) {
  const requestId = `recovery-permission-${turn.turnId}`
  const request = {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: `${turn.turnId}-tool`,
      input: {
        command: "printf '%s' 'recovery café 🧪'",
        description: 'Recovery fixture permission',
        fixtureFutureField: { preserved: true, values: [null, '漢字'], number: 17 },
      },
      fixtureFutureField: { preserveRequest: true },
    },
  }
  permissions.set(requestId, { turn, request })
  const session = readSession(turn.threadId)
  session.pendingPermission = request
  session.status = { type: 'active', activeFlags: ['waitingOnApproval'] }
  saveSession(session)
  claudeState('requires_action')
  send(request)
  record({ kind: 'permission-requested', threadId: turn.threadId, turnId: turn.turnId, request })
}

function claudeChild(turn) {
  const childId = `recovery-child-${randomUUID()}`
  const toolId = `${turn.turnId}-child-tool`
  saveSession({
    id: childId,
    parentThreadId: turn.threadId,
    cwd: process.cwd(),
    name: 'Recovery child',
    turns: [],
    status: { type: 'active', activeFlags: [] },
  })
  const childTurn = beginTurn(childId, `LIFE_RECOVERY_CHILD:${turn.prompt}`, [
    { type: 'text', text: 'Child recovery fixture' },
  ])
  send({
    type: 'assistant',
    uuid: `${turn.turnId}-spawn-envelope`,
    session_id: claudeSessionId,
    parent_tool_use_id: null,
    message: {
      id: `${turn.turnId}-spawn`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Agent',
          input: { description: 'Recovery child', prompt: 'Child recovery fixture' },
        },
      ],
    },
  })
  send({
    type: 'system',
    subtype: 'task_started',
    session_id: claudeSessionId,
    task_id: childId,
    tool_use_id: toolId,
    description: 'Recovery child',
    status: 'running',
    run_id: 'recovery-child-run-1',
  })
  send(
    claudeStream(
      childTurn,
      { type: 'message_start', message: { id: childTurn.itemId, role: 'assistant', content: [] } },
      toolId,
    ),
  )
  send(
    claudeStream(
      childTurn,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      toolId,
    ),
  )
  claudeDelta(childTurn, CHILD_INITIAL, toolId)
  waitMiddle(childTurn, toolId, true)
  record({ kind: 'child-started', threadId: turn.threadId, childId, childTurnId: childTurn.turnId })
  claudeComplete(turn)
  waitRelease(
    childId,
    'child-finish',
    () => {
      const text = childCompletionText(childTurn)
      claudeComplete(childTurn, text, toolId)
      send({
        type: 'system',
        subtype: 'task_notification',
        session_id: claudeSessionId,
        task_id: childId,
        tool_use_id: toolId,
        description: 'Recovery child',
        status: 'completed',
        summary: text,
        run_id: 'recovery-child-run-1',
      })
      record({ kind: 'child-completed', threadId: turn.threadId, childId, reply: text })
    },
    turn.threadId,
  )
}

function claudeTurn(message) {
  if (!claudeInitialized || !claudeNative)
    throw new Error('Claude native initialization is missing')
  if (claudeActive) throw new Error('Claude native fixture turn is already active')
  if (!acquire(claudeSessionId)) return
  const content = message.message?.content
  const prompt = textInput(content)
  if (message.session_id && message.session_id !== claudeSessionId)
    throw new Error('Claude native user envelope changed its session identity')
  const turn = beginTurn(claudeSessionId, prompt, content)
  claudeActive = turn
  claudeLastTurn = turn
  record({ kind: 'native-user-envelope', threadId: claudeSessionId, message })
  claudeState('running')
  send(
    claudeStream(turn, {
      type: 'message_start',
      message: { id: turn.itemId, role: 'assistant', content: [] },
    }),
  )
  send(
    claudeStream(turn, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  )
  replayGuardRequests(turn)
  if (!turn.mode) {
    claudeComplete(turn, 'Recovery fixture received an unsupported test prompt.')
    return
  }
  if (turn.mode === 'SPLIT') {
    rememberText(turn, INITIAL)
    splitDelta(
      turn,
      claudeStream(turn, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: INITIAL },
      }),
      () => {
        waitMiddle(turn)
        waitRelease(turn.threadId, 'finish', () => claudeComplete(turn))
      },
    )
    return
  }
  claudeDelta(turn, turn.studio ? completionText(turn).slice(0, 6) : INITIAL)
  waitMiddle(turn)
  if (turn.mode === 'APPROVAL') claudePermission(turn)
  else if (turn.mode === 'CHILD') claudeChild(turn)
  else waitRelease(turn.threadId, 'finish', () => claudeComplete(turn))
}

function claudeInitialize(message) {
  claudeInitialized = true
  claudeNative ||= message.request?.forwardSubagentText === true
  if (resumedId && !existsSync(sessionPath(claudeSessionId))) {
    send({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: 'The native recovery fixture session is missing',
      },
    })
    return
  }
  if (!existsSync(sessionPath(claudeSessionId))) {
    saveSession({
      id: claudeSessionId,
      cwd: process.cwd(),
      name: '',
      model: 'default',
      status: { type: 'idle' },
      turns: [],
    })
    record({ kind: 'session-created', threadId: claudeSessionId, cwd: process.cwd() })
  }
  const session = readSession(claudeSessionId)
  if (session.cwd !== process.cwd()) {
    send({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: 'The native recovery fixture workspace changed',
      },
    })
    return
  }
  if (claudeNative && !acquire(claudeSessionId)) {
    send({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: 'The native recovery fixture session still has another writer',
      },
    })
    return
  }
  const state = session.pendingPermission
    ? 'requires_action'
    : session.activeTurnId
      ? 'running'
      : 'idle'
  record({
    kind: 'provider-initialized',
    protocol: 'claude-stream-json',
    discovery: !claudeNative,
    threadId: claudeSessionId,
    state,
    resumed: Boolean(resumedId),
  })
  send({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      pending_permission_requests: session.pendingPermission ? [session.pendingPermission] : [],
      pending_user_dialog_requests: [],
      response: {
        models: claudeModels,
        session_id: claudeSessionId,
        session_state: state,
        claude_code_version: '2.1.278',
        current_permission_mode: 'default',
        fast_mode_state: 'off',
      },
    },
  })
  if (claudeNative)
    send({ type: 'system', subtype: 'init', session_id: claudeSessionId, model: 'default' })
}

function claudeInput(message) {
  if (message.type === 'control_request') {
    const subtype = message.request?.subtype
    if (subtype === 'initialize') claudeInitialize(message)
    else if (
      ['set_model', 'set_permission_mode', 'apply_flag_settings', 'get_settings'].includes(subtype)
    ) {
      if (subtype === 'set_model') claudeSettings.model = message.request.model
      if (subtype === 'set_permission_mode') claudeSettings.permissionMode = message.request.mode
      if (subtype === 'apply_flag_settings') Object.assign(claudeSettings, message.request.settings)
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { ...claudeSettings },
        },
      })
    } else if (subtype === 'interrupt') {
      const original =
        claudeActive?.mode === 'STOP'
          ? claudeActive
          : claudeLastTurn?.mode === 'STOP' &&
              stopInterrupts.has(interruptKey(claudeLastTurn.threadId, claudeLastTurn.turnId))
            ? claudeLastTurn
            : undefined
      if (original) {
        stopInterrupt(original, message, () => {
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: message.request_id, response: {} },
          })
          finishStoredTurn(original, 'interrupted')
          claudeActive = undefined
          claudeState('idle')
        })
        return
      }
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      })
      if (claudeActive) {
        finishStoredTurn(claudeActive, 'interrupted')
        claudeActive = undefined
        claudeState('idle')
      }
    } else
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: `Unsupported recovery fixture control: ${subtype}`,
        },
      })
    return
  }
  if (message.type === 'control_response') {
    const id = message.response?.request_id
    if (receiveReplayGuard(id, message)) return
    const pending = permissions.get(id)
    if (!pending) {
      record({ kind: 'unexpected-response', message })
      return
    }
    permissions.delete(id)
    pending.turn.permissionAnswered = true
    const session = readSession(pending.turn.threadId)
    delete session.pendingPermission
    session.status = { type: 'active', activeFlags: [] }
    saveSession(session)
    record({
      kind: 'permission-response',
      threadId: pending.turn.threadId,
      turnId: pending.turn.turnId,
      wireId: id,
      message,
      originalRequest: pending.request,
    })
    claudeState('running')
    waitRelease(pending.turn.threadId, 'finish', () => claudeComplete(pending.turn))
    return
  }
  if (message.type === 'user') claudeTurn(message)
  else record({ kind: 'unsupported-input', message })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    record({ kind: 'malformed-input', line })
    return
  }
  record({ kind: 'input', message })
  if (provider === 'codex') codexInput(message)
  else claudeInput(message)
})
