import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, PermissionMode, Provider, StartInput } from '../src/shared/types'

const titleGenerator = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/main/provider-titles', () => ({ generateProviderTitle: titleGenerator }))

type Message = Record<string, any>
const model = {
  model: 'test-model',
  displayName: 'Test model',
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
    reasoningEffort,
  })),
  serviceTiers: [{ id: 'default' }, { id: 'fast' }],
}
const claudeModel = {
  value: 'test-model',
  displayName: 'Test model',
  supportedEffortLevels: ['low', 'medium', 'high'],
  supportsFastMode: true,
}

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: Message[] = []
  signals: string[] = []
  closes = 0
  ends = 0
  held = new Set<string>()
  errors = new Map<string, string>()
  transportState?: 'connected' | 'suspended' | 'closed'
  turnSequence = 0
  remoteId = 'parent-remote'
  claudeInitialState?: string
  codexModels = [model, { ...model, model: 'new-model' }]
  claudeModels = [claudeModel]
  config: Message = { model: 'test-model' }

  write(raw: string) {
    const message = JSON.parse(raw) as Message
    this.messages.push(message)
    queueMicrotask(() => {
      if (this.destroyed) return
      const method = message.method || message.request?.subtype
      if (this.held.has(method)) return
      if (message.type === 'control_request') {
        this.controlReply(message, {
          models: this.claudeModels,
          ...(this.claudeInitialState ? { session_state: this.claudeInitialState } : {}),
        })
      } else if (message.id !== undefined) {
        if (this.errors.has(method))
          this.reply({
            id: message.id,
            error: { code: -32601, message: this.errors.get(method) },
          })
        else {
          const results: Record<string, Message> = {
            initialize: {},
            'config/read': { config: this.config },
            'model/list': { data: this.codexModels },
            'thread/start': { thread: { id: this.remoteId }, reasoningEffort: 'medium' },
            'thread/resume': { thread: { id: message.params?.threadId } },
            'turn/start': { turn: { id: `turn-${this.turnSequence + 1}` } },
            'thread/read': { thread: { id: message.params?.threadId } },
            'turn/settings/update': { status: 'applied' },
          }
          if (method === 'turn/start') this.turnSequence++
          this.reply({ id: message.id, result: results[method] || {} })
        }
      }
    })
    return true
  }

  reply(message: Message) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  controlReply(request: Message, response: Message = {}) {
    this.reply({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response },
    })
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

  end() {
    this.ends++
  }

  close() {
    this.closes++
    this.destroyed = true
    this.emit('close')
  }

  suspend() {
    this.transportState = 'suspended'
    this.emit('suspended')
  }

  resume() {
    this.transportState = 'connected'
    this.emit('resumed')
  }

  of(method: string) {
    return this.messages.filter(
      (message) => message.method === method || message.request?.subtype === method,
    )
  }

  users() {
    return this.messages.filter((message) => message.type === 'user')
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
  titleGenerator.mockClear()
  vi.useRealTimers()
})

function fixture(
  options: {
    durable?: boolean
    claudeInitialState?: string
    configureChannel?: (channel: Channel, command: string) => void
  } = {},
) {
  const channels: Channel[] = []
  const commands: string[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.0',
    claude: 'claude 2.1.0',
  }
  ssh.channel = vi.fn(async (command) => {
    commands.push(command)
    const channel = new Channel()
    if (ssh.state.profile) channel.remoteId = `${ssh.state.profile.host}-remote`
    if (options.durable) channel.transportState = 'connected'
    channel.claudeInitialState = options.claudeInitialState
    options.configureChannel?.(channel, command)
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  if (options.durable) ssh.durableChannel = ssh.channel
  ssh.exec = vi.fn(async () => {
    throw new Error('An ordinary conversation must not stage extra instructions')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const start = (extra: Partial<StartInput> = {}) =>
    agents.start({
      sessionId: 'local-thread',
      provider: 'codex',
      prompt: 'User request',
      model: 'test-model',
      mode: 'review',
      ...extra,
    })
  const conversation = (provider: Provider) => {
    const channel = channels.find((channel) =>
      provider === 'codex' ? channel.of('turn/start').length > 0 : channel.users().length > 0,
    )
    if (!channel) throw new Error(`No active ${provider} channel`)
    return channel
  }
  return { channels, commands, ssh, events, agents, start, conversation }
}

function codexComplete(channel: Channel, turnId = 'turn-1') {
  channel.reply({
    method: 'turn/completed',
    params: { threadId: 'parent-remote', turn: { id: turnId, status: 'completed' } },
  })
}

describe('native provider access controls', () => {
  it.each([
    {
      mode: 'ask-for-approval',
      sandbox: 'workspace-write',
      policy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false },
      approvalPolicy: 'on-request',
      reviewer: 'user',
    },
    {
      mode: 'read-only',
      sandbox: 'read-only',
      policy: { type: 'readOnly' },
      approvalPolicy: 'on-request',
      reviewer: 'user',
    },
    {
      mode: 'auto-review',
      sandbox: 'workspace-write',
      policy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false },
      approvalPolicy: 'on-request',
      reviewer: 'auto_review',
    },
    {
      mode: 'full-access',
      sandbox: 'danger-full-access',
      policy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
      reviewer: 'user',
    },
  ])(
    'applies Codex $mode at startup and through live settings',
    async ({ mode, sandbox, policy, approvalPolicy, reviewer }) => {
      const { start, agents, conversation } = fixture()
      await start({ mode: mode as PermissionMode })
      const channel = conversation('codex')
      expect(channel.of('thread/start')[0].params).toMatchObject({
        sandbox,
        approvalPolicy,
        approvalsReviewer: reviewer,
      })
      expect(channel.of('turn/start')[0].params).toMatchObject({
        sandboxPolicy: policy,
        approvalPolicy,
        approvalsReviewer: reviewer,
      })
      await agents.configure({ sessionId: 'local-thread', mode: mode as PermissionMode })
      expect(channel.of('thread/settings/update')[0].params).toMatchObject({
        sandboxPolicy: policy,
        approvalPolicy,
        approvalsReviewer: reviewer,
      })
      await agents.configure({ sessionId: 'local-thread', mode: 'ask-for-approval' })
      expect(channel.of('thread/settings/update')[1].params).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/project'],
          networkAccess: false,
        },
      })
    },
  )

  it.each<[PermissionMode, string]>([
    ['review', 'default'],
    ['edit', 'acceptEdits'],
    ['auto', 'auto'],
    ['dontAsk', 'dontAsk'],
    ['full-access', 'bypassPermissions'],
  ])('applies Claude %s through its native CLI and live control', async (mode, nativeMode) => {
    const { start, agents, commands, conversation } = fixture()
    await start({ provider: 'claude', mode })
    expect(commands[0]).toContain(`'--permission-mode' '${nativeMode}'`)
    expect(commands[0]).toContain("'--allow-dangerously-skip-permissions'")
    const channel = conversation('claude')
    await agents.configure({ sessionId: 'local-thread', mode })
    expect(channel.of('set_permission_mode')[0].request).toEqual({
      subtype: 'set_permission_mode',
      mode: nativeMode,
    })
    expect(channel.users()).toHaveLength(1)
    expect(channel.of('interrupt')).toHaveLength(0)
  })
})

