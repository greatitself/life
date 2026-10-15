import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, truncate } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createConnection, createServer, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOTE_AGENT_BROKER_SOURCE,
  buildRemoteAgentBrokerCommand,
} from '../src/main/remote-agent-broker'
import { REMOTE_AGENT_BROKER_PYTHON_SOURCE } from '../src/main/remote-agent-broker-python'
import { remoteCommand } from '../src/main/ssh'

type BrokerConfig = {
  id: string
  command: string
  root: string
  cursor?: number
  launch?: boolean
  controllerId?: string
  observer?: boolean
  expectedProtocol?: number
}

type BrokerMessage = {
  type: string
  pid?: number
  cursor?: number
  lastInputSequence?: number
  data?: string
  sequence?: number
  code?: number | null
  signal?: string | null
  message?: string
  protocol?: number
  writerLease?: { epoch: number; token: string }
  writerUnavailable?: boolean
  observer?: boolean
  terminal?: boolean
  replayCursor?: number
  nativeExitConfirmed?: boolean
  inputReceipts?: number
  status?: 'written' | 'cancelled' | 'uncertain'
}

const fixtures: ProviderFixture[] = []
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

class BrokerAttach {
  readonly child: ChildProcessWithoutNullStreams
  readonly messages: BrokerMessage[] = []
  readonly errors: string[] = []
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  cursor = 0
  private stdout = ''

  constructor(
    readonly config: BrokerConfig,
    throughShell = false,
    environment: NodeJS.ProcessEnv = process.env,
    source = REMOTE_AGENT_BROKER_SOURCE,
    runtime: 'node' | 'python' = 'node',
  ) {
    this.cursor = config.cursor ?? 0
    this.child = throughShell
      ? spawn('/bin/sh', ['-c', buildRemoteAgentBrokerCommand(config)], {
          stdio: 'pipe',
          env: environment,
        })
      : spawn(
          runtime === 'node' ? process.execPath : 'python3',
          [
            runtime === 'node' ? '-e' : '-c',
            source,
            Buffer.from(JSON.stringify(config)).toString('base64'),
          ],
          { stdio: 'pipe' },
        )
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString()
      while (true) {
        const newline = this.stdout.indexOf('\n')
        if (newline < 0) break
        const line = this.stdout.slice(0, newline)
        this.stdout = this.stdout.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as BrokerMessage
          this.messages.push(message)
          // A ready cursor describes the remote journal head, not delivered data.
          if (
            ['stdout', 'stderr', 'exit', 'inputReceipt'].includes(message.type) &&
            message.cursor != null
          ) {
            this.cursor = Math.max(this.cursor, message.cursor)
          }
        } catch {
          this.errors.push('Broker emitted invalid JSON')
        }
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()))
    this.child.stdin.on('error', (error) => {
      if (!this.messages.some((message) => message.type === 'exit')) this.errors.push(error.message)
    })
    this.child.on('error', (error) => this.errors.push(error.message))
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code, signal) => resolve({ code, signal }))
    })
  }

  send(message: Record<string, unknown>) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  write(sequence: number, data: string) {
    this.send({
      type: 'write',
      sequence,
      data: Buffer.from(data).toString('base64'),
      ...(this.messages.find((message) => message.type === 'ready')?.writerLease
        ? { writerLease: this.messages.find((message) => message.type === 'ready')!.writerLease }
        : {}),
    })
  }

  output(type: 'stdout' | 'stderr' = 'stdout') {
    return this.messages
      .filter((message) => message.type === type)
      .map((message) => Buffer.from(message.data ?? '', 'base64').toString())
      .join('')
  }

  async until(predicate: () => boolean, description: string, timeout = 5000) {
    const deadline = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(
          `${description} timed out; events: ${this.messages.map((m) => m.type).join(', ')}`,
        )
      }
      if (this.errors.length) throw new Error(this.errors.join('\n'))
      const error = this.messages.find((message) => message.type === 'error')
      if (error) throw new Error(error.message ?? 'Broker rejected the command')
      await delay(10)
    }
  }

  async ready() {
    await this.until(
      () => this.messages.some((message) => message.type === 'ready'),
      'Broker ready',
    )
    const ready = this.messages.find((message) => message.type === 'ready')!
    expect(ready.pid).toBeGreaterThan(0)
    return ready
  }

  async close(sequence = 10000) {
    if (this.child.exitCode != null || this.child.signalCode != null) return
    if (!this.messages.some((message) => message.type === 'exit')) {
      this.send({
        type: 'close',
        sequence,
        writerLease: this.messages.find((message) => message.type === 'ready')?.writerLease,
      })
    }
    await this.until(
      () => this.messages.some((message) => message.type === 'exit'),
      'Provider close',
    )
    this.child.kill('SIGKILL')
    await this.exited
  }
}

class ProviderFixture {
  readonly attaches: BrokerAttach[] = []
  command: string

  constructor(readonly root: string) {
    const source = `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const root = ${JSON.stringify(root)};
      fs.appendFileSync(root + '/launches', process.pid + '\\n');
      process.stdout.write('started\\n');
      process.stderr.write('provider diagnostic\\n');
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        fs.writeFileSync(root + '/ticks', String(ticks));
        process.stdout.write('tick:' + ticks + '\\n');
      }, 40);
      process.stdin.on('data', (chunk) => fs.appendFileSync(root + '/input-bytes', chunk));
      readline.createInterface({ input: process.stdin }).on('line', line => {
        fs.appendFileSync(root + '/inputs', line + '\\n');
        process.stdout.write('input:' + line + '\\n');
      }).on('close', () => {
        clearInterval(timer);
        process.stdout.write('finished\\n');
        process.exit(0);
      });
    `
    this.command = `${quote(process.execPath)} -e ${quote(source)}`
  }

  attach(
    options: Partial<BrokerConfig> = {},
    throughShell = false,
    environment: NodeJS.ProcessEnv = process.env,
    source = REMOTE_AGENT_BROKER_SOURCE,
    runtime: 'node' | 'python' = 'node',
  ) {
    const attach = new BrokerAttach(
      {
        id: 'provider-session',
        root: this.root,
        command: this.command,
        ...options,
      },
      throughShell,
      environment,
      source,
      runtime,
    )
    this.attaches.push(attach)
    return attach
  }

