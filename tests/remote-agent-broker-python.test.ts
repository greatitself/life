import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_AGENT_BROKER_PYTHON_SOURCE } from '../src/main/remote-agent-broker-python'
import { REMOTE_AGENT_BROKER_SOURCE } from '../src/main/remote-agent-broker'

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
    runtime: 'python' | 'node' = 'python',
    pythonSource = REMOTE_AGENT_BROKER_PYTHON_SOURCE,
  ) {
    this.cursor = config.cursor ?? 0
    this.child = spawn(
      runtime === 'node' ? process.execPath : 'python3',
      [
        runtime === 'node' ? '-e' : '-c',
        runtime === 'node' ? REMOTE_AGENT_BROKER_SOURCE : pythonSource,
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
          if (['stdout', 'stderr', 'exit'].includes(message.type) && message.cursor != null) {
            this.cursor = Math.max(this.cursor, message.cursor)
          }
        } catch {
          this.errors.push('Broker emitted invalid JSON')
        }
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()))
    this.child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        this.errors.push(error.message)
      }
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
    this.send({ type: 'close', sequence })
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
    runtime: 'python' | 'node' = 'python',
    pythonSource?: string,
  ) {
    const attach = new BrokerAttach(
      {
        id: 'provider-session',
        root: this.root,
        command: this.command,
        ...options,
      },
      runtime,
      pythonSource,
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
  const value = new ProviderFixture(await mkdtemp(path.join(tmpdir(), 'life-python-broker-test-')))
  fixtures.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()))
})

