import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Agents, claudeModelOption, codexModelOption } from '../src/main/agents'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { agentProviderOptionsSchema, startSchema } from '../src/shared/validation'
import type { AgentEvent, HostKeyRequest, StartInput } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'

describe('provider capabilities and extensible request validation', () => {
  it('retains newly advertised effort and speed tiers without a local whitelist', () => {
    expect(
      codexModelOption({
        model: 'future-codex',
        displayName: 'Future Codex',
        supportedReasoningEfforts: [
          { reasoningEffort: 'future-effort', description: 'Future depth' },
        ],
        defaultReasoningEffort: 'future-effort',
        serviceTiers: [{ id: 'future-tier', name: 'Future speed', description: 'Future service' }],
        defaultServiceTier: 'future-tier',
      }),
    ).toMatchObject({
      supportedReasoningEfforts: [
        { reasoningEffort: 'future-effort', description: 'Future depth' },
      ],
      defaultReasoningEffort: 'future-effort',
      serviceTiers: [{ id: 'future-tier', name: 'Future speed', description: 'Future service' }],
      defaultServiceTier: 'future-tier',
    })
    expect(
      codexModelOption({ model: 'older', additionalSpeedTiers: ['fast'] }).serviceTiers,
    ).toEqual([
      { id: 'default', name: 'Standard' },
      { id: 'fast', name: 'Fast' },
    ])
    expect(codexModelOption({ model: 'legacy' })).toEqual({ id: 'legacy', name: 'legacy' })
  })

  it('derives Claude capabilities from its initialize catalog', () => {
    expect(
      claudeModelOption({
        value: 'opus',
        displayName: 'Opus',
        supportedEffortLevels: ['high', 'future-effort'],
        supportsFastMode: true,
      }),
    ).toMatchObject({
      supportedReasoningEfforts: [
        { reasoningEffort: 'high' },
        { reasoningEffort: 'future-effort' },
      ],
      serviceTiers: [
        { id: 'default', name: 'Standard' },
        { id: 'fast', name: 'Fast' },
      ],
    })
    expect(
      claudeModelOption({ value: 'haiku', supportsEffort: false, supportsFastMode: false }),
    ).toMatchObject({
      supportedReasoningEfforts: [],
      serviceTiers: [{ id: 'default', name: 'Standard' }],
    })
    expect(claudeModelOption({ value: 'default' })).toMatchObject({ id: '', isDefault: true })
  })

  it('does not offer effort, Fast or Auto when the Claude catalogue omits support', () => {
    expect(claudeModelOption({ value: 'haiku', displayName: 'Haiku' })).toMatchObject({
      supportedReasoningEfforts: [],
      serviceTiers: [{ id: 'default', name: 'Standard' }],
      supportsAutoMode: false,
    })
    expect(claudeModelOption({ value: 'opus', supportsAutoMode: true })).toMatchObject({
      supportsAutoMode: true,
    })
  })

  it('accepts generic provider fields while protecting conversation transport and project scope', () => {
    const input = {
      sessionId: 'thread',
      provider: 'codex',
      prompt: 'hello',
      mode: 'plan',
      reasoningEffort: 'future-effort',
      serviceTier: 'future-tier',
      providerOptions: {
        thread: { config: { future_feature: true } },
        turn: { summary: 'detailed', future_field: { levels: ['new'], count: 1 } },
      },
    }
    expect(startSchema.parse(input)).toEqual(input)
    for (const key of ['threadId', 'cwd', 'input', 'approvalPolicy', 'sandbox', 'sandboxPolicy'])
      expect(agentProviderOptionsSchema.safeParse({ turn: { [key]: 'override' } }).success).toBe(
        false,
      )
    for (const arg of [
      '--resume=other',
      '--permission-mode=acceptEdits',
      '-p',
      '--input-format=text',
      '--append-system-prompt',
    ])
      expect(agentProviderOptionsSchema.safeParse({ args: [arg] }).success).toBe(false)
    expect(
      agentProviderOptionsSchema.safeParse({
        settings: { future_flag: true },
        args: ['--add-dir', 'A literal `$(command)` value'],
      }).success,
    ).toBe(true)
  })

  it('rejects cyclic, excessive and non-JSON options without recursive parser failures', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(agentProviderOptionsSchema.safeParse({ settings: cyclic }).success).toBe(false)
    expect(agentProviderOptionsSchema.safeParse({ settings: { flag: BigInt(2) } }).success).toBe(
      false,
    )
    expect(
      agentProviderOptionsSchema.safeParse({ settings: { text: 'x'.repeat(128001) } }).success,
    ).toBe(false)
    let nested: unknown = 0
    for (let depth = 0; depth < 50; depth++) nested = { nested }
    expect(agentProviderOptionsSchema.safeParse({ settings: { nested } }).success).toBe(false)
  })
})