describe('exact user input at the provider protocol boundary', () => {
  const prompt = '  /life do not expand this\r\n```$HOME ${literal}```\n研究 👋\t '

  it.each(['codex', 'claude'] as const)(
    'sends literal /life text byte for byte to %s without a hidden user turn',
    async (provider) => {
      const { start, ssh, conversation, commands } = fixture()
      await start({ provider, prompt })
      const channel = conversation(provider)
      const content =
        provider === 'codex'
          ? channel.of('turn/start')[0].params.input
          : channel.users()[0].message.content
      expect(content).toEqual([{ type: 'text', text: prompt }])
      expect(Buffer.from(content[0].text)).toEqual(Buffer.from(prompt))
      expect(provider === 'codex' ? channel.of('turn/start') : channel.users()).toHaveLength(1)
      expect(ssh.exec).not.toHaveBeenCalled()
      expect(commands.every((command) => !command.includes(prompt))).toBe(true)
    },
  )

  it('sends only selected Codex native images and bare file paths after the exact prompt', async () => {
    const { start, conversation } = fixture()
    const image = { name: 'photo.png', mimeType: 'image/png', remotePath: '/project/photo.png' }
    const source = { name: 'source.ts', mimeType: 'text/plain', remotePath: '/project/source.ts' }
    await start({ prompt, attachments: [image, source] })
    expect(conversation('codex').of('turn/start')[0].params.input).toEqual([
      { type: 'text', text: prompt },
      { type: 'localImage', path: image.remotePath },
      { type: 'text', text: source.remotePath },
    ])
  })

  it('sends Claude attachments as native document blocks without adding a preamble', async () => {
    const { start, ssh, conversation } = fixture()
    const file = { name: 'notes.md', mimeType: 'text/markdown', remotePath: '/project/notes.md' }
    const bytes = Buffer.from('  # My original file\r\n研究\n')
    ssh.exec = vi.fn(async () =>
      JSON.stringify([{ size: bytes.length, data: bytes.toString('base64') }]),
    )
    await start({ provider: 'claude', prompt, attachments: [file] })
    expect(conversation('claude').users()[0].message.content).toEqual([
      { type: 'text', text: prompt },
      {
        type: 'document',
        title: 'notes.md',
        source: { type: 'text', media_type: 'text/plain', data: bytes.toString() },
      },
    ])
    expect(ssh.exec).toHaveBeenCalledTimes(1)
  })

  it.each(['codex', 'claude'] as const)(
    'runs a research %s conversation inside its dedicated home workspace without changing the active project',
    async (provider) => {
      const { start, ssh, conversation, commands } = fixture()
      const workspace = '/home/researcher/.life/research/topic-1'
      await start({ provider, prompt, scope: 'research', workspace })
      const channel = conversation(provider)
      expect(ssh.state.workspace).toBe('/project')
      if (provider === 'codex') {
        expect(channel.of('thread/start')[0].params.cwd).toBe(workspace)
        expect(channel.of('turn/start')[0].params.cwd).toBe(workspace)
        expect(channel.of('turn/start')[0].params.input).toEqual([{ type: 'text', text: prompt }])
      } else {
        expect(commands[0]).toContain(`cd '${workspace}'`)
        expect(channel.users()[0].message.content).toEqual([{ type: 'text', text: prompt }])
      }
      expect(ssh.exec).not.toHaveBeenCalled()
    },
  )

  it.each([
    '/project/.research/topic',
    '/home/researcher/.life/research/../outside',
    '/home/researcher/.life/research2/topic',
  ])('rejects research outside the dedicated .life/research root: %s', async (workspace) => {
    const { start, channels } = fixture()
    await expect(start({ scope: 'research', workspace })).rejects.toThrow(/research workspace/)
    expect(channels).toHaveLength(0)
  })

  it.each(['edit', 'review'] as const)(
    'pins Codex research %s writes to the goal while keeping the problem as cwd',
    async (mode) => {
      const { start, agents, conversation, ssh } = fixture()
      const goal = '/home/researcher/.life/research/topic-1'
      const problem = `${goal}/problems/problem-1`
      await start({ scope: 'research', workspace: problem, mode })
      const channel = conversation('codex')
      const policy = {
        type: 'workspaceWrite',
        writableRoots: [goal],
        networkAccess: false,
      }
      expect(channel.of('thread/start')[0].params.cwd).toBe(problem)
      expect(channel.of('turn/start')[0].params).toMatchObject({
        cwd: problem,
        sandboxPolicy: policy,
      })
      ssh.state.home = '/another-home'
      await agents.configure({ sessionId: 'local-thread', mode })
      expect(channel.of('thread/settings/update')[0].params.sandboxPolicy).toEqual(policy)
      expect(channel.of('turn/start')).toHaveLength(1)
      expect(ssh.state.workspace).toBe('/project')
    },
  )

  it('keeps research Plan read-only at startup and on permission updates', async () => {
    const { start, agents, conversation } = fixture()
    const problem = '/home/researcher/.life/research/topic-1/problems/problem-1'
    await start({ scope: 'research', workspace: problem, mode: 'plan' })
    const channel = conversation('codex')
    expect(channel.of('thread/start')[0].params).toMatchObject({
      cwd: problem,
      sandbox: 'read-only',
    })
    expect(channel.of('turn/start')[0].params).toMatchObject({
      cwd: problem,
      sandboxPolicy: { type: 'readOnly' },
    })
    await agents.configure({ sessionId: 'local-thread', mode: 'plan' })
    expect(channel.of('thread/settings/update')[0].params.sandboxPolicy).toEqual({
      type: 'readOnly',
    })
  })

  it('gives Claude research problem threads the goal as an additional directory without changing cwd or user text', async () => {
    const { start, commands, conversation } = fixture()
    const goal = '/home/researcher/.life/research/topic-1'
    const problem = `${goal}/problems/problem-1`
    await start({ provider: 'claude', scope: 'research', workspace: problem, prompt })
    expect(commands[0]).toContain(`cd '${problem}'`)
    expect(commands[0]).toContain(`'--add-dir' '${goal}'`)
    expect(conversation('claude').users()[0].message.content).toEqual([
      { type: 'text', text: prompt },
    ])
  })

  it('keeps ordinary project write permissions scoped to that project', async () => {
    const { start, agents, conversation } = fixture()
    await start({ mode: 'edit' })
    const channel = conversation('codex')
    const policy = {
      type: 'workspaceWrite',
      writableRoots: ['/project'],
      networkAccess: false,
    }
    expect(channel.of('turn/start')[0].params).toMatchObject({
      cwd: '/project',
      sandboxPolicy: policy,
    })
    await agents.configure({ sessionId: 'local-thread', mode: 'review' })
    expect(channel.of('thread/settings/update')[0].params.sandboxPolicy).toEqual(policy)
  })

  it.each([
    '/home/researcher/.life/research/',
    '/home/researcher/.life/research/.hidden',
    '/home/researcher/.life/research/topic-1/',
    '/home/researcher/.life/research/topic-1//problems/problem-1',
    '/home/researcher/.life/research/topic-1/problems/',
    '/home/researcher/.life/research/topic-1/problems/.hidden',
    '/home/researcher/.life/research/topic-1/other/problem-1',
    '/home/researcher/.life/research/topic-1/problems/problem-1/child',
    '/home/researcher/.life/research/topic-1\\problems\\problem-1',
    '/home/researcher/.life/research/topic-1/problems/problem\0one',
  ])('rejects a noncanonical research sandbox path: %j', async (workspace) => {
    const { start, channels } = fixture()
    await expect(start({ scope: 'research', workspace, mode: 'edit' })).rejects.toThrow(
      /research workspace/,
    )
    expect(channels).toHaveLength(0)
  })
})

