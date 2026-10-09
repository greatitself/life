import { gzipSync } from 'node:zlib'
import { REMOTE_AGENT_BROKER_PYTHON_SOURCE } from './remote-agent-broker-python'

export interface RemoteAgentBrokerConfig {
  id: string
  command: string
  /** The private session directory. Defaults to ~/.life/agent-sessions/<id>. */
  root?: string
  cursor?: number
  /** Reattachments must use false so a lost session cannot replay a prompt. */
  launch?: boolean
}

/**
 * A dependency-free program sent to the remote host. Only the small attachment
 * process belongs to the SSH channel; the daemon owns the provider and journals
 * its output until it exits. Reattaching never starts an existing session again.
 */
export const REMOTE_AGENT_BROKER_SOURCE = String.raw`
;(async function () {
  'use strict'
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const net = require('net')
  const crypto = require('crypto')
  const readline = require('readline')
  const childProcess = require('child_process')
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const MAX_INPUT = 24 * 1024 * 1024
  const MAX_CLIENT_BUFFER = 32 * 1024 * 1024
  let cfg
  try {
    cfg = JSON.parse(Buffer.from(process.argv[1] || '', 'base64').toString('utf8'))
    if (!cfg || !/^[a-zA-Z0-9_-]{1,80}$/.test(cfg.id) || typeof cfg.command !== 'string' || !cfg.command) {
      throw new Error('Invalid remote agent session configuration.')
    }
    cfg.cursor = Number.isSafeInteger(cfg.cursor) && cfg.cursor >= 0 ? cfg.cursor : 0
    if (cfg.root !== undefined && (typeof cfg.root !== 'string' || !path.isAbsolute(cfg.root))) {
      throw new Error('The remote agent session directory must be absolute.')
    }
    cfg.root = cfg.root || path.join(os.homedir(), '.life', 'agent-sessions', cfg.id)
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: 'error', message: error.message }) + '\n')
    process.exitCode = 1
    return
  }
  const root = cfg.root
  const configPath = path.join(root, 'session.json')
  const statePath = path.join(root, 'state.json')
  const journalPath = path.join(root, 'journal.jsonl')
  const lockPath = path.join(root, 'daemon.lock')
  const ownerPath = path.join(lockPath, 'owner.json')
  const socketPath = path.join(os.tmpdir(), 'life-' + (process.getuid ? process.getuid() : 'user') + '-' + crypto.createHash('sha256').update(root + '\0' + cfg.id).digest('hex').slice(0, 28) + '.sock')
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const removeDirectory = (directory) => {
    if (fs.rmSync) fs.rmSync(directory, { recursive: true, force: true })
    else fs.rmdirSync(directory, { recursive: true })
  }
  const saveJson = (file, value) => {
    const temporary = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const terminalRecord = () => {
    try {
      const fd = fs.openSync(journalPath, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const buffer = Buffer.alloc(Math.min(size, 128 * 1024))
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
        const lines = buffer.toString('utf8').trimEnd().split('\n')
        const last = JSON.parse(lines[lines.length - 1])
        return last.type === 'exit' ? last : null
      } finally { fs.closeSync(fd) }
    } catch { return null }
  }
  async function replay(after, highWater, send) {
    if (!fs.existsSync(journalPath)) return
    const input = fs.createReadStream(journalPath, { encoding: 'utf8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!Number.isSafeInteger(frame.cursor) || frame.cursor <= after) continue
        if (frame.cursor > highWater) break
        if (!(await send(frame))) break
      }
    } finally {
      lines.close()
      input.destroy()
    }
  }
  function linesFrom(stream, receive, fail) {
    let pending = ''
    let failed = false
    const reject = (message) => {
      if (failed) return
      failed = true
      pending = ''
      fail(new Error(message))
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      if (failed) return
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        if (newline > MAX_INPUT) {
          reject('The remote agent command exceeded the transport limit.')
          return
        }
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line) continue
        let frame
        try { frame = JSON.parse(line) } catch {
          reject('The remote agent attachment sent an invalid command.')
          return
        }
        receive(frame)
      }
      if (pending.length > MAX_INPUT) reject('The remote agent command exceeded the transport limit.')
    })
  }
  if (cfg.mode === 'daemon') {
    const persisted = readJson(configPath)
    if (!persisted || persisted.id !== cfg.id || persisted.token !== cfg.token) throw new Error('The remote agent daemon could not verify its session.')
    fs.chmodSync(root, 0o700)
    saveJson(ownerPath, { pid: process.pid, token: cfg.token })
    let cursor = 0
    let lastInputSequence = 0
    let provider = null
    let ended = false
    let closing = false
    let closeTimer = null
    const clients = new Set()
    const queued = new Map()
    let queuedBytes = 0
    const journalFd = fs.openSync(journalPath, 'a', 0o600)
    function state(exited) {
      saveJson(statePath, { id: cfg.id, pid: provider ? provider.pid : null, brokerPid: process.pid, cursor, lastInputSequence, exited: !!exited })
    }
    function send(client, frame) {
      if (client.socket.destroyed) return false
      const encoded = JSON.stringify(frame) + '\n'
      if (client.socket.writableLength + Buffer.byteLength(encoded) > MAX_CLIENT_BUFFER) {
        client.socket.destroy()
        return false
      }
      return client.socket.write(encoded)
    }
    async function sendReplay(client, frame) {
      if (client.socket.destroyed) return false
      if (send(client, frame)) return true
      if (client.socket.destroyed) return false
      return await new Promise((resolve) => {
        const done = (value) => {
          client.socket.removeListener('drain', drained)
          client.socket.removeListener('close', closed)
          resolve(value)
        }
        const drained = () => done(true)
        const closed = () => done(false)
        client.socket.once('drain', drained)
        client.socket.once('close', closed)
      })
    }
    function publish(frame) {
      frame.cursor = ++cursor
      const encoded = JSON.stringify(frame) + '\n'
      fs.writeSync(journalFd, encoded)
      for (const client of clients) {
        if (client.replaying) {
          client.pending.push(frame)
          client.pendingBytes += Buffer.byteLength(encoded)
          if (client.pendingBytes > MAX_CLIENT_BUFFER) client.socket.destroy()
        } else send(client, frame)
      }
      return frame
    }
    function killProvider(signal) {
      if (!provider || !provider.pid || ended) return
      try { process.kill(-provider.pid, signal) } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    function removeOwnedLock() {
      const owner = readJson(ownerPath)
      if (owner && owner.pid === process.pid && owner.token === cfg.token) {
        removeDirectory(lockPath)
      }
    }
    function finish(code, signal) {
      if (ended) return
      ended = true
      if (closeTimer) clearTimeout(closeTimer)
      publish({ type: 'exit', code: Number.isInteger(code) ? code : null, signal: signal || null })
      fs.fsyncSync(journalFd)
      state(true)
      const finishSockets = async () => {
        const started = Date.now()
        while ([...clients].some((client) => client.replaying) && Date.now() - started < 10000) await delay(20)
        for (const client of clients) client.socket.end()
        server.close(() => {
          try { fs.unlinkSync(socketPath) } catch {}
          removeOwnedLock()
          fs.closeSync(journalFd)
          process.exit(0)
        })
        const forced = setTimeout(() => {
          for (const client of clients) client.socket.destroy()
          try { fs.unlinkSync(socketPath) } catch {}
          removeOwnedLock()
          process.exit(0)
        }, 2000)
        forced.unref()
      }
      void finishSockets()
    }
    function ack(client, sequence) { send(client, { type: 'ack', sequence }) }
    function commandError(client, message) { send(client, { type: 'error', message }) }
    function beginClose() {
      closing = true
      killProvider('SIGTERM')
      provider.stdin.destroy()
      closeTimer = setTimeout(() => {
        killProvider('SIGKILL')
        // A detached grandchild can retain an inherited pipe after the provider
        // group exits. Explicit closure must still release the broker itself.
        closeTimer = setTimeout(() => {
          provider.stdout.destroy()
          provider.stderr.destroy()
          finish(null, 'SIGKILL')
        }, 1000)
      }, 5000)
    }
    function apply(frame, waiters) {
      lastInputSequence = frame.sequence
      state(false)
      if (frame.type === 'write') {
        if (!provider.stdin.destroyed) provider.stdin.write(Buffer.from(frame.data, 'base64'))
      } else if (frame.type === 'end') {
        provider.stdin.end()
      } else if (frame.type === 'signal') {
        killProvider(frame.signal)
      } else if (frame.type === 'close') {
        queued.clear()
        queuedBytes = 0
        beginClose()
      }
      for (const client of waiters) ack(client, frame.sequence)
    }
    function receiveCommand(client, frame) {
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1) return commandError(client, 'Invalid remote agent input sequence.')
      if (!['write', 'signal', 'end', 'close'].includes(frame.type)) return commandError(client, 'Unknown remote agent command.')
      if (frame.type === 'write' && (typeof frame.data !== 'string' || frame.data.length > MAX_INPUT - 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))) return commandError(client, 'Invalid remote agent input data.')
      if (frame.type === 'signal' && !['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'].includes(frame.signal)) return commandError(client, 'Invalid remote agent signal.')
      if (frame.sequence <= lastInputSequence) return ack(client, frame.sequence)
      if (ended || closing) return commandError(client, 'The remote agent session has ended.')
      if (frame.type === 'close') return apply(frame, new Set([client]))
      const existing = queued.get(frame.sequence)
      if (existing) {
        if (JSON.stringify(existing.frame) !== JSON.stringify(frame)) return commandError(client, 'Conflicting remote agent input sequence.')
        existing.waiters.add(client)
      } else {
        const bytes = Buffer.byteLength(JSON.stringify(frame))
        if (queued.size >= 1024 || queuedBytes + bytes > MAX_CLIENT_BUFFER) return commandError(client, 'The remote agent input queue is full.')
        queued.set(frame.sequence, { frame, bytes, waiters: new Set([client]) })
        queuedBytes += bytes
      }
      while (queued.has(lastInputSequence + 1) && !closing && !ended) {
        const next = queued.get(lastInputSequence + 1)
        queued.delete(lastInputSequence + 1)
        queuedBytes -= next.bytes
        apply(next.frame, next.waiters)
      }
    }
    const server = net.createServer((socket) => {
      let client = null
      const authTimer = setTimeout(() => socket.destroy(), 5000)
      socket.on('error', () => {})
      socket.on('close', () => { clearTimeout(authTimer); if (client) clients.delete(client) })
      linesFrom(socket, (frame) => {
        if (!client) {
          const supplied = typeof frame.token === 'string' ? Buffer.from(frame.token) : Buffer.alloc(0)
          const expected = Buffer.from(cfg.token)
          if (frame.type !== 'attach' || frame.id !== cfg.id || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return socket.destroy()
          clearTimeout(authTimer)
          client = { socket, replaying: true, pending: [], pendingBytes: 0 }
          clients.add(client)
          const highWater = cursor
          send(client, { type: 'ready', pid: provider.pid, cursor: highWater, lastInputSequence })
          const after = Number.isSafeInteger(frame.cursor) && frame.cursor >= 0 ? frame.cursor : 0
          const current = client
          void (async () => {
            await replay(after, highWater, (record) => sendReplay(current, record))
            while (current.pending.length && !socket.destroyed) {
              const record = current.pending.shift()
              current.pendingBytes -= Buffer.byteLength(JSON.stringify(record) + '\n')
              if (!(await sendReplay(current, record))) break
            }
            current.replaying = false
            if (ended && !socket.destroyed) socket.end()
          })().catch(() => socket.destroy())
          return
        }
        try { receiveCommand(client, frame) } catch (error) { commandError(client, error.message) }
      }, () => socket.destroy())
    })
    server.on('error', (error) => { console.error(error.message); killProvider('SIGKILL'); process.exit(1) })
    try { fs.unlinkSync(socketPath) } catch {}
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    fs.chmodSync(socketPath, 0o600)
    provider = childProcess.spawn('/bin/sh', ['-c', persisted.command], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    state(false)
    provider.stdout.on('data', (data) => publish({ type: 'stdout', data: data.toString('base64') }))
    provider.stderr.on('data', (data) => publish({ type: 'stderr', data: data.toString('base64') }))
    provider.stdin.on('error', (error) => { if (!closing && !ended) publish({ type: 'stderr', data: Buffer.from(error.message + '\n').toString('base64') }) })
    provider.on('error', (error) => publish({ type: 'stderr', data: Buffer.from(error.message + '\n').toString('base64') }))
    provider.on('close', finish)
    const shutdown = () => {
      if (closing || ended) return
      beginClose()
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    return
  }
  async function offlineReplay(terminal) {
    const state = readJson(statePath) || {}
    process.stdout.write(JSON.stringify({ type: 'ready', pid: state.pid || null, cursor: terminal.cursor, lastInputSequence: state.lastInputSequence || 0 }) + '\n')
    await replay(cfg.cursor, terminal.cursor, async (frame) => {
      if (process.stdout.write(JSON.stringify(frame) + '\n')) return true
      return await new Promise((resolve) => { process.stdout.once('drain', () => resolve(true)); process.stdout.once('error', () => resolve(false)) })
    })
    if (cfg.cursor >= terminal.cursor) process.stdout.write(JSON.stringify(terminal) + '\n')
  }
  function connectSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('The remote agent attachment did not connect.')) }, 1000)
      socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', failed); resolve(socket) })
      const failed = (error) => { clearTimeout(timer); socket.destroy(); reject(error) }
      socket.once('error', failed)
    })
  }
  try {
    if (cfg.launch === false && !fs.existsSync(root)) throw new Error('The remote agent session is no longer available. It was not restarted and no prompt was replayed.')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.chmodSync(root, 0o700)
    let socket = null
    let persisted = null
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      persisted = readJson(configPath)
      if (persisted && persisted.id !== cfg.id) throw new Error('The remote agent session directory belongs to another session.')
      try {
        socket = await connectSocket()
        persisted = readJson(configPath)
        if (!persisted || persisted.id !== cfg.id || typeof persisted.token !== 'string') {
          socket.destroy()
          socket = null
          throw new Error('The remote agent session metadata is unavailable.')
        }
        break
      } catch {}
      const terminal = terminalRecord()
      if (terminal) { await offlineReplay(terminal); return }
      const owner = readJson(ownerPath)
      if (owner && alive(owner.pid)) { await delay(50); continue }
      if (fs.existsSync(lockPath)) {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        // An SSH attachment can disappear between daemon spawn and publication
        // of its PID. Give the new process time to take ownership of the lock.
        if ((!owner && age < 15000) || age < 2000) { await delay(50); continue }
        removeDirectory(lockPath)
      }
      if (persisted || cfg.launch === false) throw new Error('The remote agent session is no longer available. It was not restarted and no prompt was replayed.')
      try { fs.mkdirSync(lockPath, { mode: 0o700 }) } catch (error) {
        if (error.code === 'EEXIST') { await delay(50); continue }
        throw error
      }
      saveJson(ownerPath, { pid: process.pid })
      persisted = { id: cfg.id, command: cfg.command, token: crypto.randomBytes(32).toString('hex') }
      const pendingConfigPath = configPath + '.' + process.pid + '.tmp'
      fs.writeFileSync(pendingConfigPath, JSON.stringify(persisted), { mode: 0o600, flag: 'wx' })
      try { fs.linkSync(pendingConfigPath, configPath) } finally { fs.unlinkSync(pendingConfigPath) }
      fs.closeSync(fs.openSync(journalPath, 'a', 0o600))
      const logFd = fs.openSync(path.join(root, 'broker.log'), 'a', 0o600)
      try {
        const daemonConfig = Buffer.from(JSON.stringify({ ...cfg, ...persisted, mode: 'daemon' })).toString('base64')
        const daemon = childProcess.spawn(process.execPath, ['-e', process._eval, daemonConfig], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
        await new Promise((resolve, reject) => { daemon.once('spawn', resolve); daemon.once('error', reject) })
        try { saveJson(ownerPath, { pid: daemon.pid, token: persisted.token }) } catch (error) {
          // An immediately exiting provider can finish before this attachment
          // is scheduled again. Its terminal journal is still the authority.
          if (error.code !== 'ENOENT') throw error
        }
        daemon.unref()
      } finally { fs.closeSync(logFd) }
      await delay(25)
    }
    if (!socket || !persisted) throw new Error('The remote agent session could not be attached within 15 seconds.')
    socket.on('error', () => {})
    socket.on('data', (data) => { if (!process.stdout.write(data)) socket.pause() })
    process.stdout.on('drain', () => socket.resume())
    const done = () => { process.stdin.pause(); process.stdin.destroy(); socket.destroy() }
    socket.on('end', done)
    socket.on('close', done)
    process.stdout.on('error', done)
    socket.write(JSON.stringify({ type: 'attach', id: cfg.id, token: persisted.token, cursor: cfg.cursor }) + '\n')
    process.stdin.on('data', (data) => { if (!socket.write(data)) process.stdin.pause() })
    socket.on('drain', () => process.stdin.resume())
    process.stdin.on('end', () => socket.end())
    process.stdin.on('error', () => socket.destroy())
    process.stdin.resume()
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: 'error', message: error.message }) + '\n')
    process.exitCode = 1
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ type: 'error', message: error.message }) + '\n')
  process.exitCode = 1
})
`

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

