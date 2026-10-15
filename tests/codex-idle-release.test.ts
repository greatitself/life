import { EventEmitter } from 'node:events'
import { Deferred, Effect } from 'effect'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import type { SSHConnection } from '../src/main/ssh'
import type { AgentEvent, StartInput } from '../src/shared/types'

vi.mock('../src/main/provider-titles', () => ({
  generateProviderTitle: vi.fn(async () => undefined),
}))

type Wire = Record<string, any>

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  transportState = 'connected'
  destroyed = false
  messages: Wire[] = []
  signals: string[] = []
  closeCalls = 0
  waitCalls = 0
  held = new Set<string>()
  closeAndWaitEffect?: () => Effect.Effect<boolean>
  private answered = new Set<number>()
  private terminal = Deferred.makeUnsafe<boolean>()
  private providerReady = Deferred.makeUnsafe<void, Error>()

  constructor(readonly id: number) {
    super()
    this.closeAndWaitEffect = Effect.fn('IdleReleaseTestChannel.closeAndWait')(
      function* (this: Channel) {
        this.waitCalls++
        this.close()
        return yield* Deferred.await(this.terminal)
      }.bind(this),
    )
  }

  write(raw: string) {
    const message = JSON.parse(raw) as Wire
    this.messages.push(message)
    if (message.method && typeof message.id === 'number')
      queueMicrotask(() => {
        if (!this.destroyed && !this.held.has(message.method)) this.answer(message)
      })
    return true
  }

  of(method: string) {
    return this.messages.filter((message) => message.method === method)
  }

  answer(message: Wire) {
    this.answered.add(message.id)
    const results: Record<string, Wire> = {
      initialize: {},
      'config/read': { config: { model: 'test-model' } },
      'model/list': { data: [{ model: 'test-model', displayName: 'Test', isDefault: true }] },
      'thread/start': { thread: { id: `remote-${this.id}-${message.id}` } },
      'thread/resume': { thread: { id: message.params.threadId } },
      'thread/read': { thread: { id: message.params.threadId } },
      'turn/start': { turn: { id: `turn-${this.id}-${message.id}` } },
    }
    this.reply({ id: message.id, result: results[message.method] || {} })
  }

  answerPending(method: string) {
    const message = this.of(method).findLast((request) => !this.answered.has(request.id))
    expect(message, `Expected a pending ${method} request`).toBeDefined()
    this.held.delete(method)
    this.answer(message!)
  }

  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }

  complete(remoteId: string, turnId: string) {
    this.reply({
      method: 'turn/completed',
      params: { threadId: remoteId, turn: { id: turnId, status: 'completed' } },
    })
  }

  signal(signal: string) {
    this.signals.push(signal)
  }

  close() {
    this.closeCalls++
    this.destroyed = true
    Deferred.doneUnsafe(this.providerReady, Effect.fail(new Error('Provider closed before ready')))
    this.emit('close')
  }

  get isClosing() {
    return this.destroyed
  }

  waitUntilReady() {
    return Effect.runPromise(Deferred.await(this.providerReady))
  }

  ready() {
    Deferred.doneUnsafe(this.providerReady, Effect.succeed(undefined))
  }

  remoteExit(acknowledged = true) {
    Deferred.doneUnsafe(this.terminal, Effect.succeed(acknowledged))
  }
}

const active: Agents[] = []
afterEach(() => {
  for (const agents of active.splice(0)) agents.close()
})

