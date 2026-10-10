import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent } from '../src/shared/types'
import type { ProviderUsageSnapshot } from '../src/shared/usage'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type ControlRequest = {
  type: string
  request_id: string
  request?: { subtype: string; skip_behaviors?: boolean; [key: string]: unknown }
}

const accountUsage = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 25, resets_at: '2026-10-10T08:00:00Z' },
    seven_day: { utilization: 5, resets_at: null },
  },
  session: { total_cost_usd: 1, model_usage: {} },
  behaviors: null,
}

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: ControlRequest[] = []
  signals: string[] = []
  closes = 0
  held = new Set<string>()
  errors = new Map<string, string>()
  transportState?: 'connected' | 'suspended' | 'closed'

  write(raw: string) {
    const message = JSON.parse(raw) as ControlRequest
    this.messages.push(message)
    queueMicrotask(() => {
      if (this.destroyed || message.type !== 'control_request') return
      const subtype = message.request?.subtype || ''
      if (this.held.has(subtype)) return
      const error = this.errors.get(subtype)
      if (error) this.controlReply(message, {}, error)
      else
        this.controlReply(
          message,
          subtype === 'get_usage'
            ? accountUsage
            : { claude_code_version: '2.1.296', session_state: 'idle' },
        )
    })
    return true
  }

  controlReply(request: ControlRequest, response: Record<string, unknown> = {}, error?: string) {
    this.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'control_response',
          response: {
            request_id: request.request_id,
            subtype: error ? 'error' : 'success',
            ...(error ? { error } : { response }),
          },
        }) + '\n',
      ),
    )
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

  close() {
    this.closes++
    this.destroyed = true
    this.emit('close')
  }

  of(subtype: string) {
    return this.messages.filter((message) => message.request?.subtype === subtype)
  }

  users() {
    return this.messages.filter((message) => message.type === 'user')
  }

  suspend() {
    this.transportState = 'suspended'
    this.emit('suspended')
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
  vi.useRealTimers()
})