// SSH implementations commonly cap a single exec request near 32 KiB. Keep
// both dependency-free runtime fallbacks inside that limit, including quoting.
const nodeBootstrap = `eval(require('zlib').gunzipSync(Buffer.from('${gzipSync(REMOTE_AGENT_BROKER_SOURCE).toString('base64')}','base64')).toString())`
const pythonBootstrap = `import base64,gzip;exec(gzip.decompress(base64.b64decode('${gzipSync(REMOTE_AGENT_BROKER_PYTHON_SOURCE).toString('base64')}')).decode())`

export function buildRemoteAgentBrokerCommand(config: RemoteAgentBrokerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64')
  const node = `${shellQuote(nodeBootstrap)} ${shellQuote(encoded)}`
  const python = `${shellQuote(pythonBootstrap)} ${shellQuote(encoded)}`
  const unavailable = shellQuote(
    JSON.stringify({
      type: 'error',
      message:
        'Life needs Node.js or Python 3 on this host to keep an agent running across SSH reconnects. Install either runtime and retry; no user message was sent.',
    }),
  )
  return `if command -v node >/dev/null 2>&1; then life_broker_runtime=node; elif command -v nodejs >/dev/null 2>&1; then life_broker_runtime=nodejs; else life_broker_runtime=''; fi; if [ -n "$life_broker_runtime" ]; then exec "$life_broker_runtime" -e ${node}; elif command -v python3 >/dev/null 2>&1; then exec python3 -c ${python}; else printf '%s\\n' ${unavailable}; exit 127; fi`
}
