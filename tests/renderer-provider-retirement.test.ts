import { EventEmitter } from 'node:events'
import { Deferred, Effect, Fiber } from 'effect'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { CodexRPC } from '../src/main/codex-rpc'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, Provider, StartInput } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>
const firstPrompt = '  Exact first prompt\r\n🧪  '
const nextPrompt = '  Exact follow-up\n\ud800  '

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  messages: Wire[] = []
  held = new Set<string>()
  closes = 0
  signals: string[] = []
  closeAndWaitEffect?: () => Effect.Effect<boolean>
  private answered = new Set<number | string>()

  constructor(readonly id: number) {
    super()
  }

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.messages.push(message)
    const method = message.method || message.request?.subtype
    if (method)
      queueMicrotask(() => {
        if (!this.destroyed && !this.held.has(method)) this.answer(message)
      })
    return true
  }

  of(method: string) {
    return this.messages.filter(
      (message) => message.method === method || message.request?.subtype === method,
    )
  }

  answer(message: Wire) {
    const key = message.id ?? message.request_id
    this.answered.add(key)
    if (message.type === 'control_request') {
      this.reply({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response:
            message.request.subtype === 'initialize'
              ? {
                  session_state: 'idle',
                  models: [{ value: 'test-model', displayName: 'Test' }],
                }
              : {},
        },
      })
    } else if (typeof message.id === 'number') {
      const results: Record<string, Wire> = {
        initialize: {},
        'config/read': { config: { model: 'test-model' } },
        'model/list': { data: [{ model: 'test-model', isDefault: true }] },
        'thread/start': { thread: { id: `remote-${this.id}` } },
        'thread/resume': { thread: { id: message.params.threadId } },
        'turn/start': { turn: { id: `turn-${this.id}-${message.id}` } },
        'thread/read': { thread: { id: message.params.threadId } },
      }
      this.reply({ id: message.id, result: results[message.method] || {} })
    }
  }

  answerPending(method: string) {
    const pending = this.of(method).find(
      (message) => !this.answered.has(message.id ?? message.request_id),
    )
    expect(pending, `Expected an unanswered ${method}`).toBeDefined()
    this.answer(pending!)
  }

  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  close() {
    this.closes++
    this.destroyed = true
    this.emit('close')
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

  end() {}
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})

