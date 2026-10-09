import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRPC, CodexRequestError } from '../src/main/codex-rpc'

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: Record<string, any>[] = []
  signals: string[] = []
  write(message: string) {
    this.messages.push(JSON.parse(message))
    return true
  }
  signal(signal: string) {
    this.signals.push(signal)
  }
  close() {
    this.destroyed = true
    this.emit('close')
  }
  reply(message: Record<string, unknown>) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }
}

afterEach(() => vi.useRealTimers())

function fixture() {
  const channel = new Channel()
  const receive = vi.fn()
  const rpc = new CodexRPC(channel as unknown as ClientChannel, receive)
  return { channel, receive, rpc }
}

describe('Codex RPC response and recovery lifecycle', () => {
  it('surfaces oversized resume responses immediately and terminates the unusable transport', async () => {
    const { channel, rpc } = fixture()
    const resuming = rpc.request('thread/resume', { threadId: 'saved-conversation' })
    const rejected = expect(resuming).rejects.toThrow(/larger than the protocol limit/)
    channel.emit('data', Buffer.from('{"id":1,"result":{"history":"' + 'x'.repeat(8_000_001)))
    await rejected
    expect(channel.signals).toEqual(['TERM'])
    expect(channel.destroyed).toBe(true)
    expect(rpc.closed).toBe(true)
  })

  it('rejects malformed protocol output without disguising it as a login timeout', async () => {
    const { channel, rpc } = fixture()
    const pending = rpc.request('thread/resume')
    const rejected = expect(pending).rejects.toThrow(/invalid protocol message/)
    channel.emit('data', Buffer.from('{broken-json}\n'))
    await rejected
    expect(channel.destroyed).toBe(true)
  })

  it('tolerates login-shell banners before a valid app-server handshake', async () => {
    const { channel, rpc } = fixture()
    const pending = rpc.request('initialize')
    channel.emit('data', Buffer.from('Welcome to the research machine\nLast login: today\n'))
    channel.reply({ id: 1, result: { userAgent: 'codex' } })
    await expect(pending).resolves.toEqual({ userAgent: 'codex' })
    expect(channel.destroyed).toBe(false)
  })

  it('stops a timed-out resume and all dependent requests while retaining the requested conversation ID', async () => {
    vi.useFakeTimers()
    const { channel, rpc } = fixture()
    const resume = rpc.request('thread/resume', { threadId: 'saved-conversation' }, 1000)
    const listing = rpc.request('model/list', {}, 2000)
    const resumeFailure = expect(resume).rejects.toThrow(/saved conversation is unchanged/)
    const dependentFailure = expect(listing).rejects.toThrow(/thread\/resume did not respond/)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([resumeFailure, dependentFailure])
    expect(channel.messages[0].params.threadId).toBe('saved-conversation')
    expect(channel.signals).toEqual(['TERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never replays a user prompt when turn/start times out', async () => {
    vi.useFakeTimers()
    const { channel, rpc } = fixture()
    const request = rpc.request(
      'turn/start',
      { threadId: 'saved', input: [{ text: 'edit' }] },
      1000,
    )
    const rejected = expect(request).rejects.toThrow(/untracked turn/)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(channel.messages).toHaveLength(1)
    expect(channel.destroyed).toBe(true)
  })

  it('cancels only a pending resume, ignores its late response, and clears its timer', async () => {
    vi.useFakeTimers()
    const { channel, rpc, receive } = fixture()
    const controller = new AbortController()
    const pending = rpc.request('thread/resume', { threadId: 'saved' }, 60000, controller.signal)
    const rejected = expect(pending).rejects.toThrow(/cancelled/)
    controller.abort()
    await rejected
    channel.reply({ id: 1, result: { thread: { id: 'saved' } } })
    expect(receive).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const listing = rpc.request('model/list')
    channel.reply({ id: 2, result: { data: [] } })
    await expect(listing).resolves.toEqual({ data: [] })
    expect(channel.destroyed).toBe(false)
  })

  it('preserves remote error codes and diagnostics while allowing a rejected request to be corrected', async () => {
    const { channel, rpc } = fixture()
    const pending = rpc.request('thread/resume', { threadId: 'missing' })
    channel.reply({
      id: 1,
      error: { code: -32602, message: 'Thread was not found on this machine' },
    })
    const error = await pending.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CodexRequestError)
    expect(error).toMatchObject({ method: 'thread/resume', code: -32602 })
    expect((error as Error).message).toBe('Thread was not found on this machine')
    const corrected = rpc.request('thread/resume', { threadId: 'saved' })
    channel.reply({ id: 2, result: { thread: { id: 'saved' } } })
    await expect(corrected).resolves.toEqual({ thread: { id: 'saved' } })
  })

  it('reports remote stderr when a provider exits before sending a response', async () => {
    const { channel, rpc } = fixture()
    const pending = rpc.request('initialize')
    channel.stderr.emit('data', Buffer.from('Required MCP server research failed to initialize'))
    channel.close()
    await expect(pending).rejects.toThrow('Required MCP server research failed to initialize')
  })

  it('does not terminate a working agent for an optional configuration-read timeout', async () => {
    vi.useFakeTimers()
    const { channel, rpc } = fixture()
    const pending = rpc.request('config/read', {}, 1000)
    const rejected = expect(pending).rejects.toThrow(/config\/read did not respond/)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    const next = rpc.request('model/list')
    channel.reply({ id: 2, result: { data: [] } })
    await expect(next).resolves.toEqual({ data: [] })
    expect(channel.signals).toEqual([])
  })
})

describe('Codex RPC durable transport suspension', () => {
  it('preserves the remaining response deadline while a saved conversation is offline', async () => {
    vi.useFakeTimers()
    const { channel, rpc } = fixture()
    const pending = rpc.request('thread/resume', { threadId: 'saved-conversation' }, 1000)
    const rejected = expect(pending).rejects.toThrow(/saved conversation is unchanged/)

    await vi.advanceTimersByTimeAsync(300)
    channel.emit('suspended')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(rpc.closed).toBe(false)
    expect(channel.messages).toHaveLength(1)

    channel.emit('resumed')
    await vi.advanceTimersByTimeAsync(699)
    expect(rpc.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(channel.messages).toEqual([
      { id: 1, method: 'thread/resume', params: { threadId: 'saved-conversation' } },
    ])
    expect(channel.signals).toEqual(['TERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts an offline request deadline only after reconnecting without sending the prompt twice', async () => {
    vi.useFakeTimers()
    const channel = Object.assign(new Channel(), { transportState: 'suspended' })
    const rpc = new CodexRPC(channel as unknown as ClientChannel, vi.fn())
    const params = {
      threadId: 'saved-conversation',
      input: [{ text: 'Keep this prompt unchanged.' }],
    }
    const pending = rpc.request('turn/start', params, 1000)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(rpc.closed).toBe(false)
    expect(channel.messages).toEqual([{ id: 1, method: 'turn/start', params }])

    channel.emit('resumed')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    channel.reply({ id: 1, result: { turn: { id: 'turn-after-reconnect' } } })
    await expect(pending).resolves.toEqual({ turn: { id: 'turn-after-reconnect' } })
    expect(channel.messages).toEqual([{ id: 1, method: 'turn/start', params }])
    expect(channel.signals).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps duplicate suspended and resumed events from shortening or resetting the remaining deadline', async () => {
    vi.useFakeTimers()
    const { channel, rpc } = fixture()
    const pending = rpc.request('thread/resume', { threadId: 'saved-conversation' }, 1000)
    const rejected = expect(pending).rejects.toThrow(/saved conversation is unchanged/)

    await vi.advanceTimersByTimeAsync(200)
    channel.emit('suspended')
    await vi.advanceTimersByTimeAsync(120_000)
    channel.emit('suspended')
    expect(vi.getTimerCount()).toBe(0)

    channel.emit('resumed')
    await vi.advanceTimersByTimeAsync(100)
    channel.emit('resumed')
    expect(vi.getTimerCount()).toBe(1)
    channel.emit('suspended')
    await vi.advanceTimersByTimeAsync(120_000)
    channel.emit('suspended')
    expect(vi.getTimerCount()).toBe(0)

    channel.emit('resumed')
    channel.emit('resumed')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(699)
    expect(rpc.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(channel.messages).toHaveLength(1)
    expect(channel.signals).toEqual(['TERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a suspended request without reviving its timer or accepting a late response after reconnect', async () => {
    vi.useFakeTimers()
    const { channel, rpc, receive } = fixture()
    const controller = new AbortController()
    const pending = rpc.request(
      'thread/resume',
      { threadId: 'saved-conversation' },
      1000,
      controller.signal,
    )
    const rejected = expect(pending).rejects.toThrow(/cancelled/)

    await vi.advanceTimersByTimeAsync(350)
    channel.emit('suspended')
    controller.abort()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    channel.reply({ id: 1, result: { thread: { id: 'saved-conversation' } } })
    channel.emit('resumed')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(receive).not.toHaveBeenCalled()
    expect(rpc.closed).toBe(false)
    expect(channel.signals).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    const next = rpc.request('model/list')
    channel.reply({ id: 2, result: { data: [] } })
    await expect(next).resolves.toEqual({ data: [] })
    expect(channel.messages.map((message) => message.method)).toEqual([
      'thread/resume',
      'model/list',
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
