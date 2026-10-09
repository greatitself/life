import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import type { ConnectionState } from '../src/shared/types'
import { DurableRemoteChannel } from '../src/main/durable-remote-channel'

class Attachment extends Duplex {
  readonly stderr = new PassThrough()
  readonly inputs: Record<string, unknown>[] = []
  constructor() {
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
  async channel(command: string) {
    const attachment = new Attachment()
    this.commands.push(command)
    this.attachments.push(attachment)
    setImmediate(() => attachment.frame({ type: 'ready', cursor: 0 }))
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
      Buffer.from(JSON.stringify({ ...configuration, launch: true })).toString('base64'),
    )
    expect(host.commands[1]).toContain(
      Buffer.from(JSON.stringify({ ...configuration, launch: false })).toString('base64'),
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
    second.frame({ type: 'ready', cursor: 500 })
    second.frame({ type: 'stdout', cursor: 1, data: Buffer.from('duplicate\n').toString('base64') })
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
    expect(channel.transportState).toBe('closed')
    expect(host.listenerCount('state')).toBe(0)
  })

  it('uses the original delivery number when an acknowledgement was lost', async () => {
    const host = new Host()
    const channel = await DurableRemoteChannel.open(host, 'claude')
    channel.write('one exact prompt\n')
    const original = host.attachments[0].inputs[0]
    host.disconnect()
    host.reconnect()
    await vi.waitFor(() => expect(host.attachments[1]?.inputs).toHaveLength(1))
    expect(host.attachments[1].inputs[0]).toEqual(original)
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
    expect(host.attachments[1].inputs).toEqual([{ type: 'close', sequence: 2 }])
    host.attachments[1].frame({ type: 'ack', sequence: 2 })
    expect(host.listenerCount('state')).toBe(0)
  })
})