function fixture(initiallyHeld: string[] = [], waitForReady = false) {
  const channels: Channel[] = []
  const ssh = new EventEmitter() as SSHConnection
  ssh.state = {
    status: 'connected',
    home: '/home/researcher',
    workspace: '/project',
    codex: 'codex-cli 0.162.1',
    profile: {
      id: 'machine-a',
      name: 'Machine A',
      host: 'machine-a.test',
      port: 22,
      username: 'researcher',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/project',
    },
  }
  ssh.channel = vi.fn(async () => {
    const channel = new Channel(channels.length + 1)
    for (const method of initiallyHeld) channel.held.add(method)
    channels.push(channel)
    return channel as unknown as ClientChannel
  })
  const durable = ssh as SSHConnection & {
    durableChannel: (
      command: string,
      onOpening?: (channel: ClientChannel) => void,
    ) => Promise<ClientChannel>
  }
  durable.durableChannel = vi.fn(async (command, onOpening) => {
    const channel = await ssh.channel(command)
    onOpening?.(channel)
    if (waitForReady) await (channel as unknown as Channel).waitUntilReady()
    return channel
  })
  ssh.exec = vi.fn(async () => {
    throw new Error('Idle provider release must not run a shell command or inference')
  })
  const events: AgentEvent[] = []
  const agents = new Agents(ssh, (event) => events.push(event))
  active.push(agents)
  const start = (sessionId = 'local-root', extra: Partial<StartInput> = {}) =>
    agents.start({
      sessionId,
      provider: 'codex',
      prompt: `Exact user prompt for ${sessionId}\r\n🧪`,
      model: 'test-model',
      mode: 'review',
      ...extra,
    })
  const generation = () => (agents as unknown as { generation: number }).generation
  const remoteId = (sessionId = 'local-root') =>
    events.findLast((event) => event.sessionId === sessionId && event.type === 'session')!.remoteId!
  const turnId = (channel = channels[0]) => {
    const request = channel.of('turn/start').at(-1)!
    return `turn-${channel.id}-${request.id}`
  }
  const prompts = () =>
    channels.flatMap((channel) =>
      channel.of('turn/start').map((message) => message.params.input[0].text),
    )
  const interrupts = () => channels.flatMap((channel) => channel.of('turn/interrupt'))
  const complete = async (sessionId = 'local-root', channel = channels[0]) => {
    channel.complete(remoteId(sessionId), turnId(channel))
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.sessionId === sessionId && event.type === 'complete'),
      ).toBe(true),
    )
    await Promise.resolve()
  }
  return {
    agents,
    channels,
    ssh,
    events,
    start,
    generation,
    remoteId,
    turnId,
    prompts,
    interrupts,
    complete,
  }
}

async function beginRelease(agents: Agents, channel: Channel) {
  let settled = false
  const releasing = agents.releaseIdleProviders().then((result) => {
    settled = true
    return result
  })
  await vi.waitFor(() => expect(channel.waitCalls).toBe(1))
  return { releasing, settled: () => settled }
}

async function expectProtected(agents: Agents, channel: Channel) {
  let settled = false
  const releasing = agents.releaseIdleProviders().then((result) => {
    settled = true
    return result
  })
  await vi.waitFor(() => expect(settled || channel.closeCalls > 0).toBe(true))
  if (channel.closeCalls > 0) channel.remoteExit(false)
  expect(channel.closeCalls).toBe(0)
  await expect(releasing).resolves.toEqual([false])
}

