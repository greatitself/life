import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, Provider } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>

class ProviderChannel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  sent: Wire[] = []
  signals: string[] = []

  constructor(
    readonly remoteId: string,
    private readonly models: () => Wire[],
  ) {
    super()
  }

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.sent.push(message)
    queueMicrotask(() => {
      if (this.destroyed) return
      if (message.type === 'control_request') {
        this.reply({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response:
              message.request.subtype === 'initialize'
                ? { models: this.models(), session_state: 'idle' }
                : {},
          },
        })
      } else if (message.method && message.id !== undefined) {
        const results: Record<string, Wire> = {
          initialize: {},
          'config/read': { config: { model: this.models()[0]?.model } },
          'model/list': { data: this.models() },
          'thread/start': { thread: { id: this.remoteId } },
          'turn/start': { turn: { id: `turn-${this.remoteId}` } },
          'turn/steer': {},
        }
        this.reply({ id: message.id, result: results[message.method] || {} })
      }
    })
    return true
  }

  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

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

function fixture(provider: Provider) {
  const channels: ProviderChannel[] = []
  let catalog: Wire[] =
    provider === 'claude'
      ? [
          {
            value: 'old-model',
            displayName: 'Old model',
            supportedEffortLevels: ['high'],
            supportsFastMode: true,
          },
        ]
      : [
          {
            model: 'old-model',
            displayName: 'Old model',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
          },
        ]
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    claude: '2.1.278 (Claude Code)',
    codex: 'codex-cli 0.161.0',
  }
  ssh.channel = vi.fn(async () => {
    const channel = new ProviderChannel(`remote-${channels.length + 1}`, () => catalog)
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('Provider catalog discovery must not invoke an inference or shell command')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const upgrade = () => {
    catalog =
      provider === 'claude'
        ? [
            {
              value: 'new-model',
              displayName: 'New model',
              supportedEffortLevels: ['max'],
              supportsFastMode: false,
            },
          ]
        : [
            {
              model: 'new-model',
              displayName: 'New model',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }],
            },
          ]
    ssh.state = {
      ...ssh.state,
      [provider]: provider === 'claude' ? '2.1.296 (Claude Code)' : 'codex-cli 0.162.1',
    }
    ssh.emit('state', ssh.state)
  }
  const start = (sessionId = 'local', model = 'old-model') =>
    agents.start({ sessionId, provider, model, mode: 'review', prompt: 'User request' })
  return { agents, channels, events, upgrade, start }
}

describe('verified provider upgrades refresh discovery', () => {
  it('reloads the Claude catalog without interrupting a running conversation or sending a discovery prompt', async () => {
    const { agents, channels, upgrade, start } = fixture('claude')
    expect((await agents.models('claude')).find((model) => model.id === 'old-model')).toMatchObject(
      {
        id: 'old-model',
        serviceTiers: [{ id: 'default' }, { id: 'fast' }],
      },
    )
    await start()
    const conversation = channels.find((channel) =>
      channel.sent.some((message) => message.type === 'user'),
    )!
    upgrade()
    expect((await agents.models('claude')).find((model) => model.id === 'new-model')).toMatchObject(
      {
        id: 'new-model',
        supportedReasoningEfforts: [{ reasoningEffort: 'max' }],
        serviceTiers: [{ id: 'default' }],
      },
    )
    expect(conversation.destroyed).toBe(false)
    expect(conversation.signals).toEqual([])
    expect(agents.hasRunningSessions()).toBe(true)
    expect(
      channels.flatMap((channel) => channel.sent.filter((message) => message.type === 'user')),
    ).toHaveLength(1)
    expect(
      channels.filter((channel) => !channel.sent.some((message) => message.type === 'user')),
    ).toHaveLength(2)
  })

  it('opens the updated Codex app server for new work while the previous active thread keeps its transport', async () => {
    const { agents, channels, events, upgrade, start } = fixture('codex')
    expect((await agents.models('codex')).some((model) => model.id === 'old-model')).toBe(true)
    await start()
    const previous = channels[0]
    upgrade()
    expect((await agents.models('codex')).some((model) => model.id === 'new-model')).toBe(true)
    expect(channels).toHaveLength(2)
    expect(previous.destroyed).toBe(false)
    expect(previous.signals).toEqual([])
    previous.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: previous.remoteId,
        turnId: `turn-${previous.remoteId}`,
        itemId: 'old-response',
        delta: 'The previous turn remains active',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        sessionId: 'local',
        type: 'text',
        text: 'The previous turn remains active',
      }),
    )
    await agents.steer({ sessionId: 'local', prompt: 'Continue the previous turn' })
    expect(previous.sent.some((message) => message.method === 'turn/steer')).toBe(true)
    await start('new-local', 'new-model')
    expect(channels[1].sent.some((message) => message.method === 'turn/start')).toBe(true)
    expect(previous.destroyed).toBe(false)
  })
})
