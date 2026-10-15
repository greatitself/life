#!/usr/bin/env node
// Fixture-owned native-protocol stand-in; never loads credentials or uses inference.
// A native thread has one writer until its owning app-server really exits.
const { basename, join } = require('node:path')
const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs')
const { randomUUID } = require('node:crypto')
const { createInterface } = require('node:readline')

if (basename(process.argv[1]) !== 'codex' || !process.argv.includes('app-server')) {
  // Preserve the shared fixture's discovery and optional Claude model protocols.
  if (!process.env.LIFE_TEST_FAKE_PROVIDER) throw new Error('Missing fixture-only provider source')
  require(process.env.LIFE_TEST_FAKE_PROVIDER)
} else {
  const root = join(process.env.RELAY_TEST_HOME, 'codex-writer-fixture')
  mkdirSync(root, { recursive: true })
  const owned = new Map()
  const active = new Map()
  let terminating = false
  const record = (value) =>
    appendFileSync(
      process.env.RELAY_TEST_LOG,
      JSON.stringify({ provider: 'codex', pid: process.pid, at: Date.now(), ...value }) + '\n',
    )
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
  const threadPath = (id) => join(root, `${encodeURIComponent(id)}.json`)
  const lockPath = (id) => join(root, `${encodeURIComponent(id)}.writer`)
  const readThread = (id) => JSON.parse(readFileSync(threadPath(id), 'utf8'))
  const saveThread = (thread) => writeFileSync(threadPath(thread.id), JSON.stringify(thread))
  const fail = (message, text) => send({ id: message.id, error: { code: -32005, message: text } })
  const acquire = (message, id) => {
    if (owned.has(id)) return true
    let descriptor
    try {
      descriptor = openSync(lockPath(id), 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, threadId: id }))
      owned.set(id, lockPath(id))
      record({ kind: 'writer-acquired', threadId: id })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = JSON.parse(readFileSync(lockPath(id), 'utf8'))
      record({ kind: 'writer-conflict', threadId: id, ownerPid: owner.pid })
      fail(message, `Native session ${id} still has a writer (${owner.pid}).`)
      return false
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  record({ kind: 'writer-provider-started', cwd: process.cwd() })
  // An idle app-server remains alive after detach. Only TERM releases ownership.
  const keepAlive = setInterval(() => {}, 1000)
  process.on('SIGTERM', () => {
    if (terminating) return
    terminating = true
    record({ kind: 'writer-provider-term', ownedThreadIds: [...owned.keys()] })
    setTimeout(() => {
      for (const [threadId, path] of owned) {
        const owner = JSON.parse(readFileSync(path, 'utf8'))
        if (owner.pid !== process.pid) throw new Error('Fixture writer ownership changed')
        unlinkSync(path)
        record({ kind: 'writer-released', threadId })
      }
      clearInterval(keepAlive)
      record({ kind: 'writer-provider-exited', delayedTermMs: 200 })
      process.exit(0)
    }, 200)
  })
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    record({ message })
    if (message.method === 'initialize')
      send({ id: message.id, result: { userAgent: 'exclusive-writer-fixture' } })
    else if (message.method === 'model/list')
      send({
        id: message.id,
        result: {
          data: [
            {
              id: 'writer-fixture-model',
              model: 'writer-fixture-model',
              displayName: 'Writer fixture Codex',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              defaultReasoningEffort: 'low',
            },
          ],
        },
      })
    else if (message.method === 'config/read')
      send({ id: message.id, result: { config: {}, origins: {}, layers: null } })
    else if (message.method === 'account/rateLimits/read')
      send({ id: message.id, result: { rateLimits: null } })
    else if (message.method === 'thread/start') {
      const thread = {
        id: `writer-session-${randomUUID()}`,
        cwd: message.params.cwd || process.cwd(),
        name: 'Exclusive writer ownership fixture',
        model: message.params.model || 'writer-fixture-model',
        source: 'appServer',
        turns: [],
      }
      if (!acquire(message, thread.id)) return
      saveThread(thread)
      send({ id: message.id, result: { thread } })
    } else if (message.method === 'thread/resume') {
      const id = message.params.threadId
      if (!existsSync(threadPath(id))) return fail(message, 'Native fixture session is missing')
      if (!acquire(message, id)) return
      const thread = readThread(id)
      record({ kind: 'writer-resumed', threadId: id, excludeTurns: message.params.excludeTurns })
      send({
        id: message.id,
        result: { thread: { ...thread, turns: message.params.excludeTurns ? [] : thread.turns } },
      })
    } else if (message.method === 'thread/read') {
      const id = message.params.threadId
      if (!existsSync(threadPath(id))) return fail(message, 'Native fixture session is missing')
      const thread = readThread(id)
      send({
        id: message.id,
        result: { thread: { ...thread, turns: message.params.includeTurns ? thread.turns : [] } },
      })
    } else if (message.method === 'thread/list')
      send({ id: message.id, result: { data: [], nextCursor: null } })
    else if (message.method === 'turn/start') {
      const threadId = message.params.threadId
      if (!owned.has(threadId)) return fail(message, 'This app-server does not own the writer')
      const prompt = message.params.input.find((item) => item.type === 'text').text
      const turnId = `writer-turn-${randomUUID()}`
      const itemId = `${turnId}-assistant`
      const reply = `Writer reply: ${prompt}`
      active.set(threadId, turnId)
      record({ kind: 'writer-turn-started', threadId, turnId, prompt })
      send({ id: message.id, result: { turn: { id: turnId } } })
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
      if (prompt === 'LIFE_WRITER_HANG') return
      send({ method: 'item/agentMessage/delta', params: { threadId, itemId, delta: reply } })
      setTimeout(() => {
        const thread = readThread(threadId)
        thread.turns.push({
          id: turnId,
          status: 'completed',
          items: [
            { id: `${turnId}-user`, type: 'userMessage', content: message.params.input },
            { id: itemId, type: 'agentMessage', phase: 'final_answer', text: reply },
          ],
        })
        saveThread(thread)
        active.delete(threadId)
        send({
          method: 'item/completed',
          params: {
            threadId,
            item: { id: itemId, type: 'agentMessage', phase: 'final_answer', text: reply },
          },
        })
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        })
        record({ kind: 'writer-turn-completed', threadId, turnId, prompt, reply })
      }, 30)
    } else if (message.method === 'turn/interrupt') {
      active.delete(message.params.threadId)
      send({ id: message.id, result: {} })
      send({
        method: 'turn/completed',
        params: {
          threadId: message.params.threadId,
          turn: { id: message.params.turnId, status: 'interrupted' },
        },
      })
    } else if (message.id !== undefined)
      fail(message, `Unsupported fixture request: ${message.method}`)
  })
}