describe('idle Codex provider release', () => {
  it('releases a catalog-only RPC lazily and waits for remote exit after local close', async () => {
    const { agents, channels, prompts, interrupts, generation } = fixture()
    await agents.models('codex')
    const channel = channels[0]
    const beforeGeneration = generation()
    const program = agents.releaseIdleProvidersEffect()
    expect(channel.closeCalls).toBe(0)
    let settled = false
    const releasing = Effect.runPromise(program).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(channel.waitCalls).toBe(1))
    expect(channel.destroyed).toBe(true)
    channel.emit('close')
    channel.emit('exit', 0)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(prompts()).toEqual([])
    expect(interrupts()).toEqual([])
    expect(generation()).toBe(beforeGeneration)
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
    expect(agents.hasPendingRendererWork()).toBe(false)
    expect(agents.hasProviderRetirementTargets()).toBe(false)
    await expect(agents.releaseIdleProviders()).resolves.toEqual([])
    expect(channel.waitCalls).toBe(1)
  })

  it('does not treat an unconfirmed remote exit as a successful release', async () => {
    const { agents, channels } = fixture()
    await agents.models('codex')
    const { releasing } = await beginRelease(agents, channels[0])
    channels[0].remoteExit(false)
    await expect(releasing).resolves.toEqual([false])
  })

  it('reports an ordinary SSH close as unconfirmed when there is no remote-exit adapter', async () => {
    const { agents, channels, prompts, interrupts } = fixture()
    await agents.models('codex')
    channels[0].closeAndWaitEffect = undefined
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channels[0].closeCalls).toBe(1)
    expect(channels[0].signals).toEqual(['TERM'])
    expect(prompts()).toEqual([])
    expect(interrupts()).toEqual([])
  })

  it('releases every idle RPC concurrently and waits for all their remote exits', async () => {
    const { agents, channels, ssh, generation } = fixture()
    await agents.models('codex')
    ssh.state.codex = 'codex-cli 0.163.0'
    await agents.models('codex')
    const beforeGeneration = generation()
    const { releasing, settled } = await beginRelease(agents, channels[0])
    expect(channels[1].waitCalls).toBe(1)
    channels[1].remoteExit()
    await Promise.resolve()
    expect(settled()).toBe(false)
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true, true])
    expect(generation()).toBe(beforeGeneration)
  })

  it('joins concurrent release calls without issuing duplicate closes or skipping the exit wait', async () => {
    const { agents, channels } = fixture()
    await agents.models('codex')
    const first = agents.releaseIdleProviders()
    const second = agents.releaseIdleProviders()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(channels[0].waitCalls).toBe(1))
    expect(channels[0].closeCalls).toBe(1)
    const third = agents.releaseIdleProviders()
    expect(third).toBe(first)
    channels[0].remoteExit()
    await expect(Promise.all([first, second, third])).resolves.toEqual([[true], [true], [true]])
    expect(channels[0].waitCalls).toBe(1)
    expect(channels[0].closeCalls).toBe(1)
  })

  it('waits for the original native exit before resuming its exact ID with the next prompt', async () => {
    const { agents, channels, start, remoteId, complete, prompts, interrupts, generation } =
      fixture()
    await start()
    const savedId = remoteId()
    await complete()
    expect(agents.hasRunningSessions()).toBe(false)
    const beforeGeneration = generation()
    const { releasing, settled } = await beginRelease(agents, channels[0])
    expect(prompts()).toEqual(['Exact user prompt for local-root\r\n🧪'])
    expect(interrupts()).toEqual([])
    let nextStarted = false
    const starting = start('local-root', { prompt: 'Second exact prompt\n\ud800' }).then(() => {
      nextStarted = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(nextStarted).toBe(false)
    expect(channels).toHaveLength(1)
    expect(prompts()).toEqual(['Exact user prompt for local-root\r\n🧪'])
    expect(settled()).toBe(false)
    // An attachment close and stale turn notification cannot substitute for
    // the held terminal receipt from the original native provider.
    channels[0].emit('close')
    channels[0].complete(savedId, 'stale-turn')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(channels).toHaveLength(1)
    expect(nextStarted).toBe(false)
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true])
    await starting
    expect(channels).toHaveLength(2)
    expect(channels[1].of('thread/resume')[0].params).toMatchObject({
      threadId: savedId,
      excludeTurns: true,
    })
    expect(channels[1].of('thread/start')).toEqual([])
    expect(remoteId()).toBe(savedId)
    expect(prompts()).toEqual([
      'Exact user prompt for local-root\r\n🧪',
      'Second exact prompt\n\ud800',
    ])
    expect(generation()).toBe(beforeGeneration)
    expect(channels[1].destroyed).toBe(false)
    expect(agents.hasRunningSessions()).toBe(true)
    expect(settled()).toBe(true)
  })

  it('protects a busy root and keeps delivering its existing turn without an interrupt', async () => {
    const { agents, channels, start, remoteId, turnId, events, prompts, interrupts, generation } =
      fixture()
    await start()
    const beforeGeneration = generation()
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channels[0].closeCalls).toBe(0)
    channels[0].reply({
      method: 'item/agentMessage/delta',
      params: { threadId: remoteId(), turnId: turnId(), itemId: 'reply', delta: 'Still streaming' },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Still streaming' }),
    )
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
    expect(generation()).toBe(beforeGeneration)
  })

  it('protects a completed root’s RPC while a native child remains busy', async () => {
    const { agents, channels, start, remoteId, complete, events, interrupts } = fixture()
    await start()
    const channel = channels[0]
    channel.reply({
      method: 'thread/started',
      params: {
        thread: { id: 'native-child', parentThreadId: remoteId(), status: { type: 'active' } },
      },
    })
    channel.reply({
      method: 'turn/started',
      params: { threadId: 'native-child', turn: { id: 'child-turn' } },
    })
    await complete()
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channel.closeCalls).toBe(0)
    channel.reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'native-child',
        turnId: 'child-turn',
        itemId: 'child-reply',
        delta: 'Child continues',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ agentId: 'native-child', type: 'text', text: 'Child continues' }),
    )
    expect(interrupts()).toEqual([])
    channel.complete('native-child', 'child-turn')
    const { releasing } = await beginRelease(agents, channel)
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })

  it('protects a pending native permission after both the root and child become idle', async () => {
    const { agents, channels, start, remoteId, complete, events } = fixture()
    await start()
    const channel = channels[0]
    channel.reply({
      method: 'thread/started',
      params: {
        thread: { id: 'permission-child', parentThreadId: remoteId(), status: { type: 'active' } },
      },
    })
    channel.reply({
      id: 'provider-permission-42',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'permission-child',
        itemId: 'command-42',
        command: 'printf exact',
        availableDecisions: ['accept', 'decline'],
      },
    })
    const approval = events.find((event) => event.type === 'approval')!
    expect(approval.agentId).toBe('permission-child')
    channel.reply({
      method: 'thread/status/changed',
      params: { threadId: 'permission-child', status: { type: 'idle' } },
    })
    await complete()
    expect(agents.hasRunningSessions()).toBe(false)
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channel.closeCalls).toBe(0)
    expect(channel.messages.filter((message) => message.id === 'provider-permission-42')).toEqual(
      [],
    )
    await agents.respond(
      approval.sessionId,
      approval.requestId!,
      true,
      undefined,
      'codex-approval:0',
    )
    expect(channel.messages.filter((message) => message.id === 'provider-permission-42')).toEqual([
      { id: 'provider-permission-42', result: { decision: 'accept' } },
    ])
    const { releasing } = await beginRelease(agents, channel)
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })

  it('keeps a pending native child permission on its old RPC after the root uses a newer provider', async () => {
    const { agents, channels, ssh, start, remoteId, complete, events, prompts, interrupts } =
      fixture()
    await start()
    const previous = channels[0]
    previous.reply({
      method: 'thread/started',
      params: {
        thread: {
          id: 'old-permission-child',
          parentThreadId: remoteId(),
          status: { type: 'active' },
        },
      },
    })
    previous.reply({
      id: 'old-native-permission',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'old-permission-child',
        itemId: 'old-command',
        command: 'printf exact',
        availableDecisions: ['accept', 'decline'],
      },
    })
    const approval = events.find((event) => event.type === 'approval')!
    previous.reply({
      method: 'thread/status/changed',
      params: { threadId: 'old-permission-child', status: { type: 'idle' } },
    })
    await complete()
    ssh.state.codex = 'codex-cli 0.163.0'
    await start('local-root', { prompt: 'Exact next request' })
    await complete('local-root', channels[1])
    const { releasing } = await beginRelease(agents, channels[1])
    expect(previous.closeCalls).toBe(0)
    expect(previous.messages.filter((message) => message.id === 'old-native-permission')).toEqual(
      [],
    )
    channels[1].remoteExit()
    await expect(releasing).resolves.toEqual([false, true])
    await agents.respond(
      approval.sessionId,
      approval.requestId!,
      false,
      undefined,
      'codex-approval:1',
    )
    expect(previous.messages.filter((message) => message.id === 'old-native-permission')).toEqual([
      { id: 'old-native-permission', result: { decision: 'decline' } },
    ])
    expect(
      channels[1].messages.filter((message) => message.id === 'old-native-permission'),
    ).toEqual([])
    const finalRelease = await beginRelease(agents, previous)
    previous.remoteExit()
    await expect(finalRelease.releasing).resolves.toEqual([true])
    expect(prompts()).toEqual(['Exact user prompt for local-root\r\n🧪', 'Exact next request'])
    expect(interrupts()).toEqual([])
  })

  it('cancels catalog-only initialization without inventing a prompt and waits for remote exit', async () => {
    const { agents, channels, prompts, interrupts } = fixture(['initialize'])
    const discovery = agents.models('codex').then(
      (models) => ({ models }),
      (error: unknown) => ({ error }),
    )
    await vi.waitFor(() => expect(channels[0]?.of('initialize')).toHaveLength(1))
    const { releasing, settled } = await beginRelease(agents, channels[0])
    await expect(discovery).resolves.toHaveProperty('error')
    expect(settled()).toBe(false)
    expect(prompts()).toEqual([])
    expect(interrupts()).toEqual([])
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })

  it('cancels catalog initialization in the response-to-continuation gap and waits for remote exit', async () => {
    const { agents, channels, prompts, interrupts } = fixture(['initialize'])
    const discovery = agents.models('codex').then(
      (models) => ({ models }),
      (error: unknown) => ({ error }),
    )
    await vi.waitFor(() => expect(channels[0]?.of('initialize')).toHaveLength(1))
    const channel = channels[0]
    channel.answerPending('initialize')
    const { releasing, settled } = await beginRelease(agents, channel)
    await expect(discovery).resolves.toHaveProperty('error')
    expect(settled()).toBe(false)
    expect(channel.of('initialized')).toEqual([])
    expect(prompts()).toEqual([])
    expect(interrupts()).toEqual([])
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })

  it('tracks and releases a catalog broker before provider readiness resolves', async () => {
    const { agents, channels, prompts, interrupts } = fixture([], true)
    const discovery = agents.models('codex').then(
      (models) => ({ models }),
      (error: unknown) => ({ error }),
    )
    await vi.waitFor(() => expect(channels).toHaveLength(1))
    const channel = channels[0]
    expect(channel.of('initialize')).toEqual([])
    const { releasing, settled } = await beginRelease(agents, channel)
    await expect(discovery).resolves.toHaveProperty('error')
    expect(settled()).toBe(false)
    expect(prompts()).toEqual([])
    expect(interrupts()).toEqual([])
    channel.emit('close')
    await Promise.resolve()
    expect(settled()).toBe(false)
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })

  it('protects a real root during broker startup before provider readiness resolves', async () => {
    const { agents, channels, start, prompts, interrupts } = fixture([], true)
    const starting = start()
    await vi.waitFor(() => expect(channels).toHaveLength(1))
    await expectProtected(agents, channels[0])
    expect(channels[0].of('initialize')).toEqual([])
    channels[0].ready()
    await starting
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
  })

  it('protects app-server initialization for a real root without sending a duplicate prompt', async () => {
    const { agents, channels, start, prompts, interrupts } = fixture(['initialize'])
    const starting = start()
    await vi.waitFor(() => expect(channels[0]?.of('initialize')).toHaveLength(1))
    await expectProtected(agents, channels[0])
    expect(prompts()).toEqual([])
    channels[0].answerPending('initialize')
    await starting
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
  })

  it('protects a shared RPC before a new root has been assigned its transport and during thread startup', async () => {
    const { agents, channels, start, prompts, interrupts } = fixture()
    await agents.models('codex')
    channels[0].held.add('thread/start')
    const starting = start()
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channels[0].closeCalls).toBe(0)
    await vi.waitFor(() => expect(channels[0].of('thread/start')).toHaveLength(1))
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    channels[0].answerPending('thread/start')
    await starting
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
  })

  it('protects a shared RPC while the provider has not acknowledged turn/start', async () => {
    const { agents, channels, start, prompts, interrupts } = fixture(['turn/start'])
    const starting = start()
    await vi.waitFor(() => expect(channels[0]?.of('turn/start')).toHaveLength(1))
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channels[0].closeCalls).toBe(0)
    expect(prompts()).toHaveLength(1)
    channels[0].answerPending('turn/start')
    await starting
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
  })

  it('waits for the existing native stop without duplicating its interrupt', async () => {
    const { agents, channels, start, prompts, interrupts } = fixture()
    await start()
    channels[0].held.add('turn/interrupt')
    const stopping = agents.stop('local-root')
    await vi.waitFor(() => expect(interrupts()).toHaveLength(1))
    await expect(agents.releaseIdleProviders()).resolves.toEqual([false])
    expect(channels[0].closeCalls).toBe(0)
    expect(interrupts()).toHaveLength(1)
    channels[0].answerPending('turn/interrupt')
    await stopping
    expect(prompts()).toHaveLength(1)
    const { releasing } = await beginRelease(agents, channels[0])
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true])
    expect(interrupts()).toHaveLength(1)
  })

  it('protects a stopping root after its last busy child has completed', async () => {
    const { agents, channels, start, remoteId, complete, interrupts } = fixture()
    await start()
    const channel = channels[0]
    channel.reply({
      method: 'thread/started',
      params: {
        thread: { id: 'stopping-child', parentThreadId: remoteId(), status: { type: 'active' } },
      },
    })
    channel.reply({
      method: 'turn/started',
      params: { threadId: 'stopping-child', turn: { id: 'stopping-child-turn' } },
    })
    await complete()
    channel.held.add('turn/interrupt')
    const stopping = agents.stop('local-root')
    await vi.waitFor(() => expect(interrupts()).toHaveLength(1))
    channel.complete('stopping-child', 'stopping-child-turn')
    await expectProtected(agents, channel)
    channel.answerPending('turn/interrupt')
    await stopping
    expect(agents.hasRunningSessions()).toBe(false)
    const { releasing } = await beginRelease(agents, channel)
    channel.remoteExit()
    await expect(releasing).resolves.toEqual([true])
    expect(interrupts()).toHaveLength(1)
  })

  it('releases an idle old-version RPC while preserving work on the current provider version', async () => {
    const {
      agents,
      channels,
      ssh,
      start,
      remoteId,
      turnId,
      events,
      prompts,
      interrupts,
      generation,
    } = fixture()
    await agents.models('codex')
    ssh.state.codex = 'codex-cli 0.163.0'
    await start()
    const beforeGeneration = generation()
    const { releasing } = await beginRelease(agents, channels[0])
    expect(channels[1].closeCalls).toBe(0)
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true, false])
    channels[0].emit('close')
    channels[1].reply({
      method: 'item/agentMessage/delta',
      params: {
        threadId: remoteId(),
        turnId: turnId(channels[1]),
        itemId: 'new-version-reply',
        delta: 'New provider turn continues',
      },
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'New provider turn continues' }),
    )
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
    expect(generation()).toBe(beforeGeneration)
  })

  it('releases an idle RPC on another machine while preserving the original machine’s active turn', async () => {
    const { agents, channels, ssh, start, prompts, interrupts, generation } = fixture()
    await start()
    const originalState = ssh.state
    ssh.state = {
      ...originalState,
      profile: {
        ...originalState.profile!,
        id: 'machine-b',
        name: 'Machine B',
        host: 'machine-b.test',
      },
    }
    await agents.models('codex')
    const beforeGeneration = generation()
    const { releasing } = await beginRelease(agents, channels[1])
    expect(channels[0].closeCalls).toBe(0)
    channels[1].remoteExit()
    await expect(releasing).resolves.toEqual([false, true])
    ssh.state = originalState
    await agents.steer({ sessionId: 'local-root', prompt: 'Continue the same native turn' })
    expect(channels[0].of('turn/steer')).toHaveLength(1)
    expect(channels[1].of('turn/steer')).toEqual([])
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
    expect(generation()).toBe(beforeGeneration)
  })

  it('protects an idle root while its native settings update is awaiting acknowledgement', async () => {
    const { agents, channels, start, complete, prompts, interrupts } = fixture()
    await start()
    await complete()
    channels[0].held.add('thread/settings/update')
    const configuration = agents.configure({ sessionId: 'local-root', model: 'test-model' }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await vi.waitFor(() => expect(channels[0].of('thread/settings/update')).toHaveLength(1))
    await expectProtected(agents, channels[0])
    channels[0].answerPending('thread/settings/update')
    await expect(configuration).resolves.toMatchObject({ result: { applied: 'next-request' } })
    expect(prompts()).toHaveLength(1)
    expect(interrupts()).toEqual([])
    const { releasing } = await beginRelease(agents, channels[0])
    channels[0].remoteExit()
    await expect(releasing).resolves.toEqual([true])
  })
})
