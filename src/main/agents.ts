import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type {
  AgentConfigureResult,
  AgentEvent,
  AgentQuestion,
  AgentSettingsInput,
  AgentSteerInput,
  ModelOption,
  Provider,
  StartInput,
} from '../shared/types'
import { agentProviderOptionsSchema, shellQuote } from '../shared/validation'
import { SSHConnection } from './ssh'
import { JsonLines } from './json-lines'
import { CodexRPC as RPC, CodexRequestError } from './codex-rpc'
import { LIFE_VERSION } from '../shared/version'
import { stageStudioContext } from './studio-context'
import { generateProviderTitle } from './provider-titles'
import { claudeUserContent, codexUserInput } from './agent-attachments'

type DurableChannel = ClientChannel & { transportState?: 'connected' | 'suspended' | 'closed' }

type Wire = Record<string, unknown>
const object = (value: unknown): Wire => (value && typeof value === 'object' ? (value as Wire) : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const array = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(object) : [])

function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Agent startup cancelled'))
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', cancel)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', cancel)
        reject(error)
      },
    )
  })
}

export function codexModelOption(model: Wire): ModelOption {
  const result: ModelOption = {
    id: string(model.model || model.id),
    name: string(model.displayName || model.model || model.id),
  }
  if (Array.isArray(model.supportedReasoningEfforts))
    result.supportedReasoningEfforts = array(model.supportedReasoningEfforts)
      .map((option) => ({
        reasoningEffort: string(option.reasoningEffort),
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      }))
      .filter((option) => option.reasoningEffort)
  if (typeof model.defaultReasoningEffort === 'string')
    result.defaultReasoningEffort = model.defaultReasoningEffort
  if (Array.isArray(model.serviceTiers))
    result.serviceTiers = array(model.serviceTiers)
      .map((tier) => ({
        id: string(tier.id),
        name: string(tier.name || tier.id),
        ...(typeof tier.description === 'string' ? { description: tier.description } : {}),
      }))
      .filter((tier) => tier.id)
  else if (Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.length)
    result.serviceTiers = [
      { id: 'default', name: 'Standard' },
      ...model.additionalSpeedTiers
        .filter((tier): tier is string => typeof tier === 'string' && Boolean(tier))
        .map((tier) => ({ id: tier, name: tier.charAt(0).toUpperCase() + tier.slice(1) })),
    ]
  if (typeof model.defaultServiceTier === 'string')
    result.defaultServiceTier = model.defaultServiceTier
  if (typeof model.isDefault === 'boolean') result.isDefault = model.isDefault
  return result
}

export function claudeModelOption(model: Wire): ModelOption {
  const value = string(model.value)
  const result: ModelOption = {
    id: value === 'default' ? '' : value,
    name: string(model.displayName) || value,
  }
  if (Array.isArray(model.supportedEffortLevels))
    result.supportedReasoningEfforts = model.supportedEffortLevels
      .filter((effort): effort is string => typeof effort === 'string' && Boolean(effort))
      .map((reasoningEffort) => ({ reasoningEffort }))
  else if (model.supportsEffort === false) result.supportedReasoningEfforts = []
  if (typeof model.supportsFastMode === 'boolean')
    result.serviceTiers = [
      { id: 'default', name: 'Standard' },
      ...(model.supportsFastMode ? [{ id: 'fast', name: 'Fast' }] : []),
    ]
  if (value === 'default') result.isDefault = true
  return result
}

