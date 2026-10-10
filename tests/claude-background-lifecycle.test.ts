import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, StartInput } from '../src/shared/types'
import { applyEvent, type Thread } from '../src/renderer/state'
import { threadHasRunningChildren } from '../src/renderer/thread-presentation'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>

class ClaudeChannel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  sent: Wire[] = []
  signals: string[] = []

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.sent.push(message)
    if (message.type === 'control_request')
      queueMicrotask(() =>
        this.reply({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response:
              message.request.subtype === 'initialize'
                ? {
                    session_state: 'idle',
                    current_permission_mode: 'default',
                    fast_mode_disabled_reason: 'sdk_opt_in_required',
                    models: [{ value: 'default', displayName: 'Default', supportsFastMode: true }],
                  }
                : {},
          },
        }),
      )
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
  const channels: ClaudeChannel[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    claude: '2.1.296 (Claude Code)',
  }
  ssh.channel = vi.fn(async () => {
    const channel = new ClaudeChannel()
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('This lifecycle test must not run an inference or shell command')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const start = (prompt = 'User request', providerOptions?: StartInput['providerOptions']) =>
    agents.start({
      sessionId: 'local',
      provider: 'claude',
      prompt,
      mode: 'review',
      ...(providerOptions ? { providerOptions } : {}),
    })
  await start()
  const channel = channels[0]
  channel.reply({ type: 'system', subtype: 'init', session_id: 'parent-session' })
  const finishRoot = () =>
    channel.reply({
      type: 'result',
      session_id: 'parent-session',
      subtype: 'success',
      is_error: false,
      result: '',
    })
  const child = (message: Wire) =>
    channel.reply({
      session_id: 'child-session',
      parent_tool_use_id: 'delegate',
      ...message,
    })
  return { agents, events, channels, channel, start, finishRoot, child }
}

describe('Claude background work across root turns', () => {
  it('forwards child text and approval requests after the root becomes idle', async () => {
    const { agents, events, channel, finishRoot, child } = await fixture()
    finishRoot()
    expect(agents.hasRunningSessions()).toBe(false)
    child({
      type: 'assistant',
      uuid: 'child-envelope',
      message: { id: 'child-text', content: [{ type: 'text', text: 'Background findings' }] },
    })
    child({
      type: 'control_request',
      request_id: 'background-access',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        agent_id: 'delegate',
        input: { command: 'touch background-output' },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        itemId: 'child-text',
        agentId: 'delegate',
        text: 'Background findings',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval',
        requestId: 'background-access',
        agentId: 'delegate',
      }),
    )
    await agents.respond('local', 'background-access', false)
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'control_response',
        response: expect.objectContaining({
          request_id: 'background-access',
          response: expect.objectContaining({ behavior: 'deny' }),
        }),
      }),
    )
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('accepts background tool requests identified only by the control request agent ID', async () => {
    const { events, channel, finishRoot } = await fixture()
    finishRoot()
    channel.reply({
      type: 'control_request',
      request_id: 'background-agent-only',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        agent_id: 'background-agent',
        input: { file_path: '/project/notes.txt' },
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval',
        requestId: 'background-agent-only',
        agentId: 'background-agent',
      }),
    )
  })

  it('keeps an ongoing child block identity when the same process starts another root turn', async () => {
    const { events, channels, start, finishRoot, child } = await fixture()
    child({ type: 'stream_event', event: { type: 'message_start', message: { id: 'child-api' } } })
    child({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    child({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Before' },
      },
    })
    finishRoot()
    await start('Second root request')
    expect(
      channels.filter((channel) => channel.sent.some((message) => message.type === 'user')),
    ).toHaveLength(1)
    child({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' after' },
      },
    })
    child({
      type: 'assistant',
      uuid: 'completed-child-envelope',
      message: { id: 'child-api', content: [{ type: 'text', text: 'Before after' }] },
    })
    expect(events.filter((event) => event.type === 'text' && event.agentId === 'delegate')).toEqual(
      [
        expect.objectContaining({ itemId: 'child-api', text: 'Before' }),
        expect.objectContaining({ itemId: 'child-api', text: ' after' }),
        expect.objectContaining({ itemId: 'child-api', text: 'Before after', status: 'replace' }),
      ],
    )
  })

  it('keeps a pending background approval answerable across a reused root turn', async () => {
    const { agents, events, channel, start, finishRoot, child } = await fixture()
    child({
      type: 'control_request',
      request_id: 'approval-across-turns',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        agent_id: 'delegate',
        input: { file_path: '/project/notes.txt' },
      },
    })
    finishRoot()
    await start('Another root request')
    await agents.respond('local', 'approval-across-turns', false)
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'control_response',
        response: expect.objectContaining({
          request_id: 'approval-across-turns',
          response: expect.objectContaining({ behavior: 'deny' }),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'request-resolved', requestId: 'approval-across-turns' }),
    )
  })

  it('resolves a pending child request before replacing its provider process', async () => {
    const { agents, events, channel, start, finishRoot, child } = await fixture()
    child({
      type: 'control_request',
      request_id: 'restarted-child-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        agent_id: 'delegate',
        input: { file_path: '/project/notes.txt' },
      },
    })
    finishRoot()
    await start('New settings', { settings: { env: { LIFE_REVIEW_TEST: 'changed' } } })
    expect(channel.signals).toContain('TERM')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request-resolved',
        requestId: 'restarted-child-request',
        status: 'cancelled',
      }),
    )
    await expect(agents.respond('local', 'restarted-child-request', false)).rejects.toThrow(
      /no longer pending/,
    )
  })

  it('resolves background requests and terminal state when SSH disconnects after root completion', async () => {
    const { agents, events, finishRoot, child } = await fixture()
    child({
      type: 'control_request',
      request_id: 'disconnected-child-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        agent_id: 'delegate',
        input: { file_path: '/project/notes.txt' },
      },
    })
    finishRoot()
    agents.close('Test SSH disconnect')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'request-resolved',
        requestId: 'disconnected-child-request',
      }),
    )
    const lastChild = events
      .filter((event) => event.type === 'subagent' && event.agentId === 'delegate')
      .at(-1)
    expect(['interrupted', 'failed']).toContain(lastChild?.status)
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ])
  })

  it.each(['completed', 'stopped'])(
    'settles child transcript activity on a %s task notification',
    async (status) => {
      const { agents, events, channel, finishRoot, child } = await fixture()
      channel.reply({
        type: 'assistant',
        uuid: 'background-delegate',
        message: {
          id: 'root-delegate',
          content: [
            {
              type: 'tool_use',
              id: 'delegate',
              name: 'Agent',
              input: { description: 'Researcher' },
            },
          ],
        },
      })
      channel.reply({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-child',
        tool_use_id: 'delegate',
        description: 'Researcher',
        is_backgrounded: true,
      })
      channel.reply({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'delegate', content: 'Running in the background' },
          ],
        },
      })
      child({
        type: 'assistant',
        uuid: 'background-command',
        message: {
          id: 'child-command',
          content: [
            { type: 'tool_use', id: 'child-bash', name: 'Bash', input: { command: 'read notes' } },
          ],
        },
      })
      child({
        type: 'control_request',
        request_id: 'task-request',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          agent_id: 'delegate',
          input: { file_path: '/project/notes.txt' },
        },
      })
      finishRoot()
      channel.reply({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-child',
        tool_use_id: 'delegate',
        status,
        output_file: '/project/result.txt',
        summary: 'Task ended',
      })
      const thread: Thread = {
        id: 'local',
        profileId: 'machine',
        provider: 'claude',
        model: '',
        mode: 'review',
        title: 'Background',
        updatedAt: 1,
        turn: 1,
        busy: true,
        pending: [],
        messages: [{ id: 'user', role: 'user', text: 'Request', turn: 1 }],
      }
      const ended = events.reduce(applyEvent, thread)
      expect(ended.pending).toEqual([])
      expect(threadHasRunningChildren(ended)).toBe(false)
      expect(agents.hasRunningSessions()).toBe(false)
      expect(status === 'stopped' ? ['stopped', 'interrupted'] : ['completed']).toContain(
        ended.messages.find((message) => message.title === 'Bash')?.status,
      )
    },
  )

  it('cancels a deferred Fast opt-in restart when Standard is selected before the next turn', async () => {
    const { agents, channel, start, finishRoot } = await fixture()
    await agents.configure({ sessionId: 'local', serviceTier: 'fast' })
    await agents.configure({ sessionId: 'local', serviceTier: 'default' })
    finishRoot()
    await start('Continue with Standard')
    expect(channel.destroyed).toBe(false)
    expect(channel.signals).toEqual([])
    expect(channel.sent.filter((message) => message.type === 'user')).toHaveLength(2)
  })

  it('shows a completed task as running when Claude opens a newer native run for that task', async () => {
    const { agents, events, channel, finishRoot, child } = await fixture()
    channel.reply({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-child',
      run_id: 'run-01',
      tool_use_id: 'delegate',
      description: 'Researcher',
      is_backgrounded: true,
    })
    child({
      type: 'assistant',
      uuid: 'first-run-answer',
      message: { id: 'first-run-answer', content: [{ type: 'text', text: 'First task answer' }] },
    })
    channel.reply({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-child',
      run_id: 'run-01',
      tool_use_id: 'delegate',
      status: 'completed',
      summary: 'First run complete',
    })
    finishRoot()
    const initial: Thread = {
      id: 'local',
      profileId: 'machine',
      provider: 'claude',
      title: 'Test',
      messages: [],
      pending: [],
      busy: true,
      turn: 1,
      updatedAt: 1,
      model: '',
      mode: 'review',
    }
    const completed = events.reduce(applyEvent, initial)
    expect(threadHasRunningChildren(completed)).toBe(false)
    const boundary = events.length
    channel.reply({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-child',
      run_id: 'run-02',
      tool_use_id: 'delegate',
      description: 'Researcher',
      is_backgrounded: true,
    })
    const resumed = events.slice(boundary).reduce(applyEvent, completed)
    expect(agents.hasRunningSessions()).toBe(true)
    expect(threadHasRunningChildren(resumed)).toBe(true)
    expect(resumed.busy).toBe(false)
    expect(resumed.messages.find((message) => message.text === 'First task answer')).toEqual(
      completed.messages.find((message) => message.text === 'First task answer'),
    )
    const replayBoundary = events.length
    channel.reply({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-child',
      run_id: 'run-01',
      tool_use_id: 'delegate',
      description: 'Stale run',
      is_backgrounded: true,
    })
    expect(events).toHaveLength(replayBoundary)
    channel.reply({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-child',
      run_id: 'run-02',
      tool_use_id: 'delegate',
      status: 'failed',
      summary: 'Second run failed',
    })
    const ended = events.slice(replayBoundary).reduce(applyEvent, resumed)
    expect(threadHasRunningChildren(ended)).toBe(false)
    expect(ended.messages.find((message) => message.text === 'First task answer')).toEqual(
      completed.messages.find((message) => message.text === 'First task answer'),
    )
  })

  it('cancels the child request presentation when Stop denies it and terminates the process', async () => {
    const { agents, events, channel, child } = await fixture()
    channel.reply({
      type: 'assistant',
      uuid: 'delegate-envelope',
      session_id: 'parent-session',
      message: {
        id: 'root-delegation',
        content: [
          {
            type: 'tool_use',
            id: 'delegate',
            name: 'Agent',
            input: { description: 'Researcher', prompt: 'Investigate' },
          },
        ],
      },
    })
    child({
      type: 'control_request',
      request_id: 'child-stop-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        agent_id: 'delegate',
        input: { command: 'touch background-output' },
      },
    })
    const thread: Thread = {
      id: 'local',
      profileId: 'machine',
      provider: 'claude',
      model: '',
      mode: 'review',
      title: 'Background work',
      updatedAt: 1,
      turn: 1,
      busy: true,
      pending: [],
      messages: [{ id: 'user', role: 'user', text: 'User request', turn: 1 }],
    }
    await agents.stop('local')
    expect(channel.signals).toContain('TERM')
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        type: 'control_response',
        response: expect.objectContaining({
          request_id: 'child-stop-request',
          response: expect.objectContaining({ behavior: 'deny' }),
        }),
      }),
    )
    const stopped = events.reduce(applyEvent, thread)
    expect(stopped.busy).toBe(false)
    expect(stopped.pending).toEqual([])
    expect(
      stopped.messages.find((message) => message.details?.requestId === 'child-stop-request'),
    ).toMatchObject({
      status: 'declined',
    })
    expect(
      stopped.messages.find(
        (message) => message.kind === 'subagent' && message.agentId === 'delegate',
      ),
    ).toMatchObject({
      status: 'interrupted',
    })
  })

  it('stops only active background children after an already completed root turn', async () => {
    const { agents, events, channel, finishRoot } = await fixture()
    channel.reply({
      type: 'assistant',
      uuid: 'two-delegates',
      session_id: 'parent-session',
      message: {
        id: 'root-two-delegates',
        content: ['finished-child', 'active-child'].map((id) => ({
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description: id, prompt: 'Investigate' },
        })),
      },
    })
    channel.reply({
      type: 'user',
      session_id: 'parent-session',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'finished-child', content: 'Completed findings' },
        ],
      },
    })
    finishRoot()
    const completedRootEvents = events.filter(
      (event) => event.type === 'complete' && !event.agentId,
    )
    expect(completedRootEvents).toHaveLength(1)
    await agents.stop('local')
    expect(channel.signals).toContain('TERM')
    const children = events.filter((event) => event.type === 'subagent')
    expect(children.filter((event) => event.agentId === 'finished-child').at(-1)).toMatchObject({
      status: 'completed',
    })
    expect(children.filter((event) => event.agentId === 'active-child').at(-1)).toMatchObject({
      status: 'interrupted',
    })
    expect(events.filter((event) => event.type === 'complete' && !event.agentId)).toEqual(
      completedRootEvents,
    )
  })
})