  async lines(name: string) {
    try {
      return (await readFile(path.join(this.root, name), 'utf8')).trim().split('\n').filter(Boolean)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async dispose() {
    try {
      const owned = this.attaches.find(
        (attach) =>
          attach.child.exitCode == null &&
          attach.child.signalCode == null &&
          attach.messages.some((message) => message.type === 'ready' && message.writerLease),
      )
      if (owned) await owned.close()
    } catch {
      // The assertions above report any failure; always reap the test attach processes.
    } finally {
      const state = JSON.parse(
        await readFile(path.join(this.root, 'state.json'), 'utf8').catch(() => '{}'),
      ) as {
        pid?: number
        brokerPid?: number
      }
      // These PIDs were created inside this disposable fixture, never a live profile.
      if (
        state.brokerPid &&
        state.brokerPid !== process.pid &&
        state.pid &&
        state.pid !== process.pid
      ) {
        try {
          process.kill(-state.pid, 'SIGKILL')
        } catch {}
      }
      if (state.brokerPid && state.brokerPid !== process.pid) {
        try {
          process.kill(state.brokerPid, 'SIGKILL')
        } catch {}
      }
      for (const attach of this.attaches) {
        if (attach.child.exitCode == null && attach.child.signalCode == null)
          attach.child.kill('SIGKILL')
      }
      await Promise.all(this.attaches.map((attach) => attach.exited))
      await rm(this.root, { recursive: true, force: true })
    }
  }
}

async function fixture() {
  const value = new ProviderFixture(await mkdtemp(path.join(tmpdir(), 'life-broker-test-')))
  fixtures.push(value)
  return value
}

async function attachRuntime(
  provider: ProviderFixture,
  runtime: 'node' | 'python',
  options: Partial<BrokerConfig> = {},
) {
  if (runtime === 'node') return provider.attach(options)
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  }).trim()
  const bin = path.join(provider.root, 'python-only-bin')
  await mkdir(bin, { recursive: true })
  await symlink(python, path.join(bin, 'python3')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return provider.attach(options, true, { ...process.env, PATH: bin })
}

function socketPath(provider: ProviderFixture) {
  return path.join(
    tmpdir(),
    'life-' +
      process.getuid!() +
      '-' +
      createHash('sha256')
        .update(provider.root + '\0provider-session')
        .digest('hex')
        .slice(0, 28) +
      '.sock',
  )
}

async function rawAttach(provider: ProviderFixture, observer = true, expectedProtocol = 2) {
  const persisted = JSON.parse(
    await readFile(path.join(provider.root, 'session.json'), 'utf8'),
  ) as {
    token: string
  }
  const socket = createConnection(socketPath(provider))
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const messages: BrokerMessage[] = []
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (data: string) => {
    pending += data
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n')
      messages.push(JSON.parse(pending.slice(0, newline)) as BrokerMessage)
      pending = pending.slice(newline + 1)
    }
  })
  socket.write(
    JSON.stringify({
      type: 'attach',
      id: 'provider-session',
      command: provider.command,
      token: persisted.token,
      cursor: 0,
      controllerId: 'raw-observer',
      observer,
      expectedProtocol,
    }) + '\n',
  )
  return { socket, messages, send: (frame: unknown) => socket.write(JSON.stringify(frame) + '\n') }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()))
})