function fixture(held: string[] = []) {
  const channels: Channel[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.1',
    claude: '2.1.296 (Claude Code)',
  }
  ssh.channel = vi.fn(async () => {
    const channel = new Channel(channels.length + 1)
    held.forEach((method) => channel.held.add(method))
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('Renderer retirement fixtures must not run a shell command or inference')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const start = (extra: Partial<StartInput> = {}) =>
    agents.start({
      sessionId: 'local',
      provider: 'codex',
      prompt: firstPrompt,
      model: 'test-model',
      mode: 'review',
      ...extra,
    })
  const remoteId = () =>
    events.findLast((event) => event.type === 'session' && event.sessionId === 'local')!.remoteId!
  const complete = (channel = channels[0]) => {
    channel.reply({
      method: 'turn/completed',
      params: {
        threadId: remoteId(),
        turn: {
          id: `turn-${channel.id}-${channel.of('turn/start').at(-1)!.id}`,
          status: 'completed',
        },
      },
    })
  }
  const completeClaude = (channel = channels[0]) => {
    channel.reply({ type: 'system', subtype: 'init', session_id: 'claude-native' })
    channel.reply({
      type: 'result',
      session_id: 'claude-native',
      subtype: 'success',
      is_error: false,
      result: '',
    })
  }
  const prompts = () =>
    channels.flatMap((channel) =>
      channel.messages.flatMap((message) =>
        message.method === 'turn/start'
          ? [message.params.input[0].text]
          : message.type === 'user'
            ? message.message.content.map((block: Wire) => block.text)
            : [],
      ),
    )
  return { agents, channels, events, ssh, start, remoteId, complete, completeClaude, prompts }
}

const rendererWorkPending = (agents: Agents) => agents.hasPendingRendererWork()

function retireIfIdle(agents: Agents) {
  if (rendererWorkPending(agents)) return false
  agents.close('Life is reloading its interface.')
  return true
}

function observe<T>(promise: Promise<T>) {
  void promise.catch(() => {})
  return promise
}

function terminalExit(channel: Channel) {
  const terminal = Deferred.makeUnsafe<boolean>()
  channel.closeAndWaitEffect = Effect.fnUntraced(function* () {
    channel.close()
    return yield* Deferred.await(terminal)
  })
  return (confirmed = true) => Deferred.doneUnsafe(terminal, Effect.succeed(confirmed))
}

async function drainRetirementTargets(agents: Agents) {
  let passes = 0
  for (;;) {
    passes++
    const results = await Promise.all([
      agents.releaseIdleProviders(),
      agents.releaseIdleClaudeProviders(),
    ])
    if (results.flat().some((confirmed) => !confirmed)) throw new Error('Unconfirmed native exit')
    if (!agents.hasProviderRetirementTargets()) return passes
  }
}

async function idleCodex() {
  const context = fixture()
  await context.start()
  context.complete()
  expect(context.agents.hasRunningSessions()).toBe(false)
  return context
}

function childPermission(context: Awaited<ReturnType<typeof idleCodex>>) {
  const channel = context.channels[0]
  channel.reply({
    method: 'thread/started',
    params: {
      thread: {
        id: 'permission-child',
        parentThreadId: context.remoteId(),
        status: { type: 'active' },
      },
    },
  })
  channel.reply({
    id: 'native-permission-42',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'permission-child',
      itemId: 'native-command',
      command: 'printf exact',
      availableDecisions: ['accept', 'decline'],
    },
  })
  channel.reply({
    method: 'thread/status/changed',
    params: { threadId: 'permission-child', status: { type: 'idle' } },
  })
  return context.events.findLast((event) => event.type === 'approval')!
}

describe('provider ownership during renderer retirement', () => {
  it('allows a catalog-only or completed provider to retire without starting another turn', async () => {
    const { agents, channels, start, complete, prompts } = fixture()
    await agents.models('codex')
    expect(rendererWorkPending(agents)).toBe(false)
    await start()
    expect(rendererWorkPending(agents)).toBe(true)
    complete()
    expect(rendererWorkPending(agents)).toBe(false)
    expect(retireIfIdle(agents)).toBe(true)
    expect(prompts()).toEqual([firstPrompt])
    expect(channels[0].of('turn/interrupt')).toEqual([])
  })

  it('protects initial provider startup and releases ownership after the exact turn completes', async () => {
    const { agents, channels, start, complete, prompts } = fixture(['initialize'])
    const starting = start()
    await vi.waitFor(() => expect(channels[0]?.of('initialize')).toHaveLength(1))
    expect(retireIfIdle(agents)).toBe(false)
    channels[0].answerPending('initialize')
    await starting
    expect(rendererWorkPending(agents)).toBe(true)
    complete()
    expect(rendererWorkPending(agents)).toBe(false)
    expect(prompts()).toEqual([firstPrompt])
  })

  it('owns an accepted Send while provider discovery precedes session registration', async () => {
    const { agents, ssh, start, complete, prompts } = fixture()
    ssh.state.providerVersionsStatus = 'checking'
    let ready!: () => void
    const discovery = new Promise<void>((resolve) => {
      ready = resolve
    })
    ssh.whenProviderVersionsReady = vi.fn(async () => {
      await discovery
      return ssh.state
    })
    const starting = start()
    const waiting = {
      running: agents.hasRunningSessions(),
      rendererWorkPending: rendererWorkPending(agents),
    }
    ready()
    await starting
    complete()
    expect(waiting).toEqual({ running: false, rendererWorkPending: true })
    expect(rendererWorkPending(agents)).toBe(false)
    expect(prompts()).toEqual([firstPrompt])
  })

  it('does not revive an old accepted Send when explicit retirement happens during discovery', async () => {
    const { agents, ssh, start, prompts } = fixture()
    ssh.state.providerVersionsStatus = 'checking'
    let ready!: () => void
    const discovery = new Promise<void>((resolve) => {
      ready = resolve
    })
    ssh.whenProviderVersionsReady = vi.fn(async () => {
      await discovery
      return ssh.state
    })
    const starting = start().then(
      () => ({ started: true }),
      (error: Error) => ({ error: error.message }),
    )
    agents.close('Explicit renderer retirement')
    ready()
    expect({ outcome: await starting, prompts: prompts() }).toEqual({
      outcome: { error: 'Agent startup cancelled because its environment changed' },
      prompts: [],
    })
    expect(rendererWorkPending(agents)).toBe(false)
  })

  it('preserves an idle native settings acknowledgement instead of cancelling it on reload', async () => {
    const { agents, channels, prompts } = await idleCodex()
    const channel = channels[0]
    channel.held.add('thread/settings/update')
    const configuration = agents.configure({ sessionId: 'local', model: 'test-model' }).then(
      (result) => ({ result }),
      (error: Error) => ({ error: error.message }),
    )
    await vi.waitFor(() => expect(channel.of('thread/settings/update')).toHaveLength(1))
    expect(agents.hasRunningSessions()).toBe(false)
    const retired = retireIfIdle(agents)
    channel.answerPending('thread/settings/update')
    expect({ retired, closes: channel.closes, configuration: await configuration }).toMatchObject({
      retired: false,
      closes: 0,
      configuration: { result: { applied: 'next-request' } },
    })
    expect(rendererWorkPending(agents)).toBe(false)
    expect(prompts()).toEqual([firstPrompt])
    expect(channel.of('turn/interrupt')).toEqual([])
  })

  it('retains ownership across queued native settings updates', async () => {
    const { agents, channels } = await idleCodex()
    const channel = channels[0]
    channel.held.add('thread/settings/update')
    const first = observe(agents.configure({ sessionId: 'local', model: 'test-model' }))
    const second = observe(agents.configure({ sessionId: 'local', model: 'test-model' }))
    await vi.waitFor(() => expect(channel.of('thread/settings/update')).toHaveLength(1))
    expect(rendererWorkPending(agents)).toBe(true)
    channel.answerPending('thread/settings/update')
    await first
    await vi.waitFor(() => expect(channel.of('thread/settings/update')).toHaveLength(2))
    expect(agents.hasRunningSessions()).toBe(false)
    expect(rendererWorkPending(agents)).toBe(true)
    channel.answerPending('thread/settings/update')
    await second
    expect(rendererWorkPending(agents)).toBe(false)
  })

  it('releases reload ownership when the native settings acknowledgement rejects', async () => {
    const { agents, channels } = await idleCodex()
    const channel = channels[0]
    channel.held.add('thread/settings/update')
    const configuring = observe(agents.configure({ sessionId: 'local', model: 'test-model' }))
    await vi.waitFor(() => expect(channel.of('thread/settings/update')).toHaveLength(1))
    expect(rendererWorkPending(agents)).toBe(true)
    channel.reply({
      id: channel.of('thread/settings/update')[0].id,
      error: { code: -32000, message: 'native settings refused' },
    })
    await expect(configuring).rejects.toThrow('native settings refused')
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channel.closes).toBe(0)
  })

  it('keeps an idle child permission unanswered until the user sends its exact native decision', async () => {
    const context = await idleCodex()
    const approval = childPermission(context)
    const { agents, channels, events } = context
    expect(agents.hasRunningSessions()).toBe(false)
    const retired = retireIfIdle(agents)
    expect({
      retired,
      closes: channels[0].closes,
      resolved: events.filter((event) => event.type === 'request-resolved'),
    }).toEqual({ retired: false, closes: 0, resolved: [] })
    await agents.respond('local', approval.requestId!, true, undefined, 'codex-approval:0')
    expect(channels[0].messages.filter((message) => message.id === 'native-permission-42')).toEqual(
      [{ id: 'native-permission-42', result: { decision: 'accept' } }],
    )
    expect(rendererWorkPending(agents)).toBe(false)
  })

  it('protects a permission on an old RPC after the same thread completes on a new provider', async () => {
    const context = await idleCodex()
    const approval = childPermission(context)
    const { agents, channels, ssh, start, complete, prompts } = context
    const previous = channels[0]
    ssh.state.codex = 'codex-cli 0.163.0'
    await start({ prompt: nextPrompt })
    complete(channels[1])
    expect(agents.hasRunningSessions()).toBe(false)
    expect(retireIfIdle(agents)).toBe(false)
    await agents.respond('local', approval.requestId!, false, undefined, 'codex-approval:1')
    expect(previous.messages.filter((message) => message.id === 'native-permission-42')).toEqual([
      { id: 'native-permission-42', result: { decision: 'decline' } },
    ])
    expect(channels[1].messages.filter((message) => message.id === 'native-permission-42')).toEqual(
      [],
    )
    expect(rendererWorkPending(agents)).toBe(false)
    expect(prompts()).toEqual([firstPrompt, nextPrompt])
  })

  it('protects an unacknowledged native mutation on an old retained RPC without a busy root', async () => {
    const { agents, channels, ssh } = fixture()
    await agents.models('codex')
    // Exercise transport ownership independently of the current session map.
    const rpc = (agents as unknown as { codex: CodexRPC }).codex
    channels[0].held.add('thread/resume')
    const resuming = observe(rpc.request('thread/resume', { threadId: 'exact-saved-native-id' }))
    await vi.waitFor(() => expect(channels[0].of('thread/resume')).toHaveLength(1))
    ssh.state.codex = 'codex-cli 0.163.0'
    await agents.models('codex')
    expect(agents.hasRunningSessions()).toBe(false)
    expect(rendererWorkPending(agents)).toBe(true)
    channels[0].answerPending('thread/resume')
    await expect(resuming).resolves.toEqual({ thread: { id: 'exact-saved-native-id' } })
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channels.every((channel) => channel.of('turn/start').length === 0)).toBe(true)
  })

  it('protects settings on a replaced session owner until its original RPC answers', async () => {
    const { agents, channels, ssh, start, complete, prompts } = await idleCodex()
    const previous = channels[0]
    previous.held.add('thread/settings/update')
    const configuring = agents.configure({ sessionId: 'local', model: 'test-model' }).then(
      (result) => ({ result }),
      (error: Error) => ({ error: error.message }),
    )
    await vi.waitFor(() => expect(previous.of('thread/settings/update')).toHaveLength(1))
    ssh.state.codex = 'codex-cli 0.163.0'
    await start({ prompt: nextPrompt })
    complete(channels[1])
    expect(agents.hasRunningSessions()).toBe(false)
    expect(rendererWorkPending(agents)).toBe(true)
    previous.answerPending('thread/settings/update')
    await expect(configuring).resolves.toEqual({
      error: 'Agent session changed while applying settings',
    })
    expect(rendererWorkPending(agents)).toBe(false)
    expect(previous.closes).toBe(0)
    expect(channels[1].of('thread/settings/update')).toEqual([])
    expect(prompts()).toEqual([firstPrompt, nextPrompt])
  })

  it('keeps an exact steering message owned after its native turn completes before the acknowledgement', async () => {
    const { agents, channels, start, complete, prompts } = fixture()
    await start()
    const channel = channels[0]
    channel.held.add('turn/steer')
    const steering = observe(agents.steer({ sessionId: 'local', prompt: nextPrompt }))
    await vi.waitFor(() => expect(channel.of('turn/steer')).toHaveLength(1))
    complete()
    expect(agents.hasRunningSessions()).toBe(false)
    expect(rendererWorkPending(agents)).toBe(true)
    channel.answerPending('turn/steer')
    await steering
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channel.of('turn/steer')[0].params.input).toEqual([{ type: 'text', text: nextPrompt }])
    expect(channel.of('turn/interrupt')).toEqual([])
    expect(prompts()).toEqual([firstPrompt])
  })

  it('protects an existing native stop and does not invent a second interrupt', async () => {
    const { agents, channels, start, complete } = fixture()
    await start()
    const channel = channels[0]
    channel.held.add('turn/interrupt')
    const stopping = agents.stop('local')
    await vi.waitFor(() => expect(channel.of('turn/interrupt')).toHaveLength(1))
    complete()
    expect(retireIfIdle(agents)).toBe(false)
    channel.answerPending('turn/interrupt')
    await stopping
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channel.of('turn/interrupt')).toHaveLength(1)
  })

  it('releases reload ownership after a post-completion native steering error', async () => {
    const { agents, channels, start, complete, prompts } = fixture()
    await start()
    const channel = channels[0]
    channel.held.add('turn/steer')
    const steering = observe(agents.steer({ sessionId: 'local', prompt: nextPrompt }))
    await vi.waitFor(() => expect(channel.of('turn/steer')).toHaveLength(1))
    complete()
    expect(rendererWorkPending(agents)).toBe(true)
    channel.reply({
      id: channel.of('turn/steer')[0].id,
      error: { code: -32000, message: 'native turn already complete' },
    })
    await expect(steering).rejects.toThrow('native turn already complete')
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channel.of('turn/interrupt')).toEqual([])
    expect(prompts()).toEqual([firstPrompt])
  })

  it('preserves an idle Claude settings response without creating another user message', async () => {
    const { agents, channels, start, completeClaude, prompts } = fixture()
    await start({ provider: 'claude' })
    const channel = channels[0]
    completeClaude()
    channel.held.add('set_model')
    const configuring = observe(agents.configure({ sessionId: 'local', model: 'test-model' }))
    await vi.waitFor(() => expect(channel.of('set_model')).toHaveLength(1))
    expect(agents.hasRunningSessions()).toBe(false)
    expect(retireIfIdle(agents)).toBe(false)
    channel.answerPending('set_model')
    await expect(configuring).resolves.toMatchObject({ applied: 'live' })
    expect(rendererWorkPending(agents)).toBe(false)
    expect(prompts()).toEqual([firstPrompt])
    expect(channel.messages.find((message) => message.type === 'user')!.message.content).toEqual([
      { type: 'text', text: firstPrompt },
    ])
    expect(channel.of('interrupt')).toEqual([])
  })

  it('leaves a Claude child permission for the user to answer after the root becomes idle', async () => {
    const { agents, channels, start, completeClaude, events } = fixture()
    await start({ provider: 'claude' })
    const channel = channels[0]
    completeClaude()
    channel.reply({
      type: 'control_request',
      request_id: 'claude-native-permission',
      request: {
        subtype: 'can_use_tool',
        agent_id: 'background-child',
        tool_name: 'Read',
        input: { file_path: '/project/notes.txt' },
      },
    })
    expect(agents.hasRunningSessions()).toBe(true)
    expect(retireIfIdle(agents)).toBe(false)
    expect(events.filter((event) => event.type === 'request-resolved')).toEqual([])
    await agents.respond('local', 'claude-native-permission', false)
    expect(channel.messages.filter((message) => message.type === 'control_response')).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'claude-native-permission',
          response: { behavior: 'deny', message: 'The user declined this action' },
        },
      },
    ])
    expect(rendererWorkPending(agents)).toBe(true)
    channel.reply({
      type: 'result',
      session_id: 'claude-child',
      parent_tool_use_id: 'background-child',
      subtype: 'success',
      is_error: false,
      result: '',
    })
    expect(rendererWorkPending(agents)).toBe(false)
  })

  it('waits for an idle Claude control response while its paused deadline remains provider-owned', async () => {
    const { agents, channels, start, completeClaude } = fixture()
    await start({ provider: 'claude' })
    const channel = channels[0]
    completeClaude()
    channel.held.add('get_usage')
    const usage = agents.usage('claude')
    await vi.waitFor(() => expect(channel.of('get_usage')).toHaveLength(1))
    channel.emit('suspended')
    expect(agents.hasRunningSessions()).toBe(false)
    expect(rendererWorkPending(agents)).toBe(true)
    channel.emit('resumed')
    channel.answerPending('get_usage')
    await usage
    expect(rendererWorkPending(agents)).toBe(false)
    expect(channel.closes).toBe(0)
  })
})