describe.skipIf(process.platform === 'win32')('Python remote agent broker SSH continuity', () => {
  it('accepts two valid input frames that share a receive buffer exceeding the per-frame limit', async () => {
    const provider = await fixture()
    provider.command = `${quote(process.execPath)} -e ${quote(`
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        fs.appendFileSync(${JSON.stringify(path.join(provider.root, 'inputs'))}, line + '\\n');
        process.stdout.write('received:' + line.length + '\\n');
      });
    `)}`
    const source = REMOTE_AGENT_BROKER_PYTHON_SOURCE.replace(
      'MAX_INPUT = 24 * 1024 * 1024',
      'MAX_INPUT = 8192',
    )
    const attach = provider.attach({}, 'python', source)
    await attach.ready()
    const first = 'a'.repeat(5300)
    const second = 'b'.repeat(3600)
    const firstFrame =
      JSON.stringify({
        type: 'write',
        sequence: 1,
        data: Buffer.from(first + '\n').toString('base64'),
      }) + '\n'
    const secondFrame =
      JSON.stringify({
        type: 'write',
        sequence: 2,
        data: Buffer.from(second + '\n').toString('base64'),
      }) + '\n'
    expect(Buffer.byteLength(firstFrame)).toBeLessThan(8192)
    expect(Buffer.byteLength(secondFrame)).toBeLessThan(8192)
    expect(Buffer.byteLength(firstFrame + secondFrame)).toBeGreaterThan(8192)
    attach.child.stdin.write(firstFrame.slice(0, -50))
    await delay(100)
    attach.child.stdin.write(firstFrame.slice(-50) + secondFrame)
    await attach.until(
      () => attach.output().includes('received:3600\n'),
      'Combined valid frames accepted',
    )
    expect(await provider.lines('inputs')).toEqual([first, second])
    await attach.close()
  }, 15000)

  it('discards a truncated socket frame before replaying its complete journal record', async () => {
    const provider = await fixture()
    const id = 'provider-session'
    const token = 'a'.repeat(64)
    const frame = {
      type: 'stdout',
      cursor: 1,
      data: Buffer.from('entire output survives\n').toString('base64'),
    }
    const exit = { type: 'exit', cursor: 2, code: 0, signal: null }
    await writeFile(
      path.join(provider.root, 'session.json'),
      JSON.stringify({ id, command: provider.command, token }),
      { mode: 0o600 },
    )
    await writeFile(
      path.join(provider.root, 'state.json'),
      JSON.stringify({ id, pid: process.pid, cursor: 2, lastInputSequence: 0, exited: true }),
      { mode: 0o600 },
    )
    await writeFile(
      path.join(provider.root, 'journal.jsonl'),
      JSON.stringify(frame) + '\n' + JSON.stringify(exit) + '\n',
      { mode: 0o600 },
    )
    const hash = createHash('sha256')
      .update(provider.root + '\0' + id)
      .digest('hex')
      .slice(0, 28)
    const socketPath = path.join(tmpdir(), `life-${process.getuid!()}-${hash}.sock`)
    const server = createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', (data) => {
        const auth = JSON.parse(data.toString()) as { token: string }
        expect(auth.token).toBe(token)
        socket.end(
          JSON.stringify({ type: 'ready', pid: process.pid, cursor: 2, lastInputSequence: 0 }) +
            '\n' +
            JSON.stringify(frame).slice(0, 24),
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      const attach = provider.attach({ launch: false })
      await attach.until(
        () => attach.messages.some((message) => message.type === 'exit'),
        'Truncated frame recovered',
      )
      expect(attach.errors).toEqual([])
      expect(attach.messages.map((message) => message.type)).toEqual(['ready', 'stdout', 'exit'])
      expect(attach.output()).toBe('entire output survives\n')
      expect((await attach.exited).code).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }, 15000)

  it.each([
    ['python', 'node'],
    ['node', 'python'],
  ] as const)(
    'reattaches a %s daemon through the %s runtime without restarting it',
    async (initial, resumedRuntime) => {
      const provider = await fixture()
      const first = provider.attach({}, initial)
      const before = await first.ready()
      await first.until(
        () => first.output().includes('tick:1\n'),
        'Initial output before runtime change',
      )
      first.child.kill('SIGKILL')
      await first.exited
      const cursor = first.cursor
      await delay(120)
      const resumed = provider.attach({ launch: false, cursor }, resumedRuntime)
      expect((await resumed.ready()).pid).toBe(before.pid)
      resumed.write(1, 'cross runtime\n')
      await resumed.until(
        () => resumed.output().includes('input:cross runtime\n'),
        'Cross-runtime provider input',
      )
      await resumed.close()
      const journal = (await readFile(path.join(provider.root, 'journal.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as BrokerMessage)
      const journalOutput = journal
        .filter((frame) => frame.type === 'stdout')
        .map((frame) => Buffer.from(frame.data!, 'base64').toString())
        .join('')
      expect(first.output() + resumed.output()).toBe(journalOutput)
      expect(await provider.lines('launches')).toHaveLength(1)
      expect(await provider.lines('inputs')).toEqual(['cross runtime'])
    },
    15000,
  )

  it('deduplicates input whose acknowledgement was lost when the SSH attachment ended', async () => {
    const provider = await fixture()
    const first = provider.attach()
    await first.ready()
    first.child.stdout.pause()
    first.write(1, 'accepted before disconnect\n')
    const deadline = Date.now() + 5000
    while ((await provider.lines('inputs')).length === 0) {
      if (Date.now() >= deadline) throw new Error('Provider did not accept the input')
      await delay(10)
    }
    first.child.kill('SIGKILL')
    first.child.stdout.resume()
    await first.exited
    const resumed = provider.attach({ launch: false, cursor: first.cursor })
    expect((await resumed.ready()).lastInputSequence).toBe(1)
    resumed.write(1, 'accepted before disconnect\n')
    resumed.write(2, 'new input\n')
    await resumed.until(
      () => resumed.output().includes('input:new input\n'),
      'Input after lost acknowledgement',
    )
    expect(await provider.lines('inputs')).toEqual(['accepted before disconnect', 'new input'])
    await resumed.close()
  }, 15000)

  it('replays completion that happened while no SSH attachment was connected', async () => {
    const provider = await fixture()
    provider.command = `${quote(process.execPath)} -e ${quote(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(path.join(provider.root, 'launches'))}, process.pid + '\\n');
      process.stdout.write('started\\n');
      setTimeout(() => { process.stdout.write('completed while detached\\n'); process.exit(0); }, 180);
    `)}`
    const first = provider.attach()
    await first.ready()
    await first.until(() => first.output().includes('started\n'), 'Provider started before detach')
    first.child.kill('SIGKILL')
    await first.exited
    await delay(250)
    const resumed = provider.attach({ launch: false, cursor: first.cursor })
    await resumed.until(
      () => resumed.messages.some((message) => message.type === 'exit'),
      'Detached completion replay',
    )
    expect(resumed.output()).toBe('completed while detached\n')
    expect(resumed.messages.find((message) => message.type === 'exit')?.code).toBe(0)
    expect(await provider.lines('launches')).toHaveLength(1)
    const alreadyComplete = provider.attach({ launch: false, cursor: resumed.cursor })
    await alreadyComplete.until(
      () => alreadyComplete.messages.some((message) => message.type === 'exit'),
      'Already-delivered terminal confirmation',
    )
    expect(alreadyComplete.output()).toBe('')
    expect(alreadyComplete.messages.find((message) => message.type === 'exit')?.code).toBe(0)
  }, 15000)

  it('refuses to restart a lost daemon even when a reconnect requests launch', async () => {
    const provider = await fixture()
    const first = provider.attach()
    await first.ready()
    const state = JSON.parse(await readFile(path.join(provider.root, 'state.json'), 'utf8')) as {
      pid: number
      brokerPid: number
    }
    first.child.kill('SIGKILL')
    await first.exited
    process.kill(state.brokerPid, 'SIGKILL')
    try {
      const resumed = provider.attach({ launch: true, cursor: first.cursor })
      await resumed.until(
        () => resumed.messages.some((message) => message.type === 'error'),
        'Lost daemon refusal',
      )
      expect(resumed.messages.find((message) => message.type === 'error')?.message).toContain(
        'not restarted',
      )
      expect(resumed.messages.some((message) => message.type === 'ready')).toBe(false)
      expect(await provider.lines('launches')).toHaveLength(1)
    } finally {
      try {
        process.kill(-state.pid, 'SIGKILL')
      } catch {
        /* The broker may already have closed the provider. */
      }
    }
  }, 15000)

  it('finishes an explicit close even when an escaped descendant retains stdout', async () => {
    const provider = await fixture()
    const escapedFile = path.join(provider.root, 'escaped-pid')
    provider.command = `${quote(process.execPath)} -e ${quote(`
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => process.stdout.write("escaped\\\\n"), 100)'],
        { detached: true, stdio: ['ignore', process.stdout, 'ignore'] });
      fs.writeFileSync(${JSON.stringify(escapedFile)}, String(child.pid));
      child.unref();
      process.stdout.write('started\\n');
      setInterval(() => {}, 1000);
    `)}`
    const attach = provider.attach()
    await attach.ready()
    await attach.until(() => attach.output().includes('started\n'), 'Escaped descendant started')
    const escapedPid = Number(await readFile(escapedFile, 'utf8'))
    try {
      attach.send({ type: 'close', sequence: 99 })
      await attach.until(
        () => attach.messages.some((message) => message.type === 'exit'),
        'Bounded descendant close',
        8500,
      )
      const journal = (await readFile(path.join(provider.root, 'journal.jsonl'), 'utf8'))
        .trim()
        .split('\n')
      expect(JSON.parse(journal.at(-1)!).type).toBe('exit')
    } finally {
      try {
        process.kill(-escapedPid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }, 15000)

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

  it('sends exact provider input without interpreting shell quotes or substitutions', async () => {
    const provider = await fixture()
    const attach = provider.attach()
    await attach.ready()
    const text = 'Quotes: \'single\' "double"; dollar $HOME; backticks `untouched`'
    attach.write(1, text + '\n')
    await attach.until(() => attach.output().includes('input:' + text + '\n'), 'Shell attach input')
    expect(await provider.lines('inputs')).toEqual([text])
    expect(await provider.lines('launches')).toHaveLength(1)
    await attach.close()
  }, 15000)
})
