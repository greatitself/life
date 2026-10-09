import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOTE_AGENT_BROKER_SOURCE,
  buildRemoteAgentBrokerCommand,
} from '../src/main/remote-agent-broker'
import { remoteCommand } from '../src/main/ssh'

type BrokerConfig = {
  id: string
  command: string
  root: string
  cursor?: number
  launch?: boolean
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
  ) {
    this.cursor = config.cursor ?? 0
    this.child = throughShell
      ? spawn('/bin/sh', ['-c', buildRemoteAgentBrokerCommand(config)], {
          stdio: 'pipe',
          env: environment,
        })
      : spawn(
          process.execPath,
          ['-e', source, Buffer.from(JSON.stringify(config)).toString('base64')],
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
          if (['stdout', 'stderr', 'exit'].includes(message.type) && message.cursor != null) {
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
    this.send({ type: 'write', sequence, data: Buffer.from(data).toString('base64') })
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
      this.send({ type: 'close', sequence })
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
    let recovery: BrokerAttach | undefined
    try {
      recovery = this.attach({ launch: false })
      await recovery.until(
        () => recovery!.messages.some((message) => ['ready', 'error'].includes(message.type)),
        'Cleanup attach',
        1500,
      )
      if (recovery.messages.some((message) => message.type === 'ready')) await recovery.close()
    } catch {
      // The assertions above report any failure; always reap the test attach processes.
    } finally {
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

    attach.write(1, 'duplicate first\n')
    attach.write(2, 'duplicate second\n')
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
    first.write(1, 'only once\n')
    second.write(1, 'only once\n')
    await first.until(
      () => first.output().includes('input:only once\n'),
      'Shared input acknowledgment',
    )
    await delay(80)
    expect(await provider.lines('inputs')).toEqual(['only once'])
    await first.close()
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
})