describe('actual Agents idle-provider release results', () => {
  it('omits Codex-only session rows after the owned Codex process exits', async () => {
    const { agents, channels, prompts } = await idleCodex()
    terminalExit(channels[0])()
    const codex = await agents.releaseIdleProviders()
    const claude = await agents.releaseIdleClaudeProviders()
    expect({ codex, claude }).toEqual({ codex: [true], claude: [] })
    expect(prompts()).toEqual([firstPrompt])
    expect(channels[0].of('turn/interrupt')).toEqual([])
  })

  it('omits an already released Claude session with no owned channel', async () => {
    const { agents, channels, start, completeClaude, prompts } = fixture()
    await start({ provider: 'claude' })
    completeClaude()
    const exited = terminalExit(channels[0])
    let settled = false
    const releasing = agents.releaseIdleClaudeProviders().then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(channels[0].closes).toBe(1))
    expect(settled).toBe(false)
    exited()
    await expect(releasing).resolves.toEqual([true])
    await expect(agents.releaseIdleClaudeProviders()).resolves.toEqual([])
    expect(channels[0].closes).toBe(1)
    expect(prompts()).toEqual([firstPrompt])
  })

  it('reports a genuinely pending Claude native control as protected', async () => {
    const { agents, channels, start, completeClaude } = fixture()
    await start({ provider: 'claude' })
    completeClaude()
    const channel = channels[0]
    channel.held.add('get_usage')
    const usage = agents.usage('claude')
    await vi.waitFor(() => expect(channel.of('get_usage')).toHaveLength(1))
    await expect(agents.releaseIdleClaudeProviders()).resolves.toEqual([false])
    expect(channel.closes).toBe(0)
    channel.answerPending('get_usage')
    await usage
    expect(agents.hasPendingRendererWork()).toBe(false)
    expect(channel.closes).toBe(0)
  })

  it('does not report a raw Claude close as confirmed terminal exit', async () => {
    const { agents, channels, start, completeClaude } = fixture()
    await start({ provider: 'claude' })
    completeClaude()
    expect(channels[0].closeAndWaitEffect).toBeUndefined()
    await expect(agents.releaseIdleClaudeProviders()).resolves.toEqual([false])
    expect(channels[0].closes).toBe(1)
    expect(channels[0].of('interrupt')).toEqual([])
  })
})

