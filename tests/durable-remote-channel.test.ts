import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { Effect } from 'effect'
import type { ConnectionState } from '../src/shared/types'
import { DurableRemoteChannel } from '../src/main/durable-remote-channel'

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: Record<string, unknown>[] = []
  constructor(private readonly observe: (frame: Record<string, unknown>) => void = () => {}) {
    super({ autoDestroy: false })
  }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.inputs.push(
      ...chunk
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    callback()
  }
  frame(frame: Record<string, unknown>) {
    this.observe(frame)
    this.push(JSON.stringify(frame) + '\n')
  }
  close() {
    this.emit('close')
  }
}

const connected: ConnectionState = {
  status: 'connected',
  home: '/home/fixture',
  workspace: '/project',
  profile: {
    id: 'fixture',
    name: 'Fixture',
    host: 'fixture',
    port: 22,
    username: 'fixture',
    auth: 'agent',
    privateKeyPath: '',
    workspace: '/project',
  },
}

class Host extends EventEmitter {
  state = connected
  attachments: Attachment[] = []
  commands: string[] = []
  cursor = 0
  lastInputSequence = 0
  async channel(command: string) {
    const attachment = new Attachment((frame) => {
      if (typeof frame.cursor === 'number') this.cursor = Math.max(this.cursor, frame.cursor)
      if (frame.type === 'ack' && typeof frame.sequence === 'number')
        this.lastInputSequence = Math.max(this.lastInputSequence, frame.sequence)
    })
    this.commands.push(command)
    this.attachments.push(attachment)
    const epoch = this.attachments.length
    setImmediate(() => {
      attachment.frame({
        type: 'ready',
        protocol: 2,
        cursor: this.cursor,
        lastInputSequence: this.lastInputSequence,
        writerLease: { epoch, token: 'fixture-lease-' + epoch },
      })
      attachment.frame({ type: 'replayComplete', replayCursor: this.cursor })
    })
    return attachment as unknown as ClientChannel
  }
  disconnect() {
    this.state = { ...this.state, status: 'disconnected' }
    this.emit('state', this.state)
    this.emit('disconnected')
  }
  reconnect(state = connected) {
    this.state = state
    this.emit('state', state)
  }
}