describe('native steering and live provider configuration', () => {
  it('steers the same Codex turn with its expected ID without interrupting or creating another turn', async () => {
    const { start, agents, conversation, events } = fixture()
    await start()
    const channel = conversation('codex')
    const prompt = '  change direction\r\n👋 '
    await agents.steer({ sessionId: 'local-thread', prompt })
    expect(channel.of('turn/steer')).toHaveLength(1)
    expect(channel.of('turn/steer')[0].params).toEqual({
      threadId: 'parent-remote',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: prompt }],
    })
    expect(channel.of('turn/start')).toHaveLength(1)
    expect(channel.of('turn/interrupt')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(0)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('rejects steering after completion without delivering the message as a new turn', async () => {
    const { start, agents, conversation } = fixture()
    await start()
    const channel = conversation('codex')
    codexComplete(channel)
    await expect(agents.steer({ sessionId: 'local-thread', prompt: 'Too late' })).rejects.toThrow(
      /active turn has finished/i,
    )
    expect(channel.of('turn/steer')).toHaveLength(0)
    expect(channel.of('turn/start')).toHaveLength(1)
  })

  it('updates Codex thread and running-turn model, reasoning and speed through settings-only APIs', async () => {
    const { start, agents, conversation, commands } = fixture()
    await start()
    const channel = conversation('codex')
    const result = await agents.configure({
      sessionId: 'local-thread',
      model: 'new-model',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    })
    expect(result.applied).toBe('live')
    expect(channel.of('thread/settings/update')[0].params).toEqual({
      threadId: 'parent-remote',
      model: 'new-model',
      effort: 'high',
      serviceTier: 'fast',
    })
    expect(channel.of('turn/settings/update')[0].params).toEqual({
      threadId: 'parent-remote',
      turnId: 'turn-1',
      model: 'new-model',
      effort: 'high',
      serviceTier: 'fast',
    })
    expect(channel.of('turn/start')).toHaveLength(1)
    expect(channel.of('turn/steer')).toHaveLength(0)
    expect(channel.of('turn/interrupt')).toHaveLength(0)
    expect(channel.closes).toBe(0)
    expect(commands[0]).toContain('features.step_model_switching=true')
    codexComplete(channel)
    await start({
      prompt: 'Next explicit request',
      model: 'new-model',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    })
    expect(channel.of('turn/start')[1].params).toMatchObject({
      model: 'new-model',
      effort: 'high',
      serviceTier: 'fast',
    })
    expect(channel.of('turn/start')[1].params.input).toEqual([
      { type: 'text', text: 'Next explicit request' },
    ])
  })

  it('publishes Codex reviewer changes to the active turn without a prompt or interruption', async () => {
    const { start, agents, conversation } = fixture()
    await start({ mode: 'ask-for-approval' })
    const channel = conversation('codex')
    const result = await agents.configure({ sessionId: 'local-thread', mode: 'auto-review' })
    expect(result.applied).toBe('live')
    expect(channel.of('turn/settings/update')[0].params).toEqual({
      threadId: 'parent-remote',
      turnId: 'turn-1',
      approvalsReviewer: 'auto_review',
    })
    expect(channel.of('turn/start')).toHaveLength(1)
    expect(channel.of('turn/interrupt')).toHaveLength(0)
    expect(channel.of('turn/steer')).toHaveLength(0)
  })

  it('applies live model changes alongside a permission change using only supported turn fields', async () => {
    const { start, agents, conversation } = fixture()
    await start({ mode: 'ask-for-approval' })
    const channel = conversation('codex')
    const result = await agents.configure({
      sessionId: 'local-thread',
      mode: 'read-only',
      model: 'new-model',
      reasoningEffort: 'high',
    })
    expect(result.applied).toBe('next-request')
    expect(channel.of('thread/settings/update')[0].params).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'on-request',
      model: 'new-model',
    })
    expect(channel.of('turn/settings/update')[0].params).toEqual({
      threadId: 'parent-remote',
      turnId: 'turn-1',
      approvalsReviewer: 'user',
      model: 'new-model',
      effort: 'high',
    })
    expect(channel.of('turn/start')).toHaveLength(1)
    expect(channel.of('turn/interrupt')).toHaveLength(0)
  })

  it.each(['thread/settings/update', 'turn/settings/update'])(
    'handles an older Codex missing %s without a hidden prompt or interrupted turn',
    async (method) => {
      const { start, agents, conversation } = fixture()
      await start()
      const channel = conversation('codex')
      channel.errors.set(method, 'Method not found')
      const result = await agents.configure({
        sessionId: 'local-thread',
        reasoningEffort: 'high',
        serviceTier: 'fast',
      })
      expect(result.applied).toBe('next-request')
      expect(result.note).toMatch(/next turn|next agent request/i)
      expect(channel.of('turn/start')).toHaveLength(1)
      expect(channel.of('turn/steer')).toHaveLength(0)
      expect(channel.of('turn/interrupt')).toHaveLength(0)
      expect(channel.closes).toBe(0)
      expect(agents.hasRunningSessions()).toBe(true)
    },
  )

  it('delivers Claude steering at the native next boundary while the same generation stays active', async () => {
    const { start, agents, conversation } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'init', session_id: 'claude-parent' })
    await agents.steer({ sessionId: 'local-thread', prompt: '  revise the plan\n' })
    expect(channel.users()).toHaveLength(2)
    expect(channel.users()[1]).toMatchObject({
      session_id: 'claude-parent',
      priority: 'next',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '  revise the plan\n' }] },
    })
    expect(channel.of('interrupt')).toHaveLength(0)
    expect(channel.closes).toBe(0)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('applies Claude model, effort, speed and permissions through native controls without empty messages', async () => {
    const { start, agents, conversation } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    const result = await agents.configure({
      sessionId: 'local-thread',
      model: 'test-model',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      mode: 'edit',
    })
    expect(channel.of('set_model')[0].request).toEqual({
      subtype: 'set_model',
      model: 'test-model',
    })
    expect(channel.of('apply_flag_settings')[0].request).toEqual({
      subtype: 'apply_flag_settings',
      settings: { effortLevel: 'high', fastMode: true },
    })
    expect(channel.of('set_permission_mode')[0].request).toEqual({
      subtype: 'set_permission_mode',
      mode: 'acceptEdits',
    })
    expect(result.note).toMatch(/without interrupting/)
    expect(channel.users()).toHaveLength(1)
    expect(channel.of('interrupt')).toHaveLength(0)
    expect(channel.closes).toBe(0)
    expect(channel.ends).toBe(0)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('keeps Claude alive between completed turns and sends the next explicit user message on the same channel', async () => {
    const { start, agents, conversation, channels } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'init', session_id: 'claude-parent' })
    channel.reply({ type: 'result', session_id: 'claude-parent', result: 'Done', is_error: false })
    expect(agents.hasRunningSessions()).toBe(false)
    expect(channel.closes).toBe(0)
    await start({ provider: 'claude', prompt: '  continue unchanged\r\n' })
    expect(channels.filter((channel) => channel.users().length)).toHaveLength(1)
    expect(channel.users()).toHaveLength(2)
    expect(channel.users()[1].message.content).toEqual([
      { type: 'text', text: '  continue unchanged\r\n' },
    ])
    expect(channel.of('initialize')).toHaveLength(1)
    expect(channel.closes).toBe(0)
    expect(channel.ends).toBe(0)
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('waits for authoritative Claude idle rather than ending a turn on an intermediate result', async () => {
    const { start, agents, conversation, events } = fixture({ claudeInitialState: 'idle' })
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    channel.reply({ type: 'result', result: 'First result', is_error: false })
    expect(agents.hasRunningSessions()).toBe(true)
    expect(events.some((event) => event.type === 'complete')).toBe(false)
    channel.reply({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' })
    expect(agents.hasRunningSessions()).toBe(true)
    channel.reply({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1)
    expect(agents.hasRunningSessions()).toBe(false)
  })
})

describe('complete provider events and independent child agents', () => {
  it('retains Codex commentary/final phases, reasoning summaries and structured plans', async () => {
    const { start, conversation, events } = fixture()
    await start()
    const channel = conversation('codex')
    const send = (method: string, params: Message) =>
      channel.reply({ method, params: { threadId: 'parent-remote', turnId: 'turn-1', ...params } })
    send('item/started', {
      item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Starting' },
    })
    send('item/agentMessage/delta', { itemId: 'commentary', delta: 'Visible progress' })
    send('item/completed', {
      item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Complete answer' },
    })
    send('item/reasoning/summaryTextDelta', {
      itemId: 'reasoning',
      delta: 'Published reasoning summary',
    })
    send('item/completed', {
      item: { id: 'reasoning', type: 'reasoning', summary: ['One', 'Two'] },
    })
    const plan = [
      { step: 'Inspect', status: 'completed' },
      { step: 'Fix', status: 'in_progress' },
    ]
    send('turn/plan/updated', { explanation: 'Real provider plan', plan })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        itemId: 'commentary',
        phase: 'commentary',
        text: 'Visible progress',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        itemId: 'answer',
        phase: 'final_answer',
        text: 'Complete answer',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        itemId: 'reasoning',
        text: 'One\n\nTwo',
        status: 'replace',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'plan', text: 'Real provider plan', details: { plan } }),
    )
  })

  it('routes Codex child streams and completion to their own identity without completing the parent', async () => {
    const { start, agents, conversation, events } = fixture()
    await start()
    const channel = conversation('codex')
    channel.reply({
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-remote',
          parentThreadId: 'parent-remote',
          agentNickname: 'Researcher',
        },
      },
    })
    channel.reply({
      method: 'turn/started',
      params: { threadId: 'child-remote', turn: { id: 'child-turn' } },
    })
    channel.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child-remote',
        turnId: 'child-turn',
        itemId: 'child-answer',
        delta: 'Child findings',
      },
    })
    channel.reply({
      method: 'turn/completed',
      params: { threadId: 'child-remote', turn: { id: 'child-turn', status: 'completed' } },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        sessionId: 'local-thread',
        agentId: 'child-remote',
        agentName: 'Researcher',
        text: 'Child findings',
      }),
    )
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(0)
    expect(
      events.filter((event) => event.type === 'session').map((event) => event.remoteId),
    ).toEqual(['parent-remote'])
    expect(agents.hasRunningSessions()).toBe(true)
    await agents.steer({ sessionId: 'local-thread', prompt: 'Keep the parent direction' })
    expect(channel.of('turn/steer')[0].params).toMatchObject({
      threadId: 'parent-remote',
      expectedTurnId: 'turn-1',
    })
  })

  it('keeps Claude child text separate and never adopts a child session ID as the parent conversation', async () => {
    const { start, agents, conversation, events } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'init', session_id: 'claude-parent' })
    channel.reply({
      type: 'assistant',
      session_id: 'claude-parent',
      message: {
        id: 'parent-text',
        content: [
          { type: 'text', text: 'Parent text' },
          {
            type: 'tool_use',
            id: 'delegate',
            name: 'Agent',
            input: { description: 'Researcher', prompt: 'Investigate' },
          },
        ],
      },
    })
    channel.reply({
      type: 'assistant',
      session_id: 'claude-child',
      parent_tool_use_id: 'delegate',
      message: { id: 'child-text', content: [{ type: 'text', text: 'Child findings' }] },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        itemId: 'child-text',
        parentItemId: 'delegate',
        agentId: 'delegate',
        agentName: 'Researcher',
        text: 'Child findings',
      }),
    )
    expect(
      events.filter((event) => event.type === 'session').map((event) => event.remoteId),
    ).toEqual(['claude-parent'])
    await agents.steer({ sessionId: 'local-thread', prompt: 'Continue' })
    expect(channel.users()[1].session_id).toBe('claude-parent')
  })

  it('does not complete the parent Claude turn when a child result or state event arrives', async () => {
    const { start, agents, conversation, events } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'init', session_id: 'claude-parent' })
    channel.reply({
      type: 'result',
      session_id: 'claude-child',
      parent_tool_use_id: 'delegate',
      result: 'Child finished its task',
      is_error: false,
    })
    channel.reply({
      type: 'system',
      subtype: 'session_state_changed',
      parent_tool_use_id: 'delegate',
      state: 'idle',
    })
    expect(agents.hasRunningSessions()).toBe(true)
    expect(
      events.filter((event) => event.type === 'complete' || event.type === 'error'),
    ).toHaveLength(0)
    expect(
      events.filter((event) => event.type === 'session').map((event) => event.remoteId),
    ).toEqual(['claude-parent'])
    await agents.steer({ sessionId: 'local-thread', prompt: 'Continue the parent request' })
    expect(channel.users()[1].session_id).toBe('claude-parent')
  })

  it('keeps a Claude child generated title from renaming the parent conversation', async () => {
    const { start, conversation, events } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'system', subtype: 'ai_title', aiTitle: 'Parent title' })
    channel.reply({
      type: 'system',
      subtype: 'ai_title',
      parent_tool_use_id: 'delegate',
      aiTitle: 'Child title',
    })
    expect(events.filter((event) => event.type === 'title').map((event) => event.title)).toEqual([
      'Parent title',
    ])
  })

  it('accepts a provider-generated Codex thread title after the turn is already complete', async () => {
    const { start, conversation, events } = fixture()
    await start({ prompt: 'This is a request, not a title' })
    const channel = conversation('codex')
    codexComplete(channel)
    channel.reply({
      method: 'thread/name/updated',
      params: { threadId: 'parent-remote', threadName: 'A concise generated title' },
    })
    expect(events.filter((event) => event.type === 'title')).toEqual([
      expect.objectContaining({ sessionId: 'local-thread', title: 'A concise generated title' }),
    ])
    expect(channel.of('turn/start')).toHaveLength(1)
  })

  it('fetches a Codex provider-owned title after completion using metadata only', async () => {
    const { start, conversation, events } = fixture()
    await start()
    const channel = conversation('codex')
    channel.held.add('thread/read')
    codexComplete(channel)
    const read = channel.of('thread/read')[0]
    expect(read.params).toEqual({ threadId: 'parent-remote', includeTurns: false })
    channel.reply({
      id: read.id,
      result: { thread: { id: 'parent-remote', name: 'Provider summary title' } },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'title', title: 'Provider summary title' }),
      ),
    )
    expect(channel.of('turn/start')).toHaveLength(1)
    expect(channel.of('turn/steer')).toHaveLength(0)
  })

  it('accepts a Claude generated session title after completion without creating an extra conversation turn', async () => {
    const { start, conversation, events } = fixture()
    await start({ provider: 'claude' })
    const channel = conversation('claude')
    channel.reply({ type: 'result', result: 'Done', is_error: false })
    channel.reply({ type: 'system', subtype: 'ai_title', aiTitle: 'Generated Claude title' })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'title', title: 'Generated Claude title' }),
    )
    expect(channel.users()).toHaveLength(1)
  })
})