describe('unconfirmed provider exit ownership across release retries', () => {
  it('blocks new Codex work until interrupted retirement confirms the original native exit', async () => {
    const { agents, channels, start, complete, prompts } = await idleCodex()
    const channel = channels[0]
    const exited = terminalExit(channel)
    const selected = Deferred.makeUnsafe<void>()
    const resume = Deferred.makeUnsafe<void>()
    const rpc = (agents as unknown as { codex: CodexRPC }).codex
    const boundary = rpc as unknown as { releaseEffect(): Effect.Effect<boolean> }
    const original = boundary.releaseEffect
    boundary.releaseEffect = Effect.fnUntraced(function* () {
      Deferred.doneUnsafe(selected, Effect.succeed(undefined))
      yield* Deferred.await(resume)
      return yield* original()
    })
    const fiber = Effect.runFork(agents.releaseIdleProvidersEffect())
    try {
      await Effect.runPromise(Deferred.await(selected))
      await Effect.runPromise(Fiber.interrupt(fiber))
    } finally {
      boundary.releaseEffect = original
    }
    expect(channel.closes).toBe(0)
    expect(rpc.closed).toBe(false)
    await expect(start({ prompt: nextPrompt })).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      operation: 'closing',
      reason: 'uncertain',
    })
    expect(channels).toHaveLength(1)
    expect(prompts()).toEqual([firstPrompt])
    let settled = false
    const retry = agents.releaseIdleProviders().then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(channel.closes).toBe(1))
    expect(settled).toBe(false)
    expect(agents.hasRunningSessions()).toBe(false)
    exited()
    await expect(retry).resolves.toEqual([true])
    await start({ prompt: nextPrompt })
    expect(channels).toHaveLength(2)
    expect(prompts()).toEqual([firstPrompt, nextPrompt])
    expect(channel.of('turn/interrupt')).toEqual([])
    complete(channels[1])
    const nextExited = terminalExit(channels[1])
    const finalRelease = agents.releaseIdleProviders()
    await vi.waitFor(() => expect(channels[1].closes).toBe(1))
    nextExited()
    await expect(finalRelease).resolves.toEqual([true])
    await expect(agents.releaseIdleProviders()).resolves.toEqual([])
  })

  it('retains a Claude channel if release is interrupted before its retirement owner registers', async () => {
    const { agents, channels, start, completeClaude } = fixture()
    await start({ provider: 'claude' })
    completeClaude()
    const channel = channels[0]
    const exited = terminalExit(channel)
    const selected = Deferred.makeUnsafe<void>()
    const resume = Deferred.makeUnsafe<void>()
    const boundary = agents as unknown as {
      releaseProviderEffect(
        provider: Provider,
        channel: ClientChannel,
        release: () => Effect.Effect<boolean>,
      ): Effect.Effect<boolean>
    }
    const original = boundary.releaseProviderEffect
    boundary.releaseProviderEffect = Effect.fnUntraced(function* (
      ...args: Parameters<typeof original>
    ) {
      Deferred.doneUnsafe(selected, Effect.succeed(undefined))
      yield* Deferred.await(resume)
      return yield* original(...args)
    })
    const fiber = Effect.runFork(agents.releaseIdleClaudeProvidersEffect())
    try {
      await Effect.runPromise(Deferred.await(selected))
      await Effect.runPromise(Fiber.interrupt(fiber))
    } finally {
      boundary.releaseProviderEffect = original
    }
    expect(channel.closes).toBe(0)
    let settled = false
    const retry = agents.releaseIdleClaudeProviders().then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(settled || channel.closes === 1).toBe(true))
    const beforeExit = { settled, closes: channel.closes }
    exited()
    const result = await retry
    expect({ beforeExit, result }).toEqual({
      beforeExit: { settled: false, closes: 1 },
      result: [true],
    })
    await expect(agents.releaseIdleClaudeProviders()).resolves.toEqual([])
  })

  it.each([
    ['codex', 'false'],
    ['codex', 'rejected'],
    ['claude', 'false'],
    ['claude', 'rejected'],
  ] as const)(
    'retains %s after a %s wait and blocks a second release until exit',
    async (provider, outcome) => {
      const { agents, channels, start, complete, completeClaude } = fixture()
      await start({ provider })
      if (provider === 'codex') complete()
      else completeClaude()
      const channel = channels[0]
      const terminal = Deferred.makeUnsafe<boolean>()
      let waits = 0
      channel.closeAndWaitEffect = Effect.fnUntraced(function* () {
        waits++
        if (waits === 1) {
          channel.close()
          if (outcome === 'false') return false
          return yield* Effect.die(new Error('Native exit wait failed before terminal evidence'))
        }
        return yield* Deferred.await(terminal)
      })
      const release = () =>
        provider === 'codex' ? agents.releaseIdleProviders() : agents.releaseIdleClaudeProviders()
      if (outcome === 'false') await expect(release()).resolves.toEqual([false])
      else
        await expect(release()).rejects.toThrow('Native exit wait failed before terminal evidence')
      expect(channel.closes).toBe(1)
      let settled = false
      const retry = release().then((result) => {
        settled = true
        return result
      })
      await vi.waitFor(() => expect(settled || waits === 2).toBe(true))
      const premature = settled
      // Neither local close nor its repeated notification is terminal evidence.
      channel.emit('close')
      const afterClose = settled
      channel.emit('exit', 0)
      Deferred.doneUnsafe(terminal, Effect.succeed(true))
      const retryResult = await retry
      expect({ premature, afterClose, waits, retryResult }).toEqual({
        premature: false,
        afterClose: false,
        waits: 2,
        retryResult: [true],
      })
      await expect(release()).resolves.toEqual([])
      expect(channel.closes).toBe(1)
    },
  )

  it.each(['codex', 'claude'] as const)(
    'retains raw %s close without a terminal adapter on every retry',
    async (provider) => {
      const { agents, channels, start, complete, completeClaude } = fixture()
      await start({ provider })
      if (provider === 'codex') complete()
      else completeClaude()
      const channel = channels[0]
      const release = () =>
        provider === 'codex' ? agents.releaseIdleProviders() : agents.releaseIdleClaudeProviders()
      await expect(release()).resolves.toEqual([false])
      await expect(release()).resolves.toEqual([false])
      expect(channel.closes).toBe(1)
      channel.emit('exit', 0)
      await expect(release()).resolves.toEqual([])
    },
  )

  it.each([
    ['codex', 'false'],
    ['codex', 'rejected'],
    ['claude', 'false'],
    ['claude', 'rejected'],
  ] as const)(
    'clears %s ownership when native exit precedes a %s wrapper result',
    async (provider, outcome) => {
      const { agents, channels, start, complete, completeClaude } = fixture()
      await start({ provider })
      if (provider === 'codex') complete()
      else completeClaude()
      const channel = channels[0]
      channel.closeAndWaitEffect = Effect.fnUntraced(function* () {
        channel.close()
        channel.emit('exit', 0)
        if (outcome === 'false') return false
        return yield* Effect.die(new Error('Wrapper rejected after confirmed native exit'))
      })
      const release = () =>
        provider === 'codex' ? agents.releaseIdleProviders() : agents.releaseIdleClaudeProviders()
      if (outcome === 'false') await expect(release()).resolves.toEqual([false])
      else await expect(release()).rejects.toThrow('Wrapper rejected after confirmed native exit')
      await expect(release()).resolves.toEqual([])
      expect(channel.closes).toBe(1)
    },
  )
})

