import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
const claudeModels = [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['high'] }]

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: Wire[] = []
  private initialized!: () => void
  initialization = new Promise<void>((resolve) => {
    this.initialized = resolve
  })

  constructor(
    readonly provider: 'codex' | 'claude',
    readonly holdInitialization = false,
  ) {
    super()
  }

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.messages.push(message)
    queueMicrotask(() => {
      if (this.destroyed) return
      if (message.type === 'control_request') {
        if (message.request.subtype === 'initialize') {
          this.initialized()
          if (this.holdInitialization) return
        }
        this.controlReply(message)
      } else if (message.id !== undefined) {
        const results: Record<string, Wire> = {
          initialize: {},
          'config/read': { config: { model: 'codex-model' } },
          'model/list': {
            data: [{ model: 'codex-model', displayName: 'Codex model', isDefault: true }],
          },
        }
        this.reply({ id: message.id, result: results[message.method] || {} })
      }
    })
    return true
  }

  controlReply(message: Wire) {
    this.reply({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: { models: claudeModels, session_state: 'idle' },
      },
    })
  }

  releaseInitialization() {
    this.controlReply(this.messages.find((message) => message.request?.subtype === 'initialize')!)
  }

  private reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  signal() {}
  end() {}
  close() {
    this.destroyed = true
    this.emit('close')
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})

function fixture(holdClaudeInitialization = false) {
  const channels: Channel[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    claude: '2.1.278 (Claude Code)',
    codex: 'codex-cli 0.162.1',
  }
  let opened!: (channel: Channel) => void
  const claudeDiscovery = new Promise<Channel>((resolve) => {
    opened = resolve
  })
  ssh.channel = vi.fn(async (command) => {
    const provider = command.includes('codex app-server') ? 'codex' : 'claude'
    const discovery = provider === 'claude' && !channels.some((item) => item.provider === 'claude')
    const channel = new Channel(provider, discovery && holdClaudeInitialization)
    channels.push(channel)
    if (discovery) opened(channel)
    return channel as unknown as ClientChannel
  })
  const agents = new Agents(ssh, () => {})
  active.push(agents)
  return { agents, channels, ssh, claudeDiscovery }
}

describe('independent provider model catalogs', () => {
  it('keeps in-flight Claude discovery valid when Codex opens on the same machine', async () => {
    const { agents, claudeDiscovery, ssh } = fixture(true)
    const claude = agents.models('claude')
    const discovery = await claudeDiscovery
    await discovery.initialization
    expect(await agents.models('codex')).toContainEqual(
      expect.objectContaining({ id: 'codex-model' }),
    )
    discovery.releaseInitialization()
    expect(await claude).toContainEqual(expect.objectContaining({ id: 'sonnet' }))
    expect(ssh.state.status).toBe('connected')
    expect(discovery.messages.some((message) => message.type === 'user')).toBe(false)
  })

  it('sends a resumed Claude follow-up once while simultaneous Codex discovery completes', async () => {
    const { agents, claudeDiscovery, channels } = fixture(true)
    const discoveryRequest = agents.models('claude')
    const discovery = await claudeDiscovery
    await discovery.initialization
    const queuedStart = agents.start({
      sessionId: 'queued-claude',
      provider: 'claude',
      remoteId: 'saved-claude-session',
      model: 'sonnet',
      reasoningEffort: 'high',
      serviceTier: 'default',
      mode: 'review',
      prompt: 'native-paused-follow-up',
    })
    const completed = Promise.all([discoveryRequest, queuedStart])
    await agents.models('codex')
    discovery.releaseInitialization()
    await completed
    const prompts = channels.flatMap((channel) =>
      channel.messages.filter((message) => message.type === 'user'),
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0].message.content).toEqual([{ type: 'text', text: 'native-paused-follow-up' }])
    expect(prompts[0].session_id).toBe('saved-claude-session')
  })

  it('retains cached Claude capabilities through Codex startup and transport replacement', async () => {
    const { agents, channels } = fixture()
    const catalog = await agents.models('claude')
    await agents.models('codex')
    expect(await agents.models('claude')).toBe(catalog)
    channels.find((channel) => channel.provider === 'codex')!.close()
    await agents.models('codex')
    expect(await agents.models('claude')).toBe(catalog)
    expect(channels.filter((channel) => channel.provider === 'claude')).toHaveLength(1)
    expect(channels.filter((channel) => channel.provider === 'codex')).toHaveLength(2)
  })
})