describe('actual SSH provider option routing', () => {
  let fixture: SSHFixture
  let connection: SSHConnection
  let agents: Agents
  let events: AgentEvent[]
  let sequence = 0
  const completed = async () =>
    vi.waitFor(() => expect(events.some((event) => event.type === 'complete')).toBe(true), {
      timeout: 5000,
      interval: 20,
    })
  const input = (provider: 'codex' | 'claude', extra: Partial<StartInput> = {}): StartInput => ({
    sessionId: 'controls-' + provider,
    provider,
    prompt: 'hello',
    mode: 'plan',
    ...extra,
  })
  beforeAll(async () => {
    fixture = await new SSHFixture().start()
  })
  afterAll(async () => {
    await fixture.close()
  })
  beforeEach(async () => {
    events = []
    const store = new Store(join(fixture.root, 'provider-options-' + ++sequence))
    await store.init()
    connection = new SSHConnection(store)
    connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
    agents = new Agents(connection, (event) => events.push(event))
    await connection.connect(fixture.input())
    await connection.selectWorkspace(fixture.workspace)
  })
  afterEach(() => {
    connection.disconnect()
    agents.close()
  })

  it('sends selected Codex effort and tier, then resets them on the same conversation', async () => {
    await agents.start(input('codex', { reasoningEffort: 'high', serviceTier: 'fast' }))
    await completed()
    const remoteId = events.find((event) => event.type === 'session')!.remoteId
    events = []
    await agents.start(input('codex', { reasoningEffort: '', serviceTier: '' }))
    await completed()
    const turns = (await fixture.log())
      .filter((entry) => entry.provider === 'codex' && entry.message?.method === 'turn/start')
      .slice(-2)
    expect(turns[0].message?.params).toMatchObject({
      effort: 'high',
      serviceTier: 'fast',
      threadId: remoteId,
    })
    expect(turns[1].message?.params).toMatchObject({
      effort: 'low',
      serviceTier: null,
      threadId: remoteId,
    })
  })

  it('routes future Codex thread and turn fields with the Life project and sandbox intact', async () => {
    await agents.start(
      input('codex', {
        providerOptions: {
          thread: { modelProvider: 'custom-provider', config: { experimental_future: true } },
          turn: { summary: 'detailed', future_turn: { format: 'custom' } },
        },
      }),
    )
    await completed()
    const logs = await fixture.log()
    expect(
      [...logs].reverse().find((entry) => entry.message?.method === 'thread/start')?.message
        ?.params,
    ).toMatchObject({
      modelProvider: 'custom-provider',
      config: { experimental_future: true },
      cwd: fixture.workspace,
      sandbox: 'read-only',
    })
    expect(
      [...logs].reverse().find((entry) => entry.message?.method === 'turn/start')?.message?.params,
    ).toMatchObject({
      summary: 'detailed',
      future_turn: { format: 'custom' },
      cwd: fixture.workspace,
      sandboxPolicy: { type: 'readOnly' },
    })
  })

  it('uses real Claude effort and fast settings, retaining the resumed conversation on reset', async () => {
    await agents.start(
      input('claude', { model: 'opus', reasoningEffort: 'max', serviceTier: 'fast' }),
    )
    await completed()
    const remoteId = events.find((event) => event.type === 'session')!.remoteId
    events = []
    await agents.start(
      input('claude', {
        prompt: 'Follow up with exactly this user message.',
        model: 'opus',
        reasoningEffort: '',
        serviceTier: 'default',
      }),
    )
    await completed()
    const logs = await fixture.log()
    const launches = logs.filter(
      (entry) => entry.provider === 'claude' && entry.argv?.includes('--model=opus'),
    )
    expect(launches).toHaveLength(1)
    expect(launches[0].argv).toContain('--effort=max')
    expect(
      JSON.parse(launches[0].argv![launches[0].argv!.indexOf('--settings') + 1]),
    ).toMatchObject({ fastMode: true })
    const messages = logs
      .filter((entry) => entry.provider === 'claude' && entry.message)
      .map((entry) => entry.message!)
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'control_request',
        request: { subtype: 'set_permission_mode', mode: 'plan' },
      }),
    )
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'control_request',
        request: { subtype: 'set_model', model: 'opus' },
      }),
    )
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'control_request',
        request: {
          subtype: 'apply_flag_settings',
          settings: { effortLevel: null, fastMode: false },
        },
      }),
    )
    const users = messages.filter((message) => message.type === 'user')
    expect(users).toHaveLength(2)
    expect(users[1]).toMatchObject({
      session_id: remoteId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Follow up with exactly this user message.' }],
      },
    })
    expect(
      messages.some(
        (message) => message.type === 'control_request' && message.request?.subtype === 'interrupt',
      ),
    ).toBe(false)
  })

  it('quotes generic Claude arguments and forwards session-scoped settings', async () => {
    const literal = "/tmp/life-provider-`$(touch /tmp/life-provider-injection)`; quote ' me"
    await agents.start(
      input('claude', {
        providerOptions: {
          settings: { future_flag: { enabled: true } },
          args: ['--add-dir', literal],
        },
      }),
    )
    await completed()
    const launch = [...(await fixture.log())]
      .reverse()
      .find((entry) => entry.provider === 'claude' && entry.argv?.includes('--add-dir'))!
    expect(launch.argv).toContain(literal)
    expect(JSON.parse(launch.argv![launch.argv!.indexOf('--settings') + 1])).toEqual({
      future_flag: { enabled: true },
    })
  })

  it('prevents unsupported Claude fast mode from silently changing the chosen model', async () => {
    await expect(
      agents.start(input('claude', { model: 'sonnet', serviceTier: 'fast' })),
    ).rejects.toThrow(/does not support speed tier/i)
    await expect(
      agents.start(input('claude', { model: 'sonnet', reasoningEffort: 'max' })),
    ).rejects.toThrow(/does not support reasoning effort/i)
    await agents.start(input('claude', { model: 'sonnet', reasoningEffort: 'high' }))
    await completed()
  })

  it('does not clamp unavailable Codex effort and can run a later supported turn', async () => {
    await expect(
      agents.start(input('codex', { reasoningEffort: 'unsupported-effort' })),
    ).rejects.toThrow(/does not support reasoning effort/i)
    await agents.start(input('codex', { reasoningEffort: 'high' }))
    await completed()
  })

  it('restores the remote configured defaults rather than substituting catalog recommendations', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'life-provider-defaults-'))
    const source = await readFile(join(process.cwd(), 'tests/fixtures/fake-provider.cjs'), 'utf8')
    const threadResponse = "result: { thread: { id: message.params.threadId || 'codex-remote-1' } }"
    expect(source).toContain(threadResponse)
    const providerSource = join(temporary, 'provider.cjs')
    await writeFile(
      providerSource,
      source.replace(
        threadResponse,
        "result: { thread: { id: message.params.threadId || 'codex-remote-1' }, model: 'fixture-model', reasoningEffort: 'high', serviceTier: 'fast' }",
      ),
    )
    const configured = await new SSHFixture(providerSource).start()
    const configuredStore = new Store(join(configured.root, 'settings'))
    await configuredStore.init()
    const configuredConnection = new SSHConnection(configuredStore)
    configuredConnection.on('host-key', (request: HostKeyRequest) =>
      configuredConnection.trust(request.id, true),
    )
    const configuredEvents: AgentEvent[] = []
    const configuredAgents = new Agents(configuredConnection, (event) =>
      configuredEvents.push(event),
    )
    try {
      await configuredConnection.connect(configured.input())
      await configuredConnection.selectWorkspace(configured.workspace)
      await configuredAgents.models('codex')
      const run = async (extra: Partial<StartInput>) => {
        configuredEvents.length = 0
        await configuredAgents.start(input('codex', extra))
        await vi.waitFor(() =>
          expect(configuredEvents.some((event) => event.type === 'complete')).toBe(true),
        )
      }
      await run({ reasoningEffort: '', serviceTier: '' })
      await run({ reasoningEffort: 'low', serviceTier: 'default' })
      await run({ reasoningEffort: '', serviceTier: '' })
      const turns = (await configured.log()).filter(
        (entry) => entry.message?.method === 'turn/start',
      )
      expect(
        turns.map((entry) => ({
          effort: entry.message?.params.effort,
          serviceTier: entry.message?.params.serviceTier,
        })),
      ).toEqual([
        { effort: 'high', serviceTier: 'fast' },
        { effort: 'low', serviceTier: 'default' },
        { effort: 'high', serviceTier: 'fast' },
      ])
      // The resumed thread reports its last selected values, while config/read
      // reports the current remote defaults. Recreating Agents models an app restart.
      configuredAgents.close()
      const restarted = new Agents(configuredConnection, (event) => configuredEvents.push(event))
      try {
        configuredEvents.length = 0
        await restarted.start(
          input('codex', {
            remoteId: turns[0].message?.params.threadId,
            reasoningEffort: '',
            serviceTier: '',
          }),
        )
        await vi.waitFor(() =>
          expect(configuredEvents.some((event) => event.type === 'complete')).toBe(true),
        )
        const latest = [...(await configured.log())]
          .reverse()
          .find((entry) => entry.message?.method === 'turn/start')!
        expect(latest.message?.params).toMatchObject({
          effort: 'low',
          serviceTier: null,
          threadId: turns[0].message?.params.threadId,
        })
        expect(
          (await configured.log()).some((entry) => entry.message?.method === 'config/read'),
        ).toBe(true)
      } finally {
        restarted.close()
      }
    } finally {
      configuredConnection.disconnect()
      configuredAgents.close()
      await configured.close()
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('keeps generic and resumed models scoped to their threads instead of changing Agent default', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'life-provider-model-default-'))
    const source = await readFile(join(process.cwd(), 'tests/fixtures/fake-provider.cjs'), 'utf8')
    const threadResponse = "result: { thread: { id: message.params.threadId || 'codex-remote-1' } }"
    expect(source).toContain(threadResponse)
    const providerSource = join(temporary, 'provider.cjs')
    await writeFile(
      providerSource,
      source.replace(
        threadResponse,
        "result: { thread: { id: message.params.threadId || 'model-thread-' + message.id }, model: message.params.threadId ? 'saved-custom-model' : message.params.model || 'fixture-model', reasoningEffort: 'low', serviceTier: null }",
      ),
    )
    const scoped = await new SSHFixture(providerSource).start()
    const scopedStore = new Store(join(scoped.root, 'settings'))
    await scopedStore.init()
    const scopedConnection = new SSHConnection(scopedStore)
    scopedConnection.on('host-key', (request: HostKeyRequest) =>
      scopedConnection.trust(request.id, true),
    )
    const scopedEvents: AgentEvent[] = []
    let scopedAgents = new Agents(scopedConnection, (event) => scopedEvents.push(event))
    try {
      await scopedConnection.connect(scoped.input())
      await scopedConnection.selectWorkspace(scoped.workspace)
      const run = async (sessionId: string, extra: Partial<StartInput> = {}) => {
        scopedEvents.length = 0
        await scopedAgents.start(
          input('codex', { sessionId, reasoningEffort: '', serviceTier: '', ...extra }),
        )
        await vi.waitFor(() =>
          expect(
            scopedEvents.some(
              (event) => event.type === 'complete' && event.sessionId === sessionId,
            ),
          ).toBe(true),
        )
      }
      await run('ordinary-default')
      const ordinaryRemote = scopedEvents.find((event) => event.type === 'session')!.remoteId
      await run('generic-custom', {
        providerOptions: { thread: { model: 'generic-custom-model' } },
      })
      await run('ordinary-default')
      let turns = (await scoped.log()).filter((entry) => entry.message?.method === 'turn/start')
      expect(turns.map((entry) => entry.message?.params.model)).toEqual([
        'fixture-model',
        'generic-custom-model',
        'fixture-model',
      ])
      expect(turns[0].message?.params.threadId).toBe(turns[2].message?.params.threadId)
      expect(turns[1].message?.params.threadId).not.toBe(ordinaryRemote)
      scopedAgents.close()
      scopedAgents = new Agents(scopedConnection, (event) => scopedEvents.push(event))
      await run('ordinary-default', { remoteId: ordinaryRemote })
      // The resume response deliberately reports a saved custom model. The
      // new turn must still use the independently configured Agent default.
      turns = (await scoped.log()).filter((entry) => entry.message?.method === 'turn/start')
      expect(turns.at(-1)?.message?.params).toMatchObject({
        model: 'fixture-model',
        threadId: ordinaryRemote,
        effort: 'low',
        serviceTier: null,
      })
    } finally {
      scopedConnection.disconnect()
      scopedAgents.close()
      await scoped.close()
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