describe('new native targets while a prior release memo is pending', () => {
  it('holds new Codex acquisition behind the previous exit and then retires the new idle target', async () => {
    const { agents, channels, ssh } = await idleCodex()
    const previousExited = terminalExit(channels[0])
    const previous = agents.releaseIdleProviders()
    await vi.waitFor(() => expect(channels[0].closes).toBe(1))
    ssh.state.codex = 'codex-cli 0.163.0'
    let acquired = false
    const discovery = agents.models('codex').then((models) => {
      acquired = true
      return models
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(acquired).toBe(false)
    expect(channels).toHaveLength(1)
    expect(agents.releaseIdleProviders()).toBe(previous)
    previousExited()
    await expect(previous).resolves.toEqual([true])
    await discovery
    const current = channels[1]
    const currentExited = terminalExit(current)
    let settled = false
    const preparing = drainRetirementTargets(agents).then((passes) => {
      settled = true
      return passes
    })
    await vi.waitFor(() => expect(settled || current.closes === 1).toBe(true))
    const beforeCurrentExit = { settled, closes: current.closes }
    currentExited()
    const passes = await preparing
    expect({ beforeCurrentExit, passes }).toEqual({
      beforeCurrentExit: { settled: false, closes: 1 },
      passes: 1,
    })
    await expect(agents.releaseIdleProviders()).resolves.toEqual([])
  })

  it('recollects a new idle Claude target when a newer caller joins an older global release', async () => {
    const { agents, channels, start, completeClaude } = await idleCodex()
    const previousExited = terminalExit(channels[0])
    let pending: Promise<number> | undefined
    const prepare = () => (pending ??= drainRetirementTargets(agents))
    const previous = prepare()
    await vi.waitFor(() => expect(channels[0].closes).toBe(1))
    await start({ sessionId: 'new-claude-thread', provider: 'claude', prompt: nextPrompt })
    const current = channels[1]
    completeClaude(current)
    const currentExited = terminalExit(current)
    expect(prepare()).toBe(previous)
    let settled = false
    const preparing = prepare().then((passes) => {
      settled = true
      return passes
    })
    previousExited()
    await vi.waitFor(() => expect(settled || current.closes === 1).toBe(true))
    const beforeCurrentExit = { settled, closes: current.closes }
    currentExited()
    const passes = await preparing
    expect({ beforeCurrentExit, passes }).toEqual({
      beforeCurrentExit: { settled: false, closes: 1 },
      passes: 2,
    })
    await expect(agents.releaseIdleClaudeProviders()).resolves.toEqual([])
  })

  it('retains an idle opening without an exit adapter after readiness fails and its opening row disappears', async () => {
    const { agents, channels, ssh } = fixture()
    let unavailable!: (error: Error) => void
    const readiness = new Promise<void>((_, reject) => {
      unavailable = reject
    })
    ssh.durableChannel = async (command, onOpening) => {
      const channel = await ssh.channel(command)
      onOpening?.(channel)
      await readiness
      return channel
    }
    const discovery = agents.models('codex').then(
      () => ({ ready: true }),
      (error: Error) => ({ error: error.message }),
    )
    await vi.waitFor(() => expect(channels).toHaveLength(1))
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    unavailable(new Error('Opening failed without native exit evidence'))
    await expect(discovery).resolves.toEqual({
      error: 'Opening failed without native exit evidence',
    })
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    channels[0].emit('exit', 0)
    await expect(agents.releaseIdleProviders()).resolves.toEqual([])
  })
})