describe('durable agent state and asynchronous ownership', () => {
  function selectMachine(ssh: SSHConnection, host: string) {
    ssh.state = {
      ...ssh.state,
      status: 'connected',
      workspace: `/${host}-project`,
      profile: {
        id: host,
        name: host,
        host,
        port: 22,
        username: 'researcher',
        auth: 'agent',
        privateKeyPath: '',
        workspace: `/${host}-project`,
      },
    }
    ssh.emit('workspace-changing')
  }

  it.each(['model/list', 'config/read'])(
    'rejects late machine A %s data without replacing the current machine B catalog or default',
    async (method) => {
      const { start, agents, ssh, channels } = fixture({ durable: true })
      selectMachine(ssh, 'machine-a')
      await start({ sessionId: 'thread-a' })
      const channelA = channels[0]
      channelA.held.add(method)
      const stale = agents.models('codex').catch((error: Error) => error)
      await vi.waitFor(() => expect(channelA.of(method)).toHaveLength(1))
      selectMachine(ssh, 'machine-b')
      await start({ sessionId: 'thread-b' })
      const channelB = channels[1]
      channelB.codexModels = [{ ...model, model: 'machine-b-model' }]
      channelB.config = { model: 'machine-b-model' }
      expect(await agents.models('codex')).toContainEqual(
        expect.objectContaining({ id: 'machine-b-model' }),
      )
      const request = channelA.of(method)[0]
      channelA.reply({
        id: request.id,
        result:
          method === 'model/list'
            ? { data: [{ ...model, model: 'stale-a-model' }] }
            : { config: { model: 'stale-a-model', model_reasoning_effort: 'high' } },
      })
      expect(await stale).toBeInstanceOf(Error)
      await start({ sessionId: 'another-thread-b', model: undefined })
      expect(channelB.of('turn/start').at(-1)?.params.model).toBe('machine-b-model')
      expect(channelA.of('turn/start')).toHaveLength(1)
    },
  )

  it('rejects late machine A Claude discovery without replacing the current machine B capability catalog', async () => {
    let holdDiscovery = false
    const { start, agents, ssh, channels } = fixture({
      durable: true,
      configureChannel: (channel, command) => {
        if (holdDiscovery && command.includes("'claude'")) channel.held.add('initialize')
      },
    })
    selectMachine(ssh, 'machine-a')
    await start({ sessionId: 'thread-a' })
    holdDiscovery = true
    const stale = agents.models('claude').catch((error: Error) => error)
    await vi.waitFor(() => expect(channels[1]?.of('initialize')).toHaveLength(1))
    const discoveryA = channels[1]
    selectMachine(ssh, 'machine-b')
    holdDiscovery = false
    await start({ sessionId: 'thread-b' })
    const discoveryBIndex = channels.length
    const current = agents.models('claude')
    // Set the capability catalog before the provider's initialization microtask runs.
    await Promise.resolve()
    channels[discoveryBIndex].claudeModels = [
      { ...claudeModel, value: 'machine-b-claude', supportsFastMode: false },
    ]
    expect(await current).toContainEqual(expect.objectContaining({ id: 'machine-b-claude' }))
    discoveryA.controlReply(discoveryA.of('initialize')[0], {
      models: [{ ...claudeModel, value: 'stale-a-claude', supportsFastMode: true }],
    })
    expect(await stale).toBeInstanceOf(Error)
    const count = channels.length
    expect(await agents.models('claude')).toContainEqual(
      expect.objectContaining({
        id: 'machine-b-claude',
        serviceTiers: [{ id: 'default', name: 'Standard' }],
      }),
    )
    expect(channels).toHaveLength(count)
  })

  it('keeps a hanging Codex turn on machine A alive when a separate thread starts on machine B', async () => {
    const { start, agents, ssh, channels, events } = fixture({ durable: true })
    selectMachine(ssh, 'machine-a')
    await start({ sessionId: 'thread-a' })
    const channelA = channels[0]
    channelA.suspend()
    ssh.state.status = 'disconnected'
    ssh.emit('disconnected')
    selectMachine(ssh, 'machine-b')
    await start({ sessionId: 'thread-b', prompt: 'Machine B request' })
    const channelB = channels[1]
    expect(channelA.closes).toBe(0)
    expect(channelA.of('turn/start')[0].params).toMatchObject({
      threadId: 'machine-a-remote',
      cwd: '/machine-a-project',
    })
    expect(channelB.of('turn/start')[0].params).toMatchObject({
      threadId: 'machine-b-remote',
      cwd: '/machine-b-project',
    })
    channelB.reply({
      method: 'turn/completed',
      params: { threadId: 'machine-b-remote', turn: { id: 'turn-1', status: 'completed' } },
    })
    expect(agents.hasRunningSessions()).toBe(true)
    expect(
      events.filter((event) => event.type === 'complete').map((event) => event.sessionId),
    ).toEqual(['thread-b'])
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
  })

  it('saves machine A configuration without accidentally sending it to the active machine B transport', async () => {
    const { start, agents, ssh, channels } = fixture({ durable: true })
    selectMachine(ssh, 'machine-a')
    await start({ sessionId: 'thread-a' })
    channels[0].suspend()
    selectMachine(ssh, 'machine-b')
    await start({ sessionId: 'thread-b' })
    const result = await agents.configure({
      sessionId: 'thread-a',
      model: 'new-model',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    })
    expect(result.applied).toBe('next-request')
    for (const channel of channels) {
      expect(channel.of('thread/settings/update')).toHaveLength(0)
      expect(channel.of('turn/settings/update')).toHaveLength(0)
      expect(channel.of('turn/start')).toHaveLength(1)
    }
    expect(agents.hasRunningSessions()).toBe(true)
  })

  it('returns to the original machine and resumes its existing Codex daemon and turn without resending a prompt', async () => {
    const { start, agents, ssh, channels, events } = fixture({ durable: true })
    selectMachine(ssh, 'machine-a')
    await start({ sessionId: 'thread-a', prompt: 'Original machine A request' })
    const channelA = channels[0]
    channelA.suspend()
    selectMachine(ssh, 'machine-b')
    await start({ sessionId: 'thread-b', prompt: 'Original machine B request' })
    const channelB = channels[1]
    channelB.suspend()
    selectMachine(ssh, 'machine-a')
    channelA.resume()
    await agents.models('codex')
    expect(channels).toHaveLength(2)
    expect(channelA.of('initialize')).toHaveLength(1)
    expect(channelA.of('thread/resume')).toHaveLength(0)
    expect(channelA.of('turn/start')).toHaveLength(1)
    expect(channelB.of('turn/start')).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 'thread-a', type: 'status', status: 'resumed' }),
    )
    await agents.steer({ sessionId: 'thread-a', prompt: 'User steering after reconnect' })
    expect(channelA.of('turn/steer')[0].params).toEqual({
      threadId: 'machine-a-remote',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'User steering after reconnect' }],
    })
    expect(channelB.of('turn/steer')).toHaveLength(0)
  })

  it('reopens a completed Codex thread on a fresh transport after its old daemon closes', async () => {
    const { start, conversation, channels, events } = fixture({ durable: true })
    await start()
    const channel = conversation('codex')
    codexComplete(channel)
    channel.close()
    await start({ prompt: 'Follow-up on the existing conversation' })
    const replacement = channels[1]
    expect(replacement.of('thread/start')).toHaveLength(0)
    expect(replacement.of('thread/resume')[0].params).toMatchObject({
      threadId: 'parent-remote',
      excludeTurns: true,
    })
    expect(replacement.of('turn/start')).toHaveLength(1)
    expect(replacement.of('turn/start')[0].params.input).toEqual([
      { type: 'text', text: 'Follow-up on the existing conversation' },
    ])
    expect(
      events.filter((event) => event.type === 'session').map((event) => event.remoteId),
    ).toEqual(['parent-remote', 'parent-remote'])
  })

  it.each(['codex', 'claude'] as const)(
    'preserves ownership if SSH is lost while a durable %s provider channel is opening',
    async (provider) => {
      const { start, agents, ssh, events } = fixture({ durable: true })
      const channel = new Channel()
      channel.transportState = 'suspended'
      let open!: (channel: ClientChannel) => void
      ssh.durableChannel = vi.fn(
        () =>
          new Promise<ClientChannel>((resolve) => {
            open = resolve
          }),
      )
      const starting = start({ provider })
      await vi.waitFor(() => expect(ssh.durableChannel).toHaveBeenCalledTimes(1))
      ssh.state.status = 'disconnected'
      ssh.emit('disconnected')
      open(channel as unknown as ClientChannel)
      await starting
      expect(channel.closes).toBe(0)
      expect(agents.hasRunningSessions()).toBe(true)
      expect(
        events.filter((event) => event.type === 'error' || event.type === 'complete'),
      ).toHaveLength(0)
      expect(provider === 'codex' ? channel.of('turn/start') : channel.users()).toHaveLength(1)
      ssh.state.status = 'connected'
      channel.resume()
      expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'resumed' }))
    },
  )

  it.each(['codex', 'claude'] as const)(
    'keeps %s running through SSH loss and resumes the same turn',
    async (provider) => {
      const { start, agents, ssh, conversation, events } = fixture({ durable: true })
      await start({ provider })
      const channel = conversation(provider)
      channel.suspend()
      ssh.state.status = 'disconnected'
      ssh.emit('disconnected')
      expect(channel.closes).toBe(0)
      expect(agents.hasRunningSessions()).toBe(true)
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'status', status: 'suspended' }),
      )
      ssh.state.status = 'connected'
      channel.resume()
      expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'resumed' }))
      expect(provider === 'codex' ? channel.of('turn/start') : channel.users()).toHaveLength(1)
      expect(
        events.filter((event) => event.type === 'error' || event.type === 'complete'),
      ).toHaveLength(0)
    },
  )

  it('pauses a pending Claude live control timeout while offline and resumes the remaining budget', async () => {
    vi.useFakeTimers()
    const { start, agents, conversation } = fixture({ durable: true })
    await start({ provider: 'claude' })
    // Model discovery is a metadata channel with no user turns; complete it before the measured control.
    await agents.models('claude')
    const channel = conversation('claude')
    channel.held.add('set_model')
    const configuring = agents.configure({ sessionId: 'local-thread', model: 'test-model' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(channel.of('set_model')).toHaveLength(1)
    channel.suspend()
    await vi.advanceTimersByTimeAsync(120000)
    expect(agents.hasRunningSessions()).toBe(true)
    expect(channel.closes).toBe(0)
    channel.resume()
    await vi.advanceTimersByTimeAsync(10000)
    channel.controlReply(channel.of('set_model')[0])
    await expect(configuring).resolves.toMatchObject({ applied: 'live' })
    expect(channel.of('set_model')).toHaveLength(1)
    expect(channel.users()).toHaveLength(1)
  })

  it('does not consume a paused Claude control deadline on duplicate suspended or resumed notifications', async () => {
    vi.useFakeTimers()
    const { start, agents, conversation } = fixture({ durable: true })
    await start({ provider: 'claude' })
    await agents.models('claude')
    const channel = conversation('claude')
    channel.held.add('set_model')
    const configuring = agents.configure({ sessionId: 'local-thread', model: 'test-model' })
    const outcome = configuring.catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(4000)
    channel.suspend()
    await vi.advanceTimersByTimeAsync(1000)
    channel.emit('suspended')
    await vi.advanceTimersByTimeAsync(120000)
    channel.resume()
    channel.emit('resumed')
    await vi.advanceTimersByTimeAsync(10000)
    channel.controlReply(channel.of('set_model')[0])
    expect(await outcome).toMatchObject({ applied: 'live' })
    expect(channel.of('set_model')).toHaveLength(1)
    expect(channel.users()).toHaveLength(1)
  })

  it('does not let a queued configuration mutate a replacement agent after a project change', async () => {
    const { start, agents, ssh, conversation, channels, events } = fixture()
    await start()
    const oldChannel = conversation('codex')
    oldChannel.held.add('thread/settings/update')
    const first = agents.configure({ sessionId: 'local-thread', model: 'new-model' })
    const firstOutcome = first.catch((error: Error) => error)
    const queued = agents.configure({ sessionId: 'local-thread', reasoningEffort: 'high' })
    const queuedOutcome = queued.catch((error: Error) => error)
    await vi.waitFor(() => expect(oldChannel.of('thread/settings/update')).toHaveLength(1))
    agents.close('Project changed')
    ssh.state.workspace = '/another-project'
    events.length = 0
    await start({ prompt: 'Replacement request' })
    const newChannel = channels.find(
      (channel) => channel !== oldChannel && channel.of('turn/start').length > 0,
    )!
    expect(await firstOutcome).toBeInstanceOf(Error)
    expect(await queuedOutcome).toBeInstanceOf(Error)
    expect(newChannel.of('thread/settings/update')).toHaveLength(0)
    expect(newChannel.of('turn/settings/update')).toHaveLength(0)
    expect(newChannel.of('turn/start')[0].params.model).toBe('test-model')
    expect(events.filter((event) => event.type === 'settings')).toHaveLength(0)
    expect(newChannel.closes).toBe(0)
  })
})