function fixture(configure?: (channel: Channel) => void, durable = false) {
  const channels: Channel[] = []
  const commands: string[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    claude: 'claude 2.1.296',
    profile: {
      id: 'test',
      name: 'Test machine',
      host: 'machine-a',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/project',
    },
  }
  ssh.channel = vi.fn(async (command: string) => {
    commands.push(command)
    const channel = new Channel()
    if (durable) channel.transportState = 'connected'
    configure?.(channel)
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  if (durable) ssh.durableChannel = ssh.channel
  ssh.exec = vi.fn(async () => {
    throw new Error('Account metadata must not run inference or shell commands')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const start = () =>
    agents.start({
      sessionId: 'local-thread',
      provider: 'claude',
      prompt: 'A user-authored request',
      mode: 'review',
    })
  return { agents, ssh, channels, commands, events, start }
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe('Claude native account usage transport', () => {
  it('reports offline account data as unavailable without opening a provider process', async () => {
    const { agents, ssh, channels } = fixture()
    ssh.state.status = 'disconnected'
    expect(await agents.usage('claude')).toMatchObject({
      provider: 'claude',
      status: 'unavailable',
      limits: [],
      message: expect.stringContaining('Connect'),
    })
    expect(channels).toHaveLength(0)
    expect(ssh.exec).not.toHaveBeenCalled()
  })

  it('initializes a promptless metadata process and always closes it after native get_usage', async () => {
    const { agents, ssh, channels, commands, events } = fixture()
    const disconnectListeners = ssh.listenerCount('disconnected')
    const workspaceListeners = ssh.listenerCount('workspace-changing')
    expect(await agents.usage('claude')).toMatchObject({
      provider: 'claude',
      status: 'available',
      accountType: 'max',
      limits: [
        { id: 'five_hour', primary: { usedPercent: 25, windowDurationMins: 300 } },
        { id: 'seven_day', primary: { usedPercent: 5, windowDurationMins: 10080 } },
      ],
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("'--input-format' 'stream-json'")
    expect(commands[0]).toContain("'--permission-mode' 'plan'")
    const channel = channels[0]
    expect(channel.messages.map((message) => message.request)).toEqual([
      { subtype: 'initialize', hooks: null },
      { subtype: 'get_usage', skip_behaviors: true },
    ])
    expect(channel.users()).toEqual([])
    expect(channel.signals).toEqual(['TERM'])
    expect(channel.closes).toBe(1)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(ssh.listenerCount('disconnected')).toBe(disconnectListeners)
    expect(ssh.listenerCount('workspace-changing')).toBe(workspaceListeners)
    expect(ssh.exec).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('reuses a live Claude control channel without adding prompts or closing the conversation', async () => {
    const { agents, channels, start } = fixture()
    await start()
    const channel = channels[0]
    expect(channel.users()).toHaveLength(1)
    const before = [...channel.messages]
    expect(await agents.usage('claude')).toMatchObject({ status: 'available', accountType: 'max' })
    expect(channels).toHaveLength(1)
    expect(channel.messages.slice(before.length).map((message) => message.request)).toEqual([
      { subtype: 'get_usage', skip_behaviors: true },
    ])
    expect(channel.users()).toHaveLength(1)
    expect(channel.of('initialize')).toHaveLength(1)
    expect(channel.closes).toBe(0)
    expect(channel.signals).toEqual([])
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it.each([false, true])(
    'reports unsupported native get_usage explicitly (live: %s)',
    async (live) => {
      const { agents, channels, start } = fixture((channel) => {
        channel.errors.set('get_usage', 'Unknown control request subtype: get_usage')
      })
      if (live) await start()
      expect(await agents.usage('claude')).toMatchObject({
        provider: 'claude',
        status: 'unavailable',
        limits: [],
        message: 'Unknown control request subtype: get_usage',
      })
      expect(channels).toHaveLength(1)
      expect(channels[0].users()).toHaveLength(live ? 1 : 0)
      expect(channels[0].closes).toBe(live ? 0 : 1)
    },
  )

  it.each([false, true])(
    'rejects stale quota returned after the connected machine changes (live: %s)',
    async (live) => {
      const { agents, ssh, channels, events, start } = fixture((channel) =>
        channel.held.add('get_usage'),
      )
      if (live) await start()
      const reading = agents.usage('claude')
      await flush()
      const channel = channels[0]
      expect(channel.of('get_usage')).toHaveLength(1)
      ssh.state.profile = { ...ssh.state.profile!, host: 'machine-b' }
      channel.controlReply(channel.of('get_usage')[0], accountUsage)
      expect(await reading).toMatchObject({
        status: 'unavailable',
        limits: [],
        message: expect.stringContaining('machine changed'),
      })
      expect(events.filter((event) => event.type === 'account-usage')).toEqual([])
      expect(channel.closes).toBe(live ? 0 : 1)
    },
  )

  it.each(['disconnected', 'workspace-changing'] as const)(
    'cancels pending metadata requests on %s and ignores late quotas',
    async (event) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const { agents, ssh, channels, events } = fixture((channel) => channel.held.add('get_usage'))
      const reading = agents.usage('claude')
      await flush()
      const channel = channels[0]
      const request = channel.of('get_usage')[0]
      expect(request).toBeDefined()
      if (event === 'disconnected') ssh.state.status = 'disconnected'
      else ssh.state.workspace = '/another-project'
      ssh.emit(event)
      const snapshot = await reading
      expect(snapshot).toMatchObject({ status: 'unavailable', limits: [] })
      expect(snapshot.message).toMatch(/closed|cancelled|changed/)
      channel.controlReply(request, accountUsage)
      await flush()
      expect(snapshot.status).toBe('unavailable')
      expect(events.filter((item) => item.type === 'account-usage')).toEqual([])
      expect(channel.destroyed).toBe(true)
      expect(channel.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('cancels live usage requests on disconnect without publishing a stale answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { agents, ssh, channels, start } = fixture((channel) => channel.held.add('get_usage'))
    await start()
    const reading = agents.usage('claude')
    await flush()
    const request = channels[0].of('get_usage')[0]
    ssh.state.status = 'disconnected'
    ssh.emit('disconnected')
    expect(await reading).toMatchObject({
      status: 'unavailable',
      limits: [],
      message: expect.stringContaining('disconnected'),
    })
    channels[0].controlReply(request, accountUsage)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels usage reads on a suspended durable conversation without stopping that conversation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { agents, ssh, channels, start } = fixture(
      (channel) => channel.held.add('get_usage'),
      true,
    )
    await start()
    const snapshots: ProviderUsageSnapshot[] = []
    const reading = agents.usage('claude').then((snapshot) => snapshots.push(snapshot))
    await flush()
    const channel = channels[0]
    const request = channel.of('get_usage')[0]
    expect(request).toBeDefined()
    channel.suspend()
    ssh.state.status = 'disconnected'
    ssh.emit('disconnected')
    await flush()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ status: 'unavailable', limits: [] })
    expect(channel.closes).toBe(0)
    expect(channel.signals).toEqual([])
    channel.controlReply(request, accountUsage)
    await reading
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].status).toBe('unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { subtype: 'initialize', timeout: 60_000 },
    { subtype: 'get_usage', timeout: 15_000 },
  ])(
    'bounds promptless $subtype requests to $timeout ms and closes the process',
    async ({ subtype, timeout }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const { agents, channels } = fixture((channel) => channel.held.add(subtype))
      let finished = false
      const reading = agents.usage('claude').then((snapshot) => {
        finished = true
        return snapshot
      })
      await flush()
      expect(channels[0].of(subtype)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(timeout - 1)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await reading).toMatchObject({
        status: 'unavailable',
        limits: [],
        message: expect.stringContaining(`${subtype} metadata request timed out`),
      })
      expect(channels[0].users()).toEqual([])
      expect(channels[0].closes).toBe(1)
      expect(channels[0].signals).toEqual(['TERM'])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('bounds a live usage request without interrupting the conversation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { agents, channels, start } = fixture((channel) => channel.held.add('get_usage'))
    await start()
    const reading = agents.usage('claude')
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await reading).toMatchObject({
      status: 'unavailable',
      limits: [],
      message: expect.stringContaining('get_usage timed out'),
    })
    expect(channels[0].users()).toHaveLength(1)
    expect(channels[0].closes).toBe(0)
    expect(agents.hasRunningSessions()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