describe.skipIf(process.platform === 'win32')('remote agent broker SSH continuity', () => {
  it('bounds individual input frames after splitting a coalesced chunk and rejects oversized frames once', () => {
    const start = REMOTE_AGENT_BROKER_SOURCE.indexOf('  function linesFrom(')
    const end = REMOTE_AGENT_BROKER_SOURCE.indexOf("  if (cfg.mode === 'daemon')", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const parse = new Function(
      'MAX_INPUT',
      REMOTE_AGENT_BROKER_SOURCE.slice(start, end) + '; return linesFrom',
    )(4096) as (
      stream: PassThrough,
      receive: (frame: unknown) => void,
      fail: (error: Error) => void,
    ) => void
    const frames = [1, 2].map((sequence) => ({
      type: 'write',
      sequence,
      data: Buffer.from(String(sequence).repeat(1800) + '\n').toString('base64'),
    }))
    const encoded = frames.map((frame) => JSON.stringify(frame) + '\n')
    expect(encoded.every((line) => Buffer.byteLength(line) < 4096)).toBe(true)
    const chunk = Buffer.from(encoded.join(''))
    expect(chunk.byteLength).toBeGreaterThan(4096)
    const stream = new PassThrough()
    const received: unknown[] = []
    const failures: Error[] = []
    parse(
      stream,
      (frame) => received.push(frame),
      (error) => failures.push(error),
    )
    stream.write(chunk)
    expect(received).toEqual(frames)
    expect(failures).toEqual([])
    stream.destroy()

    const invalid = new PassThrough()
    const invalidReceived: unknown[] = []
    const invalidFailures: Error[] = []
    parse(
      invalid,
      (frame) => invalidReceived.push(frame),
      (error) => invalidFailures.push(error),
    )
    invalid.write(
      JSON.stringify({ type: 'write', sequence: 1, data: 'x'.repeat(5000) }) + '\n' + encoded[0],
    )
    invalid.write(encoded[1])
    expect(invalidFailures).toHaveLength(1)
    expect(invalidFailures[0].message).toMatch(/exceeded the transport limit/)
    expect(invalidReceived).toEqual([])
    invalid.destroy()
  })

  it('delivers coalesced valid provider writes even when the combined chunk exceeds the per-frame limit', async () => {
    const source = REMOTE_AGENT_BROKER_SOURCE.replace(
      'const MAX_INPUT = 24 * 1024 * 1024',
      'const MAX_INPUT = 4096',
    )
    expect(source).not.toBe(REMOTE_AGENT_BROKER_SOURCE)
    const provider = await fixture()
    const attach = provider.attach({}, false, process.env, source)
    await attach.ready()
    const lines = ['first:' + 'a'.repeat(1794), 'second:' + 'b'.repeat(1793)]
    const frames = lines.map((line, index) => ({
      type: 'write',
      sequence: index + 1,
      data: Buffer.from(line + '\n').toString('base64'),
    }))
    expect(frames.every((frame) => frame.data.length <= 4096 - 1024)).toBe(true)
    const chunk = Buffer.from(frames.map((frame) => JSON.stringify(frame) + '\n').join(''))
    expect(chunk.byteLength).toBeGreaterThan(4096)
    attach.child.stdin.write(chunk)
    await attach.until(
      () => attach.output().includes('input:' + lines[1] + '\n'),
      'Coalesced provider input',
    )
    expect(await provider.lines('inputs')).toEqual(lines)
    expect(attach.messages.filter((message) => message.type === 'error')).toEqual([])
    expect(await provider.lines('launches')).toHaveLength(1)
    await attach.close()
  }, 15000)

  it('keeps the complete SSH exec request below the 32 KiB packet limit', () => {
    const commands = [
      "cd '/home/research/projects/current project' && exec codex app-server --listen stdio:// -c features.step_model_switching=true",
      "cd '/home/research/projects/current project' && exec 'claude' '-p' '--input-format' 'stream-json' '--output-format' 'stream-json' '--verbose' '--permission-prompt-tool' 'stdio' '--permission-mode' 'default' '--model' 'claude-sonnet-4-6'",
      'cd ' +
        quote('/home/research/' + 'long-project-name-'.repeat(40)) +
        ' && exec codex app-server --listen stdio://',
    ]
    for (const command of commands) {
      expect(Buffer.byteLength(command)).toBeLessThanOrEqual(1024)
      const completeRequest = remoteCommand(
        buildRemoteAgentBrokerCommand({
          id: '5f01dc3a-b099-4fc0-ab40-62ff43101e5b',
          root: '/home/research/.life/agent-sessions/5f01dc3a-b099-4fc0-ab40-62ff43101e5b',
          command,
          cursor: 123456,
          launch: false,
        }),
      )
      expect(Buffer.byteLength(completeRequest)).toBeLessThan(32768)
    }
  })

  it('keeps the provider running after an attach is killed and replays the missed journal on reconnect', async () => {
    const provider = await fixture()
    const first = provider.attach()
    const before = await first.ready()
    await first.until(() => first.output().includes('tick:1\n'), 'Initial provider output')
    first.write(1, 'before disconnect\n')
    await first.until(
      () => first.output().includes('input:before disconnect\n'),
      'Input before SSH disconnect',
    )
    const cursor = first.cursor
    first.child.kill('SIGKILL')
    await first.exited
    await delay(180)

    const resumed = provider.attach({ launch: false, cursor })
    const after = await resumed.ready()
    expect(after.pid).toBe(before.pid)
    expect(after.lastInputSequence).toBe(1)
    await resumed.until(
      () => /tick:[2-9]\n/.test(resumed.output()),
      'Output generated while detached',
    )
    expect(resumed.output()).not.toContain('started\n')
    resumed.write(1, 'before disconnect\n')
    resumed.write(2, 'still running\n')
    await resumed.until(
      () => resumed.output().includes('input:still running\n'),
      'Resumed provider input',
    )
    expect(await provider.lines('launches')).toHaveLength(1)
    expect(await provider.lines('inputs')).toEqual(['before disconnect', 'still running'])
    await resumed.close()
  }, 15000)

  it('delivers future input sequences in order and never repeats an acknowledged input', async () => {
    const provider = await fixture()
    const attach = provider.attach()
    await attach.ready()
    attach.write(2, 'second\n')
    await delay(120)
    expect(await provider.lines('inputs')).toEqual([])
    attach.write(1, 'first\n')
    await attach.until(() => attach.output().includes('input:second\n'), 'Ordered provider input')
    expect(await provider.lines('inputs')).toEqual(['first', 'second'])
    expect(
      attach.messages.filter((message) => message.type === 'ack').map((m) => m.sequence),
    ).toEqual(expect.arrayContaining([1, 2]))

    attach.write(1, 'first\n')
    attach.write(2, 'second\n')
    attach.write(3, 'third\n')
    await attach.until(
      () => attach.output().includes('input:third\n'),
      'Input after duplicate retry',
    )
    expect(await provider.lines('inputs')).toEqual(['first', 'second', 'third'])
    await attach.close()
  }, 15000)

  it('closes across a missing input sequence and retains the terminal result for later replay', async () => {
    const provider = await fixture()
    const attach = provider.attach()
    await attach.ready()
    await attach.until(
      () =>
        attach.output().includes('started\n') &&
        attach.output('stderr').includes('provider diagnostic\n'),
      'Provider startup output on both streams',
    )
    attach.write(8, 'must never arrive\n')
    attach.send({ type: 'close', sequence: 99 })
    await attach.until(
      () => attach.messages.some((message) => message.type === 'exit'),
      'Gap-independent close',
    )
    const exit = attach.messages.find((message) => message.type === 'exit')!
    expect(exit.cursor).toBeGreaterThan(0)
    expect(await provider.lines('inputs')).toEqual([])
    attach.child.kill('SIGKILL')
    await attach.exited

    const replay = provider.attach({ launch: false, cursor: 0 })
    await replay.until(
      () => replay.messages.some((message) => message.type === 'exit'),
      'Terminal journal replay',
    )
    expect(replay.output()).toContain('started\n')
    expect(replay.output('stderr')).toContain('provider diagnostic\n')
    expect(replay.messages.find((message) => message.type === 'exit')).toEqual(exit)
    expect(await provider.lines('launches')).toHaveLength(1)
  }, 15000)

  it('does not create a provider when attaching to an absent session with launch disabled', async () => {
    const provider = await fixture()
    const attach = provider.attach({ launch: false })
    await attach.until(
      () => attach.messages.some((message) => message.type === 'error'),
      'Missing session error',
    )
    expect(attach.messages.some((message) => message.type === 'ready')).toBe(false)
    expect(await provider.lines('launches')).toEqual([])
    await expect(stat(path.join(provider.root, 'launches'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, 10000)

  it('starts exactly one provider when the first two attaches race', async () => {
    const provider = await fixture()
    const first = provider.attach()
    const second = provider.attach()
    const [a, b] = await Promise.all([first.ready(), second.ready()])
    expect(a.pid).toBe(b.pid)
    await Promise.all([
      first.until(() => first.output().includes('started\n'), 'First concurrent attach output'),
      second.until(() => second.output().includes('started\n'), 'Second concurrent attach output'),
    ])
    expect(await provider.lines('launches')).toHaveLength(1)
    const owner = a.writerLease ? first : second
    expect([a, b].filter((ready) => ready.writerLease)).toHaveLength(1)
    expect([a, b].filter((ready) => ready.writerUnavailable)).toHaveLength(1)
    owner.write(1, 'only once\n')
    owner.write(1, 'only once\n')
    await owner.until(
      () => owner.output().includes('input:only once\n'),
      'Shared input acknowledgment',
    )
    await delay(80)
    expect(await provider.lines('inputs')).toEqual(['only once'])
    await owner.close()
  }, 15000)

  it('ends provider stdin once and replays a clean exit after reconnecting', async () => {
    const provider = await fixture()
    const first = provider.attach()
    await first.ready()
    first.write(1, 'last input\n')
    first.send({ type: 'end', sequence: 2 })
    await first.until(
      () => first.messages.some((message) => message.type === 'exit'),
      'Clean provider exit',
    )
    expect(first.output()).toContain('input:last input\n')
    expect(first.output()).toContain('finished\n')
    expect(first.messages.find((message) => message.type === 'exit')?.code).toBe(0)
    const cursor = first.cursor
    first.child.kill('SIGKILL')
    await first.exited

    const replay = provider.attach({ launch: false, cursor: cursor - 1 })
    await replay.until(
      () => replay.messages.some((message) => message.type === 'exit'),
      'Clean exit replay',
    )
    expect(replay.messages.find((message) => message.type === 'exit')?.code).toBe(0)
    expect(await provider.lines('launches')).toHaveLength(1)
    expect(await provider.lines('inputs')).toEqual(['last input'])
  }, 15000)

  it('forwards a sequenced interrupt to the provider while preserving the exit journal', async () => {
    const provider = await fixture()
    const attach = provider.attach()
    await attach.ready()
    await attach.until(
      () => attach.output().includes('started\n'),
      'Provider start before interrupt',
    )
    attach.send({ type: 'signal', sequence: 1, signal: 'SIGINT' })
    await attach.until(
      () => attach.messages.some((message) => message.type === 'exit'),
      'Interrupted provider exit',
    )
    expect(
      attach.messages.filter((message) => message.type === 'ack').map((m) => m.sequence),
    ).toContain(1)
    expect(attach.messages.find((message) => message.type === 'exit')?.signal).toBe('SIGINT')
  }, 15000)

  it('builds a usable remote shell command without changing quoted provider input', async () => {
    const provider = await fixture()
    const attach = provider.attach({}, true)
    await attach.ready()
    const text = 'Quotes: \'single\' "double"; dollar $HOME; backticks `untouched`'
    attach.write(1, text + '\n')
    await attach.until(() => attach.output().includes('input:' + text + '\n'), 'Shell attach input')
    expect(await provider.lines('inputs')).toEqual([text])
    expect(await provider.lines('launches')).toHaveLength(1)
    await attach.close()
  }, 15000)

  it('uses Python when it is the only runtime on the remote PATH and supports a Node reconnect', async () => {
    const provider = await fixture()
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim()
    const bin = path.join(provider.root, 'python-only-bin')
    await mkdir(bin)
    await symlink(python, path.join(bin, 'python3'))
    const first = provider.attach({}, true, { ...process.env, PATH: bin })
    const initial = await first.ready()
    first.write(1, 'python fallback input\n')
    await first.until(
      () => first.output().includes('input:python fallback input\n'),
      'Python-backed provider input',
    )
    const cursor = first.cursor
    first.child.kill('SIGKILL')
    await first.exited

    const resumed = provider.attach({ launch: false, cursor })
    const ready = await resumed.ready()
    expect(ready.pid).toBe(initial.pid)
    expect(ready.lastInputSequence).toBe(1)
    resumed.write(1, 'python fallback input\n')
    resumed.write(2, 'node reattachment input\n')
    await resumed.until(
      () => resumed.output().includes('input:node reattachment input\n'),
      'Node attach to Python broker',
    )
    expect(await provider.lines('inputs')).toEqual([
      'python fallback input',
      'node reattachment input',
    ])
    expect(await provider.lines('launches')).toHaveLength(1)
    await resumed.close()
  }, 15000)

  it('reports missing runtimes as a protocol error without launching a provider', async () => {
    const provider = await fixture()
    const emptyBin = path.join(provider.root, 'empty-bin')
    await mkdir(emptyBin)
    const attach = provider.attach({}, true, { ...process.env, PATH: emptyBin })
    await attach.until(
      () => attach.messages.some((message) => message.type === 'error'),
      'Missing runtime protocol error',
    )
    expect(attach.messages).toHaveLength(1)
    expect(attach.messages[0].message).toMatch(/Node\.js or Python 3/)
    expect(attach.messages.some((message) => message.type === 'ready')).toBe(false)
    expect((await attach.exited).code).toBe(127)
    expect(await provider.lines('launches')).toEqual([])
    await expect(stat(path.join(provider.root, 'session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, 10000)

  it.each(['node', 'python'] as const)(
    'fences concurrent controllers and observers in the %s broker',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'first-runtime',
        expectedProtocol: 2,
      })
      const ready = await owner.ready()
      expect(ready.protocol).toBe(2)
      expect(ready.writerLease).toEqual({
        epoch: 1,
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      const peer = provider.attach({
        launch: false,
        controllerId: 'first-runtime',
        expectedProtocol: 2,
      })
      expect(await peer.ready()).toMatchObject({ protocol: 2, writerUnavailable: true })
      const observer = provider.attach({
        launch: false,
        controllerId: 'observer-runtime',
        observer: true,
        expectedProtocol: 2,
      })
      expect(await observer.ready()).toMatchObject({ protocol: 2, observer: true })
      expect(peer.messages.find((message) => message.type === 'ready')!.writerLease).toBeUndefined()
      const raw = await rawAttach(provider)
      try {
        await owner.until(
          () => raw.messages.some((message) => message.type === 'ready'),
          'Raw observer ready',
        )
        for (const type of ['write', 'signal', 'end', 'close']) {
          raw.send({
            type,
            sequence: 1,
            writerLease: ready.writerLease,
            ...(type === 'write'
              ? { data: Buffer.from('forbidden\n').toString('base64') }
              : type === 'signal'
                ? { signal: 'SIGTERM' }
                : {}),
          })
        }
        await owner.until(
          () => raw.messages.filter((message) => message.type === 'error').length === 4,
          'Observer mutation refusals',
        )
        expect(
          raw.messages
            .filter((message) => message.type === 'error')
            .every((message) => /writer lease/.test(message.message!)),
        ).toBe(true)
        owner.write(1, '  exact prompt with trailing spaces  \n')
        await owner.until(
          () => owner.output().includes('input:  exact prompt with trailing spaces  \n'),
          'Owned input after observer refusals',
        )
        expect(await readFile(path.join(provider.root, 'inputs'))).toEqual(
          Buffer.from('  exact prompt with trailing spaces  \n'),
        )
        owner.write(3, 'queued while observing\n')
        await delay(50)
        raw.socket.destroy()
        await delay(50)
        owner.write(2, 'owner second input\n')
        await owner.until(
          () => owner.output().includes('input:queued while observing\n'),
          'Observer disconnect retained owner future queue',
        )
        expect(await readFile(path.join(provider.root, 'inputs'))).toEqual(
          Buffer.from(
            '  exact prompt with trailing spaces  \nowner second input\nqueued while observing\n',
          ),
        )
        expect(await provider.lines('launches')).toHaveLength(1)
        expect(owner.messages.some((message) => message.type === 'replayComplete')).toBe(true)
      } finally {
        raw.socket.destroy()
      }
      await owner.close()
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'transfers %s ownership without applying stale queued or conflicting accepted inputs',
    async (runtime) => {
      const provider = await fixture()
      const first = await attachRuntime(provider, runtime, {
        controllerId: 'old-runtime',
        expectedProtocol: 2,
      })
      const before = await first.ready()
      first.write(1, 'already accepted\n')
      await first.until(
        () => first.output().includes('input:already accepted\n'),
        'Accepted original input',
      )
      first.write(3, 'old queued command\n')
      await delay(50)
      first.child.kill('SIGKILL')
      await first.exited
      const resumed = await attachRuntime(provider, runtime === 'node' ? 'python' : 'node', {
        launch: false,
        controllerId: 'new-runtime',
        expectedProtocol: 2,
      })
      const after = await resumed.ready()
      expect(after.pid).toBe(before.pid)
      expect(after.lastInputSequence).toBe(1)
      expect(after.writerLease!.epoch).toBe(2)
      expect(after.writerLease!.token).not.toBe(before.writerLease!.token)
      resumed.write(1, 'already accepted\n')
      resumed.send({
        type: 'write',
        sequence: 2,
        data: Buffer.from('stale lease\n').toString('base64'),
        writerLease: before.writerLease,
      })
      await resumed.until(
        () => resumed.messages.some((message) => message.type === 'error'),
        'Stale lease rejection',
      )
      expect(resumed.messages.find((message) => message.type === 'error')!.message).toMatch(
        /writer lease/,
      )
      resumed.messages.splice(
        resumed.messages.findIndex((message) => message.type === 'error'),
        1,
      )
      resumed.write(2, 'new second command\n')
      await resumed.until(
        () => resumed.output().includes('input:new second command\n'),
        'New owner second input',
      )
      await delay(50)
      expect(await provider.lines('inputs')).toEqual(['already accepted', 'new second command'])
      resumed.write(3, 'new third command\n')
      await resumed.until(
        () => resumed.output().includes('input:new third command\n'),
        'New owner third input',
      )
      resumed.write(1, 'conflicting accepted bytes\n')
      await resumed.until(
        () => resumed.messages.some((message) => message.type === 'error'),
        'Applied sequence conflict',
      )
      expect(resumed.messages.find((message) => message.type === 'error')!.message).toMatch(
        /Conflicting remote agent input sequence/,
      )
      resumed.messages.splice(
        resumed.messages.findIndex((message) => message.type === 'error'),
        1,
      )
      expect(await provider.lines('inputs')).toEqual([
        'already accepted',
        'new second command',
        'new third command',
      ])
      expect((await stat(path.join(provider.root, 'input-digests'))).size).toBe(3 * 40)
      expect(await provider.lines('launches')).toHaveLength(1)
      await resumed.close()
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'replays a completed %s broker offline without granting a writer',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'original-runtime',
        expectedProtocol: 2,
      })
      await owner.ready()
      owner.write(1, 'final exact input\n')
      owner.send({
        type: 'end',
        sequence: 2,
        writerLease: owner.messages.find((message) => message.type === 'ready')!.writerLease,
      })
      await owner.until(
        () => owner.messages.some((message) => message.type === 'exit'),
        'Terminal provider output',
      )
      await owner.exited
      await owner.until(
        () =>
          !existsSync(socketPath(provider)) && !existsSync(path.join(provider.root, 'daemon.lock')),
        'Detached broker shutdown',
      )
      const replay = await attachRuntime(provider, runtime === 'node' ? 'python' : 'node', {
        launch: false,
        controllerId: 'recovery-runtime',
        expectedProtocol: 2,
      })
      const ready = await replay.ready()
      expect(ready).toMatchObject({ protocol: 2, terminal: true, lastInputSequence: 2 })
      expect(ready.writerLease).toBeUndefined()
      await replay.until(
        () => replay.messages.some((message) => message.type === 'replayComplete'),
        'Offline replay barrier',
      )
      expect(replay.output()).toContain('input:final exact input\n')
      expect(
        replay.messages.find((message) => message.type === 'replayComplete')!.replayCursor,
      ).toBe(ready.cursor)
      expect(await provider.lines('launches')).toHaveLength(1)
    },
    15000,
  )

  it('rejects malformed unauthenticated JSON without disturbing the owner', async () => {
    const provider = await fixture()
    const owner = provider.attach({ controllerId: 'owner', expectedProtocol: 2 })
    await owner.ready()
    for (const frame of [null, 1, [], true, 'invalid']) {
      const socket = createConnection(socketPath(provider))
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      socket.write(JSON.stringify(frame) + '\n')
      await closed
    }
    owner.write(1, 'still alive\n')
    await owner.until(
      () => owner.output().includes('input:still alive\n'),
      'Owner input after malformed attachments',
    )
    expect(await provider.lines('launches')).toHaveLength(1)
    await owner.close()
  }, 15000)

  it.each(['node', 'python'] as const)(
    'does not start a missing provider for a %s observer or unsupported protocol',
    async (runtime) => {
      const provider = await fixture()
      const observer = await attachRuntime(provider, runtime, {
        observer: true,
        controllerId: 'observer',
        expectedProtocol: 2,
      })
      await observer.until(
        () => observer.messages.some((message) => message.type === 'error'),
        'Observer missing-session refusal',
      )
      expect(await provider.lines('launches')).toEqual([])
      const unsupported = await attachRuntime(provider, runtime, {
        controllerId: 'owner',
        expectedProtocol: 3,
      })
      await unsupported.until(
        () => unsupported.messages.some((message) => message.type === 'error'),
        'Unsupported protocol refusal',
      )
      expect(unsupported.messages.find((message) => message.type === 'error')!.message).toMatch(
        /Unsupported remote agent broker protocol/,
      )
      expect(await provider.lines('launches')).toEqual([])
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'withholds buffered %s mutations from an unfenced broker',
    async (runtime) => {
      const provider = await fixture()
      const token = 'legacy-private-token'
      await writeFile(
        path.join(provider.root, 'session.json'),
        JSON.stringify({ id: 'provider-session', token, command: provider.command }),
      )
      const received: unknown[] = []
      const sockets = new Set<Socket>()
      const server = createServer((socket) => {
        sockets.add(socket)
        let pending = ''
        socket.setEncoding('utf8')
        socket.on('data', (data: string) => {
          pending += data
          while (pending.includes('\n')) {
            const newline = pending.indexOf('\n')
            const frame = JSON.parse(pending.slice(0, newline)) as { type: string }
            received.push(frame)
            pending = pending.slice(newline + 1)
            if (frame.type === 'attach')
              socket.write(
                JSON.stringify({ type: 'ready', pid: 123, cursor: 0, lastInputSequence: 0 }) + '\n',
              )
          }
        })
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath(provider), resolve)
      })
      try {
        const attach = await attachRuntime(provider, runtime, {
          launch: false,
          controllerId: 'recovery',
          expectedProtocol: 2,
        })
        attach.send({
          type: 'write',
          sequence: 1,
          data: Buffer.from('must not be resent\n').toString('base64'),
        })
        await attach.until(
          () => attach.messages.some((message) => message.type === 'error'),
          'Unfenced broker refusal',
        )
        expect(attach.messages.find((message) => message.type === 'error')!.message).toMatch(
          /required fenced protocol/,
        )
        await attach.exited
        expect(received).toHaveLength(1)
        expect((received[0] as { type: string }).type).toBe('attach')
        expect(attach.messages.some((message) => message.type === 'ready')).toBe(false)
        expect(await provider.lines('launches')).toEqual([])
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'removes %s mutation authority after an incomplete accepted digest',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'owner',
        expectedProtocol: 2,
      })
      await owner.ready()
      owner.write(1, 'committed original\n')
      await owner.until(
        () => owner.output().includes('input:committed original\n'),
        'Original accepted input',
      )
      await truncate(path.join(provider.root, 'input-digests'), 39)
      owner.write(2, 'must not repair a damaged journal\n')
      await owner.until(
        () => owner.messages.some((message) => message.type === 'error'),
        'Incomplete digest refusal',
      )
      expect(owner.messages.find((message) => message.type === 'error')!.message).toMatch(
        /input journal is incomplete/,
      )
      owner.messages.splice(
        owner.messages.findIndex((message) => message.type === 'error'),
        1,
      )
      owner.write(1, 'committed original\n')
      await owner.until(
        () => owner.messages.some((message) => message.type === 'error'),
        'Mutation unavailable refusal',
      )
      expect(owner.messages.find((message) => message.type === 'error')!.message).toMatch(
        /Mutation ownership is unavailable/,
      )
      expect(await provider.lines('inputs')).toEqual(['committed original'])
      owner.child.kill('SIGKILL')
      await owner.exited
      await delay(50)
      const recovered = provider.attach({
        launch: false,
        controllerId: 'new-owner',
        expectedProtocol: 2,
      })
      expect(await recovered.ready()).toMatchObject({ protocol: 2, writerUnavailable: true })
      expect(
        recovered.messages.find((message) => message.type === 'ready')!.writerLease,
      ).toBeUndefined()
      await recovered.until(
        () => recovered.messages.some((message) => message.type === 'replayComplete'),
        'Read-only recovery after journal failure',
      )
      expect(recovered.output()).toContain('input:committed original\n')
      expect(await provider.lines('launches')).toHaveLength(1)
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'refuses raw protocol disagreement in the %s broker while preserving its owner',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'owner',
        expectedProtocol: 2,
      })
      await owner.ready()
      const raw = await rawAttach(provider, true, 3)
      try {
        await owner.until(
          () => raw.messages.some((message) => message.type === 'error'),
          'Raw protocol mismatch refusal',
        )
        expect(raw.messages.find((message) => message.type === 'error')!.message).toMatch(
          /Unsupported remote agent broker protocol/,
        )
        expect(raw.messages.some((message) => message.type === 'ready')).toBe(false)
      } finally {
        raw.socket.destroy()
      }
      owner.write(1, 'owner still available\n')
      await owner.until(
        () => owner.output().includes('input:owner still available\n'),
        'Owner preserved after mismatch',
      )
      await owner.close()
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'never accepts a new %s write after its numbered stdin end',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'owner',
        expectedProtocol: 2,
      })
      const ready = await owner.ready()
      const frames = [
        { type: 'write', sequence: 1, data: Buffer.from('final input\n').toString('base64') },
        { type: 'end', sequence: 2 },
        {
          type: 'write',
          sequence: 3,
          data: Buffer.from('must not be acknowledged\n').toString('base64'),
        },
      ].map((frame) => ({ ...frame, writerLease: ready.writerLease }))
      owner.child.stdin.write(frames.map((frame) => JSON.stringify(frame) + '\n').join(''))
      await owner.until(
        () => owner.messages.some((message) => message.type === 'error'),
        'Write after stdin end rejection',
      )
      expect(owner.messages.find((message) => message.type === 'error')!.message).toMatch(
        /(?:input stream|session) has ended/,
      )
      expect(
        owner.messages.some((message) => message.type === 'ack' && message.sequence === 3),
      ).toBe(false)
      expect((await stat(path.join(provider.root, 'input-digests'))).size).toBe(80)
      owner.messages.splice(
        owner.messages.findIndex((message) => message.type === 'error'),
        1,
      )
      await owner.until(
        () => owner.messages.some((message) => message.type === 'exit'),
        'Native completion after refused write',
      )
      expect(await provider.lines('inputs')).toEqual(['final input'])
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'preserves exact UTF-8 bytes and native escaped prompt text across %s ownership recovery',
    async (runtime) => {
      const provider = await fixture()
      const first = await attachRuntime(provider, runtime, {
        controllerId: 'original',
        expectedProtocol: 2,
      })
      const ready = await first.ready()
      const original =
        JSON.stringify({
          prompt: '  🧪 café 中文 \r\npartial-surrogate:\ud800-gap-\udfff  ',
          requestId: 'native-original-id',
        }) + '\n'
      const frame = {
        type: 'write',
        sequence: 1,
        data: Buffer.from(original).toString('base64'),
        writerLease: ready.writerLease,
      }
      const encoded = JSON.stringify(frame) + '\n'
      for (const fragment of [encoded.slice(0, 17), encoded.slice(17, -2), encoded.slice(-2)])
        first.child.stdin.write(fragment)
      await first.until(
        () => first.output().includes('input:' + original),
        'Exact original provider bytes',
      )
      expect(await readFile(path.join(provider.root, 'input-bytes'))).toEqual(Buffer.from(original))
      first.child.kill('SIGKILL')
      await first.exited
      await delay(50)
      const next = await attachRuntime(provider, runtime === 'node' ? 'python' : 'node', {
        launch: false,
        controllerId: 'replacement',
        expectedProtocol: 2,
      })
      const nextReady = await next.ready()
      expect(nextReady.pid).toBe(ready.pid)
      next.send({ ...frame, writerLease: nextReady.writerLease })
      await next.until(
        () => next.messages.some((message) => message.type === 'ack' && message.sequence === 1),
        'Exact envelope retry acknowledgement',
      )
      expect(await readFile(path.join(provider.root, 'input-bytes'))).toEqual(Buffer.from(original))
      expect(await provider.lines('launches')).toHaveLength(1)
      await next.close()
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'refuses a foreign launch command when rejoining the %s broker',
    async (runtime) => {
      const provider = await fixture()
      const owner = await attachRuntime(provider, runtime, {
        controllerId: 'owner',
        expectedProtocol: 2,
      })
      const ready = await owner.ready()
      const foreign = await attachRuntime(provider, runtime === 'node' ? 'python' : 'node', {
        launch: false,
        controllerId: 'other',
        expectedProtocol: 2,
        command: provider.command + ' # foreign provider configuration',
      })
      await foreign.until(
        () => foreign.messages.some((message) => message.type === 'error'),
        'Foreign launch command refusal',
      )
      expect(foreign.messages.find((message) => message.type === 'error')!.message).toMatch(
        /different launch command/,
      )
      expect(foreign.messages.some((message) => message.type === 'ready')).toBe(false)
      owner.write(1, 'original owner unchanged\n')
      await owner.until(
        () => owner.output().includes('input:original owner unchanged\n'),
        'Original launch ownership preserved',
      )
      expect(owner.messages.find((message) => message.type === 'ready')!.pid).toBe(ready.pid)
      expect(await provider.lines('launches')).toHaveLength(1)
      await owner.close()
    },
    15000,
  )

  it.each(['node', 'python'] as const)(
    'distinguishes unobserved %s child termination through the actual forced broker journal path',
    async (runtime) => {
      const productionSource =
        runtime === 'node' ? REMOTE_AGENT_BROKER_SOURCE : REMOTE_AGENT_BROKER_PYTHON_SOURCE
      const baselineSource =
        runtime === 'node'
          ? productionSource
              .replace(
                'function finish(code, signal, nativeExitConfirmed = true)',
                'function finish(code, signal)',
              )
              .replace(', ...(nativeExitConfirmed ? {} : { nativeExitConfirmed: false })', '')
              .replace(
                "const nativeExitConfirmed = Number.isInteger(provider.exitCode) || !!provider.signalCode\n          finish(provider.exitCode, provider.signalCode || (nativeExitConfirmed ? null : 'SIGKILL'), nativeExitConfirmed)",
                "finish(null, 'SIGKILL')",
              )
          : productionSource.replace(
              ', **({"nativeExitConfirmed": False} if code is None else {})',
              '',
            )
      expect(baselineSource).not.toBe(productionSource)
      const proofs: Record<string, unknown>[] = []
      for (const [phase, source] of [
        ['baseline', baselineSource],
        ['candidate', productionSource],
      ] as const) {
        const provider = await fixture()
        const providerSource = `
        const fs = require('node:fs');
        const root = ${JSON.stringify(provider.root)};
        fs.appendFileSync(root + '/launches', process.pid + '\\n');
        let ticks = 0;
        const tick = () => {
          fs.writeFileSync(root + '/ticks.tmp', String(++ticks));
          fs.renameSync(root + '/ticks.tmp', root + '/ticks');
        };
        tick();
        setInterval(tick, 20);
        process.stdin.resume();
        process.stdin.on('error', () => {});
        process.stdout.on('error', () => {});
        process.stdout.write('started\\n');
      `
        provider.command = `${quote(process.execPath)} -e ${quote(providerSource)}`
        const faultSource =
          runtime === 'node'
            ? source
                .replace('process.kill(-provider.pid, signal)', 'void signal')
                .replace('        }, 1000)\n      }, 5000)', '        }, 50)\n      }, 50)')
            : source
                .replace('os.killpg(provider.pid, getattr(signal, name))', 'return')
                .replace(
                  'threading.Timer(5, lambda: kill_provider("SIGKILL"))',
                  'threading.Timer(0.05, lambda: kill_provider("SIGKILL"))',
                )
                .replace(
                  'threading.Timer(6, lambda: finish_provider(provider.poll(), "SIGTERM"))',
                  'threading.Timer(0.1, lambda: finish_provider(provider.poll(), "SIGTERM"))',
                )
        expect(faultSource).not.toBe(source)
        const owner = provider.attach(
          { controllerId: 'terminal-proof', expectedProtocol: 2 },
          false,
          process.env,
          faultSource,
          runtime,
        )
        const ready = await owner.ready()
        await owner.until(() => owner.output().includes('started\n'), 'Unobserved child started')
        const childPid = Number((await provider.lines('launches'))[0])
        const stateBefore = JSON.parse(
          await readFile(path.join(provider.root, 'state.json'), 'utf8'),
        ) as { id: string; pid: number; brokerPid: number }
        expect(stateBefore.id).toBe('provider-session')
        expect(stateBefore.pid).toBe(ready.pid)
        expect(stateBefore.brokerPid).toBeGreaterThan(0)
        expect(childPid).toBeGreaterThan(0)
        expect(childPid).not.toBe(process.pid)
        const ticksBefore = Number(await readFile(path.join(provider.root, 'ticks'), 'utf8'))
        owner.send({ type: 'close', sequence: 1, writerLease: ready.writerLease })
        await owner.until(
          () => owner.messages.some((message) => message.type === 'exit'),
          'Forced broker journal record',
        )
        const terminal = owner.messages.find((message) => message.type === 'exit')!
        expect(terminal.code).toBeNull()
        expect(terminal.nativeExitConfirmed).toBe(phase === 'candidate' ? false : undefined)
        await owner.exited
        process.kill(childPid, 0)
        await delay(100)
        const ticksAfter = Number(await readFile(path.join(provider.root, 'ticks'), 'utf8'))
        expect(ticksAfter).toBeGreaterThan(ticksBefore)
        const stateAfter = JSON.parse(
          await readFile(path.join(provider.root, 'state.json'), 'utf8'),
        ) as { exited: boolean; lastInputSequence: number }
        expect(stateAfter).toMatchObject({ exited: true, lastInputSequence: 1 })
        const journal = (await readFile(path.join(provider.root, 'journal.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(journal[journal.length - 1]).toMatchObject({
          type: 'exit',
          code: null,
          ...(phase === 'candidate' ? { nativeExitConfirmed: false } : {}),
        })
        const replay = provider.attach({
          launch: false,
          controllerId: 'terminal-proof-replay',
          expectedProtocol: 2,
        })
        await replay.until(
          () => replay.messages.some((message) => message.type === 'replayComplete'),
          'Forced journal cold replay',
        )
        expect(
          replay.messages.find((message) => message.type === 'exit')!.nativeExitConfirmed,
        ).toBe(phase === 'candidate' ? false : undefined)
        await replay.exited
        process.kill(-stateBefore.pid, 'SIGKILL')
        await delay(100)
        const status = await readFile(`/proc/${childPid}/stat`, 'utf8').catch(() => '')
        expect(status === '' || status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')).toBe(
          true,
        )
        const stoppedAt = await readFile(path.join(provider.root, 'ticks'), 'utf8')
        await delay(100)
        expect(await readFile(path.join(provider.root, 'ticks'), 'utf8')).toBe(stoppedAt)
        proofs.push({
          phase,
          runtime,
          root: provider.root,
          providerPid: stateBefore.pid,
          childPid,
          brokerPid: stateBefore.brokerPid,
          sourceSha256: createHash('sha256').update(source).digest('hex'),
          faultSourceSha256: createHash('sha256').update(faultSource).digest('hex'),
          nativeExitConfirmed: terminal.nativeExitConfirmed ?? 'legacy-default',
          nativeChildAliveAtJournal: true,
          ticksBefore,
          ticksAfter,
          brokerStateExitedMeansJournalClosed: stateAfter.exited,
          cleanup: { ticksStopped: true, childTerminated: true },
        })
      }
      const proofRoot = path.resolve('output/broker-unobserved-close')
      await mkdir(proofRoot, { recursive: true })
      await writeFile(
        path.join(proofRoot, runtime + '-proof.json'),
        JSON.stringify(
          {
            runtime,
            matchedFixture: true,
            baselineFalseNativeTerminal: 1,
            candidateFalseNativeTerminal: 0,
            proofs,
          },
          null,
          2,
        ) + '\n',
      )
    },
    20000,
  )

  it.each(['node', 'python'] as const)(
    'records exact %s pipe receipts instead of inferring delivery from accepted ACKs',
    async (runtime) => {
      const source =
        runtime === 'node' ? REMOTE_AGENT_BROKER_SOURCE : REMOTE_AGENT_BROKER_PYTHON_SOURCE
      const phases: Record<string, unknown>[] = []
      for (const mode of ['paused', 'partial', 'complete'] as const) {
        const provider = await fixture()
        const payload = Buffer.from(
          JSON.stringify({
            nativeRequestId: 'same-original-request',
            prompt: '🧪  exact prompt  ' + 'x'.repeat(512 * 1024),
          }) + '\n',
        )
        const second = Buffer.from('must remain queued before close\n')
        const providerSource = `
        const fs = require('node:fs');
        const root = ${JSON.stringify(provider.root)};
        const mode = ${JSON.stringify(mode)};
        fs.appendFileSync(root + '/launches',process.pid+'\\n');
        fs.writeFileSync(root + '/input-bytes',Buffer.alloc(0));
        fs.writeFileSync(root + '/total','0');
        process.stdout.write('started\\n');
        setInterval(()=>{},20);
          if(mode==='paused') {
            process.on('SIGTERM',()=>{
              setTimeout(()=>{
                process.stdin.on('data',chunk=>fs.appendFileSync(root+'/input-bytes',chunk));
                process.stdin.on('end',()=>process.exit(0));
                process.stdin.resume();
              },80);
            });
            const {execFileSync}=require('node:child_process');
            setInterval(()=>{
              try {
                const observation=execFileSync('python3',['-c',${JSON.stringify("import array,fcntl,json,os,socket,termios; unread=array.array('i',[0]); fcntl.ioctl(0,termios.FIONREAD,unread,True); capacity=0\ntry:\n capacity=fcntl.fcntl(0,1032)\nexcept OSError:\n channel=socket.fromfd(0,socket.AF_UNIX,socket.SOCK_STREAM); capacity=channel.getsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF); channel.close()\nprint(json.dumps({'bytes':unread[0],'capacity':capacity}))")}],{stdio:['inherit','pipe','ignore'],encoding:'utf8'});
                fs.writeFileSync(root+'/pipe-observation',observation);
              } catch {}
            },20);
          }
        if(mode!=='paused') {
          let total=0;
          process.stdin.on('data',chunk=>{
            fs.appendFileSync(root+'/input-bytes',chunk);
            total+=chunk.length;
            fs.writeFileSync(root+'/total',String(total));
            if(mode==='partial') process.exit(23);
          });
          process.stdin.resume();
        }
      `
        provider.command = `${quote(process.execPath)} -e ${quote(providerSource)}`
        const owner = provider.attach(
          { controllerId: 'pipe-receipt-owner', expectedProtocol: 2 },
          false,
          process.env,
          source,
          runtime,
        )
        const ready = await owner.ready()
        expect(ready.inputReceipts).toBe(1)
        await owner.until(
          () => owner.output().includes('started\n'),
          'Controlled native pipe reader',
        )
        const childPid = Number((await provider.lines('launches'))[0])
        let pausedPipeBytes = 0
        let pausedPipeCapacity = 0
        const frame = {
          type: 'write',
          sequence: 1,
          data: payload.toString('base64'),
          writerLease: ready.writerLease,
        }
        owner.send(frame)
        await owner.until(
          () => owner.messages.some((message) => message.type === 'ack' && message.sequence === 1),
          'Acceptance receipt',
        )
        if (mode === 'paused') {
          if (process.platform === 'linux') {
            const deadline = Date.now() + 3000
            while (pausedPipeBytes === 0 && Date.now() < deadline) {
              const observed = await readFile(
                path.join(provider.root, 'pipe-observation'),
                'utf8',
              ).catch(() => '')
              const observation = (observed ? JSON.parse(observed) : { bytes: 0, capacity: 0 }) as {
                bytes: number
                capacity: number
              }
              pausedPipeBytes = observation.bytes
              pausedPipeCapacity = observation.capacity
              if (pausedPipeBytes === 0) await delay(10)
            }
            expect(pausedPipeBytes).toBeGreaterThan(0)
            expect(pausedPipeCapacity).toBeLessThan(payload.length)
          } else await delay(50)
          owner.write(2, second.toString('utf8'))
          await owner.until(
            () =>
              owner.messages.some((message) => message.type === 'ack' && message.sequence === 2),
            'Second accepted queued input',
          )
          expect(
            owner.messages.filter(
              (message) =>
                message.type === 'inputReceipt' &&
                (message.sequence === 1 || message.sequence === 2),
            ),
          ).toEqual([])
          expect((await readFile(path.join(provider.root, 'input-bytes'))).length).toBe(0)
          owner.send({ type: 'close', sequence: 3, writerLease: ready.writerLease })
        } else if (mode === 'complete') {
          await owner.until(
            () =>
              owner.messages.some(
                (message) => message.type === 'inputReceipt' && message.sequence === 1,
              ),
            'Full pipe delivery receipt',
          )
          expect(
            owner.messages.find(
              (message) => message.type === 'inputReceipt' && message.sequence === 1,
            )!.status,
          ).toBe('written')
          const deadline = Date.now() + 3000
          while (
            (await readFile(path.join(provider.root, 'input-bytes'))).length < payload.length &&
            Date.now() < deadline
          )
            await delay(10)
          expect(await readFile(path.join(provider.root, 'input-bytes'))).toEqual(payload)
          owner.send(frame)
          await delay(50)
          expect(
            owner.messages.filter(
              (message) => message.type === 'inputReceipt' && message.sequence === 1,
            ),
          ).toHaveLength(1)
          expect(await readFile(path.join(provider.root, 'input-bytes'))).toEqual(payload)
          owner.send({ type: 'close', sequence: 2, writerLease: ready.writerLease })
        }
        await owner.until(
          () => owner.messages.some((message) => message.type === 'exit'),
          'Controlled pipe terminal',
        )
        await owner.exited
        const receipts = owner.messages.filter((message) => message.type === 'inputReceipt')
        const first = receipts.find((message) => message.sequence === 1)!
        expect(first.status).toBe(mode === 'complete' ? 'written' : 'uncertain')
        const bytes = await readFile(path.join(provider.root, 'input-bytes'))
        if (mode === 'partial') {
          expect(bytes.length).toBeGreaterThan(0)
          expect(bytes.length).toBeLessThan(payload.length)
          expect(bytes).toEqual(payload.subarray(0, bytes.length))
        }
        if (mode === 'paused') {
          expect(bytes.length).toBeGreaterThan(0)
          expect(bytes.length).toBeLessThan(payload.length)
          expect(bytes).toEqual(payload.subarray(0, bytes.length))
          expect(receipts.find((message) => message.sequence === 2)!.status).toBe('cancelled')
          expect(receipts.find((message) => message.sequence === 3)!.status).toBe('written')
        }
        const replay = provider.attach({
          launch: false,
          controllerId: 'pipe-receipt-replay',
          expectedProtocol: 2,
        })
        const replayReady = await replay.ready()
        expect(replayReady.inputReceipts).toBe(1)
        await replay.until(
          () => replay.messages.some((message) => message.type === 'replayComplete'),
          'Delivery evidence cold replay',
        )
        expect(
          replay.messages
            .filter((message) => message.type === 'inputReceipt')
            .map(({ sequence, status }) => ({ sequence, status })),
        ).toEqual(receipts.map(({ sequence, status }) => ({ sequence, status })))
        await replay.exited
        const journal = (await readFile(path.join(provider.root, 'journal.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(journal[journal.length - 1].type).toBe('exit')
        expect(
          journal
            .filter((message) => message.type === 'inputReceipt')
            .map(({ sequence, status }: BrokerMessage) => ({ sequence, status })),
        ).toEqual(receipts.map(({ sequence, status }) => ({ sequence, status })))
        phases.push({
          mode,
          root: provider.root,
          acceptedAck: true,
          inputReceiptsCapability: replayReady.inputReceipts,
          payloadBytes: payload.length,
          providerObservedBytes: bytes.length,
          pausedPipeBytes,
          pausedPipeCapacity,
          exactPrefix: true,
          receipts: receipts.map(({ cursor, sequence, status }) => ({ cursor, sequence, status })),
          duplicatePayloadResent: false,
          providerApplicationInferred: false,
        })
      }
      const proofRoot = path.resolve('output/broker-input-receipts')
      await mkdir(proofRoot, { recursive: true })
      await writeFile(
        path.join(proofRoot, runtime + '-proof.json'),
        JSON.stringify(
          { runtime, sourceSha256: createHash('sha256').update(source).digest('hex'), phases },
          null,
          2,
        ) + '\n',
      )
    },
    20000,
  )
})
