import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentQuestion, ModelOption, Provider, StartInput } from '../shared/types'
import { agentProviderOptionsSchema, shellQuote } from '../shared/validation'
import { SSHConnection } from './ssh'
import { JsonLines } from './json-lines'
import { CodexRPC as RPC } from './codex-rpc'
import { LIFE_VERSION } from '../shared/version'

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
    { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >
  workspace: string
  appliedModel?: string
  appliedReasoningEffort?: string
  phase: 'initializing' | 'startingTurn' | 'running'
}
export class Agents {
  private codex?: RPC
  private codexStarting?: Promise<RPC>
  private codexTransports = new Set<RPC>()
  private sessions = new Map<string, Session>()
  private threads = new Map<string, string>()
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
  constructor(
    private ssh: SSHConnection,
    private emit: (event: AgentEvent) => void,
  ) {
    ssh.on('disconnected', () => this.close())
    ssh.on('workspace-changing', () =>
      this.close("Project changed. Select this thread's project to continue."),
    )
  }
  private event(sessionId: string, event: Omit<AgentEvent, 'sessionId'>) {
    this.emit({ sessionId, ...event })
  }
  private async getCodex(): Promise<RPC> {
    if (this.codex && !this.codex.closed) return this.codex
    if (this.codexStarting) return this.codexStarting
    if (this.codex) {
      this.codex = undefined
      this.threads.clear()
    }
    const generation = this.generation
    const codexGeneration = ++this.codexGeneration
    const starting = (async () => {
      const channel = await this.ssh.channel(
        `cd ${shellQuote(this.ssh.state.workspace!)} && exec codex app-server --listen stdio://`,
      )
      if (this.generation !== generation) {
        channel.close()
        throw new Error('SSH connection cancelled')
      }
      const rpc = new RPC(
        channel,
        (message) => {
          if (this.generation === generation && this.codexGeneration === codexGeneration)
            this.receiveCodex(message, rpc)
        },
        (error) => {
          this.codexTransports.delete(rpc)
          if (this.codexGeneration !== codexGeneration || this.generation !== generation) return
          if (this.codex === rpc) this.codex = undefined
          this.threads.clear()
          // Invalidate all turns immediately, without waiting for the remote SSH
          // close acknowledgement, which can arrive after a replacement starts.
          for (const [id, session] of this.sessions)
            if (session.input.provider === 'codex' && session.busy && !session.stopRequested) {
              session.busy = false
              session.approvals.clear()
              this.event(id, { type: 'error', text: error.message })
            }
        },
      )
      this.codexTransports.add(rpc)
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'life_desktop', title: 'Life', version: LIFE_VERSION },
          capabilities: { experimentalApi: false },
        })
        if (this.generation !== generation) throw new Error('SSH connection cancelled')
        rpc.send({ method: 'initialized', params: {} })
        this.codex = rpc
        return rpc
      } catch (error) {
        rpc.close(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()
    this.codexStarting = starting
    try {
      return await starting
    } finally {
      if (this.codexStarting === starting) this.codexStarting = undefined
    }
  }
  async models(provider: Provider): Promise<ModelOption[]> {
    if (this.ssh.state.status !== 'connected') throw new Error('Connect to a machine first')
    if (!this.ssh.state.workspace) throw new Error('Select a project first')
    if (provider === 'claude') return this.discoverClaudeModels()
    const generation = this.generation
    const rpc = await this.getCodex()
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
    if (generation !== this.generation) throw new Error('SSH connection cancelled')
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
        `cd ${shellQuote(this.ssh.state.workspace!)} && exec ${args.map(shellQuote).join(' ')}`,
      )
      if (generation !== this.generation) {
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
        if (generation !== this.generation) throw new Error('SSH connection cancelled')
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
      if (generation !== this.generation) throw new Error('SSH connection cancelled')
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
    if (!this.ssh.state.workspace) throw new Error('Select a project first')
    if (input.workspace && input.workspace !== this.ssh.state.workspace)
      throw new Error("The selected project changed. Select this thread's project to continue.")
    const version = this.ssh.state[input.provider]
    if (!version || version === 'missing')
      throw new Error(
        `${input.provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed on this machine. Install and sign in using the terminal.`,
      )
    const old = this.sessions.get(input.sessionId)
    if (old?.busy) throw new Error('This thread is already running')
    if (old && old.input.provider !== input.provider)
      throw new Error('Start a new thread to change providers')
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
      appliedModel: old?.appliedModel,
      appliedReasoningEffort: old?.appliedReasoningEffort,
      phase: 'initializing',
      initialization: new AbortController(),
    }
    this.sessions.set(input.sessionId, session)
    const startup = untilCancelled(
      input.provider === 'codex' ? this.startCodex(session) : this.startClaude(session),
      session.initialization.signal,
    )
    session.startup = startup
    try {
      await startup
    } catch (error) {
      if (!session.stopRequested && this.sessions.get(input.sessionId) === session) {
        session.busy = false
        throw error
      }
    } finally {
      if (session.startup === startup) session.startup = undefined
    }
  }
  private async startCodex(session: Session) {
    const rpc = await this.getCodex()
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
    if (!session.remoteId || !this.threads.has(session.remoteId)) {
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
      this.event(input.sessionId, { type: 'session', remoteId: session.remoteId })
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
      input: [{ type: 'text', text: input.prompt }],
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
          : { type: 'workspaceWrite', writableRoots: [session.workspace], networkAccess: false },
    })
    if (effort) session.appliedReasoningEffort = effort
    session.turnId = string(object(result.turn).id)
    session.appliedModel = turnModel
    session.phase = 'running'
  }
  private receiveCodex(message: Wire, rpc: RPC) {
    const method = string(message.method)
    const params = object(message.params)
    const remoteId = string(params.threadId || object(params.thread).id)
    if (method === 'thread/closed') {
      this.threads.delete(remoteId)
      return
    }
    const sessionId = this.threads.get(remoteId)
    if (!sessionId) {
      if (message.id != null && method)
        rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    const turnId = string(params.turnId || object(params.turn).id)
    if (
      !session.busy ||
      (turnId &&
        (session.ignoredTurns.has(turnId) || (session.turnId && session.turnId !== turnId)))
    ) {
      if (message.id != null && method)
        rpc.send({
          id: message.id,
          error: { code: -32000, message: 'The turn is no longer active' },
        })
      return
    }
    const item = object(params.item)
    if (method === 'item/agentMessage/delta')
      this.event(sessionId, {
        type: 'text',
        text: string(params.delta),
        itemId: string(params.itemId),
      })
    if (
      (method === 'item/started' || method === 'item/completed') &&
      item.type !== 'agentMessage' &&
      item.type !== 'userMessage' &&
      item.type !== 'reasoning'
    ) {
      this.event(sessionId, {
        type: 'tool',
        itemId: string(item.id),
        title:
          item.type === 'commandExecution'
            ? string(item.command)
            : item.type === 'fileChange'
              ? 'Editing files'
              : string(item.type),
        text:
          string(item.aggregatedOutput) ||
          (item.changes ? JSON.stringify(item.changes, null, 2) : ''),
        status: method === 'item/completed' ? string(item.status) || 'completed' : 'running',
      })
    }
    if (method === 'item/completed' && item.type === 'agentMessage')
      this.event(sessionId, {
        type: 'text',
        itemId: string(item.id),
        text: string(item.text),
        status: 'replace',
      })
    if (method === 'item/commandExecution/outputDelta')
      this.event(sessionId, {
        type: 'tool-output',
        itemId: string(params.itemId),
        text: string(params.delta),
      })
    if (method === 'turn/started') session.turnId = string(object(params.turn).id)
    if (method === 'turn/completed') {
      if (turnId) session.ignoredTurns.add(turnId)
      if (session.stopRequested) return
      session.busy = false
      session.approvals.clear()
      const turn = object(params.turn)
      this.event(sessionId, {
        type: turn.status === 'failed' ? 'error' : 'complete',
        status: string(turn.status),
        text: string(object(turn.error).message),
      })
    }
    if (method === 'error')
      this.event(sessionId, {
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
        this.event(sessionId, {
          type: 'approval',
          requestId,
          title: method.includes('fileChange') ? 'Allow file changes?' : 'Allow this command?',
          text: string(params.command || params.reason) || 'Codex needs permission to continue.',
        })
      } else if (method === 'item/tool/requestUserInput') {
        session.approvals.set(requestId, { wireId: message.id, method, params })
        this.event(sessionId, {
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
  private async startClaude(session: Session) {
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
    if (input.model) args.push(`--model=${input.model}`)
    if (input.reasoningEffort) args.push(`--effort=${input.reasoningEffort}`)
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
    args.push(...(input.providerOptions?.args || []))
    if (session.remoteId) args.push(`--resume=${session.remoteId}`)
    const channel = await this.ssh.channel(
      `cd ${shellQuote(session.workspace)} && exec ${args.map(shellQuote).join(' ')}`,
    )
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) {
      channel.close()
      return
    }
    session.channel = channel
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
      await this.claudeControl(session, { subtype: 'initialize', hooks: null }, 60000)
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      channel.write(
        JSON.stringify({
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
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
      const timer = setTimeout(() => {
        session.controls.delete(requestId)
        reject(
          new Error(
            `Claude ${string(request.subtype)} timed out. Check its remote login in the terminal.`,
          ),
        )
      }, timeout)
      session.controls.set(requestId, { resolve, reject, timer })
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
    if (message.type === 'system' && message.subtype === 'notification')
      this.event(id, {
        type: 'status',
        text: string(message.message || message.text) || JSON.stringify(message),
      })
    if (message.type === 'control_cancel_request') {
      session.approvals.delete(string(message.request_id))
      return
    }
    if (!session.busy && message.type !== 'system') return
    if (typeof message.session_id === 'string' && message.session_id !== session.remoteId) {
      session.remoteId = message.session_id
      this.event(id, { type: 'session', remoteId: message.session_id })
    }
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      const event = object(message.event)
      const delta = object(event.delta)
      if (event.type === 'message_start')
        session.messageId = string(object(event.message).id) || randomUUID()
      if (delta.type === 'text_delta') {
        const itemId = session.messageId || 'response'
        session.streamed.add(itemId)
        this.event(id, { type: 'text', itemId, text: string(delta.text) })
      }
      const block = object(event.content_block)
      if (event.type === 'content_block_start' && block.type === 'tool_use')
        this.event(id, {
          type: 'tool',
          itemId: string(block.id),
          title: string(block.name),
          status: 'running',
        })
    }
    if (message.type === 'assistant') {
      const content = object(message.message)
      const itemId = string(content.id) || session.messageId || randomUUID()
      const text = array(content.content)
        .filter((b) => b.type === 'text')
        .map((b) => string(b.text))
        .join('\n')
      if (text && !message.parent_tool_use_id)
        this.event(id, { type: 'text', itemId, text, status: 'replace' })
      for (const tool of array(content.content).filter((b) => b.type === 'tool_use'))
        this.event(id, {
          type: 'tool',
          itemId: string(tool.id),
          title: string(tool.name),
          text: JSON.stringify(tool.input, null, 2),
          status: 'running',
        })
    }
    if (message.type === 'user')
      for (const result of array(object(message.message).content).filter(
        (b) => b.type === 'tool_result',
      ))
        this.event(id, {
          type: 'tool',
          itemId: string(result.tool_use_id),
          text:
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          status: result.is_error ? 'failed' : 'completed',
        })
    if (message.type === 'control_request') {
      const request = object(message.request)
      const requestId = string(message.request_id)
      if (request.subtype === 'can_use_tool') {
        session.approvals.set(requestId, {
          wireId: requestId,
          method: string(request.tool_name),
          params: request,
        })
        const toolInput = object(request.input)
        if (request.tool_name === 'AskUserQuestion')
          this.event(id, {
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
          this.event(id, {
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
      session.busy = false
      session.approvals.clear()
      if (message.is_error)
        this.event(id, {
          type: 'error',
          text:
            (Array.isArray(message.errors) ? message.errors.join('\n') : '') ||
            string(message.result) ||
            string(message.subtype),
        })
      else this.event(id, { type: 'complete', status: 'completed' })
    }
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
      if (!this.codex) throw new Error('Codex is disconnected')
      this.codex.send({ id: approval.wireId, result })
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
    const rpc = this.codex
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
    session.channel?.signal('TERM')
    session.channel?.close()
    for (const pending of session.controls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Agent session disposed'))
    }
    session.controls.clear()
    if (session.remoteId && this.threads.get(session.remoteId) === sessionId)
      this.threads.delete(session.remoteId)
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
    }
    this.sessions.clear()
  }
}