interface Session {
  input: StartInput
  machineIdentity: string
  codexRPC?: RPC
  remoteId?: string
  turnId?: string
  channel?: ClientChannel
  busy: boolean
  messageId?: string
  streamed: Set<string>
  stderr: string
  approvals: Map<string, { wireId: unknown; method: string; params: Wire }>
  startup?: Promise<void>
  initialization: AbortController
  stopRequested: boolean
  stopping?: Promise<void>
  ignoredTurns: Set<string>
  controls: Map<
    string,
    {
      resolve: (value: Wire) => void
      reject: (error: Error) => void
      timer?: NodeJS.Timeout
      remaining: number
      started: number
      expire: () => void
    }
  >
  workspace: string
  writableRoot: string
  appliedModel?: string
  appliedReasoningEffort?: string
  configuration?: Promise<void>
  titleTask?: AbortController
  title?: string
  itemPhases: Map<string, 'commentary' | 'final_answer'>
  claudeMessageIds: Map<string, string>
  claudeAgentNames: Map<string, string>
  claudeStateAware?: boolean
  claudeState?: 'idle' | 'running' | 'requires_action'
  claudeResult?: Wire
  claudeReply?: string
  phase: 'initializing' | 'startingTurn' | 'running'
}
export class Agents {
  private codex?: RPC
  private codexStarting?: Promise<RPC>
  private codexTransports = new Set<RPC>()
  private codexByMachine = new Map<string, RPC>()
  private codexStartingByMachine = new Map<string, Promise<RPC>>()
  private sessions = new Map<string, Session>()
  private threads = new Map<string, string>()
  private threadTransports = new Map<string, RPC>()
  private generation = 0
  private codexGeneration = 0
  private defaultCodexModel?: string
  private codexModels?: ModelOption[]
  private codexDefaultEfforts = new Map<string, string>()
  private codexDefaultTiers = new Map<string, string | null>()
  private codexDiskConfig?: Wire
  private codexConfigStarting?: Promise<Wire>
  private claudeModels?: ModelOption[]
  private claudeModelsStarting?: Promise<ModelOption[]>
  private discoveryChannels = new Set<ClientChannel>()
  private childThreads = new Map<string, { sessionId: string; agentName?: string }>()
  private durableOpening = 0
  private catalogGeneration = 0
  constructor(
    private ssh: SSHConnection,
    private emit: (event: AgentEvent) => void,
  ) {
    ssh.on('disconnected', () => {
      // A durable provider process belongs to its thread, not to the currently
      // attached SSH socket. Its broker will replay events after reconnect.
      if (!this.hasDurableChannels()) this.close()
    })
    ssh.on('workspace-changing', () => {
      if (!this.hasDurableChannels())
        this.close("Project changed. Select this thread's project to continue.")
      else this.clearModelCatalogs()
    })
  }
  private hasDurableChannels() {
    return (
      this.durableOpening > 0 ||
      [...this.codexTransports].some((rpc) =>
        Boolean((rpc.channel as DurableChannel).transportState),
      ) ||
      [...this.sessions.values()].some((session) =>
        Boolean((session.channel as DurableChannel | undefined)?.transportState),
      )
    )
  }
  private clearModelCatalogs() {
    this.catalogGeneration++
    this.defaultCodexModel = undefined
    this.codexModels = undefined
    this.codexDefaultEfforts.clear()
    this.codexDefaultTiers.clear()
    this.codexDiskConfig = undefined
    this.codexConfigStarting = undefined
    this.claudeModels = undefined
    this.claudeModelsStarting = undefined
  }
  private async providerChannel(command: string): Promise<ClientChannel> {
    const durable = this.ssh as SSHConnection & {
      durableChannel?: (command: string) => Promise<ClientChannel>
    }
    if (!durable.durableChannel) return this.ssh.channel(command)
    this.durableOpening++
    try {
      return await durable.durableChannel(command)
    } finally {
      this.durableOpening--
    }
  }
  private transportEvents(channel: ClientChannel, sessions: () => [string, Session][]) {
    let suspended = (channel as DurableChannel).transportState === 'suspended'
    channel.on('suspended', () => {
      if (suspended) return
      suspended = true
      for (const [id, session] of sessions()) {
        for (const pending of session.controls.values()) {
          clearTimeout(pending.timer)
          pending.timer = undefined
          pending.remaining = Math.max(1, pending.remaining - (Date.now() - pending.started))
        }
        if (session.busy)
          this.event(id, {
            type: 'status',
            status: 'suspended',
            text: 'Connection interrupted. The agent continues on your machine; Life will catch up after reconnecting.',
          })
      }
    })
    channel.on('resumed', () => {
      if (!suspended) return
      suspended = false
      for (const [id, session] of sessions()) {
        for (const pending of session.controls.values()) {
          if (pending.timer) continue
          pending.started = Date.now()
          pending.timer = setTimeout(pending.expire, pending.remaining)
        }
        if (session.busy)
          this.event(id, {
            type: 'status',
            status: 'resumed',
            text: 'Reconnected. Catching up with the same agent turn…',
          })
      }
    })
  }
  private event(sessionId: string, event: Omit<AgentEvent, 'sessionId'>) {
    this.emit({ sessionId, ...event })
  }
  private machineIdentity() {
    const profile = this.ssh.state.profile
    return profile ? JSON.stringify([profile.host, profile.port, profile.username]) : 'test-machine'
  }
  private async getCodex(): Promise<RPC> {
    const machine = this.machineIdentity()
    const existing = this.codexByMachine.get(machine)
    if (existing && !existing.closed) {
      if (this.codex !== existing) this.clearModelCatalogs()
      this.codex = existing
      return existing
    }
    const opening = this.codexStartingByMachine.get(machine)
    if (opening) return opening
    const generation = this.generation
    ++this.codexGeneration
    const starting = (async () => {
      const version = /codex(?:-cli)?\s+(\d+)\.(\d+)/.exec(this.ssh.state.codex || '')
      const supportsLiveSettings = version && (Number(version[1]) > 0 || Number(version[2]) >= 162)
      const channel = await this.providerChannel(
        `cd ${shellQuote(this.ssh.state.workspace || this.ssh.state.home || '/')} && exec codex app-server --listen stdio://${supportsLiveSettings ? ' -c features.step_model_switching=true' : ''}`,
      )
      if (this.generation !== generation) {
        channel.close()
        throw new Error('SSH connection cancelled')
      }
      const rpc = new RPC(
        channel,
        (message) => {
          if (this.generation === generation && this.codexTransports.has(rpc))
            this.receiveCodex(message, rpc)
        },
        (error) => {
          this.codexTransports.delete(rpc)
          if (this.codexByMachine.get(machine) === rpc) this.codexByMachine.delete(machine)
          if (this.generation !== generation) return
          if (this.codex === rpc) this.codex = undefined
          for (const [remoteId, transport] of this.threadTransports)
            if (transport === rpc) {
              this.threadTransports.delete(remoteId)
              this.threads.delete(remoteId)
            }
          // Invalidate all turns immediately, without waiting for the remote SSH
          // close acknowledgement, which can arrive after a replacement starts.
          for (const [id, session] of this.sessions)
            if (session.codexRPC === rpc) {
              if (session.remoteId) this.threads.delete(session.remoteId)
              for (const [remoteId, child] of this.childThreads)
                if (child.sessionId === id) this.childThreads.delete(remoteId)
              if (session.busy && !session.stopRequested) {
                session.busy = false
                session.approvals.clear()
                this.event(id, { type: 'error', text: error.message })
              }
            }
        },
      )
      this.codexTransports.add(rpc)
      this.transportEvents(channel, () =>
        [...this.sessions].filter(
          ([, session]) =>
            session.machineIdentity === machine && session.input.provider === 'codex',
        ),
      )
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'life_desktop', title: 'Life', version: LIFE_VERSION },
          capabilities: { experimentalApi: true },
        })
        if (this.generation !== generation) throw new Error('SSH connection cancelled')
        rpc.send({ method: 'initialized', params: {} })
        this.codexByMachine.set(machine, rpc)
        if (this.codex !== rpc) this.clearModelCatalogs()
        this.codex = rpc
        return rpc
      } catch (error) {
        rpc.close(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()
    this.codexStarting = starting
    this.codexStartingByMachine.set(machine, starting)
    try {
      return await starting
    } finally {
      if (this.codexStarting === starting) this.codexStarting = undefined
      if (this.codexStartingByMachine.get(machine) === starting)
        this.codexStartingByMachine.delete(machine)
    }
  }
  async models(provider: Provider): Promise<ModelOption[]> {
    if (this.ssh.state.status !== 'connected') throw new Error('Connect to a machine first')
    if (provider === 'claude') return this.discoverClaudeModels()
    const generation = this.generation
    const machine = this.machineIdentity()
    const rpc = await this.getCodex()
    const catalogGeneration = this.catalogGeneration
    const config = await this.configuredCodexDefaults(rpc)
    const models: Wire[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await rpc.request('model/list', { ...(cursor ? { cursor } : {}) })
      models.push(...array(result.data))
      const next = string(result.nextCursor)
      if (!next || next === cursor) break
      cursor = next
    }
    if (
      generation !== this.generation ||
      machine !== this.machineIdentity() ||
      catalogGeneration !== this.catalogGeneration
    )
      throw new Error('SSH connection cancelled')
    const configuredModel = string(config.model)
    const defaultModel = models.find((model) =>
      configuredModel ? string(model.model || model.id) === configuredModel : model.isDefault,
    )
    this.defaultCodexModel =
      configuredModel || (defaultModel ? string(defaultModel.model || defaultModel.id) : undefined)
    this.codexModels = [
      { ...(defaultModel ? codexModelOption(defaultModel) : {}), id: '', name: 'Codex default' },
      ...models.map(codexModelOption).filter((model) => model.id),
    ]
    return this.codexModels
  }
  private async discoverClaudeModels(): Promise<ModelOption[]> {
    if (this.claudeModels) return this.claudeModels
    if (this.claudeModelsStarting) return this.claudeModelsStarting
    const generation = this.generation
    const machine = this.machineIdentity()
    const catalogGeneration = this.catalogGeneration
    const starting = (async () => {
      const args = [
        'claude',
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
        '--permission-mode',
        'plan',
      ]
      const channel = await this.ssh.channel(
        `cd ${shellQuote(this.ssh.state.workspace || this.ssh.state.home || '/')} && exec ${args.map(shellQuote).join(' ')}`,
      )
      if (generation !== this.generation || machine !== this.machineIdentity()) {
        channel.close()
        throw new Error('SSH connection cancelled')
      }
      this.discoveryChannels.add(channel)
      try {
        const result = await new Promise<Wire>((resolve, reject) => {
          const requestId = randomUUID()
          let stderr = ''
          const timer = setTimeout(
            () => finish(new Error('Claude model discovery timed out')),
            60000,
          )
          let settled = false
          const finish = (error?: Error, value?: Wire) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            error ? reject(error) : resolve(value || {})
          }
          const lines = new JsonLines((message) => {
            if (message.type !== 'control_response') return
            const response = object(message.response)
            if (response.request_id !== requestId) return
            if (response.subtype === 'error')
              finish(new Error(string(response.error) || 'Claude model discovery failed'))
            else finish(undefined, object(response.response))
          })
          channel.on('data', (chunk: Buffer) => lines.push(chunk))
          channel.stderr.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-8192)
          })
          channel.on('error', (error: Error) => finish(error))
          channel.on('close', () =>
            finish(new Error(stderr || 'Claude model discovery disconnected')),
          )
          channel.write(
            JSON.stringify({
              type: 'control_request',
              request_id: requestId,
              request: { subtype: 'initialize', hooks: null },
            }) + '\n',
          )
        })
        if (
          generation !== this.generation ||
          machine !== this.machineIdentity() ||
          catalogGeneration !== this.catalogGeneration
        )
          throw new Error('SSH connection cancelled')
        const advertised = array(result.models).map(claudeModelOption)
        this.claudeModels = advertised.length
          ? [
              {
                ...(advertised.find((model) => !model.id) || {}),
                id: '',
                name: 'Claude default',
              },
              ...advertised.filter((model) => model.id),
            ]
          : [
              { id: '', name: 'Claude default' },
              { id: 'sonnet', name: 'Sonnet' },
              { id: 'opus', name: 'Opus' },
              { id: 'haiku', name: 'Haiku' },
            ]
        return this.claudeModels
      } finally {
        this.discoveryChannels.delete(channel)
        channel.signal('TERM')
        channel.close()
      }
    })()
    this.claudeModelsStarting = starting
    try {
      return await starting
    } finally {
      if (this.claudeModelsStarting === starting) this.claudeModelsStarting = undefined
    }
  }
  private validateModelChoices(input: StartInput, models?: ModelOption[]) {
    const model = models?.find((option) => option.id === (input.model || ''))
    if (
      input.reasoningEffort &&
      model?.supportedReasoningEfforts &&
      !model.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === input.reasoningEffort,
      )
    )
      throw new Error(`${model.name} does not support reasoning effort ${input.reasoningEffort}`)
    if (
      input.serviceTier &&
      model?.serviceTiers &&
      !model.serviceTiers.some((tier) => tier.id === input.serviceTier)
    )
      throw new Error(`${model.name} does not support speed tier ${input.serviceTier}`)
    // Claude can silently switch to Opus if fast is requested on another model.
    // Require an advertised capability instead of changing the user's choice.
    if (
      input.provider === 'claude' &&
      input.serviceTier === 'fast' &&
      !model?.serviceTiers?.some((tier) => tier.id === 'fast')
    )
      throw new Error('Choose a Claude model that advertises Fast mode')
  }
  private async configuredCodexDefaults(rpc: RPC): Promise<Wire> {
    if (this.codexDiskConfig) return this.codexDiskConfig
    if (this.codexConfigStarting) return this.codexConfigStarting
    const generation = this.generation
    const machine = this.machineIdentity()
    const catalogGeneration = this.catalogGeneration
    const starting = (async () => {
      let config: Wire = {}
      try {
        const result = await rpc.request(
          'config/read',
          {
            includeLayers: false,
            cwd: this.ssh.state.workspace,
          },
          3000,
        )
        config = object(result.config)
      } catch {
        // Older app-server versions can omit configuration reads. Their model
        // catalog still provides a safe default without reusing saved overrides.
      }
      if (
        generation !== this.generation ||
        machine !== this.machineIdentity() ||
        catalogGeneration !== this.catalogGeneration
      )
        throw new Error('SSH connection cancelled')
      this.codexDiskConfig = config
      return config
    })()
    this.codexConfigStarting = starting
    try {
      return await starting
    } finally {
      if (this.codexConfigStarting === starting) this.codexConfigStarting = undefined
    }
  }
  async start(input: StartInput) {
    if (this.ssh.state.status !== 'connected') throw new Error('Connect to a machine first')
    if (!input.scope && !this.ssh.state.workspace) throw new Error('Select a project first')
    if (!input.scope && input.workspace && input.workspace !== this.ssh.state.workspace)
      throw new Error("The selected project changed. Select this thread's project to continue.")
    if (input.scope === 'life-customization' && !input.studioContext)
      throw new Error('Life Studio requires its dedicated instruction context')
    let researchWritableRoot: string | undefined
    if (input.scope === 'research') {
      const home = this.ssh.state.home
      const root = home ? `${home.replace(/\/+$/, '')}/.life/research/` : ''
      const parts = input.workspace?.startsWith(root)
        ? input.workspace.slice(root.length).split('/')
        : []
      if (
        !root ||
        !parts.length ||
        parts.some((part) => !part || part.startsWith('.') || /[\\\0]/.test(part)) ||
        !(parts.length === 1 || (parts.length === 3 && parts[1] === 'problems'))
      )
        throw new Error('Select a research workspace inside this machine’s .life/research folder')
      // A problem conversation keeps its own cwd, but its metadata and maps
      // belong to the containing goal. Pin that validated root to this session.
      researchWritableRoot = root + parts[0]
    }
    const version = this.ssh.state[input.provider]
    if (!version || version === 'missing')
      throw new Error(
        `${input.provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed on this machine. Install and sign in using the terminal.`,
      )
    const old = this.sessions.get(input.sessionId)
    if (old?.busy) throw new Error('This thread is already running')
    if (old && old.input.provider !== input.provider)
      throw new Error('Start a new thread to change providers')
    if (old && old.input.scope !== input.scope)
      throw new Error('This conversation belongs to a different workspace view')
    if (old && old.machineIdentity !== this.machineIdentity())
      throw new Error('Reconnect to this thread’s saved machine before continuing it')
    if (input.providerOptions) agentProviderOptionsSchema.parse(input.providerOptions)
    if (
      input.provider === 'codex' &&
      (input.providerOptions?.settings || input.providerOptions?.args)
    )
      throw new Error('Codex provider options use thread and turn parameters')
    if (
      input.provider === 'claude' &&
      (input.providerOptions?.thread || input.providerOptions?.turn)
    )
      throw new Error('Claude provider options use settings and command-line arguments')
    // Each turn owns its asynchronous callbacks; an earlier cancelled startup
    // must not resume against the next turn's input or stop flag.
    const session: Session = {
      input,
      machineIdentity: this.machineIdentity(),
      codexRPC: undefined,
      busy: true,
      approvals: new Map(),
      streamed: new Set(),
      stderr: '',
      remoteId: old?.remoteId || input.remoteId,
      channel: old?.channel,
      stopRequested: false,
      ignoredTurns: old?.ignoredTurns || new Set(),
      controls: new Map(),
      workspace: this.ssh.state.workspace!,
      writableRoot: researchWritableRoot || this.ssh.state.workspace!,
      appliedModel: old?.appliedModel,
      appliedReasoningEffort: old?.appliedReasoningEffort,
      title: old?.title,
      titleTask: old?.titleTask,
      itemPhases: new Map(),
      claudeMessageIds: new Map(),
      claudeAgentNames: old?.claudeAgentNames || new Map(),
      claudeStateAware: old?.claudeStateAware,
      claudeState: old?.claudeState,
      phase: 'initializing',
      initialization: new AbortController(),
    }
    // Claude's stream-json process supports further user messages and native
    // configuration controls. Keep it alive between turns so provider-owned
    // subagents and the session are not recreated on every Send.
    const reuseClaude =
      old?.input.provider === 'claude' &&
      old.channel &&
      !old.channel.destroyed &&
      old.workspace ===
        (input.scope ? input.workspace || old.workspace : this.ssh.state.workspace) &&
      JSON.stringify(old.input.providerOptions || {}) ===
        JSON.stringify(input.providerOptions || {})
    const activeSession = reuseClaude
      ? Object.assign(old, session, { controls: old.controls })
      : session
    this.sessions.set(input.sessionId, activeSession)
    const initialize = async () => {
      if (input.scope === 'life-customization') {
        activeSession.workspace = await stageStudioContext(
          this.ssh,
          input.sessionId,
          input.studioContext!,
          activeSession.initialization.signal,
        )
        activeSession.writableRoot = activeSession.workspace
      } else if (input.scope === 'research') activeSession.workspace = input.workspace!
      if (activeSession.stopRequested || this.sessions.get(input.sessionId) !== activeSession)
        return
      await (input.provider === 'codex'
        ? this.startCodex(activeSession)
        : this.startClaude(activeSession, Boolean(reuseClaude)))
    }
    const startup = untilCancelled(initialize(), activeSession.initialization.signal)
    activeSession.startup = startup
    try {
      await startup
      if (!activeSession.stopRequested && !old?.title && !old?.remoteId && !input.remoteId)
        this.beginTitleTask(activeSession)
    } catch (error) {
      if (!activeSession.stopRequested && this.sessions.get(input.sessionId) === activeSession) {
        activeSession.busy = false
        throw error
      }
    } finally {
      if (activeSession.startup === startup) activeSession.startup = undefined
    }
  }
  private setProviderTitle(session: Session, title: string) {
    const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!normalized || normalized === session.title) return
    session.title = normalized
    session.titleTask?.abort()
    this.event(session.input.sessionId, { type: 'title', title: normalized })
  }
  private beginTitleTask(session: Session) {
    if (session.title || session.titleTask) return
    const controller = new AbortController()
    session.titleTask = controller
    const sessionId = session.input.sessionId
    // This is an isolated metadata job. Its instruction file and result never
    // enter the user's actual conversation, and the user input is unchanged.
    void generateProviderTitle(
      this.ssh,
      {
        provider: session.input.provider,
        prompt: session.input.prompt,
        model: session.input.model,
      },
      controller.signal,
    )
      .then((title) => {
        const current = this.sessions.get(sessionId)
        if (title && !controller.signal.aborted && current?.titleTask === controller)
          this.setProviderTitle(current, title)
      })
      .catch(() => {})
  }
  async steer(input: AgentSteerInput): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    if (!session?.busy || session.stopRequested)
      throw new Error('The active turn has finished. Send this message as the next turn.')
    await session.startup
    if (this.sessions.get(input.sessionId) !== session || !session.busy || session.stopRequested)
      throw new Error('The active turn has finished. Your message was not sent.')
    if (session.input.provider === 'codex') {
      const rpc = session.codexRPC
      const turnId = session.turnId
      if (!rpc || rpc.closed || !turnId || !session.remoteId)
        throw new Error('The Codex turn is not ready for steering')
      await rpc.request('turn/steer', {
        threadId: session.remoteId,
        expectedTurnId: turnId,
        input: codexUserInput(input.prompt, input.attachments),
      })
    } else {
      const channel = session.channel
      if (!channel || channel.destroyed) throw new Error('Claude Code is disconnected')
      const content = await claudeUserContent(this.ssh, input.prompt, input.attachments)
      if (session.channel !== channel || !session.busy || session.stopRequested)
        throw new Error('The active turn has finished. Your message was not sent.')
      // `next` delivers at a provider boundary. `now` would interrupt Claude's
      // current generation; it is deliberately not used for steering.
      channel.write(
        JSON.stringify({
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          priority: 'next',
        }) + '\n',
      )
    }
  }
  async configure(input: AgentSettingsInput): Promise<AgentConfigureResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session)
      return { applied: 'next-request', ...input, note: 'Used when this thread starts.' }
    const previous = session.configuration || Promise.resolve()
    let resolveOperation!: () => void
    const current = new Promise<void>((resolve) => {
      resolveOperation = resolve
    })
    session.configuration = current
    await previous.catch(() => {})
    try {
      await session.startup
      if (this.sessions.get(input.sessionId) !== session || session.stopRequested)
        throw new Error('This agent session changed. Try updating its settings again.')
      return await this.configureSession(session, input)
    } finally {
      resolveOperation()
      if (session.configuration === current) session.configuration = undefined
    }
  }
  private async configureSession(
    session: Session,
    input: AgentSettingsInput,
  ): Promise<AgentConfigureResult> {
    const choices = { ...session.input, ...input }
    if (session.machineIdentity !== this.machineIdentity()) {
      session.input = choices
      const result: AgentConfigureResult = {
        ...input,
        applied: 'next-request',
        note: 'Saved for this thread. Reconnect to its own machine to apply these choices.',
      }
      this.event(input.sessionId, {
        type: 'settings',
        status: result.applied,
        text: result.note,
        details: result,
      })
      return result
    }
    if (
      session.input.provider === 'codex' &&
      !this.codexModels &&
      this.ssh.state.status === 'connected'
    )
      await this.models('codex')
    if (
      session.input.provider === 'claude' &&
      !this.claudeModels &&
      this.ssh.state.status === 'connected'
    )
      await this.models('claude')
    const catalog = session.input.provider === 'codex' ? this.codexModels : this.claudeModels
    this.validateModelChoices(choices, catalog)
    const result: AgentConfigureResult = {
      applied: 'next-request',
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    }
    const ownsSession = () =>
      this.sessions.get(session.input.sessionId) === session && !session.stopRequested
    if (session.input.provider === 'codex') {
      const rpc = session.codexRPC
      if (rpc && !rpc.closed && session.remoteId) {
        const model = choices.model || this.defaultCodexModel
        const effort =
          input.reasoningEffort === ''
            ? this.codexDefaultEfforts.get(model || '') ||
              catalog?.find((item) => item.id === model)?.defaultReasoningEffort
            : input.reasoningEffort
        if (input.reasoningEffort === '' && !effort)
          throw new Error('Codex has not advertised its default effort for this model')
        const patch = {
          ...(input.model !== undefined ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(input.serviceTier !== undefined
            ? { serviceTier: input.serviceTier || this.codexDefaultTiers.get(model || '') || null }
            : {}),
          ...(input.mode !== undefined
            ? {
                approvalPolicy: input.mode === 'review' ? 'untrusted' : 'on-request',
                sandboxPolicy:
                  input.mode === 'plan'
                    ? { type: 'readOnly' }
                    : {
                        type: 'workspaceWrite',
                        writableRoots: [session.writableRoot],
                        networkAccess: false,
                      },
              }
            : {}),
        }
        try {
          await rpc.request(
            'thread/settings/update',
            { threadId: session.remoteId, ...patch },
            15000,
          )
          if (!ownsSession()) throw new Error('Agent session changed while applying settings')
          if (session.busy && session.turnId && input.mode === undefined) {
            try {
              const live = await rpc.request(
                'turn/settings/update',
                {
                  threadId: session.remoteId,
                  turnId: session.turnId,
                  ...patch,
                },
                15000,
              )
              if (!ownsSession()) throw new Error('Agent session changed while applying settings')
              if (live.status === 'applied') {
                result.applied = 'live'
                result.note = 'Applied at the next model step in this running turn.'
              } else result.note = 'The active turn finished; saved for the next turn.'
            } catch (error) {
              if (
                !(error instanceof CodexRequestError) ||
                !/not found|unsupported|requires|step_model_switching|not available/i.test(
                  error.message,
                )
              )
                throw error
              result.note =
                'Saved for the next turn. Update remote Codex to enable live model-step changes.'
            }
          } else
            result.note =
              input.mode !== undefined && session.busy
                ? 'Permission changes are saved for the next turn; pending approvals keep their original policy.'
                : 'Saved in the Codex thread without starting a turn.'
        } catch (error) {
          if (
            !(error instanceof CodexRequestError) ||
            !/not found|unsupported|requires|not available/i.test(error.message)
          )
            throw error
          result.note =
            'Saved in Life for the next turn. This Codex version has no settings-only API.'
        }
      } else result.note = 'Saved for the next agent request.'
    } else if (session.channel && !session.channel.destroyed) {
      if (input.mode !== undefined)
        await this.claudeControl(
          session,
          {
            subtype: 'set_permission_mode',
            mode:
              input.mode === 'plan' ? 'plan' : input.mode === 'edit' ? 'acceptEdits' : 'default',
          },
          15000,
        )
      if (input.model !== undefined)
        await this.claudeControl(
          session,
          { subtype: 'set_model', model: input.model || 'default' },
          15000,
        )
      if (!ownsSession()) throw new Error('Agent session changed while applying settings')
      const settings = {
        ...(input.reasoningEffort !== undefined
          ? { effortLevel: input.reasoningEffort || null }
          : {}),
        ...(input.serviceTier !== undefined
          ? { fastMode: input.serviceTier ? input.serviceTier === 'fast' : null }
          : {}),
      }
      if (Object.keys(settings).length)
        await this.claudeControl(session, { subtype: 'apply_flag_settings', settings }, 15000)
      if (!ownsSession()) throw new Error('Agent session changed while applying settings')
      result.applied = 'live'
      if (input.serviceTier !== undefined) {
        result.applied = 'next-request'
        result.note =
          'Accepted without interrupting. Claude changes speed on the next turn; model and effort change at subsequent model requests.'
      } else result.note = 'Applied at Claude’s next model request without interrupting this turn.'
    }
    if (!ownsSession()) throw new Error('Agent session changed while applying settings')
    session.input = { ...session.input, ...input }
    if (input.model !== undefined) session.appliedModel = input.model
    if (input.reasoningEffort !== undefined) session.appliedReasoningEffort = input.reasoningEffort
    this.event(input.sessionId, {
      type: 'settings',
      status: result.applied,
      text: result.note,
      details: result,
    })
    return result
  }
  private async startCodex(session: Session) {
    const rpc = await this.getCodex()
    session.codexRPC = rpc
    const { input } = session
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) return
    const approvalPolicy = input.mode === 'review' ? 'untrusted' : 'on-request'
    const sandbox = input.mode === 'plan' ? 'read-only' : 'workspace-write'
    const genericThreadModel = string(input.providerOptions?.thread?.model)
    const genericTurnModel = string(input.providerOptions?.turn?.model)
    if (!input.model && !genericThreadModel && !genericTurnModel) {
      const config = await this.configuredCodexDefaults(rpc)
      const configuredModel = string(config.model)
      if (configuredModel) this.defaultCodexModel = configuredModel
      if (!this.defaultCodexModel) await this.models('codex')
    }
    const threadModel = input.model || genericThreadModel || this.defaultCodexModel
    const turnModel =
      input.model || genericTurnModel || genericThreadModel || this.defaultCodexModel
    const effectiveOptions = {
      ...input,
      model: turnModel,
      reasoningEffort:
        input.reasoningEffort === undefined
          ? string(input.providerOptions?.turn?.effort)
          : input.reasoningEffort,
      serviceTier:
        input.serviceTier === undefined
          ? string(input.providerOptions?.turn?.serviceTier)
          : input.serviceTier,
    }
    if (
      !this.codexModels &&
      (effectiveOptions.reasoningEffort ||
        effectiveOptions.serviceTier ||
        (input.reasoningEffort === '' && session.appliedReasoningEffort))
    )
      await this.models('codex')
    this.validateModelChoices(effectiveOptions, this.codexModels)
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    if (!session.remoteId || this.threadTransports.get(session.remoteId) !== rpc) {
      const resuming = Boolean(session.remoteId)
      this.event(input.sessionId, {
        type: 'status',
        text: resuming ? 'Reopening the saved Codex conversation…' : 'Starting Codex…',
      })
      const result = await rpc.request(
        session.remoteId ? 'thread/resume' : 'thread/start',
        {
          ...input.providerOptions?.thread,
          // Life persists its own message history. Hydrating every remote turn can
          // overflow the protocol frame and block resuming large conversations.
          ...(session.remoteId ? { threadId: session.remoteId, excludeTurns: true } : {}),
          cwd: session.workspace,
          approvalPolicy,
          sandbox,
          ...(threadModel ? { model: threadModel } : {}),
        },
        60000,
        session.initialization.signal,
      )
      if (this.sessions.get(input.sessionId) !== session)
        throw new Error('SSH connection cancelled')
      const responseModel = string(result.model) || threadModel || ''
      const ordinaryDefaults =
        !input.providerOptions?.thread?.config &&
        !genericThreadModel &&
        !input.providerOptions?.thread?.serviceTier
      if (
        responseModel &&
        typeof result.reasoningEffort === 'string' &&
        !resuming &&
        ordinaryDefaults &&
        !session.appliedReasoningEffort
      )
        this.codexDefaultEfforts.set(responseModel, result.reasoningEffort)
      if (
        responseModel &&
        (typeof result.serviceTier === 'string' || result.serviceTier === null) &&
        !resuming &&
        ordinaryDefaults &&
        !this.codexDefaultTiers.has(responseModel)
      )
        this.codexDefaultTiers.set(responseModel, result.serviceTier)
      const returnedId = string(object(result.thread).id)
      if (!returnedId) throw new Error('Codex did not return a thread ID')
      if (resuming && returnedId !== session.remoteId)
        throw new Error(
          'Codex returned a different conversation while resuming. Your saved thread is unchanged.',
        )
      session.remoteId = returnedId
      this.threads.set(session.remoteId, input.sessionId)
      this.threadTransports.set(session.remoteId, rpc)
      this.event(input.sessionId, { type: 'session', remoteId: session.remoteId })
      this.setProviderTitle(session, string(object(result.thread).name))
    }
    if (session.stopRequested) return
    if (
      session.remoteId &&
      (input.reasoningEffort === '' || input.serviceTier === '') &&
      (!this.codexDefaultEfforts.has(turnModel || '') ||
        !this.codexDefaultTiers.has(turnModel || ''))
    ) {
      const config = await this.configuredCodexDefaults(rpc)
      const key = turnModel || ''
      if (
        key &&
        typeof config.model_reasoning_effort === 'string' &&
        !this.codexDefaultEfforts.has(key)
      )
        this.codexDefaultEfforts.set(key, config.model_reasoning_effort)
      if (
        key &&
        (typeof config.service_tier === 'string' || config.service_tier === null) &&
        !this.codexDefaultTiers.has(key)
      )
        this.codexDefaultTiers.set(key, config.service_tier)
    }
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    const modelOption = this.codexModels?.find((model) => model.id === (turnModel || ''))
    let effort = input.reasoningEffort
    if (effort === '') {
      effort = this.codexDefaultEfforts.get(turnModel || '') || modelOption?.defaultReasoningEffort
      if (!effort && session.appliedReasoningEffort)
        throw new Error('Codex did not advertise a default reasoning effort for this model')
    }
    session.phase = 'startingTurn'
    const result = await rpc.request('turn/start', {
      ...input.providerOptions?.turn,
      threadId: session.remoteId,
      input: codexUserInput(input.prompt, input.attachments),
      cwd: session.workspace,
      approvalPolicy,
      ...(turnModel ? { model: turnModel } : {}),
      ...(effort ? { effort } : {}),
      ...(input.serviceTier !== undefined
        ? {
            serviceTier: input.serviceTier || this.codexDefaultTiers.get(turnModel || '') || null,
          }
        : {}),
      sandboxPolicy:
        input.mode === 'plan'
          ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [session.writableRoot], networkAccess: false },
    })
    if (effort) session.appliedReasoningEffort = effort
    session.turnId = string(object(result.turn).id)
    session.appliedModel = turnModel
    session.phase = 'running'
  }
  private receiveCodex(message: Wire, rpc: RPC) {
    const method = string(message.method)
    const params = object(message.params)
    const thread = object(params.thread)
    const remoteId = string(params.threadId || thread.id)
    if (method === 'thread/started' && thread.parentThreadId) {
      const parentId = string(thread.parentThreadId)
      const owner = this.threads.get(parentId) || this.childThreads.get(parentId)?.sessionId
      if (owner && this.sessions.get(owner)?.codexRPC === rpc)
        this.childThreads.set(remoteId, {
          sessionId: owner,
          agentName: string(thread.agentNickname || thread.agentRole || thread.name) || undefined,
        })
    }
    if (method === 'thread/closed') {
      const childOwner = this.childThreads.get(remoteId)?.sessionId
      if (
        this.threadTransports.get(remoteId) === rpc ||
        (childOwner && this.sessions.get(childOwner)?.codexRPC === rpc)
      ) {
        this.threads.delete(remoteId)
        this.threadTransports.delete(remoteId)
        this.childThreads.delete(remoteId)
      }
      return
    }
    const child = this.childThreads.get(remoteId)
    const sessionId = this.threads.get(remoteId) || child?.sessionId
    if (!sessionId) {
      if (message.id != null && method)
        rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.codexRPC !== rpc) {
      if (message.id != null && method)
        rpc.send({
          id: message.id,
          error: { code: -32000, message: 'The client moved to a replacement provider transport' },
        })
      return
    }
    const isChild = Boolean(child && session.remoteId !== remoteId)
    const emit = (event: Omit<AgentEvent, 'sessionId'>) =>
      this.event(sessionId, {
        ...event,
        provider: 'codex',
        ...(isChild ? { agentId: remoteId, agentName: child?.agentName } : {}),
      })
    // Thread metadata remains relevant after the work completes. In particular,
    // provider-generated titles often arrive after turn/completed.
    if (method === 'thread/name/updated' && !isChild) {
      this.setProviderTitle(session, string(params.threadName || params.name))
      return
    }
    if (method === 'thread/settings/updated' && !isChild) {
      emit({ type: 'settings', details: params.threadSettings, status: 'provider-updated' })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      emit({
        type: 'status',
        itemId: `usage-${remoteId}`,
        title: 'Token usage',
        text: 'Token usage',
        details: { tokenUsage: params.tokenUsage },
      })
      return
    }
    const turnId = string(params.turnId || object(params.turn).id)
    if (
      !isChild &&
      (!session.busy ||
        (turnId &&
          (session.ignoredTurns.has(turnId) || (session.turnId && session.turnId !== turnId))))
    ) {
      if (message.id != null && method)
        rpc.send({
          id: message.id,
          error: { code: -32000, message: 'The turn is no longer active' },
        })
      return
    }
    const item = object(params.item)
    const itemId = string(item.id || params.itemId)
    const lifecycle = method === 'item/started' || method === 'item/completed'
    const phase =
      item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined
    if (phase && itemId) session.itemPhases.set(itemId, phase)
    if (method === 'item/agentMessage/delta')
      emit({
        type: 'text',
        text: string(params.delta),
        itemId,
        phase: session.itemPhases.get(itemId),
      })
    if (lifecycle && item.type === 'agentMessage')
      emit({
        type: 'text',
        itemId,
        text: string(item.text),
        status: 'replace',
        phase: phase || session.itemPhases.get(itemId),
      })
    if (method === 'item/reasoning/summaryTextDelta')
      emit({ type: 'reasoning', itemId, text: string(params.delta) })
    if (method === 'item/reasoning/summaryPartAdded' && Number(params.summaryIndex) > 0)
      emit({ type: 'reasoning', itemId, text: '\n\n' })
    if (lifecycle && item.type === 'reasoning' && Array.isArray(item.summary))
      emit({
        type: 'reasoning',
        itemId,
        text: item.summary.map(string).join('\n\n'),
        status: 'replace',
      })
    if (method === 'item/plan/delta') emit({ type: 'plan', itemId, text: string(params.delta) })
    if (lifecycle && item.type === 'plan')
      emit({ type: 'plan', itemId, text: string(item.text), status: 'replace' })
    if (method === 'turn/plan/updated')
      emit({
        type: 'plan',
        itemId: `plan-${turnId}`,
        title: 'Plan',
        text: string(params.explanation),
        status: 'replace',
        details: { plan: params.plan },
      })
    if (
      lifecycle &&
      ['collabAgentToolCall', 'collabToolCall', 'subAgentActivity'].includes(string(item.type))
    ) {
      const receivers = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.map(string)
        : [string(item.receiverThreadId || item.newThreadId || item.agentThreadId)].filter(Boolean)
      for (const receiver of receivers)
        if (!this.threads.has(receiver) && !this.childThreads.has(receiver))
          this.childThreads.set(receiver, { sessionId })
      emit({
        type: 'subagent',
        itemId,
        title: string(item.tool || item.kind) || 'Subagent',
        text: string(item.prompt),
        status: string(item.status) || (method === 'item/completed' ? 'completed' : 'running'),
        agentId: receivers[0] || undefined,
        agentName: string(item.agentPath) || undefined,
        details: item,
      })
    } else if (
      lifecycle &&
      !['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(string(item.type))
    ) {
      emit({
        type: 'tool',
        itemId,
        title:
          item.type === 'commandExecution'
            ? string(item.command)
            : item.type === 'fileChange'
              ? 'Editing files'
              : string(item.tool || item.name || item.type),
        text:
          string(item.aggregatedOutput) ||
          (item.changes
            ? JSON.stringify(item.changes, null, 2)
            : item.result
              ? JSON.stringify(item.result, null, 2)
              : item.output
                ? typeof item.output === 'string'
                  ? item.output
                  : JSON.stringify(item.output, null, 2)
                : string(item.review || item.query)),
        status: method === 'item/completed' ? string(item.status) || 'completed' : 'running',
        details: item,
      })
    }
    if (method === 'item/commandExecution/outputDelta')
      emit({ type: 'tool-output', itemId, text: string(params.delta) })
    if (method === 'turn/diff/updated')
      emit({
        type: 'tool',
        itemId: `diff-${turnId}`,
        title: 'Changes',
        text: string(params.diff),
        status: 'completed',
      })
    if (method === 'turn/started') {
      if (isChild)
        emit({
          type: 'subagent',
          itemId: `agent-${remoteId}`,
          agentId: remoteId,
          title: child?.agentName || 'Subagent',
          status: 'running',
          details: thread,
        })
      else session.turnId = string(object(params.turn).id)
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn)
      if (isChild) {
        emit({
          type: 'subagent',
          itemId: `agent-${remoteId}`,
          agentId: remoteId,
          title: child?.agentName || 'Subagent',
          status: string(turn.status),
          text: string(object(turn.error).message),
          details: { lifecycle: 'turn' },
        })
        return
      }
      if (turnId) session.ignoredTurns.add(turnId)
      if (session.stopRequested) return
      session.busy = false
      for (const [requestId, approval] of session.approvals)
        if (!approval.params.threadId || approval.params.threadId === session.remoteId)
          session.approvals.delete(requestId)
      emit({
        type: turn.status === 'failed' ? 'error' : 'complete',
        status: string(turn.status),
        text: string(object(turn.error).message),
      })
      void rpc
        .request('thread/read', { threadId: remoteId, includeTurns: false }, 3000)
        .then((result) => {
          const current = this.sessions.get(sessionId)
          if (current?.remoteId === remoteId)
            this.setProviderTitle(current, string(object(result.thread).name))
        })
        .catch(() => {})
    }
    if (method === 'error')
      emit({
        type: params.willRetry ? 'status' : 'error',
        text: string(object(params.error).message),
      })
    if (message.id != null && method) {
      const requestId = randomUUID()
      if (
        /requestApproval$/.test(method) &&
        (method.includes('commandExecution') || method.includes('fileChange'))
      ) {
        session.approvals.set(requestId, { wireId: message.id, method, params })
        emit({
          type: 'approval',
          requestId,
          title: method.includes('fileChange') ? 'Allow file changes?' : 'Allow this command?',
          text: string(params.command || params.reason) || 'Codex needs permission to continue.',
        })
      } else if (method === 'item/tool/requestUserInput') {
        session.approvals.set(requestId, { wireId: message.id, method, params })
        emit({
          type: 'question',
          requestId,
          questions: array(params.questions) as unknown as AgentQuestion[],
        })
      } else
        rpc.send({
          id: message.id,
          error: { code: -32601, message: 'Life does not support this server request yet' },
        })
    }
  }
  private async startClaude(session: Session, reuse = false) {
    const { input } = session
    const settings = { ...input.providerOptions?.settings }
    if (input.serviceTier !== undefined) {
      if (input.serviceTier === '') delete settings.fastMode
      else if (input.serviceTier === 'fast') settings.fastMode = true
      else if (input.serviceTier === 'default') settings.fastMode = false
      else throw new Error(`Claude Code does not support speed tier ${input.serviceTier}`)
    }
    if (input.reasoningEffort !== undefined) delete settings.effortLevel
    const effectiveOptions = {
      ...input,
      reasoningEffort:
        input.reasoningEffort === undefined ? string(settings.effortLevel) : input.reasoningEffort,
      serviceTier: settings.fastMode === true ? 'fast' : input.serviceTier,
      model: input.model || string(settings.model),
    }
    if (!this.claudeModels && (effectiveOptions.reasoningEffort || settings.fastMode === true))
      await this.discoverClaudeModels()
    this.validateModelChoices(effectiveOptions, this.claudeModels)
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    if (reuse && session.channel) {
      const channel = session.channel
      await this.claudeControl(
        session,
        {
          subtype: 'set_permission_mode',
          mode: input.mode === 'plan' ? 'plan' : input.mode === 'edit' ? 'acceptEdits' : 'default',
        },
        15000,
      )
      await this.configureSession(session, {
        sessionId: input.sessionId,
        model: input.model || '',
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      })
      const content = await claudeUserContent(
        this.ssh,
        input.prompt,
        input.attachments,
        session.initialization.signal,
      )
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      channel.write(
        JSON.stringify({
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        }) + '\n',
      )
      return
    }
    if (session.channel) {
      // A new process lets each turn apply the selected model and permission mode.
      const oldChannel = session.channel
      session.channel = undefined
      oldChannel.end()
      oldChannel.close()
    }
    const args = [
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      input.mode === 'plan' ? 'plan' : input.mode === 'edit' ? 'acceptEdits' : 'default',
    ]
    if (input.scope === 'research' && session.writableRoot !== session.workspace)
      args.push('--add-dir', session.writableRoot)
    if (input.model) args.push(`--model=${input.model}`)
    if (input.reasoningEffort) args.push(`--effort=${input.reasoningEffort}`)
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
    args.push(...(input.providerOptions?.args || []))
    if (session.remoteId) args.push(`--resume=${session.remoteId}`)
    const channel = await this.providerChannel(
      `cd ${shellQuote(session.workspace)} && exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 ${args.map(shellQuote).join(' ')}`,
    )
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) {
      channel.close()
      return
    }
    session.channel = channel
    this.transportEvents(channel, () => [[input.sessionId, session]])
    session.stderr = ''
    const lines = new JsonLines((message) => {
      if (session.channel !== channel || this.sessions.get(input.sessionId) !== session) return
      if (message.type === 'control_response') {
        const response = object(message.response)
        const requestId = string(response.request_id)
        const pending = session.controls.get(requestId)
        if (!pending) return
        session.controls.delete(requestId)
        clearTimeout(pending.timer)
        if (response.subtype === 'error')
          pending.reject(new Error(string(response.error) || 'Claude control request failed'))
        else pending.resolve(object(response.response))
      } else this.receiveClaude(session, message)
    })
    channel.on('data', (chunk: Buffer) => lines.push(chunk))
    channel.stderr.on('data', (chunk: Buffer) => {
      if (session.channel === channel)
        session.stderr = (session.stderr + chunk.toString()).slice(-8192)
    })
    const failed = (error: Error) => {
      if (session.channel !== channel) return
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      session.controls.clear()
      session.channel = undefined
      session.approvals.clear()
      if (session.busy && !session.stopRequested) {
        session.busy = false
        this.event(input.sessionId, { type: 'error', text: error.message })
      }
    }
    channel.on('error', (error: Error) => failed(error))
    channel.on('close', () =>
      failed(
        new Error(
          session.stderr ||
            'Claude Code exited before completing this turn. Check its remote login.',
        ),
      ),
    )
    try {
      const initialized = await this.claudeControl(
        session,
        { subtype: 'initialize', hooks: null, forwardSubagentText: true },
        60000,
      )
      if (['idle', 'running', 'requires_action'].includes(string(initialized.session_state))) {
        session.claudeStateAware = true
        session.claudeState = initialized.session_state as Session['claudeState']
      }
      if (session.stopRequested || session.channel !== channel) return
      const content = await claudeUserContent(
        this.ssh,
        input.prompt,
        input.attachments,
        session.initialization.signal,
      )
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      channel.write(
        JSON.stringify({
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        }) + '\n',
      )
    } catch (error) {
      channel.close()
      throw error
    }
  }
  private claudeControl(session: Session, request: Wire, timeout: number): Promise<Wire> {
    const channel = session.channel
    if (!channel || channel.destroyed)
      return Promise.reject(new Error('Claude Code is disconnected'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const expire = () => {
        session.controls.delete(requestId)
        reject(
          new Error(
            `Claude ${string(request.subtype)} timed out. Check its remote login in the terminal.`,
          ),
        )
      }
      const timer =
        (channel as DurableChannel).transportState === 'suspended'
          ? undefined
          : setTimeout(expire, timeout)
      session.controls.set(requestId, {
        resolve,
        reject,
        timer,
        remaining: timeout,
        started: Date.now(),
        expire,
      })
      try {
        channel.write(
          JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n',
        )
      } catch (error) {
        clearTimeout(timer)
        session.controls.delete(requestId)
        reject(error)
      }
    })
  }
  private receiveClaude(session: Session, message: Wire) {
    const id = session.input.sessionId
    const parentItemId = string(message.parent_tool_use_id) || undefined
    const emit = (event: Omit<AgentEvent, 'sessionId'>) =>
      this.event(id, {
        ...event,
        provider: 'claude',
        ...(parentItemId
          ? {
              parentItemId,
              agentId: parentItemId,
              agentName: session.claudeAgentNames.get(parentItemId),
            }
          : {}),
      })
    if (
      parentItemId &&
      (message.type === 'result' ||
        (message.type === 'system' && message.subtype === 'session_state_changed'))
    ) {
      emit({
        type: 'subagent',
        itemId: `agent-${parentItemId}`,
        title: session.claudeAgentNames.get(parentItemId) || 'Subagent',
        status:
          message.type === 'result'
            ? message.is_error
              ? 'failed'
              : 'completed'
            : message.state === 'idle'
              ? 'completed'
              : 'running',
        text: string(message.result),
        details: { ...message, lifecycle: 'turn' },
      })
      return
    }
    if (
      message.type === 'system' &&
      message.subtype === 'session_state_changed' &&
      ['idle', 'running', 'requires_action'].includes(string(message.state))
    ) {
      session.claudeStateAware = true
      session.claudeState = message.state as Session['claudeState']
      if (message.state === 'idle' && session.claudeResult)
        this.finishClaudeResult(session, session.claudeResult)
      else if (message.state !== 'idle' && !session.stopRequested) {
        session.busy = true
        emit({ type: 'status', status: 'running', details: { providerState: message.state } })
      }
      return
    }
    if (
      !parentItemId &&
      ((message.type === 'system' &&
        ['ai_title', 'title', 'session_title'].includes(string(message.subtype))) ||
        message.type === 'ai-title')
    )
      this.setProviderTitle(session, string(message.aiTitle || message.title || message.name))
    if (message.type === 'system' && message.subtype === 'notification')
      emit({
        type: 'status',
        text: string(message.message || message.text) || JSON.stringify(message),
      })
    if (
      message.type === 'system' &&
      /^task_(started|progress|notification|updated)$/.test(string(message.subtype))
    ) {
      const agentId = string(message.task_id || message.tool_use_id)
      const parent = string(message.tool_use_id) || parentItemId
      const name = string(message.description || message.summary || message.task_type)
      if (parent && name) session.claudeAgentNames.set(parent, name)
      emit({
        type: 'subagent',
        itemId: `task-${agentId}`,
        agentId,
        agentName: name || undefined,
        parentItemId: parent || undefined,
        title: name || 'Subagent',
        text: string(message.summary || message.description),
        status:
          string(message.status) ||
          (message.subtype === 'task_notification' ? 'completed' : 'running'),
        details: message,
      })
      return
    }
    if (message.type === 'control_cancel_request') {
      session.approvals.delete(string(message.request_id))
      return
    }
    if (!session.busy && message.type !== 'system') return
    if (
      typeof message.session_id === 'string' &&
      !parentItemId &&
      message.session_id !== session.remoteId
    ) {
      session.remoteId = message.session_id
      emit({ type: 'session', remoteId: message.session_id })
    }
    if (message.type === 'stream_event') {
      const event = object(message.event)
      const delta = object(event.delta)
      const stream = parentItemId || 'root'
      if (event.type === 'message_start') {
        const messageId = string(object(event.message).id) || randomUUID()
        session.claudeMessageIds.set(stream, messageId)
        if (!parentItemId) session.messageId = messageId
      }
      if (delta.type === 'text_delta') {
        const itemId = session.claudeMessageIds.get(stream) || session.messageId || 'response'
        session.streamed.add(itemId)
        emit({ type: 'text', itemId, text: string(delta.text) })
      }
      const block = object(event.content_block)
      if (event.type === 'content_block_start' && block.type === 'tool_use')
        emit({
          type: 'tool',
          itemId: string(block.id),
          title: string(block.name),
          status: 'running',
          details: block,
        })
    }
    if (message.type === 'assistant') {
      const content = object(message.message)
      const itemId =
        string(content.id) || session.claudeMessageIds.get(parentItemId || 'root') || randomUUID()
      const text = array(content.content)
        .filter((block) => block.type === 'text')
        .map((block) => string(block.text))
        .join('\n')
      if (text) {
        if (!parentItemId) session.claudeReply = text
        emit({ type: 'text', itemId, text, status: 'replace' })
      }
      for (const tool of array(content.content).filter((block) => block.type === 'tool_use')) {
        const toolInput = object(tool.input)
        const delegated = tool.name === 'Agent' || tool.name === 'Task'
        const agentName = string(toolInput.description || toolInput.subagent_type)
        if (delegated && agentName) session.claudeAgentNames.set(string(tool.id), agentName)
        emit({
          type: delegated ? 'subagent' : 'tool',
          itemId: string(tool.id),
          title: delegated ? agentName || string(tool.name) : string(tool.name),
          text: JSON.stringify(tool.input, null, 2),
          status: 'running',
          ...(delegated ? { agentId: string(tool.id), agentName: agentName || undefined } : {}),
          details: tool,
        })
      }
    }
    if (message.type === 'user')
      for (const result of array(object(message.message).content).filter(
        (block) => block.type === 'tool_result',
      ))
        emit({
          type: session.claudeAgentNames.has(string(result.tool_use_id)) ? 'subagent' : 'tool',
          itemId: string(result.tool_use_id),
          ...(session.claudeAgentNames.has(string(result.tool_use_id))
            ? {
                agentId: string(result.tool_use_id),
                agentName: session.claudeAgentNames.get(string(result.tool_use_id)),
              }
            : {}),
          text:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          status: result.is_error ? 'failed' : 'completed',
          details: result,
        })
    if (message.type === 'control_request') {
      const request = object(message.request)
      const requestId = string(message.request_id)
      if (request.subtype === 'can_use_tool') {
        session.approvals.set(requestId, {
          wireId: requestId,
          method: string(request.tool_name),
          params: { ...request, ...(parentItemId ? { parent_tool_use_id: parentItemId } : {}) },
        })
        const toolInput = object(request.input)
        if (request.tool_name === 'AskUserQuestion')
          emit({
            type: 'question',
            requestId,
            questions: array(toolInput.questions).map((q, i) => ({
              id: string(q.question) || String(i),
              question: string(q.question),
              header: string(q.header),
              options: array(q.options).map((o) => ({
                label: string(o.label),
                description: string(o.description),
              })),
            })),
          })
        else
          emit({
            type: 'approval',
            requestId,
            title: `Allow ${string(request.tool_name)}?`,
            text: string(toolInput.command) || JSON.stringify(toolInput, null, 2),
          })
      } else
        session.channel?.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: 'Unsupported control request',
            },
          }) + '\n',
        )
    }
    if (message.type === 'result') {
      if (session.stopRequested) return
      if (!message.is_error && string(message.result) && message.result !== session.claudeReply)
        emit({
          type: 'text',
          itemId: session.messageId || `result-${string(message.uuid) || randomUUID()}`,
          text: string(message.result),
          status: 'replace',
        })
      const metrics = Object.fromEntries(
        ['usage', 'modelUsage', 'total_cost_usd', 'num_turns', 'duration_ms', 'duration_api_ms']
          .filter((key) => message[key] !== undefined)
          .map((key) => [key, message[key]]),
      )
      if (Object.keys(metrics).length)
        emit({
          type: 'status',
          itemId: `usage-${session.messageId || id}`,
          title: 'Usage and cost',
          text: 'Usage and cost',
          details: metrics,
        })
      session.claudeResult = message
      if (!session.claudeStateAware || session.claudeState === 'idle')
        this.finishClaudeResult(session, message)
    }
  }
  private finishClaudeResult(session: Session, message: Wire) {
    if (session.stopRequested || !session.busy) return
    session.busy = false
    session.claudeResult = undefined
    for (const [requestId, approval] of session.approvals)
      if (!approval.params.parent_tool_use_id && !approval.params.agent_id)
        session.approvals.delete(requestId)
    this.event(
      session.input.sessionId,
      message.is_error
        ? {
            type: 'error',
            text:
              (Array.isArray(message.errors) ? message.errors.join('\n') : '') ||
              string(message.result) ||
              string(message.subtype),
          }
        : { type: 'complete', status: 'completed' },
    )
  }
  async respond(
    sessionId: string,
    requestId: string,
    accepted: boolean,
    answers?: Record<string, string[]>,
  ) {
    const session = this.sessions.get(sessionId)
    const approval = session?.approvals.get(requestId)
    if (!session || !approval) throw new Error('This request is no longer pending')
    if (session.input.provider === 'codex') {
      const result =
        approval.method === 'item/tool/requestUserInput'
          ? {
              answers: Object.fromEntries(
                Object.entries(answers || {}).map(([key, value]) => [key, { answers: value }]),
              ),
            }
          : { decision: accepted ? 'accept' : 'decline' }
      if (!session.codexRPC) throw new Error('Codex is disconnected')
      session.codexRPC.send({ id: approval.wireId, result })
    } else {
      const original = object(approval.params.input)
      const updatedInput =
        approval.method === 'AskUserQuestion'
          ? {
              ...original,
              answers: Object.fromEntries(
                Object.entries(answers || {}).map(([key, value]) => [key, value.join(', ')]),
              ),
            }
          : original
      if (!session.channel || session.channel.destroyed)
        throw new Error('Claude Code is disconnected')
      session.channel.write(
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: approval.wireId,
            response: accepted
              ? { behavior: 'allow', updatedInput }
              : { behavior: 'deny', message: 'The user declined this action' },
          },
        }) + '\n',
      )
    }
    session.approvals.delete(requestId)
  }
  async stop(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || !session.busy) return
    if (session.stopping) return session.stopping
    session.stopRequested = true
    const stopping = this.stopSession(sessionId, session)
    session.stopping = stopping
    try {
      await stopping
    } finally {
      if (session.stopping === stopping) session.stopping = undefined
    }
  }
  private async stopSession(sessionId: string, session: Session) {
    const generation = this.generation
    const rpc = session.codexRPC
    const ownsSession = () =>
      this.generation === generation && this.sessions.get(sessionId) === session
    // No user prompt has been sent during initialization. Finish immediately;
    // the startup checks the turn identity before issuing any remote work.
    if (session.phase === 'initializing') {
      session.initialization.abort()
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Agent startup cancelled'))
      }
      session.controls.clear()
      const channel = session.channel
      session.channel = undefined
      try {
        channel?.signal('TERM')
      } catch {}
      try {
        channel?.close()
      } catch {}
      session.busy = false
      session.approvals.clear()
      this.event(sessionId, { type: 'complete', status: 'interrupted' })
      return
    }
    await session.startup?.catch(() => {})
    if (!ownsSession()) return
    for (const id of [...session.approvals.keys()]) {
      if (!ownsSession()) return
      if (session.approvals.has(id)) {
        try {
          await this.respond(sessionId, id, false)
        } catch (error) {
          if (!ownsSession()) return
          throw error
        }
      }
      if (!ownsSession()) return
    }
    if (
      session.input.provider === 'codex' &&
      session.turnId &&
      !session.ignoredTurns.has(session.turnId)
    ) {
      try {
        await rpc?.request(
          'turn/interrupt',
          { threadId: session.remoteId, turnId: session.turnId },
          10000,
        )
        if (!ownsSession()) return
      } catch (error) {
        if (!ownsSession()) return
        // A failed interrupt must not leave the remote agent silently running.
        if (!session.ignoredTurns.has(session.turnId)) {
          rpc?.close(error instanceof Error ? error : new Error(String(error)))
          this.event(sessionId, {
            type: 'status',
            text: `Codex interruption failed; its connection was closed. ${(error as Error).message}`,
          })
        }
      }
      if (!ownsSession()) return
      session.ignoredTurns.add(session.turnId)
    } else if (session.channel) {
      const channel = session.channel
      try {
        await this.claudeControl(session, { subtype: 'interrupt' }, 10000)
        if (!ownsSession()) return
      } catch (error) {
        if (!ownsSession()) return
        this.event(sessionId, {
          type: 'status',
          text: `Claude did not acknowledge the interrupt; its process was terminated. ${(error as Error).message}`,
        })
      } finally {
        if (ownsSession() && session.channel === channel) {
          session.channel = undefined
          try {
            channel.signal('TERM')
          } catch {}
          try {
            channel.close()
          } catch {}
        }
      }
    }
    if (!ownsSession()) return
    session.busy = false
    session.approvals.clear()
    this.event(sessionId, { type: 'complete', status: 'interrupted' })
  }
  async dispose(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.stop(sessionId)
    if (this.sessions.get(sessionId) !== session) return
    session.stopRequested = true
    session.initialization.abort()
    session.titleTask?.abort()
    session.channel?.signal('TERM')
    session.channel?.close()
    for (const pending of session.controls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Agent session disposed'))
    }
    session.controls.clear()
    if (session.remoteId && this.threads.get(session.remoteId) === sessionId)
      this.threads.delete(session.remoteId)
    if (session.remoteId) this.threadTransports.delete(session.remoteId)
    for (const [remoteId, child] of this.childThreads)
      if (child.sessionId === sessionId) this.childThreads.delete(remoteId)
    this.sessions.delete(sessionId)
  }
  hasRunningSessions(): boolean {
    return [...this.sessions.values()].some(
      (session) => session.busy || session.startup !== undefined || session.stopping !== undefined,
    )
  }
  close(reason = 'SSH disconnected. Reconnect to continue this thread.') {
    this.generation++
    this.codexGeneration++
    for (const rpc of this.codexTransports) rpc.close(new Error(reason))
    this.codexTransports.clear()
    this.codexByMachine.clear()
    this.codexStartingByMachine.clear()
    this.codex = undefined
    this.codexStarting = undefined
    this.defaultCodexModel = undefined
    this.codexModels = undefined
    this.codexDefaultEfforts.clear()
    this.codexDefaultTiers.clear()
    this.codexDiskConfig = undefined
    this.codexConfigStarting = undefined
    this.claudeModels = undefined
    this.claudeModelsStarting = undefined
    for (const channel of this.discoveryChannels) {
      channel.signal('TERM')
      channel.close()
    }
    this.discoveryChannels.clear()
    this.threads.clear()
    this.threadTransports.clear()
    this.childThreads.clear()
    for (const [id, session] of this.sessions) {
      const channel = session.channel
      session.channel = undefined
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(reason))
      }
      session.controls.clear()
      channel?.signal('TERM')
      channel?.close()
      if (session.busy)
        this.event(id, {
          type: 'error',
          text: reason,
        })
      session.busy = false
      session.stopRequested = true
      session.initialization.abort()
      session.titleTask?.abort()
    }
    this.sessions.clear()
  }
}
