import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent } from '../src/shared/types'
import { applyEvent, type Thread } from '../src/renderer/state'
import { threadHasRunningChildren } from '../src/renderer/thread-presentation'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
class CodexChannel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  sent: Wire[] = []
  signals: string[] = []
  constructor(readonly remoteId: string) {
    super()
  }
  get rootTurnId() {
    return `${this.remoteId}-turn`
  }
  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.sent.push(message)
    if (message.method && message.id !== undefined)
      queueMicrotask(() => {
        const results: Record<string, Wire> = {
          initialize: {},
          'config/read': { config: { model: 'test-model' } },
          'model/list': {
            data: [{ model: 'test-model', displayName: 'Test model', isDefault: true }],
          },
          'thread/start': { thread: { id: this.remoteId } },
          'thread/resume': { thread: { id: message.params?.threadId } },
          'turn/start': { turn: { id: this.rootTurnId } },
        }
        if (!this.destroyed) this.reply({ id: message.id, result: results[message.method] || {} })
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
async function fixture() {
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.0',
  }
  const channels: CodexChannel[] = []
  ssh.channel = vi.fn(async () => {
    const channel = new CodexChannel(`root-${channels.length + 1}`)
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('This lifecycle fixture must not invoke real inference')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  await agents.start({
    sessionId: 'local',
    provider: 'codex',
    prompt: 'Request',
    mode: 'review',
    model: 'test-model',
  })
  const channel = channels[0]
  channel.reply({
    method: 'thread/started',
    params: {
      thread: { id: 'child', parentThreadId: channel.remoteId, agentNickname: 'Researcher' },
    },
  })
  channel.reply({
    method: 'turn/started',
    params: { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } },
  })
  const rootComplete = () =>
    channel.reply({
      method: 'turn/completed',
      params: { threadId: channel.remoteId, turn: { id: channel.rootTurnId, status: 'completed' } },
    })
  const approval = () => {
    channel.reply({
      id: 'child-request',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'child-command',
        command: 'touch child-output',
      },
    })
    return events.findLast((event) => event.type === 'approval')!.requestId!
  }
  return { agents, events, ssh, channels, channel, rootComplete, approval }
}

describe('Codex background work after a root turn ends', () => {
  it('keeps child work active and its existing RPC alive across an installed CLI refresh', async () => {
    const { agents, events, ssh, channels, channel, rootComplete } = await fixture()
    rootComplete()
    expect(agents.hasRunningSessions()).toBe(true)
    ssh.state = { ...ssh.state, codex: 'codex-cli 0.162.1' }
    ssh.emit('state', ssh.state)
    await agents.models('codex')
    expect(channels).toHaveLength(2)
    expect(channel.destroyed).toBe(false)
    expect(channel.signals).toEqual([])
    channel.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'child-text',
        delta: 'Background findings',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text', agentId: 'child', text: 'Background findings' }),
    )
  })

  it('stops the pending child after root completion without rewriting the completed root turn', async () => {
    const { agents, events, channel, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    const completed = events.filter((event) => event.type === 'complete' && !event.agentId)
    await agents.stop('local')
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        method: 'turn/interrupt',
        params: { threadId: 'child', turnId: 'child-turn' },
      }),
    )
    expect(channel.sent).toContainEqual({ id: 'child-request', result: { decision: 'decline' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'request-resolved', requestId }))
    expect(
      events.filter((event) => event.type === 'subagent' && event.agentId === 'child').at(-1),
    ).toMatchObject({ status: 'interrupted' })
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toEqual(completed)
    expect(agents.hasRunningSessions()).toBe(false)
  })

  it('resolves child approvals and running state when the child thread closes', async () => {
    const { agents, events, channel, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    channel.reply({ method: 'thread/closed', params: { threadId: 'child' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'request-resolved', requestId }))
    expect(agents.hasRunningSessions()).toBe(false)
    const final = events
      .filter((event) => event.type === 'subagent' && event.agentId === 'child')
      .at(-1)
    expect(['interrupted', 'closed', 'completed']).toContain(final?.status)
  })

  it('settles a completed child turn while preserving completed parent state', async () => {
    const { agents, events, channel, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'request-resolved', requestId, agentId: 'child' }),
    )
    expect(agents.hasRunningSessions()).toBe(false)
    expect(
      events.filter((event) => event.type === 'subagent' && event.agentId === 'child').at(-1),
    ).toMatchObject({ status: 'completed' })
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ])
  })

  it('resolves waiting child requests and terminal child state when its connection closes', async () => {
    const { agents, events, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    agents.close('Test disconnect')
    expect(events).toContainEqual(expect.objectContaining({ type: 'request-resolved', requestId }))
    expect(['interrupted', 'failed']).toContain(
      events.filter((event) => event.type === 'subagent' && event.agentId === 'child').at(-1)
        ?.status,
    )
    expect(agents.hasRunningSessions()).toBe(false)
  })

  it('keeps child requests and events on their original transport when the next root turn uses an updated CLI', async () => {
    const { agents, events, ssh, channels, channel, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    ssh.state = { ...ssh.state, codex: 'codex-cli 0.162.1' }
    await agents.start({
      sessionId: 'local',
      provider: 'codex',
      prompt: 'Next request',
      mode: 'review',
      model: 'test-model',
    })
    const replacement = channels[1]
    expect(replacement).toBeDefined()
    expect(channel.destroyed).toBe(false)
    channel.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'child-text',
        delta: 'Old child remains attached',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        agentId: 'child',
        text: 'Old child remains attached',
      }),
    )
    await agents.respond('local', requestId, true)
    expect(channel.sent).toContainEqual({ id: 'child-request', result: { decision: 'accept' } })
    expect(replacement.sent).not.toContainEqual(expect.objectContaining({ id: 'child-request' }))
    await agents.steer({ sessionId: 'local', prompt: 'New root remains steerable' })
    expect(replacement.sent).toContainEqual(
      expect.objectContaining({
        method: 'turn/steer',
        params: expect.objectContaining({
          threadId: channel.remoteId,
          expectedTurnId: replacement.rootTurnId,
        }),
      }),
    )
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('fails only the old child when its RPC closes after a new root turn has started on a replacement', async () => {
    const { agents, events, ssh, channels, channel, rootComplete, approval } = await fixture()
    const requestId = approval()
    rootComplete()
    ssh.state = { ...ssh.state, codex: 'codex-cli 0.162.1' }
    await agents.start({
      sessionId: 'local',
      provider: 'codex',
      prompt: 'Next request',
      mode: 'review',
      model: 'test-model',
    })
    const replacement = channels[1]
    channel.close()
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'request-resolved', requestId, agentId: 'child' }),
    )
    expect(
      events.filter((event) => event.type === 'subagent' && event.agentId === 'child').at(-1),
    ).toMatchObject({ status: 'failed' })
    expect(events.filter((event) => event.type === 'error' && !event.agentId)).toEqual([])
    expect(agents.hasRunningSessions()).toBe(true)
    replacement.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: channel.remoteId,
        turnId: replacement.rootTurnId,
        itemId: 'new-root-text',
        delta: 'Replacement root survives',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Replacement root survives' }),
    )
    replacement.reply({
      method: 'turn/completed',
      params: {
        threadId: channel.remoteId,
        turn: { id: replacement.rootTurnId, status: 'completed' },
      },
    })
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toHaveLength(2)
    expect(agents.hasRunningSessions()).toBe(false)
  })

  it('shows a reused child thread as running when a new native child turn starts', async () => {
    const { agents, events, channel, rootComplete } = await fixture()
    channel.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'first-child-answer',
        delta: 'First child answer',
      },
    })
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } },
    })
    rootComplete()
    const initial: Thread = {
      id: 'local',
      profileId: 'machine',
      provider: 'codex',
      title: 'Test',
      workspace: '/project',
      messages: [],
      pending: [],
      busy: true,
      turn: 1,
      updatedAt: 1,
      model: 'test-model',
      mode: 'review',
    }
    const completed = events.reduce(applyEvent, initial)
    expect(threadHasRunningChildren(completed)).toBe(false)
    const boundary = events.length
    channel.reply({
      method: 'turn/started',
      params: { threadId: 'child', turn: { id: 'child-turn-2', status: 'inProgress' } },
    })
    const resumed = events.slice(boundary).reduce(applyEvent, completed)
    expect(agents.hasRunningSessions()).toBe(true)
    expect(threadHasRunningChildren(resumed)).toBe(true)
    expect(resumed.busy).toBe(false)
    expect(resumed.messages.find((message) => message.text === 'First child answer')).toEqual(
      completed.messages.find((message) => message.text === 'First child answer'),
    )
    const replayBoundary = events.length
    channel.reply({
      method: 'turn/started',
      params: { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } },
    })
    expect(events).toHaveLength(replayBoundary)
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'child', turn: { id: 'child-turn-2', status: 'failed' } },
    })
    const ended = events.slice(replayBoundary).reduce(applyEvent, resumed)
    expect(threadHasRunningChildren(ended)).toBe(false)
    expect(ended.messages.find((message) => message.text === 'First child answer')).toEqual(
      completed.messages.find((message) => message.text === 'First child answer'),
    )
  })
})