describe('durable provider transport', () => {
  it('waits for the actual provider exit after an idle close acknowledgement', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const attachment = host.attachments[0]
    let settled = false
    const released = Effect.runPromise(channel.closeAndWaitEffect()).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(attachment.inputs.at(-1)?.type).toBe('close'))
    attachment.frame({ type: 'ack', sequence: attachment.inputs.at(-1)!.sequence })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(channel.transportState).toBe('connected')
    attachment.frame({ type: 'exit', cursor: 1, code: 0, signal: null })
    expect(await released).toBe(true)
    expect(channel.transportState).toBe('closed')
    expect(host.listenerCount('state')).toBe(0)
    expect(host.listenerCount('disconnected')).toBe(0)
  })

  it('keeps reading terminal frames behind paused output without replaying an uncertain input', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const attachment = host.attachments[0]
    attachment.frame({
      type: 'stdout',
      cursor: 1,
      data: Buffer.alloc(65536, 'x').toString('base64'),
    })
    await vi.waitFor(() => expect(attachment.isPaused()).toBe(true))
    channel.write('An unacknowledged user prompt')
    const released = Effect.runPromise(channel.closeAndWaitEffect())
    await vi.waitFor(() => expect(attachment.inputs.at(-1)?.type).toBe('close'))
    attachment.frame({ type: 'ack', sequence: attachment.inputs.at(-1)!.sequence })
    attachment.frame({
      type: 'stdout',
      cursor: 2,
      data: Buffer.from('finishing').toString('base64'),
    })
    attachment.frame({ type: 'exit', cursor: 3, code: 0, signal: null })
    expect(await released).toBe(true)
    expect(attachment.inputs.filter((input) => input.type === 'write')).toHaveLength(1)
  })

  it('bounds an unconfirmed idle shutdown and releases its local listeners', async () => {
    vi.useFakeTimers()
    try {
      const host = new Host()
      const opening = DurableRemoteChannel.open(host, 'codex')
      await vi.runOnlyPendingTimersAsync()
      const channel = await opening
      const released = Effect.runPromise(channel.closeAndWaitEffect(250))
      await vi.advanceTimersByTimeAsync(0)
      host.attachments[0].frame({ type: 'ack', sequence: 1 })
      await vi.advanceTimersByTimeAsync(250)
      expect(await released).toBe(false)
      expect(channel.transportState).toBe('closed')
      expect(host.listenerCount('state')).toBe(0)
      expect(host.listenerCount('disconnected')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a cancelled opening promptly even before its SSH acknowledgement arrives', async () => {
    let acknowledge!: (channel: ClientChannel) => void
    class DelayedHost extends Host {
      override async channel(): Promise<ClientChannel> {
        return new Promise((resolve) => {
          acknowledge = resolve
        })
      }
    }
    const host = new DelayedHost()
    let candidate!: DurableRemoteChannel
    const opening = DurableRemoteChannel.open(host, 'codex', (channel) => {
      candidate = channel
    })
    const rejected = expect(opening).rejects.toThrow('closed before it was ready')
    expect(await Effect.runPromise(candidate.closeAndWaitEffect(20))).toBe(false)
    await rejected
    expect(host.listenerCount('state')).toBe(0)
    const late = new Attachment()
    const closed = vi.spyOn(late, 'close')
    acknowledge(late as unknown as ClientChannel)
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })

  it('bounds unread provider output and resumes delivery in order when the consumer drains', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const attachment = host.attachments[0]
    const chunk = Buffer.alloc(65536, 'x')
    for (let cursor = 1; cursor <= 40; cursor++)
      attachment.frame({ type: 'stdout', cursor, data: chunk.toString('base64') })
    await new Promise((resolve) => setImmediate(resolve))
    expect(channel.readableLength).toBeLessThanOrEqual(chunk.length)
    expect(attachment.isPaused()).toBe(true)
    const output: Buffer[] = []
    channel.on('data', (bytes: Buffer) => output.push(bytes))
    await vi.waitFor(() => expect(Buffer.concat(output).length).toBe(chunk.length * 40))
    expect(Buffer.concat(output).equals(Buffer.alloc(chunk.length * 40, 'x'))).toBe(true)
    channel.close()
    attachment.frame({ type: 'ack', sequence: 1 })
  })

  it('accepts a coalesced transport chunk containing many individually bounded frames', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const errors: Error[] = []
    const output: Buffer[] = []
    channel.on('error', (error: Error) => errors.push(error))
    channel.on('data', (bytes: Buffer) => output.push(bytes))
    const data = Buffer.alloc(65536, 'x').toString('base64')
    host.attachments[0].push(
      Array.from(
        { length: 40 },
        (_, index) => JSON.stringify({ type: 'stdout', cursor: index + 1, data }) + '\n',
      ).join(''),
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual([])
    expect(Buffer.concat(output).length).toBe(65536 * 40)
    channel.close()
    host.attachments[0].frame({ type: 'ack', sequence: 1 })
  })

  it('pauses both output lanes until unread stderr drains', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'claude')
    const attachment = host.attachments[0]
    const stdout: string[] = []
    channel.on('data', (bytes: Buffer) => stdout.push(bytes.toString()))
    const bytes = Buffer.alloc(65536, 'e')
    attachment.frame({ type: 'stderr', cursor: 1, data: bytes.toString('base64') })
    attachment.frame({
      type: 'stdout',
      cursor: 2,
      data: Buffer.from('after stderr').toString('base64'),
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(attachment.isPaused()).toBe(true)
    expect(stdout).toEqual([])
    expect(channel.stderr.readableLength).toBe(bytes.length)
    const stderr: Buffer[] = []
    channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    await vi.waitFor(() => expect(stdout).toEqual(['after stderr']))
    expect(Buffer.concat(stderr).equals(bytes)).toBe(true)
    channel.close()
    attachment.frame({ type: 'ack', sequence: 1 })
  })

  it('reattaches a paused stream without skipping already buffered output', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const bytes = Buffer.alloc(65536, 'x')
    host.attachments[0].frame({ type: 'stdout', cursor: 1, data: bytes.toString('base64') })
    await new Promise((resolve) => setImmediate(resolve))
    host.disconnect()
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
    const second = host.attachments[1]
    await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
    second.frame({ type: 'stdout', cursor: 2, data: Buffer.from('offline').toString('base64') })
    const output: Buffer[] = []
    channel.on('data', (chunk: Buffer) => output.push(chunk))
    await vi.waitFor(() => expect(Buffer.concat(output).length).toBe(bytes.length + 7))
    expect(Buffer.concat(output).equals(Buffer.concat([bytes, Buffer.from('offline')]))).toBe(true)
    channel.close()
    second.frame({ type: 'ack', sequence: 1 })
  })

  it('processes terminal acknowledgement while output consumers stay paused', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'claude')
    const attachment = host.attachments[0]
    attachment.frame({ type: 'stdout', cursor: 1, data: Buffer.alloc(65536).toString('base64') })
    await new Promise((resolve) => setImmediate(resolve))
    expect(attachment.isPaused()).toBe(true)
    channel.close()
    attachment.frame({ type: 'ack', sequence: 1 })
    await vi.waitFor(() => expect(channel.transportState).toBe('closed'))
    expect(host.listenerCount('state')).toBe(0)
  })

  it('releases a destroyed local attachment without terminating the detached provider', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const attachment = host.attachments[0]
    const closed = vi.spyOn(attachment, 'close')
    channel.destroy()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(attachment.inputs).toEqual([])
    expect(host.listenerCount('state')).toBe(0)
    expect(host.listenerCount('disconnected')).toBe(0)
    expect(channel.stderr.destroyed).toBe(true)
  })

  it('still rejects an individually oversized broker frame', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const errors: Error[] = []
    channel.on('error', (error: Error) => errors.push(error))
    host.attachments[0].push('x'.repeat(2_000_001) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors[0]?.message).toContain('oversized frame')
    expect(channel.transportState).toBe('closed')
  })

  it('bounds a stalled broker handshake while the SSH machine remains connected', async () => {
    vi.useFakeTimers()
    try {
      class SilentHost extends Host {
        override async channel(command: string) {
          const attachment = new Attachment()
          this.commands.push(command)
          this.attachments.push(attachment)
          return attachment as unknown as ClientChannel
        }
      }
      const host = new SilentHost()
      const opening = DurableRemoteChannel.open(host, 'codex')
      const rejected = expect(opening).rejects.toThrow('did not become ready within 20 seconds')
      await vi.advanceTimersByTimeAsync(20000)
      await rejected
      expect(host.listenerCount('state')).toBe(0)
      expect(host.listenerCount('disconnected')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains an uncertain initial launch when reconnect wins the late SSH acknowledgement', async () => {
    let rejectFirst!: (error: Error) => void
    class DelayedHost extends Host {
      private first = true
      override async channel(command: string): Promise<ClientChannel> {
        if (this.first) {
          this.first = false
          this.commands.push(command)
          return new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
        }
        return super.channel(command)
      }
    }
    const host = new DelayedHost()
    const opening = DurableRemoteChannel.open(host, 'codex')
    host.disconnect()
    host.reconnect()
    rejectFirst(new Error('SSH exec acknowledgement lost'))
    const channel = await opening
    expect(host.commands).toHaveLength(2)
    const configuration = {
      id: channel.sessionId,
      command: 'codex',
      root: '/home/fixture/.life/agent-sessions/' + channel.sessionId,
      cursor: 0,
    }
    expect(host.commands[0]).toContain(
      Buffer.from(
        JSON.stringify({
          ...configuration,
          launch: true,
          controllerId: channel.controllerId,
          expectedProtocol: 2,
        }),
      ).toString('base64'),
    )
    expect(host.commands[1]).toContain(
      Buffer.from(
        JSON.stringify({
          ...configuration,
          launch: false,
          controllerId: channel.controllerId,
          expectedProtocol: 2,
        }),
      ).toString('base64'),
    )
    expect(channel.transportState).toBe('connected')
    channel.close()
    host.attachments[0].frame({ type: 'ack', sequence: 1 })
  })

  it('reattaches a closed exec channel without requiring the healthy SSH connection to reconnect', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    const received: string[] = []
    channel.on('data', (bytes: Buffer) => received.push(bytes.toString()))
    host.attachments[0].frame({
      type: 'stdout',
      cursor: 1,
      data: Buffer.from('first').toString('base64'),
    })
    await vi.waitFor(() => expect(received).toEqual(['first']))
    host.attachments[0].close()
    await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
    await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
    host.attachments[1].frame({
      type: 'stdout',
      cursor: 2,
      data: Buffer.from('second').toString('base64'),
    })
    await vi.waitFor(() => expect(received).toEqual(['first', 'second']))
    expect(host.state.status).toBe('connected')
    channel.close()
    host.attachments[1].frame({ type: 'ack', sequence: 1 })
  })

  it('keeps the provider channel alive and resumes all offline output exactly once', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex app-server')
    const received: string[] = []
    const closed = vi.fn()
    const suspended = vi.fn()
    const resumed = vi.fn()
    channel.on('data', (data: Buffer) => received.push(data.toString()))
    channel.on('close', closed)
    channel.on('suspended', suspended)
    channel.on('resumed', resumed)
    host.attachments[0].frame({
      type: 'stdout',
      cursor: 1,
      data: Buffer.from('before\n').toString('base64'),
    })
    await vi.waitFor(() => expect(received).toEqual(['before\n']))
    host.disconnect()
    expect(channel.transportState).toBe('suspended')
    expect(suspended).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
    channel.write('exact prompt\n')
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
    const second = host.attachments[1]
    await vi.waitFor(() => expect(second.inputs).toHaveLength(1))
    second.frame({ type: 'stdout', cursor: 1, data: Buffer.from('before\n').toString('base64') })
    second.frame({ type: 'stdout', cursor: 2, data: Buffer.from('offline\n').toString('base64') })
    second.frame({ type: 'ack', sequence: 1 })
    await vi.waitFor(() => expect(received).toEqual(['before\n', 'offline\n']))
    expect(resumed).toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    expect(second.inputs[0]).toMatchObject({
      type: 'write',
      sequence: 1,
      data: Buffer.from('exact prompt\n').toString('base64'),
    })
    channel.close()
    second.frame({ type: 'ack', sequence: 2 })
    await vi.waitFor(() => expect(channel.transportState).toBe('closed'))
    expect(host.listenerCount('state')).toBe(0)
  })

  it('uses the original delivery number when an acknowledgement was lost', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'claude')
    channel.write('one exact prompt\n')
    await vi.waitFor(() => expect(host.attachments[0].inputs).toHaveLength(1))
    const original = host.attachments[0].inputs[0]
    host.disconnect()
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments[1]?.inputs).toHaveLength(1))
    const { writerLease: _oldLease, ...oldFrame } = original
    const { writerLease: _newLease, ...newFrame } = host.attachments[1].inputs[0]
    expect(newFrame).toEqual(oldFrame)
    expect(host.attachments[1].inputs[0].writerLease).toEqual({
      epoch: 2,
      token: 'fixture-lease-2',
    })
    host.attachments[1].frame({ type: 'ack', sequence: 1 })
    channel.close()
    host.attachments[1].frame({ type: 'ack', sequence: 2 })
  })

  it('does not attach an active provider to another SSH machine', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'codex')
    host.disconnect()
    host.reconnect({ ...connected, profile: { ...connected.profile!, host: 'another-machine' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(host.attachments).toHaveLength(1)
    expect(channel.transportState).toBe('suspended')
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments).toHaveLength(2))
    await vi.waitFor(() => expect(channel.transportState).toBe('connected'))
    channel.close()
    host.attachments[1].frame({ type: 'ack', sequence: 1 })
  })

  it('discards unsent input when closed offline and delivers only a terminal instruction', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'claude')
    host.disconnect()
    channel.write('must not be submitted after stop\n')
    channel.close()
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments[1]?.inputs).toHaveLength(1))
    expect(host.attachments[1].inputs).toEqual([
      { type: 'close', sequence: 2, writerLease: { epoch: 2, token: 'fixture-lease-2' } },
    ])
    host.attachments[1].frame({ type: 'ack', sequence: 2 })
    await vi.waitFor(() => expect(host.listenerCount('state')).toBe(0))
  })
})
