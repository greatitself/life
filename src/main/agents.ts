import type { ClientChannel } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Deferred, Effect, Exit, Schema, Semaphore, type Scope } from 'effect'
import type {
  AgentConfigureResult,
  AgentEvent,
  AgentAttachment,
  AgentQuestion,
  AgentSettingsInput,
  AgentSteerInput,
  ModelOption,
  Provider,
  StartInput,
  NativeRecoveryConsumer,
  NativeRecoveryHistoryReceipt,
  NativeRecoveryOwnerState,
  NativeRecoveryActionRequest,
} from '../shared/types'
import type { ProviderUsageSnapshot } from '../shared/usage'
import type {
  ConversationCheckpointAck,
  ConversationProjectionAdmission,
} from '../shared/conversations'
import type { ConversationRecoveryProof } from './conversation-recovery-sidecar'
import { agentProviderOptionsSchema, shellQuote } from '../shared/validation'
import { claudePermissionMode, codexPermissions } from '../shared/permissions'
import { SSHConnection } from './ssh'
import { JsonLines } from './json-lines'
import { CodexRPC as RPC, CodexRequestError, CodexTransportError } from './codex-rpc'
import { LIFE_VERSION } from '../shared/version'
import { stageStudioContext } from './studio-context'
import { generateProviderTitle } from './provider-titles'
import { claudeUserContent, codexUserInput } from './agent-attachments'
import {
  claudeAdvisoryEvent,
  claudeLaunchCommand,
  claudeMetadataControls,
  claudeProtocolError,
  claudeRestoresUsageTotals,
  ClaudeMessageBlocks,
} from './claude-protocol'
import {
  codexApprovalChoices,
  codexApprovalPresentation,
  codexApprovalResponseOutcome,
  codexApprovalStopDecisionId,
  codexElicitationQuestions,
  codexRequestResponse,
} from './codex-requests'
import { claudeElicitationQuestions, claudeElicitationResponse } from './claude-requests'
import { codexUsageSnapshot } from './provider-usage'
import { claudeAccountInfo, normalizeClaudeUsageSnapshot } from './claude-usage'
import { runEffect } from './effect-runtime'
import { DurableRemoteChannel } from './durable-remote-channel'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import {
  validateNativeRecoveryPlatformPolicyEffect,
  type NativeRecoveryPlatformPolicy,
} from './native-recovery-platform'
import {
  NativeRecoveryError,
  type NativeRecoveryInputSemantic,
  type NativeRecoveryOwner,
  type NativeRecoverySnapshot,
  type NativeRecoveryStoredInput,
  type NativeRecoveryInputReceipt,
  nativeRecoveryStartInputSchema,
  isConfirmedNativeExit,
} from './native-recovery-types'
import { nativeMachineIdentity } from './native-machine-identity'
import {
  NativeAgentRecovery,
  maxNativeRequestId,
  stampRecoveryEvent,
  type NativeRecoveryOwnerStamp,
} from './agent-native-recovery'
import { nativeRecoveryActionIntentHash } from './native-recovery-actions'
import { planNativeStopRecovery } from './agent-native-stop-recovery'
import { applyNativeCodexSettings } from './agent-native-codex-settings'
import {
  applyNativeClaudeControl,
  type NativeClaudeControlDetails,
} from './agent-native-claude-controls'

type DurableChannel = ClientChannel & {
  transportState?: 'connected' | 'suspended' | 'closed'
  isClosing?: boolean
  readonly hasPendingDelivery?: boolean
  closeAndWaitEffect?: () => Effect.Effect<boolean, NativeRecoveryError>
  recoveryId?: string
  sessionId?: string
  outputCursor?: number
  recoveryDescriptor?: NativeRecoverySnapshot['transport']
  recordOwner?: (owner: NativeRecoveryOwner) => Promise<void>
  writeNative?: (message: Wire, semantic?: NativeRecoveryInputSemantic) => boolean
  writeNativeAndWait?: (message: Wire, semantic?: NativeRecoveryInputSemantic) => Promise<void>
  resumeRecoveryOutput?: () => void
  waitForReplay?: () => Promise<void>
  activateRecoveryInputs?: () => Promise<void>
  hasUnconfirmedRecoveryInputs?: boolean
  confirmNativeInputProcessed?: (sequence: number) => void
  detach?: () => Promise<void>
  flushRecovery?: () => Promise<void>
  signalNativeAndWait?: (signal: string, semantic: NativeRecoveryInputSemantic) => Promise<void>
  closeNativeAndWait?: (
    semantic: NativeRecoveryInputSemantic,
    timeoutMs?: number,
  ) => Promise<boolean>
}

class AgentEnvironmentError extends Schema.TaggedError<AgentEnvironmentError>()(
  'AgentEnvironmentError',
  {
    reason: Schema.Literals(['discovery', 'changed', 'retirement']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type Wire = Record<string, unknown>
const claudeMessageBlocks = new WeakMap<object, ClaudeMessageBlocks>()
const object = (value: unknown): Wire => (value && typeof value === 'object' ? (value as Wire) : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const array = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(object) : [])
const recoveryNatural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const recoveryCursorSchema = Schema.Struct({
  appliedRevision: recoveryNatural,
  snapshotToken: Schema.optionalKey(Schema.NonEmptyString),
  ownerGeneration: Schema.optionalKey(recoveryNatural),
})
const recoveryProjectionAdmissionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  transportId: Schema.NonEmptyString,
  appliedRevision: recoveryNatural,
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: recoveryNatural,
  deliveryToken: Schema.NonEmptyString,
})
const recoveryInputSchema = Schema.Struct({
  membershipAdmissions: Schema.optionalKey(Schema.Array(recoveryProjectionAdmissionSchema)),
  consumers: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['main', 'studio']),
      sessionId: Schema.NonEmptyString,
      profileId: Schema.NonEmptyString,
      workspace: Schema.optionalKey(Schema.String),
      remoteId: Schema.optionalKey(Schema.String),
      cacheHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
      projectionAdmissions: Schema.optionalKey(Schema.Array(recoveryProjectionAdmissionSchema)),
      applied: Schema.optionalKey(Schema.Record(Schema.String, recoveryCursorSchema)),
    }),
  ),
})
const recoveryOwnerInputSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  clientRecovery: Schema.Json,
  transportId: Schema.optionalKey(Schema.NonEmptyString),
  ownerGeneration: Schema.optionalKey(recoveryNatural),
  projectionAdmissions: Schema.optionalKey(Schema.Array(recoveryProjectionAdmissionSchema)),
})
const recoveryReceiptSchema = Schema.Struct({
  kind: Schema.Literal('studio'),
  sessionId: Schema.NonEmptyString,
  transportId: Schema.NonEmptyString,
  snapshotToken: Schema.NonEmptyString,
  snapshotId: Schema.NonEmptyString,
  throughEventRevision: recoveryNatural,
  durability: Schema.Literal('admitted-cache'),
  fileHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
})
const recoveryReservationSchema = Schema.Struct({
  input: Schema.JsonObject,
  clientRecovery: Schema.JsonObject,
})

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
  if (Array.isArray(model.inputModalities))
    result.inputModalities = model.inputModalities.filter(
      (value): value is string => typeof value === 'string',
    )
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
  else result.supportedReasoningEfforts = []
  result.serviceTiers = [
    { id: 'default', name: 'Standard' },
    ...(model.supportsFastMode === true ? [{ id: 'fast', name: 'Fast' }] : []),
  ]
  if (typeof model.supportsAutoMode === 'boolean') result.supportsAutoMode = model.supportsAutoMode
  else result.supportsAutoMode = false
  if (value === 'default') result.isDefault = true
  return result
}

interface Session {
  nativeStartIntentId?: string
  nativeStartPlan?: Wire
  recoveryTransportId?: string
  recoveryGeneration?: number
  recoverySnapshotToken?: string
  recoveryUnknown?: boolean
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
  approvals: Map<
    string,
    {
      wireId: unknown
      method: string
      params: Wire
      rpc?: RPC
      owner?: NativeRecoveryOwner
      wireOrdinal?: number
    }
  >
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
      request: Wire
      details?: NativeClaudeControlDetails
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
  claudeFastModeNeedsOptIn?: boolean
  claudeRestartForSettings?: boolean
  claudeUsageCallId?: string
  claudeCodeVersion?: string
  claudeAccount?: ProviderUsageSnapshot['account']
  claudeSubscriptionType?: string
  claudeActiveChildren?: Map<
    string,
    { itemId: string; title?: string; parentItemId?: string; owner?: NativeRecoveryOwner }
  >
  claudeTaskRuns?: Map<string, string>
  phase: 'initializing' | 'startingTurn' | 'running'
}
export class Agents {
  private readonly recovery: NativeAgentRecovery
  private recoveryStarting?: Promise<void>
  private recoveryLoaded = new Set<string>()
  private recoveryFailures = new Map<string, string>()
  private recoveryConsumerFailures = new Set<string>()
  private recoveryConsumers: NativeRecoveryConsumer[] = []
  private recoveryMembershipAdmissions: readonly ConversationProjectionAdmission[] = []
  private pendingHistoryReceipts: ConversationCheckpointAck[] = []
  private replayingTransports = new Set<string>()
  private recoverySnapshots = new Map<string, NativeRecoverySnapshot>()
  private recoveryReservations = new Map<string, NativeRecoverySnapshot>()
  private replayOutputCursors = new Map<string, number>()
  private codexRecoveryIds = new WeakMap<RPC, string>()
  private replayInputs = new Map<string, Map<string | number, NativeRecoveryStoredInput>>()
  private replayResolved = new Map<string, Set<string>>()
  private pendingRecoveryDecisions = new Map<
    string,
    Map<number, { input: NativeRecoveryStoredInput; owner?: NativeRecoveryOwnerStamp }>
  >()
  private pendingReceiptReconciliations = new Set<Promise<void>>()
  private deferredRecoveryAttachments = new Map<
    string,
    { channel: DurableChannel; rpc?: RPC; machine: string }
  >()
  private recoveringCodexInitialization = new Set<string>()
  private pendingCodexAcquisitions = new Map<Promise<RPC>, Promise<void>>()
  private registeredCodexAllocations = new WeakSet<Promise<void>>()
  private nativeDeliveryFailures = new Map<string, { transportId: string; message: string }>()
  private permissionOccurrenceIds = new Map<string, Set<string>>()
  private nativeProcessedInputs = new Map<string, Set<number>>()
  private nativeInterruptAcks = new Map<string, Set<string>>()
  private nativeStartControlAcks = new Map<string, Set<string>>()
  private recoveredStops = new Set<string>()
  private recoveredStarts = new Set<string>()
  private continuingStarts = new Set<string>()
  private continuingStops = new Set<string>()
  private stopContinuations = new Map<string, Promise<void>>()
  private pendingStopWakes = new Set<string>()
  private terminalEmission = new Map<string, number>()
  private rendererSuspended = false
  private recoveryAdmissionMutex = Semaphore.makeUnsafe(1)
  private recoveryAdmissionDepth = 0
  private recoveryAdmissionEvents: AgentEvent[] = []
  private pendingOwnerUpdates = new Set<Promise<void>>()
  private pendingStartAdmissions = new Map<string, { machine: string; provider: Provider }>()
  private pendingPermissionResponses = new Map<
    string,
    { sessionId: string; promise: Promise<void> }
  >()
  private stopCompletions = new Map<string, Deferred.Deferred<void, NativeRecoveryError>>()
  private replayInitialization = new Map<
    string,
    { response: boolean; initialized: boolean; requestId?: string | number }
  >()
  private claudeParsers = new WeakMap<Session, JsonLines>()
  private claudeWireSequences = new WeakMap<Session, number>()
  private codex?: RPC
  private codexStarting?: Promise<RPC>
  private codexTransports = new Set<RPC>()
  private codexByMachine = new Map<string, RPC>()
  private codexStartingByMachine = new Map<string, Promise<RPC>>()
  private codexStartingAllocationByMachine = new Map<string, Promise<void>>()
  private codexTransportVersions = new WeakMap<RPC, string>()
  private codexTransportMachines = new WeakMap<RPC, string>()
  private openingCodexChannels = new Map<DurableChannel, string>()
  private freshProviderChannels = new Map<
    string,
    { channel: DurableChannel; machine: string; provider: Provider }
  >()
  private failedFreshProviders = new Map<
    string,
    { machine: string; provider: Provider; message: string }
  >()
  private ownerlessClaudeAttachments = new Map<
    string,
    { channel: DurableChannel; machine: string }
  >()
  private ownerlessClaudeObservers = new Map<
    string,
    { channel: DurableChannel; cleanup: () => void }
  >()
  private idleClaudeProviderRelease?: Promise<boolean[]>
  private pendingNativeOperations = new Set<Promise<unknown>>()
  private pendingNativeOperationMachines = new WeakMap<Promise<unknown>, string>()
  private pendingProviderExits = new Map<
    DurableChannel,
    { provider: Provider; machine: string; onExit: () => void }
  >()
  private environmentChanges = new Map<string, object>()
  private idleProviderRelease?: Promise<boolean[]>
  private intentionalIdleClosing = new Set<RPC>()
  private terminalTransports = new Set<string>()
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
  private codexUsageSnapshots = new WeakMap<RPC, ProviderUsageSnapshot>()
  private codexAccountRevisions = new WeakMap<RPC, number>()
  private codexConfigStarting?: Promise<Wire>
  private claudeModels?: ModelOption[]
  private claudeModelsStarting?: Promise<ModelOption[]>
  private discoveryChannels = new Set<ClientChannel>()
  private childThreads = new Map<
    string,
    {
      sessionId: string
      agentName?: string
      rpc: RPC
      busy: boolean
      turnId?: string
      ignoredTurns: Set<string>
      owner?: NativeRecoveryOwner
    }
  >()
  private durableOpening = 0
  private catalogGeneration = 0
  private codexCatalogGeneration = 0
  private catalogIdentity?: string
  constructor(
    private ssh: SSHConnection,
    private emit: (event: AgentEvent) => unknown,
    private nativeRecovery?: NativeRecoveryStoreHandle,
    private recoveryPlatform?: NativeRecoveryPlatformPolicy,
  ) {
    this.recovery = new NativeAgentRecovery(
      nativeRecovery,
      (event) => this.deliverNativeEvent(event),
      (error) => {
        for (const [sessionId, session] of this.sessions)
          if (session.recoveryTransportId === error.path)
            this.markRecoveryUnknown(sessionId, error.message)
      },
    )
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
    ssh.on('state', (state) => {
      if (state.status === 'connected') void this.ensureNativeRecovery().catch(() => {})
    })
  }
  private hasDurableChannels() {
    return (
      (this.nativeRecovery !== undefined && this.pendingCodexAcquisitions.size > 0) ||
      this.durableOpening > 0 ||
      this.freshProviderChannels.size > 0 ||
      this.ownerlessClaudeAttachments.size > 0 ||
      [...this.codexTransports].some((rpc) =>
        Boolean((rpc.channel as DurableChannel).transportState),
      ) ||
      [...this.sessions.values()].some((session) =>
        Boolean((session.channel as DurableChannel | undefined)?.transportState),
      )
    )
  }
  private clearCodexModelCatalogs() {
    this.codexCatalogGeneration++
    this.defaultCodexModel = undefined
    this.codexModels = undefined
    this.codexDefaultEfforts.clear()
    this.codexDefaultTiers.clear()
    this.codexDiskConfig = undefined
    this.codexConfigStarting = undefined
  }
  private clearModelCatalogs() {
    this.catalogGeneration++
    this.clearCodexModelCatalogs()
    this.claudeModels = undefined
    this.claudeModelsStarting = undefined
  }
  /** Browser reconnects can restore live turn state without starting or repeating a request. */
  runningSessionEvents(): AgentEvent[] {
    return [...this.sessions.entries()].flatMap(([sessionId, session]) => {
      if (session.stopRequested) return []
      const events: AgentEvent[] = session.busy
        ? [{ sessionId, type: 'status', status: 'running', provider: session.input.provider }]
        : []
      for (const [agentId, child] of this.childThreads)
        if (child.sessionId === sessionId && child.busy)
          events.push({
            sessionId,
            type: 'subagent',
            provider: 'codex',
            agentId,
            itemId: `agent-${agentId}`,
            agentName: child.agentName,
            title: child.agentName || 'Subagent',
            status: 'running',
            details: { lifecycle: 'turn', nativeTurnId: child.turnId },
          })
      return events
    })
  }
  private readonly recoveryPlatformEffect = Effect.fnUntraced(
    function* (this: Agents) {
      return this.recoveryPlatform
        ? yield* validateNativeRecoveryPlatformPolicyEffect(this.recoveryPlatform)
        : undefined
    }.bind(this),
  )
  private readonly freshProviderSupportEffect = Effect.fnUntraced(
    function* (this: Agents) {
      const policy = yield* this.recoveryPlatformEffect()
      if (policy)
        yield* policy.assertFreshSshStartEffect(this.ssh.state.profile?.transport || 'ssh')
    }.bind(this),
  )
  private readonly nativeRecoverySupportEffect = Effect.fnUntraced(
    function* (this: Agents, operation: string) {
      const policy = yield* this.recoveryPlatformEffect()
      if (policy) yield* policy.assertNativeRecoveryEffect(operation)
    }.bind(this),
  )
  private channelHasPendingDelivery(channel: DurableChannel | undefined) {
    return Boolean(
      channel &&
      (channel.hasUnconfirmedRecoveryInputs || (!channel.recoveryId && channel.hasPendingDelivery)),
    )
  }
  private assertProviderRetirement(provider: Provider, machine = this.machineIdentity()) {
    if (
      [...this.pendingProviderExits.values()].some(
        (owner) => owner.provider === provider && owner.machine === machine,
      )
    )
      throw this.recoveryError(
        'closing',
        'The previous provider has not produced its native exit. Life did not open a replacement writer.',
      )
  }
  private async providerChannel(
    command: string,
    onOpening?: (channel: ClientChannel) => void,
    provider: Provider = 'codex',
    expectedMachine = this.machineIdentity(),
  ): Promise<ClientChannel> {
    await runEffect(this.freshProviderSupportEffect())
    if (this.ssh.state.status !== 'connected' || this.machineIdentity() !== expectedMachine)
      throw new Error('The connected machine changed before provider allocation')
    const durable = this.ssh as SSHConnection & {
      durableChannel?: (
        command: string,
        onOpening?: (channel: ClientChannel) => void,
        provider?: Provider,
      ) => Promise<ClientChannel>
    }
    const machine = this.machineIdentity()
    this.assertProviderRetirement(provider, machine)
    if (!durable.durableChannel) return this.ssh.channel(command)
    const failed = [...this.failedFreshProviders.values()].find(
      (claim) => claim.machine === machine && claim.provider === provider,
    )
    if (failed) throw this.recoveryError('opening', failed.message)
    let opening: DurableChannel | undefined
    this.durableOpening++
    try {
      return await durable.durableChannel(
        command,
        (channel) => {
          opening = channel as DurableChannel
          const id = opening.sessionId || opening.recoveryId
          if (this.nativeRecovery && id)
            this.freshProviderChannels.set(id, { channel: opening, machine, provider })
          onOpening?.(channel)
        },
        provider,
      )
    } catch (cause) {
      if (opening) await this.failFreshProviderChannel(opening, cause)
      throw cause
    } finally {
      this.durableOpening--
    }
  }
  private adoptFreshProviderChannel(channel: DurableChannel) {
    for (const [id, claim] of this.freshProviderChannels)
      if (claim.channel === channel) this.freshProviderChannels.delete(id)
  }
  private clearFreshProviderFailure(id: string) {
    const failed = this.failedFreshProviders.get(id)
    if (failed && this.recoveryFailures.get(`transport:${failed.machine}`) === failed.message)
      this.recoveryFailures.delete(`transport:${failed.machine}`)
    const initializing = this.recoveringCodexInitialization.has(id)
      ? this.deferredRecoveryAttachments.get(id)
      : undefined
    if (
      initializing &&
      this.recoveryFailures.get(`transport:${initializing.machine}`) ===
        'The original native initialization has not been proven complete. Life did not initialize a replacement connection.'
    )
      this.recoveryFailures.delete(`transport:${initializing.machine}`)
    this.failedFreshProviders.delete(id)
  }
  private readonly failFreshProviderChannelEffect = Effect.fn('Agents.failFreshProviderChannel')(
    function* (this: Agents, channel: DurableChannel, cause: unknown) {
      const fresh = [...this.freshProviderChannels].find(([, claim]) => claim.channel === channel)
      if (!fresh) return
      const [id, claim] = fresh
      let attachmentClosed =
        channel.destroyed || channel.closed || channel.transportState === 'closed'
      const closedDuringRead = () => {
        attachmentClosed = true
      }
      channel.once('close', closedDuringRead)
      let absenceProven = false
      const registered = channel.recoveryId === id || channel.recoveryDescriptor?.id === id
      const snapshot = yield* this.nativeRecovery!.readTransport(id).pipe(
        Effect.catch(() =>
          registered
            ? Effect.succeed(undefined)
            : this.nativeRecovery!.listTransports().pipe(
                Effect.map((snapshots) => {
                  const found = snapshots.find((value) => value.transport.id === id)
                  absenceProven = !found
                  return found
                }),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
        ),
      )
      if (
        (!snapshot && !absenceProven) ||
        (snapshot && !snapshot.outputs.some(isConfirmedNativeExit))
      )
        this.failedFreshProviders.set(id, {
          machine: claim.machine,
          provider: claim.provider,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      channel.off('close', closedDuringRead)
      this.recoveryLoaded.delete(id)
      if (
        snapshot?.closeInputSequence !== undefined &&
        !snapshot.outputs.some(isConfirmedNativeExit)
      ) {
        // Its existing close owner must keep observing the original terminal
        // receipt; attachment retirement alone gives no native-exit credit.
        if (
          attachmentClosed ||
          channel.destroyed ||
          channel.closed ||
          channel.transportState === 'closed'
        ) {
          this.adoptFreshProviderChannel(channel)
          return
        }
        const settled = () => this.adoptFreshProviderChannel(channel)
        channel.once('exit', settled)
        channel.once('close', settled)
        return
      }
      yield* Effect.tryPromise({
        try: () => channel.detach?.() || Promise.resolve(),
        catch: (error) =>
          this.recoveryError(
            'opening',
            'The failed original provider attachment could not be detached.',
            error,
          ),
      }).pipe(Effect.ensuring(Effect.sync(() => this.freshProviderChannels.delete(id))))
    }.bind(this),
  )
  private failFreshProviderChannel(channel: DurableChannel, cause: unknown) {
    return runEffect(this.failFreshProviderChannelEffect(channel, cause))
  }
  private observeOwnerlessClaude(id: string, channel: DurableChannel, machine: string) {
    this.removeOwnerlessClaudeObserver(id)
    const drain = (_chunk: Buffer) => {}
    const failed = (cause: Error) => {
      if (
        this.ownerlessClaudeObservers.get(id)?.channel !== channel ||
        this.terminalTransports.has(id)
      )
        return
      this.failedFreshProviders.set(id, {
        machine,
        provider: 'claude',
        message: cause.message || 'The original ownerless Claude attachment remains unknown.',
      })
    }
    const cleanup = () => {
      channel.off('data', drain)
      channel.stderr.off('data', drain)
      channel.off('error', failed)
      channel.off('close', cleanup)
      if (this.ownerlessClaudeObservers.get(id)?.channel === channel)
        this.ownerlessClaudeObservers.delete(id)
    }
    this.ownerlessClaudeObservers.set(id, { channel, cleanup })
    channel.on('data', drain)
    channel.stderr.on('data', drain)
    channel.on('error', failed)
    channel.once('close', cleanup)
  }
  private removeOwnerlessClaudeObserver(id: string) {
    this.ownerlessClaudeObservers.get(id)?.cleanup()
  }
  private transportEvents(channel: ClientChannel, sessions: () => [string, Session][]) {
    channel.on('input-receipt', (receipt: NativeRecoveryInputReceipt) => {
      const id = (channel as DurableChannel).recoveryId
      if (!id || !this.nativeRecovery) return
      const operation = this.receiveNativeInputReceipt(id, receipt).catch((cause) => {
        for (const [sessionId] of sessions())
          this.markRecoveryUnknown(
            sessionId,
            cause instanceof Error ? cause.message : String(cause),
          )
      })
      this.pendingReceiptReconciliations.add(operation)
      void operation
        .finally(() => this.pendingReceiptReconciliations.delete(operation))
        .catch(() => {})
    })
    channel.on('exit', () => {
      const id = (channel as DurableChannel).recoveryId
      if (id) {
        this.terminalTransports.add(id)
        this.reduceNativeExit(id, (channel as DurableChannel).outputCursor ?? 0, sessions())
        this.queueRecoveredStops(id)
      }
    })
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
  private hasPendingNativeDecision(sessionId: string, requestId?: string) {
    return [...this.pendingRecoveryDecisions.values()].some((entries) =>
      [...entries.values()].some(
        ({ input }) =>
          input.semantic.sessionId === sessionId &&
          (requestId === undefined ||
            object(input.semantic.responseBinding).requestId === requestId),
      ),
    )
  }
  private receiptInputOwner(
    snapshot: NativeRecoverySnapshot,
    input: NativeRecoveryStoredInput,
  ): NativeRecoveryOwnerStamp | undefined {
    const binding = object(input.semantic.responseBinding)
    const generation = input.semantic.ownerGeneration ?? 0
    const recorded = snapshot.events.find(
      (event) =>
        event.event.sessionId === input.semantic.sessionId &&
        event.event.requestId === binding.requestId &&
        ['approval', 'question'].includes(string(event.event.type)),
    )
    const native = object(recorded?.event.nativeRecovery)
    if (string(native.snapshotToken))
      return {
        generation:
          typeof native.ownerGeneration === 'number' ? native.ownerGeneration : generation,
        snapshotToken: string(native.snapshotToken),
        localTurn: typeof native.localTurn === 'number' ? native.localTurn : 0,
      }
    const owners = snapshot.records.flatMap((record) =>
      record.kind === 'create'
        ? [...record.transport.owners]
        : record.kind === 'transport'
          ? [...(record.patch.owners || [])]
          : [],
    )
    return owners
      .reverse()
      .find(
        (owner) => owner.sessionId === input.semantic.sessionId && owner.generation === generation,
      )
  }
  private readonly receiveNativeInputReceiptEffect = Effect.fn('Agents.receiveNativeInputReceipt')(
    function* (this: Agents, id: string, receipt: NativeRecoveryInputReceipt) {
      const snapshot = yield* this.nativeRecovery!.readTransport(id)
      const input = snapshot.inputs.find((input) => input.sequence === receipt.sequence)
      if (
        !input ||
        input.deliveryReceipt?.cursor !== receipt.cursor ||
        input.deliveryReceipt.status !== receipt.status
      )
        return yield* this.recoveryError(
          'input-receipt',
          'The native delivery receipt is not committed to its exact original input.',
        )
      yield* Effect.try({
        try: () => {
          this.recoverySnapshots.set(id, snapshot)
          this.foldNativeInputReceipt(id, receipt, input, this.receiptInputOwner(snapshot, input))
        },
        catch: (cause) =>
          this.recoveryError(
            'input-receipt',
            'The original native delivery receipt could not be reconstructed.',
            cause,
          ),
      })
      yield* this.recovery.flushEffect()
      if (!this.replayingTransports.has(id)) {
        yield* this.reconcileNativeAttachmentEffect(id)
        this.queueRecoveredStops(id)
        this.queueRecoveredStarts(id)
      }
    }.bind(this),
  )
  private receiveNativeInputReceipt(id: string, receipt: NativeRecoveryInputReceipt) {
    return runEffect(this.receiveNativeInputReceiptEffect(id, receipt))
  }
  private foldNativeInputReceipt(
    id: string,
    receipt: NativeRecoveryInputReceipt,
    input: NativeRecoveryStoredInput,
    owner?: NativeRecoveryOwnerStamp,
  ) {
    if (receipt.status === 'written') {
      if (['permission-response', 'initialize'].includes(input.semantic.kind))
        this.foldRecoveryInput(id, input, true, owner, receipt.cursor)
      return
    }
    for (const [sessionId, session] of this.sessions)
      if (session.recoveryTransportId === id) {
        const message = `A native input receipt reported ${receipt.status} delivery. Life retained the original provider owner.`
        this.nativeDeliveryFailures.set(sessionId, { transportId: id, message })
        this.markRecoveryUnknown(sessionId, message)
        this.recovery.event(
          id,
          { sessionId, type: 'status', status: 'unknown', text: message },
          this.recoveryStamp(session),
          {
            replay: this.replayingTransports.has(id),
            outputCursor: receipt.cursor,
            eventId: `${id}:output:${receipt.cursor}:input-${receipt.status}:${sessionId}`,
          },
        )
      }
  }
  private event(
    sessionId: string,
    event: Omit<AgentEvent, 'sessionId'>,
    owner?: NativeRecoveryOwnerStamp,
  ) {
    const session = this.sessions.get(sessionId)
    const id = session?.recoveryTransportId
    if (id)
      this.recovery.event(
        id,
        { sessionId, ...event },
        owner ||
          (event.agentId
            ? this.childThreads.get(event.agentId)?.owner ||
              session?.claudeActiveChildren?.get(event.agentId)?.owner
            : undefined) ||
          this.recoveryStamp(session!),
        this.terminalEmission.has(id)
          ? {
              outputCursor: this.terminalEmission.get(id),
              replay: this.replayingTransports.has(id),
              eventId: `${id}:output:${this.terminalEmission.get(id)}:exit:${sessionId}:${event.type}:${event.requestId || event.agentId || event.itemId || 'root'}`,
            }
          : undefined,
      )
    else this.emit({ sessionId, ...event })
  }
  private deliverNativeEvent(event: AgentEvent, recoveryReplay = false) {
    if (this.rendererSuspended || this.recoveryConsumerFailures.has(event.sessionId)) return false
    if (this.recoveryAdmissionDepth && !recoveryReplay) {
      this.recoveryAdmissionEvents.push(event)
      return false
    }
    const session = this.sessions.get(event.sessionId)
    const ownerStatus =
      !session || session.recoveryUnknown || this.recoveryFailures.has(event.sessionId)
        ? ('unknown' as const)
        : this.recoveredStarts.has(event.sessionId) ||
            this.hasPendingNativeDecision(event.sessionId) ||
            this.hasDeferredNativeAttachment(session) ||
            (session.recoveryTransportId &&
              this.replayingTransports.has(session.recoveryTransportId))
          ? ('recovering' as const)
          : session.busy ||
              this.hasCodexChildren(event.sessionId) ||
              session.claudeActiveChildren?.size ||
              session.approvals.size ||
              session.startup
            ? ('running' as const)
            : ('idle' as const)
    return (
      this.emit(
        event.nativeRecovery
          ? { ...event, nativeRecovery: { ...event.nativeRecovery, ownerStatus } }
          : event,
      ) !== false
    )
  }
  private machineIdentity() {
    const profile = this.ssh.state.profile
    return profile ? nativeMachineIdentity(profile) : 'test-machine'
  }
  private assertEnvironmentAdmission(machine = this.machineIdentity()) {
    if (this.environmentChanges.has(machine))
      throw new AgentEnvironmentError({
        reason: 'changed',
        message: 'The selected environment is changing. Try again when it returns.',
        cause: undefined,
      })
  }
  private readonly providerDiscoveryEffect = Effect.fn('Agents.providerDiscovery')(function* (
    this: Agents,
  ) {
    if (this.ssh.state.providerVersionsStatus !== 'checking') return
    const owner = this.machineIdentity()
    yield* Effect.tryPromise({
      try: () => this.ssh.whenProviderVersionsReady(),
      catch: (cause) =>
        new AgentEnvironmentError({
          reason: 'discovery',
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })
    if (this.ssh.state.status !== 'connected' || this.machineIdentity() !== owner)
      return yield* new AgentEnvironmentError({
        reason: 'changed',
        message: 'The environment changed while checking installed providers.',
        cause: undefined,
      })
  })
  private reduceNativeExit(id: string, cursor: number, entries: [string, Session][]) {
    this.clearFreshProviderFailure(id)
    this.ownerlessClaudeAttachments.delete(id)
    this.deferredRecoveryAttachments.delete(id)
    this.recoveringCodexInitialization.delete(id)
    this.terminalTransports.add(id)
    this.terminalEmission.set(id, cursor)
    try {
      for (const [sessionId, session] of entries) {
        if (session.recoveryTransportId !== id) continue
        const deliveryFailure = this.nativeDeliveryFailures.get(sessionId)
        if (
          deliveryFailure?.transportId === id &&
          this.recoveryFailures.get(sessionId) === deliveryFailure.message
        ) {
          this.nativeDeliveryFailures.delete(sessionId)
          this.recoveryFailures.delete(sessionId)
          session.recoveryUnknown = false
        }
        this.pendingRecoveryDecisions.get(id)?.clear()
        for (const pending of session.controls.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('The original native process exited.'))
        }
        session.controls.clear()
        if (session.input.provider === 'claude') {
          this.resolveClaudeRequests(sessionId, session, undefined, 'provider-resolved')
          this.finishClaudeChildren(
            sessionId,
            session,
            session.stopRequested ? 'interrupted' : 'failed',
          )
        } else {
          this.resolveCodexRequests(sessionId, session)
          this.finishCodexChildren(
            sessionId,
            session,
            session.stopRequested ? 'interrupted' : 'failed',
          )
        }
        if (
          this.recoveryFailures.get(sessionId) ===
          'Native termination has not been observed. Life preserved the original provider owner.'
        ) {
          session.recoveryUnknown = false
          this.recoveryFailures.delete(sessionId)
        }
        if (session.stopRequested) {
          session.busy = false
          // Terminal output settles the explicitly recorded Stop even after a
          // close timeout. It never certifies a previously corrupt parser.
          if (this.recoveredStops.has(sessionId)) {
            session.recoveryUnknown = false
            this.recoveryFailures.delete(sessionId)
          }
          this.emitStopped(session)
        } else if (session.busy) {
          session.busy = false
          this.event(sessionId, {
            type: 'error',
            text: session.stderr || 'The native process exited before completing its turn.',
          })
        }
      }
    } finally {
      this.terminalEmission.delete(id)
      for (const rpc of this.codexTransports)
        if ((rpc.channel as DurableChannel).recoveryId === id)
          this.forgetRetiredCodex(rpc.channel as DurableChannel)
    }
  }
  private emitStopped(session: Session) {
    const id = session.recoveryTransportId
    if (id)
      this.recovery.event(
        id,
        { sessionId: session.input.sessionId, type: 'complete', status: 'interrupted' },
        this.recoveryStamp(session),
        {
          replay: this.replayingTransports.has(id),
          eventId: `${id}:stop:${session.recoveryGeneration}:${session.recoverySnapshotToken}:complete`,
        },
      )
    else this.event(session.input.sessionId, { type: 'complete', status: 'interrupted' })
  }
  private refreshModelCatalogIdentity() {
    const identity = JSON.stringify([
      this.machineIdentity(),
      this.ssh.state.codex || '',
      this.ssh.state.claude || '',
    ])
    if (this.catalogIdentity !== undefined && this.catalogIdentity !== identity)
      this.clearModelCatalogs()
    this.catalogIdentity = identity
  }
  private recoveryError(operation: string, message: string, cause?: unknown) {
    return new NativeRecoveryError({
      operation,
      path: 'agents',
      reason: 'uncertain',
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  }
  private recoveryStamp(session: Session): NativeRecoveryOwnerStamp {
    return {
      generation: session.recoveryGeneration ?? 0,
      ...(session.recoverySnapshotToken ? { snapshotToken: session.recoverySnapshotToken } : {}),
      localTurn: session.input.localTurn ?? 0,
    }
  }
  private recoveryMachine(snapshot: NativeRecoverySnapshot) {
    const machine = snapshot.transport.machine
    return machine.transport === 'local'
      ? JSON.stringify(['local', machine.profileId])
      : JSON.stringify([machine.host, machine.port, machine.username])
  }
  private recoveryOwner(session: Session): NativeRecoveryOwner {
    return {
      ownerId: session.input.sessionId,
      sessionId: session.input.sessionId,
      kind: 'root',
      workspace: session.workspace,
      writableRoot: session.writableRoot,
      generation: session.recoveryGeneration ?? 0,
      localTurn: session.input.localTurn ?? 0,
      snapshotToken: session.recoverySnapshotToken,
      phase: session.phase,
      stopRequested: session.stopRequested,
      ignoredTurns: [...session.ignoredTurns],
      ...(session.claudeRestartForSettings === undefined
        ? {}
        : { claudeRestartForSettings: session.claudeRestartForSettings }),
      ...(session.nativeStartIntentId === undefined
        ? {}
        : { nativeStartIntentId: session.nativeStartIntentId }),
      ...(session.nativeStartPlan === undefined
        ? {}
        : { nativeStartPlan: JSON.parse(JSON.stringify(session.nativeStartPlan)) }),
      ...(session.input.provider === 'codex' && session.remoteId
        ? { nativeThreadId: session.remoteId }
        : {}),
      ...(session.input.provider === 'claude' && session.remoteId
        ? { nativeSessionId: session.remoteId }
        : {}),
      ...(session.turnId ? { nativeTurnId: session.turnId } : {}),
      state: session.recoveryUnknown
        ? 'unknown'
        : session.busy
          ? session.phase === 'initializing'
            ? 'starting'
            : 'active'
          : 'idle',
      input: JSON.parse(JSON.stringify(session.input)),
      ...(session.input.clientRecovery === undefined
        ? {}
        : { clientRecovery: JSON.parse(JSON.stringify(session.input.clientRecovery)) }),
    }
  }
  private async recordRecoveryOwner(session: Session, channel: ClientChannel) {
    const durable = channel as DurableChannel
    if (!durable.recoveryId || !durable.recordOwner) return
    session.recoveryTransportId = durable.recoveryId
    session.recoverySnapshotToken ??= randomUUID()
    try {
      await runEffect(
        this.recovery.updateOwnerEffect(durable.recoveryId, this.recoveryOwner(session)),
      )
    } catch (cause) {
      await this.failFreshProviderChannel(durable, cause)
      throw cause
    }
    this.recoveryLoaded.add(durable.recoveryId)
    this.adoptFreshProviderChannel(durable)
    const reservation = this.recoveryReservations.get(session.input.sessionId)
    if (
      reservation &&
      reservation.transport.id !== durable.recoveryId &&
      session.nativeStartIntentId
    ) {
      const owner = reservation.transport.owners.find(
        (value) => value.kind === 'root' && value.sessionId === session.input.sessionId,
      )!
      await runEffect(
        this.recovery.updateOwnerEffect(reservation.transport.id, {
          ...owner,
          linkedTransportId: durable.recoveryId,
          nativeStartIntentId: session.nativeStartIntentId,
          nativeStartClaimed: true,
        }),
      )
      this.recoveryReservations.delete(session.input.sessionId)
    }
  }
  private recoverySemantic(
    session: Session,
    kind: NativeRecoveryInputSemantic['kind'],
    extra: Partial<NativeRecoveryInputSemantic> = {},
  ): NativeRecoveryInputSemantic {
    return {
      kind,
      sessionId: session.input.sessionId,
      ownerGeneration: session.recoveryGeneration ?? 0,
      ...(session.remoteId ? { nativeThreadId: session.remoteId } : {}),
      ...(session.turnId ? { nativeTurnId: session.turnId } : {}),
      ...extra,
    }
  }
  private writeClaude(session: Session, message: Wire, semantic: NativeRecoveryInputSemantic) {
    const channel = session.channel as DurableChannel | undefined
    if (!channel || channel.destroyed) throw new Error('Claude Code is disconnected')
    if (channel.writeNative) channel.writeNative(message, semantic)
    else channel.write(JSON.stringify(message) + '\n')
  }
  private async writeClaudeAndWait(
    session: Session,
    message: Wire,
    semantic: NativeRecoveryInputSemantic,
  ) {
    const channel = session.channel as DurableChannel | undefined
    if (!channel || channel.destroyed) throw new Error('Claude Code is disconnected')
    if (channel.writeNativeAndWait) await channel.writeNativeAndWait(message, semantic)
    else this.writeClaude(session, message, semantic)
  }
  private assertRecovered(sessionId: string, nativeStop = false, metadata = false) {
    if (this.recovery.failure) throw this.recovery.failure
    const session = this.sessions.get(sessionId)
    if (
      (!nativeStop && this.rendererSuspended) ||
      (session?.recoveryTransportId && this.replayingTransports.has(session.recoveryTransportId))
    )
      throw this.recoveryError(
        'mutation',
        'Native controls are disabled during recovery replay or renderer suspension.',
      )
    const channel = (
      session?.input.provider === 'codex' ? session.codexRPC?.channel : session?.channel
    ) as DurableChannel | undefined
    if (
      channel?.isClosing &&
      channel.recoveryId &&
      !this.terminalTransports.has(channel.recoveryId)
    )
      throw this.recoveryError(
        'closing',
        'The original native process is still closing. Wait for its terminal receipt before changing this conversation.',
      )
    if (
      !nativeStop &&
      !metadata &&
      (channel?.hasUnconfirmedRecoveryInputs ||
        (session?.recoveryTransportId &&
          this.recoveringCodexInitialization.has(session.recoveryTransportId)))
    )
      throw this.recoveryError(
        'delivery',
        'The original native input is awaiting its exact delivery or processing proof. Native controls remain read-only.',
      )
    if (!nativeStop && !metadata && this.hasPendingNativeDecision(sessionId))
      throw this.recoveryError(
        'permission',
        'An original native permission decision is awaiting actual delivery. Life did not allocate a replacement response.',
      )
    const failure = this.recoveryFailures.get('*') || this.recoveryFailures.get(sessionId)
    if (
      failure ||
      this.sessions.get(sessionId)?.recoveryUnknown ||
      (!nativeStop && this.recoveryConsumerFailures.has(sessionId))
    )
      throw this.recoveryError(
        'mutation',
        failure ||
          'The native owner is unknown. Recover its original transport before changing this conversation.',
      )
  }
  private restoreOwner(
    owner: NativeRecoveryOwner,
    snapshot: NativeRecoverySnapshot,
    rpc?: RPC,
    channel?: ClientChannel,
  ) {
    if (owner.kind === 'child') {
      if (rpc && owner.nativeThreadId && owner.parentSessionId)
        this.childThreads.set(owner.nativeThreadId, {
          sessionId: owner.parentSessionId,
          rpc,
          busy: owner.state === 'starting' || owner.state === 'active',
          turnId: owner.nativeTurnId,
          ignoredTurns: new Set(),
          owner,
        })
      return
    }
    const prior = this.sessions.get(owner.sessionId)
    if (
      prior?.recoveryTransportId !== snapshot.transport.id &&
      (prior?.recoveryGeneration ?? -1) > (owner.generation ?? 0)
    )
      return
    const same =
      prior?.recoveryTransportId === snapshot.transport.id &&
      prior.recoveryGeneration === (owner.generation ?? 0) &&
      prior.recoverySnapshotToken === owner.snapshotToken
    const fresh: Session = {
      input: owner.input as unknown as StartInput,
      machineIdentity: this.recoveryMachine(snapshot),
      busy: owner.state === 'starting' || owner.state === 'active',
      streamed: new Set(),
      stderr: '',
      approvals: new Map(
        [...(prior?.approvals || [])].filter(([, approval]) =>
          snapshot.transport.provider === 'codex'
            ? this.childThreads.has(string(approval.params.threadId))
            : Boolean(approval.params.parent_tool_use_id || approval.params.agent_id),
        ),
      ),
      initialization: new AbortController(),
      stopRequested: false,
      ignoredTurns: new Set(),
      controls: new Map(),
      workspace: owner.workspace,
      writableRoot: owner.writableRoot || owner.workspace,
      itemPhases: new Map(),
      claudeMessageIds: prior?.claudeMessageIds || new Map(),
      claudeAgentNames: prior?.claudeAgentNames || new Map(),
      claudeActiveChildren: prior?.claudeActiveChildren || new Map(),
      claudeTaskRuns: prior?.claudeTaskRuns || new Map(),
      phase: 'initializing',
      remoteId: undefined,
      turnId: undefined,
      messageId: undefined,
      claudeResult: undefined,
      claudeReply: undefined,
    }
    const session = same
      ? prior!
      : prior?.recoveryTransportId === snapshot.transport.id
        ? Object.assign(prior, fresh)
        : fresh
    session.recoveryTransportId = snapshot.transport.id
    session.recoveryGeneration = owner.generation ?? 0
    session.recoverySnapshotToken = owner.snapshotToken
    session.recoveryUnknown = owner.state === 'unknown'
    if (owner.state !== 'unknown')
      session.busy = owner.state === 'starting' || owner.state === 'active'
    session.stopRequested = owner.stopRequested ?? false
    session.claudeRestartForSettings = owner.claudeRestartForSettings
    session.nativeStartIntentId = owner.nativeStartIntentId
    session.nativeStartPlan = owner.nativeStartPlan as Wire | undefined
    session.ignoredTurns = new Set(owner.ignoredTurns || session.ignoredTurns)
    session.phase = owner.phase || session.phase
    session.input = owner.input as unknown as StartInput
    if (owner.clientRecovery !== undefined)
      session.input = { ...session.input, clientRecovery: owner.clientRecovery }
    session.remoteId = owner.nativeThreadId || owner.nativeSessionId || session.remoteId
    session.turnId = owner.nativeTurnId || session.turnId
    if (snapshot.transport.provider === 'claude')
      session.claudeUsageCallId = `${snapshot.transport.id}:generation:${session.recoveryGeneration}`
    if (rpc) session.codexRPC = rpc
    if (channel) session.channel = channel
    this.sessions.set(owner.sessionId, session)
    if (!same && snapshot.transport.provider === 'claude') {
      const blocks = claudeMessageBlocks.get(session)
      if (blocks) blocks.resetRoot()
      else claudeMessageBlocks.set(session, new ClaudeMessageBlocks())
    }
    if (rpc && session.remoteId) {
      this.threads.set(session.remoteId, owner.sessionId)
      this.threadTransports.set(session.remoteId, rpc)
    }
  }
  private permissionReplayKey(
    wireId: unknown,
    sessionId: string,
    generation: number,
    params: Wire,
    ordinal?: number,
  ) {
    return JSON.stringify([
      typeof wireId,
      wireId,
      sessionId,
      generation,
      params.threadId || params.agent_id || params.parent_tool_use_id || '',
      params.turnId || params.tool_use_id || params.itemId || '',
      ordinal ?? null,
    ])
  }
  private permissionLocalId(
    session: Session,
    wireId: unknown,
    base: string,
    ordinal: number,
    params: Wire,
    method: string,
  ) {
    for (const [requestId, approval] of session.approvals)
      if (approval.wireId === wireId) {
        const same = approval.method === method && isDeepStrictEqual(approval.params, params)
        if (same) return requestId
        const responding =
          this.pendingPermissionResponses.has(
            JSON.stringify([session.input.sessionId, requestId]),
          ) || this.hasPendingNativeDecision(session.input.sessionId, requestId)
        if (!responding)
          throw this.recoveryError(
            'permission',
            'The native provider reused an unresolved permission ID for a different request.',
          )
      }
    const transport =
      session.recoveryTransportId || `legacy:${session.input.provider}:${session.input.sessionId}`
    const issued = this.permissionOccurrenceIds.get(transport) || new Set<string>()
    let requestId = base
    if (issued.has(requestId)) requestId = `${base}:wire:${ordinal}`
    let collision = 0
    while (issued.has(requestId)) requestId = `${base}:wire:${ordinal}:${++collision}`
    issued.add(requestId)
    this.permissionOccurrenceIds.set(transport, issued)
    return requestId
  }
  private isAnsweredReplayPermission(
    transport: string,
    wireId: unknown,
    sessionId: string,
    generation: number,
    params: Wire,
    ordinal: number,
  ) {
    if (!this.replayingTransports.has(transport)) return false
    const resolved = this.replayResolved.get(transport)
    return Boolean(
      resolved?.has(this.permissionReplayKey(wireId, sessionId, generation, params, ordinal)) ||
      resolved?.has(this.permissionReplayKey(wireId, sessionId, generation, params)),
    )
  }
  private publicRecoveryInput(owner: NativeRecoveryOwner): StartInput {
    const input = owner.input as unknown as StartInput
    return input?.scope === 'life-customization' ? { ...input, workspace: owner.workspace } : input
  }
  private foldRecoveryInput(
    id: string,
    input: NativeRecoveryStoredInput,
    fromReceipt = false,
    receiptOwner?: NativeRecoveryOwnerStamp,
    receiptCursor?: number,
  ) {
    const semantic = input.semantic
    if (semantic.requestId !== undefined && semantic.kind !== 'permission-response')
      this.replayInputs.get(id)?.set(semantic.requestId, input)
    if (input.cancellation && !input.written && semantic.kind !== 'permission-response') return
    if (semantic.kind === 'initialize') {
      const initialization = this.replayInitialization.get(id)
      if (initialization) {
        if (semantic.method === 'initialize') initialization.requestId = semantic.requestId
        if (semantic.method === 'initialized' && input.written) initialization.initialized = true
      }
    }
    const session = semantic.sessionId ? this.sessions.get(semantic.sessionId) : undefined
    if (
      !session ||
      session.recoveryTransportId !== id ||
      (semantic.ownerGeneration !== undefined &&
        semantic.ownerGeneration !== session.recoveryGeneration &&
        semantic.kind !== 'permission-response' &&
        semantic.kind !== 'interrupt')
    )
      return
    if (semantic.kind === 'user-prompt') {
      session.busy = true
      session.phase = semantic.method === 'turn/start' ? 'startingTurn' : 'running'
      if (session.input.provider === 'claude') {
        claudeMessageBlocks.get(session)?.resetRoot()
        session.claudeMessageIds.delete('root')
        session.claudeResult = undefined
        session.claudeReply = undefined
      }
    }
    if (semantic.kind === 'permission-response' && semantic.permissionRequestId !== undefined) {
      const binding = object(semantic.responseBinding)
      const originalOwner = session.approvals.get(string(binding.requestId))?.owner || receiptOwner
      const decisions =
        this.pendingRecoveryDecisions.get(id) ||
        new Map<number, { input: NativeRecoveryStoredInput; owner?: NativeRecoveryOwnerStamp }>()
      this.pendingRecoveryDecisions.set(id, decisions)
      if (!fromReceipt) {
        decisions.set(input.sequence, {
          input,
          owner: originalOwner || this.recoveryStamp(session),
        })
        return
      }
      if (!input.written) return
      const decisionOwner = decisions.get(input.sequence)?.owner || originalOwner
      decisions.delete(input.sequence)
      const key = this.permissionReplayKey(
        semantic.permissionRequestId,
        session.input.sessionId,
        semantic.ownerGeneration ?? 0,
        object(binding.params),
        typeof binding.wireOrdinal === 'number' ? binding.wireOrdinal : undefined,
      )
      this.replayResolved.get(id)?.add(key)
      for (const [localId, approval] of session.approvals)
        if (
          approval.wireId === semantic.permissionRequestId &&
          (string(binding.requestId)
            ? localId === binding.requestId
            : approval.owner?.generation === semantic.ownerGeneration)
        )
          session.approvals.delete(localId)
      if (string(binding.requestId))
        this.recovery.event(
          id,
          {
            sessionId: session.input.sessionId,
            type: 'request-resolved',
            requestId: string(binding.requestId),
            status: string(binding.status) || 'provider-resolved',
            ...(binding.details ? { details: binding.details } : {}),
          },
          decisionOwner || this.recoveryStamp(session),
          {
            replay: this.replayingTransports.has(id),
            outputCursor: receiptCursor ?? this.replayOutputCursors.get(id) ?? 0,
            eventId: `${id}:input:${input.sequence}:request-resolved`,
          },
        )
    }
    if (semantic.kind === 'interrupt') {
      session.stopRequested = true
      if (semantic.nativeTurnId) session.ignoredTurns.add(semantic.nativeTurnId)
      const child = semantic.nativeThreadId
        ? this.childThreads.get(semantic.nativeThreadId)
        : undefined
      if (child?.turnId) child.ignoredTurns.add(child.turnId)
    }
  }
  private hasDeferredNativeAttachment(session: Session) {
    const channel = (
      session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
    ) as DurableChannel | undefined
    return Boolean(
      channel?.hasUnconfirmedRecoveryInputs ||
      (session.recoveryTransportId &&
        this.recoveringCodexInitialization.has(session.recoveryTransportId)),
    )
  }
  private readonly reconcileNativeAttachmentEffect = Effect.fn('Agents.reconcileNativeAttachment')(
    function* (this: Agents, id: string) {
      const attachment = this.deferredRecoveryAttachments.get(id)
      if (
        !attachment ||
        this.replayingTransports.has(id) ||
        attachment.channel.hasUnconfirmedRecoveryInputs
      )
        return
      const initialized = this.replayInitialization.get(id)
      if (attachment.rpc && (!initialized?.response || !initialized.initialized)) return
      if (attachment.rpc && this.recoveringCodexInitialization.has(id)) {
        yield* this.nativeRecovery!.updateTransport(id, { initialization: { status: 'complete' } })
        this.recoveringCodexInitialization.delete(id)
        const failureKey = `transport:${attachment.machine}`
        if (
          this.recoveryFailures.get(failureKey) ===
          'The original native initialization has not been proven complete. Life did not initialize a replacement connection.'
        )
          this.recoveryFailures.delete(failureKey)
        this.codexByMachine.set(attachment.machine, attachment.rpc)
      }
      for (const session of this.sessions.values())
        if (session.recoveryTransportId === id && !session.recoveryUnknown)
          yield* Effect.tryPromise({
            try: () => this.recordRecoveryOwner(session, attachment.channel),
            catch: (cause) =>
              this.recoveryError(
                'owner',
                'The verified native owner state could not be persisted.',
                cause,
              ),
          })
      yield* Effect.tryPromise({
        try: () => attachment.channel.activateRecoveryInputs?.() || Promise.resolve(),
        catch: (cause) =>
          this.recoveryError(
            'activate',
            'The original native input attachment could not be activated.',
            cause,
          ),
      })
      this.deferredRecoveryAttachments.delete(id)
      if (
        attachment.channel.transportState === 'connected' &&
        !attachment.channel.isClosing &&
        !attachment.channel.destroyed &&
        (attachment.rpc
          ? !attachment.rpc.closed
          : [...this.sessions.values()].some(
              (session) => session.recoveryTransportId === id && !session.recoveryUnknown,
            ))
      )
        this.clearFreshProviderFailure(id)
      for (const [sessionId, session] of this.sessions)
        if (session.recoveryTransportId === id && !session.recoveryUnknown)
          this.event(sessionId, {
            type: 'status',
            status: 'resumed',
            text: 'The original native input delivery has been verified.',
          })
      yield* this.recovery.flushEffect()
      this.queueRecoveredStops(id)
      this.queueRecoveredStarts(id)
    }.bind(this),
  )
  private queueNativeAttachmentReconciliation(id: string) {
    if (this.replayingTransports.has(id) || !this.deferredRecoveryAttachments.has(id)) return
    const operation = runEffect(this.reconcileNativeAttachmentEffect(id)).catch((cause) => {
      for (const [sessionId, session] of this.sessions)
        if (session.recoveryTransportId === id)
          this.markRecoveryUnknown(
            sessionId,
            cause instanceof Error ? cause.message : String(cause),
          )
    })
    this.pendingReceiptReconciliations.add(operation)
    void operation
      .finally(() => this.pendingReceiptReconciliations.delete(operation))
      .catch(() => {})
  }
  private isNativeCodexResponse(message: Wire) {
    if (
      typeof message.id !== 'number' ||
      !Number.isSafeInteger(message.id) ||
      message.method !== undefined ||
      (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')
    )
      return false
    const result = Object.prototype.hasOwnProperty.call(message, 'result')
    const error = Object.prototype.hasOwnProperty.call(message, 'error')
    if (result === error) return false
    if (error) {
      const failure = object(message.error)
      return Number.isInteger(failure.code) && typeof failure.message === 'string'
    }
    return true
  }
  private hasNativeInputProcessingProof(id: string, input: NativeRecoveryStoredInput) {
    return Boolean(
      this.nativeProcessedInputs.get(id)?.has(input.sequence) &&
      !input.cancellation &&
      !input.deliveryReceipt &&
      input.frame.type === 'write' &&
      input.semantic.requestId !== undefined &&
      input.semantic.kind !== 'permission-response' &&
      input.semantic.method !== 'initialized' &&
      input.semantic.requestType !== 'initialized',
    )
  }
  private confirmNativeInputProcessing(
    channel: DurableChannel,
    input: NativeRecoveryStoredInput | undefined,
  ) {
    if (
      !input ||
      input.deliveryReceipt ||
      !channel.hasUnconfirmedRecoveryInputs ||
      !channel.confirmNativeInputProcessed
    )
      return
    channel.confirmNativeInputProcessed(input.sequence)
    if (channel.recoveryId) {
      const processed = this.nativeProcessedInputs.get(channel.recoveryId) || new Set<number>()
      processed.add(input.sequence)
      this.nativeProcessedInputs.set(channel.recoveryId, processed)
    }
  }
  private orphanCodexResponse(
    id: string,
    rpc: RPC,
    message: Wire,
    originalSemantic?: NativeRecoveryInputSemantic,
  ) {
    this.recovery.beginWire(
      id,
      rpc.receivedMessageSequence,
      this.replayOutputCursors.get(id) ?? (rpc.channel as DurableChannel).outputCursor ?? 0,
      this.replayingTransports.has(id),
    )
    try {
      const input = this.replayInputs.get(id)?.get(message.id as string | number)
      const semantic = originalSemantic || input?.semantic
      if (!semantic || !this.isNativeCodexResponse(message)) return
      this.confirmNativeInputProcessing(rpc.channel as DurableChannel, input)
      if (message.error) return
      if (semantic.kind === 'interrupt') {
        const acknowledged = this.nativeInterruptAcks.get(id) || new Set<string>()
        acknowledged.add(JSON.stringify([semantic.nativeThreadId, semantic.nativeTurnId]))
        this.nativeInterruptAcks.set(id, acknowledged)
      }
      if (semantic.method === 'initialize') {
        const initialization = this.replayInitialization.get(id)
        if (initialization) initialization.response = true
        return
      }
      const session = semantic.sessionId ? this.sessions.get(semantic.sessionId) : undefined
      if (
        !session ||
        session.recoveryTransportId !== id ||
        (semantic.ownerGeneration !== undefined &&
          semantic.ownerGeneration !== session.recoveryGeneration)
      )
        return
      const result = object(message.result)
      if (
        semantic.kind === 'settings' &&
        ['thread/settings/update', 'turn/settings/update'].includes(semantic.method || '')
      ) {
        const reduced = applyNativeCodexSettings({
          session,
          method: semantic.method!,
          details: object(semantic.details),
          result,
          success: true,
        })
        if (reduced.settingsEvent) this.event(session.input.sessionId, reduced.settingsEvent)
      }
      if (semantic.method === 'thread/start' || semantic.method === 'thread/resume') {
        const nativeId = string(object(result.thread).id)
        if (!nativeId || (session.remoteId && session.remoteId !== nativeId))
          throw this.recoveryError(
            'response',
            'The recovered Codex response changed its registered conversation identity.',
          )
        session.remoteId = nativeId
        this.threads.set(nativeId, session.input.sessionId)
        this.threadTransports.set(nativeId, rpc)
        this.event(session.input.sessionId, { type: 'session', remoteId: nativeId })
        this.setProviderTitle(session, string(object(result.thread).name))
      }
      if (semantic.method === 'turn/start') {
        session.turnId = string(object(result.turn).id) || session.turnId
        session.phase = 'running'
      }
    } finally {
      this.recovery.endWire(id)
      if (!this.replayingTransports.has(id)) {
        this.queueNativeAttachmentReconciliation(id)
        this.queueRecoveredStops(id)
        this.queueRecoveredStarts(id)
      }
    }
  }
  private handleCodexWire(message: Wire, rpc: RPC) {
    const id = this.codexRecoveryIds.get(rpc) ?? (rpc.channel as DurableChannel).recoveryId
    if (id)
      this.recovery.beginWire(
        id,
        rpc.receivedMessageSequence,
        this.replayOutputCursors.get(id) ?? (rpc.channel as DurableChannel).outputCursor ?? 0,
        this.replayingTransports.has(id),
      )
    try {
      this.receiveCodex(message, rpc)
    } catch (cause) {
      if (!id || this.replayingTransports.has(id)) throw cause
      const error = cause instanceof Error ? cause : new Error(String(cause))
      for (const [sessionId, session] of this.sessions)
        if (session.recoveryTransportId === id) this.markRecoveryUnknown(sessionId, error.message)
      void rpc.detach(error).catch(() => {})
    } finally {
      if (id) this.recovery.endWire(id)
      if (id && !this.replayingTransports.has(id)) this.queueRecoveredStops(id)
    }
  }
  private async restoreNativeTransport(snapshot: NativeRecoverySnapshot) {
    const id = snapshot.transport.id
    const protocol = snapshot.transport.nativeProtocol
    const virtual = protocol === 'life-studio-planner-v1'
    const expected =
      snapshot.transport.provider === 'codex' ? 'codex-app-server-jsonrpc' : 'claude-stream-json'
    const supportedVersion =
      snapshot.transport.provider === 'codex'
        ? /^(?:codex(?:-cli)?\s+)?0\.162\.1$/i.test(snapshot.transport.providerVersion)
        : /^(?:claude(?:\s+code)?\s+)?2\.1\.278(?: \(Claude Code\))?$/i.test(
            snapshot.transport.providerVersion,
          )
    if ((!virtual && protocol !== expected) || (!virtual && !supportedVersion))
      throw this.recoveryError(
        'protocol',
        'The recorded native protocol or provider version is unsupported. Its process was left untouched.',
      )
    for (const session of this.sessions.values())
      if (session.recoveryTransportId === id) {
        this.claudeParsers.delete(session)
        this.claudeWireSequences.delete(session)
        if (session.input.provider === 'claude')
          claudeMessageBlocks.set(session, new ClaudeMessageBlocks())
        session.recoveryGeneration = undefined
        session.recoverySnapshotToken = undefined
      }
    if (!virtual) {
      for (const [sessionId, session] of this.sessions)
        if (session.recoveryTransportId === id) this.sessions.delete(sessionId)
      for (const [threadId, transport] of this.threadTransports)
        if (this.codexRecoveryIds.get(transport) === id) {
          this.threadTransports.delete(threadId)
          this.threads.delete(threadId)
        }
      for (const [threadId, child] of this.childThreads)
        if (this.codexRecoveryIds.get(child.rpc) === id) this.childThreads.delete(threadId)
    }
    this.recovery.seed(snapshot)
    this.recoverySnapshots.set(id, snapshot)
    this.replayInputs.set(id, new Map())
    this.replayResolved.set(id, new Set())
    this.pendingRecoveryDecisions.set(id, new Map())
    this.permissionOccurrenceIds.set(id, new Set())
    this.replayInitialization.set(id, { response: false, initialized: false })
    this.nativeProcessedInputs.set(id, new Set())
    this.nativeInterruptAcks.set(id, new Set())
    this.nativeStartControlAcks.set(id, new Set())
    for (const owner of snapshot.transport.owners) this.recoveryFailures.delete(owner.sessionId)
    this.replayingTransports.add(id)
    if (virtual) {
      for (const owner of snapshot.transport.owners)
        if (owner.kind === 'root') {
          const prior = this.recoveryReservations
            .get(owner.sessionId)
            ?.transport.owners.find(
              (value) => value.kind === 'root' && value.sessionId === owner.sessionId,
            )
          if (!prior || (owner.generation ?? 0) > (prior.generation ?? 0))
            this.recoveryReservations.set(owner.sessionId, snapshot)
        }
      for (const record of snapshot.records)
        if (record.kind === 'create' || record.kind === 'transport') {
          const owners = record.kind === 'create' ? record.transport.owners : record.patch.owners
          for (const owner of owners || [])
            if (!this.sessions.has(owner.sessionId)) this.restoreOwner(owner, snapshot)
        }
      this.replayingTransports.delete(id)
      this.recoveryLoaded.add(id)
      return
    }
    const completed = snapshot.outputs.some(isConfirmedNativeExit)
    let channel: ClientChannel | undefined
    let rpc: RPC | undefined
    if (!completed) {
      const options = {
        store: this.nativeRecovery!,
        provider: snapshot.transport.provider,
        snapshot,
        deferRecoveryInputs: true,
      }
      const ownerlessClaude =
        snapshot.transport.provider === 'claude' &&
        !snapshot.records.some((record) =>
          (record.kind === 'create'
            ? record.transport.owners
            : record.kind === 'transport'
              ? record.patch.owners || []
              : []
          ).some((owner) => owner.kind === 'root'),
        )
      const onOpening = ownerlessClaude
        ? (opening: ClientChannel) =>
            this.observeOwnerlessClaude(
              id,
              opening as DurableChannel,
              this.recoveryMachine(snapshot),
            )
        : undefined
      const restore = (
        this.ssh as SSHConnection & {
          restoreDurableChannel?: (
            snapshot: NativeRecoverySnapshot,
            onOpening?: (channel: ClientChannel) => void,
          ) => Promise<ClientChannel>
        }
      ).restoreDurableChannel
      channel = restore
        ? await restore.call(this.ssh, snapshot, onOpening)
        : ((await (onOpening
            ? DurableRemoteChannel.open(
                this.ssh,
                snapshot.transport.launchCommand,
                (opening) => onOpening(opening as unknown as ClientChannel),
                options,
              )
            : DurableRemoteChannel.open(
                this.ssh,
                snapshot.transport.launchCommand,
                options,
              ))) as unknown as ClientChannel)
    } else {
      // A completed journal can be reduced without opening a replacement broker.
      const { PassThrough } = await import('node:stream')
      channel = Object.assign(new PassThrough(), {
        stderr: new PassThrough(),
        recoveryId: id,
        signal() {},
        close() {},
      }) as unknown as ClientChannel
    }
    try {
      if (snapshot.transport.provider === 'codex') {
        rpc = new RPC(
          channel,
          (message) => this.handleCodexWire(message, rpc!),
          () => {
            if (completed) return
            for (const owner of snapshot.transport.owners)
              if (this.sessions.get(owner.sessionId)?.recoveryTransportId === id)
                this.markRecoveryUnknown(
                  owner.sessionId,
                  'The recorded Codex transport could not be reattached.',
                )
          },
          {
            nextRequestId: maxNativeRequestId(snapshot) + 1,
            onOrphanResponse: (message) => this.orphanCodexResponse(id, rpc!, message),
            onResponse: (message, semantic) =>
              this.orphanCodexResponse(id, rpc!, message, semantic),
          },
        )
        this.codexTransports.add(rpc)
        this.codexRecoveryIds.set(rpc, id)
        this.codexTransportMachines.set(rpc, this.recoveryMachine(snapshot))
        this.codexTransportVersions.set(rpc, snapshot.transport.providerVersion)
      }
      const reconciled = this.nativeRecovery
        ? await runEffect(this.nativeRecovery.readTransport(id))
        : snapshot
      const finalInputs = new Map(reconciled.inputs.map((input) => [input.sequence, input]))
      // Owner resets must precede their original input/output, rather than applying
      // all old token deltas to the final saved turn.
      for (const record of snapshot.records) {
        if (record.kind === 'create' || record.kind === 'transport') {
          const owners = record.kind === 'create' ? record.transport.owners : record.patch.owners
          for (const owner of owners || [])
            this.restoreOwner(
              owner,
              snapshot,
              rpc,
              snapshot.transport.provider === 'claude' ? channel : undefined,
            )
        }
        if (record.kind === 'input')
          this.foldRecoveryInput(
            id,
            finalInputs.get(record.input.sequence) || {
              ...record.input,
              acknowledged: false,
              written: false,
              consumed: false,
            },
          )
        if (record.kind === 'output') {
          const frame = record.frame
          this.replayOutputCursors.set(id, frame.cursor)
          if (frame.type === 'stdout') {
            if (rpc) {
              rpc.replayOutput(Buffer.from(frame.data, 'base64'))
            } else {
              const session = [...this.sessions.values()].find(
                (value) => value.recoveryTransportId === id,
              )
              if (session) {
                this.bindClaudeParser(session, channel!)
                this.claudeParsers.get(session)!.push(Buffer.from(frame.data, 'base64'))
              }
            }
          } else if (frame.type === 'stderr') {
            for (const session of this.sessions.values())
              if (session.recoveryTransportId === id)
                session.stderr = (
                  session.stderr + Buffer.from(frame.data, 'base64').toString()
                ).slice(-8192)
          } else if (frame.type === 'inputReceipt') {
            const input = finalInputs.get(frame.sequence)
            if (input)
              this.foldNativeInputReceipt(id, frame, input, this.receiptInputOwner(snapshot, input))
          } else if (frame.type === 'exit' && frame.nativeExitConfirmed === false) {
            if (!this.terminalTransports.has(id))
              for (const [sessionId, session] of this.sessions)
                if (session.recoveryTransportId === id) {
                  this.markRecoveryUnknown(
                    sessionId,
                    'Native termination has not been observed. Life preserved the original provider owner.',
                  )
                  this.recovery.event(
                    id,
                    {
                      sessionId,
                      type: 'status',
                      status: 'unknown',
                      text: 'Native termination has not been observed. Life preserved the original provider owner.',
                    },
                    this.recoveryStamp(session),
                    {
                      replay: true,
                      outputCursor: frame.cursor,
                      eventId: `${id}:output:${frame.cursor}:unconfirmed-exit:${sessionId}`,
                    },
                  )
                }
          } else if (frame.type === 'exit')
            this.reduceNativeExit(
              id,
              frame.cursor,
              [...this.sessions].filter(([, session]) => session.recoveryTransportId === id),
            )
        }
      }
      this.replayOutputCursors.delete(id)
      const owned = [...this.sessions.values()].filter(
        (session) => session.recoveryTransportId === id,
      )
      if (snapshot.transport.provider === 'claude') {
        for (const session of owned) this.bindClaudeParser(session, channel)
        if (owned.length > 0) this.removeOwnerlessClaudeObserver(id)
      }
      const ownerlessClaude = !completed && !rpc && owned.length === 0
      if (ownerlessClaude) {
        this.ownerlessClaudeAttachments.set(id, {
          channel: channel as DurableChannel,
          machine: this.recoveryMachine(snapshot),
        })
        this.failedFreshProviders.set(id, {
          machine: this.recoveryMachine(snapshot),
          provider: 'claude',
          message:
            'The original Claude transport has no registered native owner. Life retained its attachment read-only.',
        })
      }
      if (!completed) {
        if (rpc || ownerlessClaude)
          this.transportEvents(channel, () =>
            owned.map((session) => [session.input.sessionId, session]),
          )
        ;(channel as DurableChannel).resumeRecoveryOutput?.()
        await (channel as DurableChannel).waitForReplay?.()
        await this.flushRecovery(false)
        if (owned.some((session) => session.recoveryUnknown)) {
          await (channel as DurableChannel).detach?.()
          throw this.recoveryError(
            'reducer',
            'The original native state could not be reconstructed; no pending input was activated.',
          )
        }
        if (!ownerlessClaude && (channel as DurableChannel).hasUnconfirmedRecoveryInputs)
          this.deferredRecoveryAttachments.set(id, {
            channel: channel as DurableChannel,
            rpc,
            machine: this.recoveryMachine(snapshot),
          })
        else if (!ownerlessClaude) await (channel as DurableChannel).activateRecoveryInputs?.()
      }
      this.replayingTransports.delete(id)
      const initialized = this.replayInitialization.get(id)
      if (
        rpc &&
        !completed &&
        initialized?.response &&
        !initialized.initialized &&
        !(channel as DurableChannel).hasUnconfirmedRecoveryInputs &&
        snapshot.closeInputSequence === undefined &&
        snapshot.transport.initialization?.status === 'pending' &&
        snapshot.transport.initialization.requestId === initialized.requestId &&
        !snapshot.inputs.some((input) => input.semantic.method === 'initialized')
      ) {
        const reservations = (await runEffect(this.nativeRecovery!.listTransports())).filter(
          (candidate) =>
            candidate.transport.nativeProtocol === 'life-studio-planner-v1' &&
            candidate.transport.provider === 'codex' &&
            this.recoveryMachine(candidate) === this.recoveryMachine(snapshot) &&
            candidate.transport.owners.some(
              (owner) =>
                owner.nativeStartClaimed &&
                owner.nativeStartIntentId &&
                !owner.linkedTransportId &&
                !owner.stopRequested,
            ),
        )
        if (reservations.length === 1) {
          await rpc.sendAndWait(
            { method: 'initialized', params: {} },
            { kind: 'initialize', method: 'initialized' },
          )
          initialized.initialized = true
        }
      }
      if (rpc && !completed) {
        if (!initialized?.response || !initialized.initialized) {
          const message =
            'The original native initialization has not been proven complete. Life did not initialize a replacement connection.'
          this.recoveringCodexInitialization.add(id)
          this.deferredRecoveryAttachments.set(id, {
            channel: channel as DurableChannel,
            rpc,
            machine: this.recoveryMachine(snapshot),
          })
          this.recoveryFailures.set(`transport:${this.recoveryMachine(snapshot)}`, message)
          const failed = this.failedFreshProviders.get(id)
          if (failed) this.failedFreshProviders.set(id, { ...failed, message })
        } else {
          this.recoveryFailures.delete(`transport:${this.recoveryMachine(snapshot)}`)
          this.codexByMachine.set(this.recoveryMachine(snapshot), rpc)
          await runEffect(
            this.nativeRecovery!.updateTransport(id, { initialization: { status: 'complete' } }),
          )
        }
      }
      for (const session of owned) {
        const admittedPrompt = (
          await runEffect(this.nativeRecovery!.readTransport(id))
        ).inputs.some(
          (input) =>
            input.semantic.kind === 'user-prompt' &&
            input.semantic.sessionId === session.input.sessionId &&
            input.semantic.ownerGeneration === session.recoveryGeneration,
        )
        if (session.busy && !admittedPrompt && !session.stopRequested) {
          const reservations = await runEffect(this.nativeRecovery!.listTransports())
          const captured =
            session.input.scope === 'life-customization' &&
            session.nativeStartIntentId &&
            session.nativeStartPlan &&
            reservations.some(
              (reservation) =>
                reservation.transport.nativeProtocol === 'life-studio-planner-v1' &&
                reservation.transport.provider === session.input.provider &&
                this.recoveryMachine(reservation) === session.machineIdentity &&
                reservation.transport.owners.some(
                  (owner) =>
                    owner.sessionId === session.input.sessionId &&
                    owner.nativeStartClaimed &&
                    owner.nativeStartIntentId === session.nativeStartIntentId &&
                    owner.localTurn === session.input.localTurn &&
                    owner.generation! < session.recoveryGeneration! &&
                    (!owner.linkedTransportId || owner.linkedTransportId === id),
                ),
            )
          if (captured && !completed) {
            this.recoveredStarts.add(session.input.sessionId)
            await this.continueRecoveredStart(session)
          } else
            this.markRecoveryUnknown(
              session.input.sessionId,
              'Life closed before a native user turn was admitted. Its original startup intent could not be proven, so no prompt was submitted.',
            )
        }
        if (!session.recoveryUnknown && !completed) await this.recordRecoveryOwner(session, channel)
        if (session.stopRequested && !session.recoveryUnknown && !completed) {
          this.recoveredStops.add(session.input.sessionId)
          await this.continueRecoveredStop(session)
        }
      }
      if (completed) {
        for (const session of owned) {
          if (session.channel === channel) session.channel = undefined
          if (session.codexRPC === rpc) session.codexRPC = undefined
          this.claudeParsers.delete(session)
          this.claudeWireSequences.delete(session)
        }
        if (rpc) this.codexTransports.delete(rpc)
        channel.destroy()
      }
      this.recoveryLoaded.add(id)
      if (
        completed ||
        (!(channel as DurableChannel).hasUnconfirmedRecoveryInputs &&
          !(channel as DurableChannel).isClosing &&
          !channel.destroyed &&
          (rpc
            ? !rpc.closed && initialized?.response && initialized.initialized
            : owned.length > 0 &&
              initialized?.response &&
              owned.every((session) => !session.recoveryUnknown)))
      )
        this.clearFreshProviderFailure(id)
    } catch (cause) {
      this.ownerlessClaudeAttachments.delete(id)
      this.deferredRecoveryAttachments.delete(id)
      this.recoveringCodexInitialization.delete(id)
      this.replayingTransports.delete(id)
      this.replayOutputCursors.delete(id)
      if (rpc)
        await rpc.detach(cause instanceof Error ? cause : new Error(String(cause))).catch(() => {})
      else if (!completed) await (channel as DurableChannel).detach?.().catch(() => {})
      else channel.destroy()
      this.removeOwnerlessClaudeObserver(id)
      for (const session of this.sessions.values())
        if (session.recoveryTransportId === id) {
          this.claudeParsers.delete(session)
          this.claudeWireSequences.delete(session)
          session.channel = undefined
        }
      throw cause
    }
  }
  private markRecoveryUnknown(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId)
    if (session) session.recoveryUnknown = true
    this.recoveryFailures.set(sessionId, message)
  }
  private async continueRecoveredStart(session: Session) {
    const sessionId = session.input.sessionId
    const id = session.recoveryTransportId
    if (
      !id ||
      !this.nativeRecovery ||
      !this.recoveredStarts.has(sessionId) ||
      this.continuingStarts.has(sessionId) ||
      session.stopRequested ||
      session.recoveryUnknown ||
      this.hasDeferredNativeAttachment(session)
    )
      return
    this.continuingStarts.add(sessionId)
    try {
      const snapshot = await runEffect(this.nativeRecovery.readTransport(id))
      if (snapshot.closeInputSequence !== undefined || snapshot.outputs.some(isConfirmedNativeExit))
        throw this.recoveryError(
          'start-continuation',
          'The original startup transport is closing or has exited.',
        )
      const owns = (input: NativeRecoveryStoredInput) =>
        input.semantic.sessionId === sessionId &&
        input.semantic.ownerGeneration === session.recoveryGeneration
      if (snapshot.inputs.some((input) => owns(input) && input.semantic.kind === 'user-prompt')) {
        this.recoveredStarts.delete(sessionId)
        return
      }
      const plan = session.nativeStartPlan
      if (!plan || plan.provider !== session.input.provider)
        throw this.recoveryError(
          'start-continuation',
          'The original native startup frame plan is missing.',
        )
      if (session.input.provider === 'codex') {
        const rpc = session.codexRPC
        if (!rpc || rpc.closed)
          throw this.recoveryError(
            'start-continuation',
            'The original Codex stream is unavailable.',
          )
        if (!session.remoteId) {
          if (
            snapshot.inputs.some(
              (input) =>
                owns(input) &&
                ['thread/start', 'thread/resume'].includes(input.semantic.method || ''),
            )
          )
            return
          const thread = object(plan.thread)
          if (!['thread/start', 'thread/resume'].includes(string(thread.method)))
            throw this.recoveryError(
              'start-continuation',
              'The original Codex thread command is invalid.',
            )
          await rpc.request(
            string(thread.method),
            object(thread.params),
            60000,
            undefined,
            this.recoverySemantic(session, 'transport'),
          )
        }
        if (!session.remoteId || session.stopRequested) return
        session.phase = 'startingTurn'
        await this.recordRecoveryOwner(session, rpc.channel)
        const result = await rpc.request(
          'turn/start',
          { ...object(object(plan.turn).params), threadId: session.remoteId },
          60000,
          undefined,
          this.recoverySemantic(session, 'user-prompt'),
        )
        session.turnId = string(object(result.turn).id)
      } else {
        const channel = session.channel
        if (!channel || channel.destroyed)
          throw this.recoveryError(
            'start-continuation',
            'The original Claude stream is unavailable.',
          )
        if (!this.replayInitialization.get(id)?.response) {
          if (
            snapshot.inputs.some(
              (input) => owns(input) && input.semantic.requestType === 'initialize',
            )
          )
            return
          await this.claudeControl(session, object(plan.initialize), 60000)
        }
        for (const [index, control] of array(plan.controls).entries()) {
          const request = object(control.request)
          if (
            !['set_permission_mode', 'set_model', 'apply_flag_settings'].includes(
              string(request.subtype),
            )
          )
            throw this.recoveryError(
              'start-continuation',
              'The captured Claude startup control is unsupported.',
            )
          const key = JSON.stringify([session.recoveryGeneration ?? 0, index])
          if (this.nativeStartControlAcks.get(id)?.has(key)) continue
          const allocated = snapshot.inputs.find(
            (input) => owns(input) && object(input.semantic.details).startControlIndex === index,
          )
          if (allocated) {
            if (allocated.cancellation)
              this.markRecoveryUnknown(
                sessionId,
                'A captured native startup control was canceled before its completion could be observed. Life retained the original owner.',
              )
            return
          }
          await this.claudeControl(
            session,
            request,
            15000,
            undefined,
            object(control.details) as NativeClaudeControlDetails,
          )
          if (session.stopRequested || session.recoveryUnknown) return
        }
        if (session.stopRequested) return
        session.phase = 'running'
        await this.recordRecoveryOwner(session, channel)
        await this.writeClaudeAndWait(
          session,
          {
            ...object(plan.user),
            session_id: session.remoteId || string(object(plan.user).session_id),
          },
          this.recoverySemantic(session, 'user-prompt'),
        )
      }
      session.phase = 'running'
      this.recoveredStarts.delete(sessionId)
      const channel =
        session.input.provider === 'codex' ? session.codexRPC!.channel : session.channel!
      await this.recordRecoveryOwner(session, channel)
      await this.flushRecovery(false)
    } finally {
      this.continuingStarts.delete(sessionId)
    }
  }
  private queueRecoveredStarts(id: string) {
    for (const session of this.sessions.values())
      if (
        session.recoveryTransportId === id &&
        this.recoveredStarts.has(session.input.sessionId) &&
        !this.continuingStarts.has(session.input.sessionId)
      )
        queueMicrotask(() => {
          void this.continueRecoveredStart(session).catch((cause) =>
            this.markRecoveryUnknown(
              session.input.sessionId,
              cause instanceof Error ? cause.message : String(cause),
            ),
          )
        })
  }
  private continueRecoveredStop(session: Session): Promise<void> {
    const sessionId = session.input.sessionId
    const previous = this.stopContinuations.get(sessionId)
    if (previous) return previous
    const continuation = this.continueRecoveredStopOperation(session)
    this.stopContinuations.set(sessionId, continuation)
    void continuation
      .finally(() => {
        if (this.stopContinuations.get(sessionId) === continuation)
          this.stopContinuations.delete(sessionId)
        if (this.pendingStopWakes.delete(sessionId) && session.recoveryTransportId)
          this.queueRecoveredStops(session.recoveryTransportId)
      })
      .catch(() => {})
    return continuation
  }
  private async continueRecoveredStopOperation(session: Session) {
    const id = session.recoveryTransportId
    const sessionId = session.input.sessionId
    if (
      !id ||
      !this.nativeRecovery ||
      !session.stopRequested ||
      session.stopping ||
      this.continuingStops.has(sessionId)
    )
      return
    this.continuingStops.add(sessionId)
    try {
      await Promise.allSettled(
        [...this.pendingPermissionResponses.values()]
          .filter((pending) => pending.sessionId === sessionId)
          .map((pending) => pending.promise),
      )
      const snapshot = await runEffect(this.nativeRecovery.readTransport(id))
      const owner = snapshot.transport.owners.find(
        (value) => value.kind === 'root' && value.sessionId === session.input.sessionId,
      )
      if (!owner) return
      if (
        snapshot.closeInputSequence !== undefined &&
        !snapshot.outputs.some(isConfirmedNativeExit)
      )
        return
      const children = [...this.childThreads]
        .filter(([, child]) => child.sessionId === session.input.sessionId)
        .map(([nativeThreadId, child]) => ({
          state: child.busy ? ('active' as const) : ('idle' as const),
          nativeThreadId,
          nativeTurnId: child.turnId,
          ownershipProven: child.rpc === session.codexRPC,
          interruptAcknowledged: this.nativeInterruptAcks
            .get(id)
            ?.has(JSON.stringify([nativeThreadId, child.turnId])),
          owner: child.owner || owner,
        }))
      for (const [agentId, child] of session.claudeActiveChildren || [])
        children.push({
          state: 'active',
          nativeThreadId: agentId,
          nativeTurnId: undefined,
          ownershipProven: !session.recoveryUnknown,
          interruptAcknowledged: false,
          owner: child.owner || owner,
        })
      const plan = planNativeStopRecovery({
        snapshot,
        owner,
        processedInputSequences: [...(this.nativeProcessedInputs.get(id) || [])],
        root: {
          state: session.busy ? (session.phase === 'initializing' ? 'starting' : 'active') : 'idle',
          nativeThreadId: session.remoteId,
          nativeTurnId: session.turnId,
          ownershipProven: !session.recoveryUnknown,
          interruptAcknowledged:
            this.nativeInterruptAcks
              .get(id)
              ?.has(JSON.stringify([session.remoteId, session.turnId])) ||
            this.nativeInterruptAcks.get(id)?.has('claude'),
        },
        children,
        graphComplete: true,
        approvals: [...session.approvals].map(([requestId, approval]) => ({
          requestId,
          nativeRequestId: approval.wireId as string | number,
          requestType: approval.method,
          owner: approval.owner || owner,
          nativeThreadId: string(approval.params.threadId) || session.remoteId,
          canDeny:
            session.input.provider !== 'codex' ||
            codexApprovalStopDecisionId(approval.method, approval.params) !== null,
        })),
      })
      if (plan.status === 'unknown') {
        if (
          plan.reasons.every(
            (reason) =>
              reason.startsWith('An original user prompt remains unresolved;') ||
              reason.startsWith('An admitted native turn has not yet yielded') ||
              reason.startsWith('An original native control was accepted without proven delivery;'),
          )
        )
          return
        this.markRecoveryUnknown(session.input.sessionId, plan.reasons.join(' '))
        const completion = this.stopCompletions.get(session.input.sessionId)
        if (completion)
          Deferred.doneUnsafe(
            completion,
            Effect.fail(this.recoveryError('stop', plan.reasons.join(' '))),
          )
        return
      }
      const continuation = (async () => {
        let finished = false
        for (const action of plan.actions) {
          if (action.type === 'retry-input') continue
          if (action.type === 'deny-approval') {
            const approval = session.approvals.get(action.approval.requestId)
            if (approval)
              await this.respondOnce(
                session.input.sessionId,
                action.approval.requestId,
                false,
                undefined,
                session.input.provider === 'codex'
                  ? codexApprovalStopDecisionId(approval.method, approval.params) || undefined
                  : undefined,
                true,
              )
          }
          if (action.type === 'interrupt-codex')
            await session.codexRPC?.request(
              'turn/interrupt',
              {
                threadId: action.nativeThreadId,
                turnId: action.nativeTurnId,
              },
              10000,
              undefined,
              this.recoverySemantic(session, 'interrupt', {
                ownerGeneration:
                  children.find((child) => child.nativeThreadId === action.nativeThreadId)?.owner
                    .generation ??
                  owner.generation ??
                  0,
                nativeThreadId: action.nativeThreadId,
                nativeTurnId: action.nativeTurnId,
                details: { stopKey: action.stopKey },
              }),
            )
          if (action.type === 'interrupt-claude')
            await this.claudeControl(session, { subtype: 'interrupt' }, 10000)
          if (action.type === 'finish-unstarted' || action.type === 'finish-stop') {
            session.busy = false
            if (session.input.provider !== 'claude' || this.terminalTransports.has(id))
              this.emitStopped(session)
            finished = true
          }
        }
        if (
          session.input.provider === 'claude' &&
          (this.nativeInterruptAcks.get(id)?.has('claude') || finished)
        ) {
          const channel = session.channel as DurableChannel | undefined
          if (channel?.signalNativeAndWait && channel.closeNativeAndWait) {
            const latest = await runEffect(this.nativeRecovery!.readTransport(id))
            const signaled = latest.inputs.some(
              (input) =>
                input.semantic.method === 'life/stop-signal' &&
                input.semantic.sessionId === session.input.sessionId &&
                input.semantic.ownerGeneration === session.recoveryGeneration,
            )
            if (!signaled && !latest.outputs.some(isConfirmedNativeExit))
              await channel.signalNativeAndWait(
                'TERM',
                this.recoverySemantic(session, 'transport', { method: 'life/stop-signal' }),
              )
            const exited = await channel.closeNativeAndWait(
              this.recoverySemantic(session, 'close', { method: 'life/stop-close' }),
            )
            if (!exited) {
              this.markRecoveryUnknown(
                session.input.sessionId,
                'Claude is still closing. Life retained its original writer and did not start another process.',
              )
              const completion = this.stopCompletions.get(sessionId)
              if (completion)
                Deferred.doneUnsafe(
                  completion,
                  Effect.fail(
                    this.recoveryError('stop', 'The original Claude process has not exited yet.'),
                  ),
                )
              finished = false
            } else {
              finished = true
              this.emitStopped(session)
            }
          } else if (!this.terminalTransports.has(id)) {
            throw this.recoveryError(
              'stop',
              'The native Claude transport cannot prove its terminal retirement.',
            )
          }
        }
        const channel =
          session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
        if (channel) await this.recordRecoveryOwner(session, channel)
        else await runEffect(this.recovery.updateOwnerEffect(id, this.recoveryOwner(session)))
        await this.flushRecovery(false)
        if (!finished && this.terminalTransports.has(id)) {
          session.busy = false
          session.recoveryUnknown = false
          this.recoveryFailures.delete(sessionId)
          await runEffect(this.recovery.updateOwnerEffect(id, this.recoveryOwner(session)))
          this.emitStopped(session)
          await this.flushRecovery(false)
          finished = true
        }
        if (finished) {
          this.recoveredStops.delete(sessionId)
          const completion = this.stopCompletions.get(session.input.sessionId)
          if (completion) Deferred.doneUnsafe(completion, Effect.void)
        }
      })()
      session.stopping = continuation
      try {
        await continuation
      } finally {
        if (session.stopping === continuation) session.stopping = undefined
      }
    } catch (cause) {
      if (!this.terminalTransports.has(id)) throw cause
      session.busy = false
      session.recoveryUnknown = false
      this.recoveryFailures.delete(sessionId)
      this.emitStopped(session)
      const channel =
        session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
      if (channel) await this.recordRecoveryOwner(session, channel)
      else await runEffect(this.recovery.updateOwnerEffect(id, this.recoveryOwner(session)))
      await this.flushRecovery(false)
      this.recoveredStops.delete(sessionId)
      const completion = this.stopCompletions.get(sessionId)
      if (completion) Deferred.doneUnsafe(completion, Effect.void)
    } finally {
      this.continuingStops.delete(sessionId)
    }
  }
  private queueRecoveredStops(id: string) {
    for (const session of this.sessions.values())
      if (session.recoveryTransportId === id && this.recoveredStops.has(session.input.sessionId)) {
        if (
          session.stopping ||
          this.continuingStops.has(session.input.sessionId) ||
          this.stopContinuations.has(session.input.sessionId)
        ) {
          this.pendingStopWakes.add(session.input.sessionId)
          continue
        }
        queueMicrotask(() => {
          void this.continueRecoveredStop(session).catch((cause) => {
            this.markRecoveryUnknown(
              session.input.sessionId,
              cause instanceof Error ? cause.message : String(cause),
            )
            const completion = this.stopCompletions.get(session.input.sessionId)
            if (completion)
              Deferred.doneUnsafe(
                completion,
                Effect.fail(
                  this.recoveryError('stop', 'The native Stop outcome remains unresolved.', cause),
                ),
              )
          })
        })
      }
  }
  private ensureNativeRecovery(): Promise<void> {
    if (!this.nativeRecovery || this.ssh.state.status !== 'connected') return Promise.resolve()
    if (this.recoveryStarting) return this.recoveryStarting
    const started = runEffect(this.ensureNativeRecoveryEffect())
    this.recoveryStarting = started
    void started
      .finally(() => {
        if (this.recoveryStarting === started) this.recoveryStarting = undefined
      })
      .catch(() => {})
    return started
  }
  private readonly ensureNativeRecoveryEffect = Effect.fn('Agents.ensureNativeRecovery')(
    function* (this: Agents) {
      if (!this.nativeRecovery || !this.ssh.state.profile) return
      yield* this.nativeRecoverySupportEffect('restore')
      yield* this.providerDiscoveryEffect()
      const profile = this.ssh.state.profile
      if (!profile || this.ssh.state.status !== 'connected') return
      const machine = nativeMachineIdentity(profile)
      const ownsEnvironment = this.ssh.captureEnvironmentOwnership?.()
      const current = () =>
        this.ssh.state.status === 'connected' &&
        this.ssh.state.profile?.id === profile.id &&
        this.machineIdentity() === machine &&
        (!ownsEnvironment || ownsEnvironment())
      const changed = () =>
        new AgentEnvironmentError({
          reason: 'changed',
          message: 'The selected environment changed while reading native recovery.',
          cause: undefined,
        })
      const snapshots = yield* this.nativeRecovery.listTransports().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            this.recoveryFailures.set('*', error.message)
          }),
        ),
      )
      if (!current()) return yield* changed()
      const nativeSnapshots = snapshots.filter(
        (snapshot) =>
          snapshot.transport.nativeProtocol !== 'life-studio-planner-v1' &&
          snapshot.transport.machine.profileId === profile.id &&
          this.recoveryMachine(snapshot) === nativeMachineIdentity(profile),
      )
      const successors = new Map(
        nativeSnapshots.map((snapshot) => [snapshot.transport.id, new Set<string>()]),
      )
      const dependencies = new Map(nativeSnapshots.map((snapshot) => [snapshot.transport.id, 0]))
      const histories = new Map<string, { id: string; generation: number }[]>()
      for (const snapshot of nativeSnapshots)
        for (const owner of snapshot.transport.owners)
          if (owner.kind === 'root') {
            const history = histories.get(owner.sessionId) || []
            history.push({ id: snapshot.transport.id, generation: owner.generation ?? 0 })
            histories.set(owner.sessionId, history)
          }
      const ambiguous = new Set<string>()
      for (const history of histories.values()) {
        history.sort((left, right) => left.generation - right.generation)
        for (let index = 1; index < history.length; index++) {
          const prior = history[index - 1],
            next = history[index]
          if (prior.generation === next.generation) {
            ambiguous.add(prior.id)
            ambiguous.add(next.id)
          } else if (!successors.get(prior.id)!.has(next.id)) {
            successors.get(prior.id)!.add(next.id)
            dependencies.set(next.id, dependencies.get(next.id)! + 1)
          }
        }
      }
      const byId = new Map(nativeSnapshots.map((snapshot) => [snapshot.transport.id, snapshot]))
      const queue = nativeSnapshots
        .filter((snapshot) => dependencies.get(snapshot.transport.id) === 0)
        .map((snapshot) => snapshot.transport.id)
      const ordered: NativeRecoverySnapshot[] = []
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]
        ordered.push(byId.get(id)!)
        for (const next of successors.get(id)!) {
          const count = dependencies.get(next)! - 1
          dependencies.set(next, count)
          if (count === 0) queue.push(next)
        }
      }
      if (ordered.length !== nativeSnapshots.length) {
        const error = this.recoveryError(
          'restore',
          'The recorded native owner generations contain contradictory transport chronology. Life retained every original provider.',
        )
        this.recoveryFailures.set('*', error.message)
        return yield* error
      }
      ordered.push(
        ...snapshots.filter(
          (snapshot) => snapshot.transport.nativeProtocol === 'life-studio-planner-v1',
        ),
      )
      for (const snapshot of ordered) {
        if (!current()) return yield* changed()
        this.recoverySnapshots.set(snapshot.transport.id, snapshot)
        if (ambiguous.has(snapshot.transport.id)) {
          for (const owner of snapshot.transport.owners)
            this.markRecoveryUnknown(
              owner.sessionId,
              'The same native owner generation was registered on multiple transports. Life retained the original processes without admitting a replacement.',
            )
          continue
        }
        if (
          this.recoveryLoaded.has(snapshot.transport.id) ||
          this.freshProviderChannels.has(snapshot.transport.id)
        )
          continue
        if (
          snapshot.transport.machine.profileId !== profile.id ||
          this.recoveryMachine(snapshot) !== nativeMachineIdentity(profile)
        )
          continue
        yield* Effect.tryPromise({
          try: () => this.restoreNativeTransport(snapshot),
          catch: (cause) =>
            cause instanceof NativeRecoveryError
              ? cause
              : this.recoveryError(
                  'restore',
                  'Native transport recovery failed without launching a replacement provider.',
                  cause,
                ),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              const failed = this.failedFreshProviders.get(snapshot.transport.id)
              if (failed)
                this.failedFreshProviders.set(snapshot.transport.id, {
                  ...failed,
                  message: error.message,
                })
              else if (
                snapshot.transport.provider === 'claude' &&
                !snapshot.transport.owners.some((owner) => owner.kind === 'root') &&
                !snapshot.outputs.some(isConfirmedNativeExit)
              )
                this.failedFreshProviders.set(snapshot.transport.id, {
                  machine: this.recoveryMachine(snapshot),
                  provider: 'claude',
                  message: error.message,
                })
              for (const owner of snapshot.transport.owners)
                this.markRecoveryUnknown(owner.sessionId, error.message)
              if (
                snapshot.transport.provider === 'codex' &&
                !snapshot.outputs.some(isConfirmedNativeExit)
              )
                this.recoveryFailures.set(
                  `transport:${this.recoveryMachine(snapshot)}`,
                  error.message,
                )
            }),
          ),
        )
        if (!current()) return yield* changed()
      }
      if (!current()) return yield* changed()
      for (const [sessionId, reservation] of this.recoveryReservations) {
        const reserved = reservation.transport.owners.find(
          (owner) => owner.kind === 'root' && owner.sessionId === sessionId,
        )
        if (
          reserved?.nativeStartIntentId &&
          snapshots.some(
            (snapshot) =>
              snapshot.transport.nativeProtocol !== 'life-studio-planner-v1' &&
              snapshot.transport.owners.some(
                (owner) =>
                  owner.kind === 'root' &&
                  owner.sessionId === sessionId &&
                  owner.nativeStartIntentId === reserved.nativeStartIntentId &&
                  (owner.generation ?? 0) > (reserved.generation ?? 0),
              ),
          )
        )
          this.recoveryReservations.delete(sessionId)
      }
    }.bind(this),
  )
  readonly recoverEffect = Effect.fn('Agents.recover')(
    function* (
      this: Agents,
      input: {
        consumers: NativeRecoveryConsumer[]
        membershipAdmissions?: readonly ConversationProjectionAdmission[]
      },
    ) {
      const policy = yield* this.recoveryPlatformEffect()
      if (policy?.mode === 'unsupported-clean') {
        yield* policy.assertOrdinaryHistoryWriteEffect()
        this.rendererSuspended = false
        return { owners: [] }
      }
      yield* this.nativeRecoverySupportEffect('recover')
      this.rendererSuspended = false
      this.recoveryConsumerFailures.clear()
      for (const rpc of this.codexTransports)
        if (rpc.closed) {
          const id = this.codexRecoveryIds.get(rpc) || (rpc.channel as DurableChannel).recoveryId
          if (id && !this.terminalTransports.has(id) && !this.intentionalIdleClosing.has(rpc)) {
            this.recoveryLoaded.delete(id)
            this.codexTransports.delete(rpc)
            const machine = this.codexTransportMachines.get(rpc)
            if (machine && this.codexByMachine.get(machine) === rpc)
              this.codexByMachine.delete(machine)
          }
        }
      for (const session of this.sessions.values())
        if (
          session.recoveryUnknown &&
          session.recoveryTransportId &&
          this.terminalTransports.has(session.recoveryTransportId)
        )
          this.recoveryLoaded.delete(session.recoveryTransportId)
      for (const session of this.sessions.values())
        if (
          session.input.provider === 'claude' &&
          session.recoveryUnknown &&
          session.recoveryTransportId &&
          !this.terminalTransports.has(session.recoveryTransportId)
        )
          this.recoveryLoaded.delete(session.recoveryTransportId)
      if (input.membershipAdmissions !== undefined)
        this.recoveryMembershipAdmissions = input.membershipAdmissions.map((admission) => ({
          ...admission,
        }))
      const consumerKinds = new Set(input.consumers.map((consumer) => consumer.kind))
      if (input.membershipAdmissions !== undefined) consumerKinds.add('main')
      this.recoveryConsumers = [
        ...this.recoveryConsumers.filter((consumer) => !consumerKinds.has(consumer.kind)),
        ...input.consumers.map((consumer) => ({
          ...consumer,
          applied: consumer.applied ? { ...consumer.applied } : undefined,
        })),
      ]
      yield* Effect.tryPromise({
        try: () => this.ensureNativeRecovery(),
        catch: (cause) =>
          cause instanceof NativeRecoveryError
            ? cause
            : this.recoveryError('recover', 'Native recovery could not be admitted.', cause),
      })
      yield* this.recovery.flushEffect()
      const snapshots = this.nativeRecovery ? yield* this.nativeRecovery.listTransports() : []
      const newest = new Map<string, NativeRecoverySnapshot>()
      for (const snapshot of snapshots)
        for (const owner of snapshot.transport.owners)
          if (owner.kind === 'root') {
            const previous = newest
              .get(owner.sessionId)
              ?.transport.owners.find((value) => value.ownerId === owner.ownerId)
            if (!previous || (owner.generation ?? 0) >= (previous.generation ?? 0))
              newest.set(owner.sessionId, snapshot)
          }
      const profile = this.ssh.state.profile
      const absentOwners = new Set<string>()
      for (const [sessionId, snapshot] of newest) {
        const owner = snapshot.transport.owners.find(
          (value) => value.kind === 'root' && value.sessionId === sessionId,
        )!
        if (
          owner.state === 'complete' &&
          this.recovery.isAbsentMembership(snapshot, owner, this.recoveryMembershipAdmissions)
        ) {
          absentOwners.add(sessionId)
          this.recoveryConsumerFailures.add(sessionId)
        }
        if (
          profile &&
          snapshot.transport.machine.profileId === profile.id &&
          this.recoveryMachine(snapshot) === nativeMachineIdentity(profile) &&
          object(owner.input).scope === 'life-customization'
        )
          for (const consumer of this.recoveryConsumers)
            if (
              consumer.kind === 'studio' &&
              consumer.sessionId === sessionId &&
              consumer.profileId === profile.id &&
              consumer.workspace === undefined
            )
              consumer.workspace = owner.workspace
      }
      this.recoveryConsumers = this.recoveryConsumers.filter(
        (consumer) => !absentOwners.has(consumer.sessionId),
      )
      for (const [sessionId, snapshot] of newest) {
        const owner = snapshot.transport.owners.find(
          (value) => value.kind === 'root' && value.sessionId === sessionId,
        )!
        if (
          owner.state === 'complete' ||
          absentOwners.has(sessionId) ||
          !profile ||
          snapshot.transport.machine.profileId !== profile.id ||
          this.recoveryMachine(snapshot) !== nativeMachineIdentity(profile) ||
          this.recoveryConsumers.some((consumer) => consumer.sessionId === sessionId)
        )
          continue
        const client = object(owner.clientRecovery)
        const kind =
          client.kind === 'main'
            ? 'main'
            : object(owner.input).scope === 'life-customization'
              ? 'studio'
              : undefined
        if (kind)
          this.recoveryConsumers.push({
            kind,
            sessionId,
            profileId: profile.id,
            workspace: owner.workspace,
            remoteId: owner.nativeThreadId || owner.nativeSessionId,
          })
      }
      const owners: NativeRecoveryOwnerState[] = []
      for (const snapshot of snapshots) {
        this.recoverySnapshots.set(snapshot.transport.id, snapshot)
        for (const owner of snapshot.transport.owners) {
          if (owner.kind !== 'root' || absentOwners.has(owner.sessionId)) continue
          if (newest.get(owner.sessionId)?.transport.id !== snapshot.transport.id) continue
          const session = this.sessions.get(owner.sessionId)
          const reserved = snapshot.transport.nativeProtocol === 'life-studio-planner-v1'
          const active =
            session?.recoveryTransportId === snapshot.transport.id ||
            (reserved &&
              this.recoveryReservations.get(owner.sessionId)?.transport.id ===
                snapshot.transport.id)
          const consumer = this.recoveryConsumers.find(
            (value) => value.sessionId === owner.sessionId,
          )
          const baselineUnknown = Boolean(
            consumer && !this.recovery.validateConsumerBaseline(snapshot, consumer),
          )
          if (baselineUnknown) this.recoveryConsumerFailures.add(owner.sessionId)
          const unknown =
            !active ||
            session?.recoveryUnknown ||
            this.recoveryFailures.has(owner.sessionId) ||
            baselineUnknown
          const pending =
            !unknown && !reserved && session
              ? [...session.approvals.keys()].flatMap((requestId) => {
                  const stored = [...snapshot.events]
                    .reverse()
                    .find(
                      (event) =>
                        event.event.sessionId === owner.sessionId &&
                        event.event.requestId === requestId &&
                        ['approval', 'question'].includes(string(event.event.type)),
                    )
                  return stored ? [stampRecoveryEvent(stored, snapshot.transport.id)] : []
                })
              : []
          const currentChildren =
            !unknown && !reserved
              ? this.runningSessionEvents().filter(
                  (event) => event.sessionId === owner.sessionId && event.type === 'subagent',
                )
              : []
          if (!unknown && !reserved && session)
            for (const [agentId, child] of session.claudeActiveChildren || [])
              currentChildren.push({
                sessionId: owner.sessionId,
                provider: 'claude',
                type: 'subagent',
                agentId,
                itemId: child.itemId,
                title: child.title || 'Subagent',
                parentItemId: child.parentItemId,
                status: 'running',
              })
          const accepted = consumer ? this.recovery.acceptedCursor(snapshot, consumer) : undefined
          owners.push({
            sessionId: owner.sessionId,
            transportId: snapshot.transport.id,
            status: unknown
              ? 'unknown'
              : this.recoveredStarts.has(owner.sessionId) ||
                  this.hasPendingNativeDecision(owner.sessionId) ||
                  (session && this.hasDeferredNativeAttachment(session))
                ? 'recovering'
                : !reserved &&
                    session &&
                    (session.busy ||
                      this.hasCodexChildren(owner.sessionId) ||
                      session.claudeActiveChildren?.size ||
                      session.approvals.size)
                  ? 'running'
                  : 'idle',
            snapshotToken: owner.snapshotToken,
            ownerGeneration: owner.generation ?? 0,
            throughEventRevision: snapshot.eventRevision,
            clientRecovery: owner.clientRecovery,
            ...(unknown
              ? {
                  message:
                    (baselineUnknown
                      ? 'The retained history projection has no current private source proof. Life preserved it without appending an ambiguous native tail.'
                      : this.recoveryFailures.get(owner.sessionId)) ||
                    'Reconnect to this native owner’s machine to recover it.',
                }
              : {}),
            originalInput: this.publicRecoveryInput(owner),
            localTurn: owner.localTurn,
            remoteId:
              owner.nativeThreadId ||
              owner.nativeSessionId ||
              (!reserved ? session?.remoteId : undefined),
            provider: snapshot.transport.provider,
            pending,
            currentChildren,
            acceptedAppliedRevision: accepted?.appliedRevision ?? 0,
            acceptedAppliedCursor: accepted,
            deliveryToken: unknown
              ? undefined
              : this.recovery.getDeliveryToken(snapshot.transport.id, owner),
            acceptedProjectionAdmission:
              consumer && accepted
                ? this.recovery.getAcceptedProjectionAdmission(snapshot, consumer, accepted)
                : undefined,
            acceptedCacheHash:
              consumer?.kind === 'studio' && accepted && !baselineUnknown
                ? consumer.cacheHash
                : undefined,
          } as NativeRecoveryOwnerState)
        }
        for (const event of this.recovery.replayEvents(snapshot, this.recoveryConsumers)) {
          const rollback = this.recovery.noteReplayDelivery(event)
          if (!this.deliverNativeEvent(event, true)) rollback()
        }
      }
      return { owners }
    }.bind(this),
    (effect: Effect.Effect<{ owners: NativeRecoveryOwnerState[] }, NativeRecoveryError>) =>
      this.recoveryAdmissionMutex.withPermits(1)(
        Effect.gen(
          function* (this: Agents) {
            this.recoveryAdmissionDepth++
            try {
              const result = yield* effect
              yield* this.recovery.flushEffect()
              this.recoveryAdmissionDepth--
              const queued = this.recoveryAdmissionEvents.splice(0)
              const byTransport = new Map<string, AgentEvent[]>()
              for (const event of queued) {
                const key = event.nativeRecovery!.transportId
                const group = byTransport.get(key) || []
                group.push(event)
                byTransport.set(key, group)
              }
              for (const group of byTransport.values())
                group.sort(
                  (left, right) => left.nativeRecovery!.revision - right.nativeRecovery!.revision,
                )
              for (const slot of queued) {
                const event = byTransport.get(slot.nativeRecovery!.transportId)!.shift()!
                const rollback = this.recovery.noteReplayDelivery(event)
                if (!this.deliverNativeEvent(event)) rollback()
              }
              return result
            } finally {
              this.recoveryAdmissionDepth = 0
              this.recoveryAdmissionEvents = []
            }
          }.bind(this),
        ),
      ),
  )
  recover(input: unknown) {
    return runEffect(
      Schema.decodeUnknownEffect(recoveryInputSchema)(input).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('recover', 'Recovery consumers are invalid.', cause),
        ),
        Effect.flatMap((decoded) =>
          this.recoverEffect({
            membershipAdmissions: decoded.membershipAdmissions,
            consumers: decoded.consumers.map((consumer) => ({
              ...consumer,
              applied: consumer.applied ? { ...consumer.applied } : undefined,
            })),
          }),
        ),
      ),
    )
  }
  readonly reserveRecoveryOwnerEffect = Effect.fn('Agents.reserveRecoveryOwner')(
    function* (this: Agents, value: unknown) {
      yield* this.nativeRecoverySupportEffect('reserve')
      const decoded = yield* Schema.decodeUnknownEffect(recoveryReservationSchema)(value).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('reserve', 'The Studio preparation reservation is invalid.', cause),
        ),
      )
      yield* Effect.tryPromise({
        try: () => this.ensureNativeRecovery(),
        catch: (cause) =>
          this.recoveryError(
            'reserve',
            'Native owners could not be reconciled before Studio preparation.',
            cause,
          ),
      })
      yield* Schema.decodeUnknownEffect(nativeRecoveryStartInputSchema)(decoded.input).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('reserve', 'The exact Studio input is invalid.', cause),
        ),
      )
      const input = decoded.input as unknown as StartInput
      const profile = this.ssh.state.profile
      const home = this.ssh.state.home
      const planner = decoded.clientRecovery
      if (
        !this.nativeRecovery ||
        this.ssh.state.status !== 'connected' ||
        !profile ||
        !home?.startsWith('/') ||
        input.scope !== 'life-customization' ||
        input.mode !== 'plan' ||
        !input.sessionId ||
        typeof input.prompt !== 'string' ||
        !['codex', 'claude'].includes(input.provider) ||
        planner.sessionId !== input.sessionId ||
        planner.profileId !== profile.id ||
        planner.provider !== input.provider ||
        planner.phase !== 'preparing' ||
        planner.nativeIteration !== 0 ||
        planner.request !== input.prompt
      )
        return yield* this.recoveryError(
          'reserve',
          'The exact Studio preparation does not belong to the connected machine.',
        )
      this.assertRecovered(input.sessionId)
      if (this.sessions.get(input.sessionId)?.busy)
        return yield* this.recoveryError('reserve', 'This Studio native turn is still active.')
      const snapshots = yield* this.nativeRecovery.listTransports()
      const generation =
        snapshots.reduce(
          (highest, snapshot) =>
            Math.max(
              highest,
              ...snapshot.transport.owners
                .filter((owner) => owner.sessionId === input.sessionId)
                .map((owner) => owner.generation ?? 0),
            ),
          -1,
        ) + 1
      const workspace = `${home.replace(/\/+$/, '')}/.life/customization/${createHash('sha256').update(input.sessionId).digest('hex')}`
      const token = randomUUID()
      const id = randomUUID()
      const owner: NativeRecoveryOwner = {
        ownerId: input.sessionId,
        sessionId: input.sessionId,
        kind: 'root',
        workspace,
        writableRoot: workspace,
        generation,
        snapshotToken: token,
        localTurn: input.localTurn ?? 0,
        state: 'idle',
        phase: 'initializing',
        input: { ...decoded.input, workspace },
        clientRecovery: decoded.clientRecovery,
      }
      const snapshot = yield* this.nativeRecovery.createTransport({
        id,
        brokerId: id,
        brokerRoot: `${home.replace(/\/+$/, '')}/.life/agents`,
        launchCommand: 'life:studio-preparation-only',
        provider: input.provider,
        providerVersion: this.ssh.state[input.provider] || 'unstarted',
        nativeProtocol: 'life-studio-planner-v1',
        brokerProtocolVersion: 2,
        machine: {
          transport: profile.transport ?? 'ssh',
          profileId: profile.id,
          host: profile.host,
          port: profile.port,
          username: profile.username,
        },
        controller: { id: randomUUID(), epoch: 0 },
        initialization: { status: 'not-started' },
        owners: [owner],
      })
      this.recoveryReservations.set(input.sessionId, snapshot)
      this.recoverySnapshots.set(id, snapshot)
      this.recoveryLoaded.add(id)
      this.recovery.seed(snapshot)
      if (!this.sessions.has(input.sessionId)) this.restoreOwner(owner, snapshot)
      return {
        sessionId: input.sessionId,
        transportId: id,
        status: 'idle',
        snapshotToken: token,
        ownerGeneration: generation,
        originalInput: this.publicRecoveryInput(owner),
        localTurn: owner.localTurn,
        provider: input.provider,
        clientRecovery: owner.clientRecovery,
        throughEventRevision: 0,
        acceptedAppliedRevision: 0,
        pending: [],
        currentChildren: [],
      } satisfies NativeRecoveryOwnerState
    }.bind(this),
  )
  reserveRecoveryOwner(value: unknown) {
    return runEffect(this.reserveRecoveryOwnerEffect(value))
  }
  readonly updateRecoveryOwnerEffect = Effect.fn('Agents.updateRecoveryOwner')(
    function* (
      this: Agents,
      input: {
        sessionId: string
        clientRecovery: unknown
        transportId?: string
        ownerGeneration?: number
        projectionAdmissions?: readonly ConversationProjectionAdmission[]
      },
    ) {
      yield* this.nativeRecoverySupportEffect('owner-update')
      this.assertRecovered(input.sessionId, false, true)
      const reserved = this.recoveryReservations.get(input.sessionId)
      if (reserved && (!input.transportId || input.transportId === reserved.transport.id)) {
        const owner = reserved.transport.owners.find(
          (value) => value.kind === 'root' && value.sessionId === input.sessionId,
        )!
        if (input.ownerGeneration !== undefined && input.ownerGeneration !== owner.generation)
          return yield* this.recoveryError(
            'owner',
            'This preparation checkpoint belongs to an older native reservation.',
          )
        const clientRecovery = yield* Schema.decodeUnknownEffect(Schema.Json)(
          input.clientRecovery,
        ).pipe(
          Effect.mapError((cause) =>
            this.recoveryError('owner', 'The preparation state is invalid.', cause),
          ),
        )
        yield* this.recovery.updateOwnerEffect(
          reserved.transport.id,
          { ...owner, clientRecovery },
          input.projectionAdmissions,
        )
        const updated = yield* this.nativeRecovery!.readTransport(reserved.transport.id)
        this.recoveryReservations.set(input.sessionId, updated)
        this.recoverySnapshots.set(reserved.transport.id, updated)
        return
      }
      const session = this.sessions.get(input.sessionId)
      if (!session?.recoveryTransportId)
        return yield* this.recoveryError('owner', 'This session has no admitted native owner.')
      if (
        (input.transportId !== undefined && input.transportId !== session.recoveryTransportId) ||
        (input.ownerGeneration !== undefined &&
          input.ownerGeneration !== session.recoveryGeneration)
      )
        return yield* this.recoveryError(
          'owner',
          'This renderer checkpoint belongs to an older native owner.',
        )
      const clientRecovery = yield* Schema.decodeUnknownEffect(Schema.Json)(
        input.clientRecovery,
      ).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('owner', 'Renderer recovery state must be JSON.', cause),
        ),
      )
      session.input = { ...session.input, clientRecovery }
      yield* this.recovery.updateOwnerEffect(
        session.recoveryTransportId,
        this.recoveryOwner(session),
        input.projectionAdmissions,
      )
    }.bind(this),
  )
  updateRecoveryOwner(input: unknown) {
    if (this.rendererSuspended)
      return Promise.reject(
        this.recoveryError(
          'owner',
          'This renderer has been suspended. Its recovery checkpoint was not admitted.',
        ),
      )
    const updated = runEffect(
      Schema.decodeUnknownEffect(recoveryOwnerInputSchema)(input).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('owner', 'The renderer owner checkpoint is invalid.', cause),
        ),
        Effect.flatMap((decoded) => this.updateRecoveryOwnerEffect(decoded)),
      ),
    )
    this.pendingOwnerUpdates.add(updated)
    void updated.finally(() => this.pendingOwnerUpdates.delete(updated)).catch(() => {})
    return updated
  }
  readonly assertRecoveryActionOwnerEffect = Effect.fn('Agents.assertRecoveryActionOwner')(
    function* (this: Agents, input: NativeRecoveryActionRequest) {
      yield* this.nativeRecoverySupportEffect('action')
      yield* Effect.tryPromise({
        try: () => this.ensureNativeRecovery(),
        catch: (cause) =>
          this.recoveryError('action', 'Native Studio ownership could not be recovered.', cause),
      })
      this.assertRecovered(input.sessionId)
      const session = this.sessions.get(input.sessionId)
      const reservation = this.recoveryReservations.get(input.sessionId)
      const reserved = reservation?.transport.id === input.transportId
      if (
        (!session && !reserved) ||
        !this.nativeRecovery ||
        (!reserved &&
          (session!.recoveryTransportId !== input.transportId ||
            session!.recoveryGeneration !== input.ownerGeneration ||
            session!.input.scope !== 'life-customization' ||
            session!.machineIdentity !== this.machineIdentity()))
      )
        return yield* this.recoveryError(
          'action',
          'The Studio action does not belong to the admitted native owner.',
        )
      const snapshot = yield* this.nativeRecovery.readTransport(input.transportId)
      const owner = snapshot.transport.owners.find(
        (value) => value.kind === 'root' && value.sessionId === input.sessionId,
      )
      if (
        !owner ||
        (!reserved && owner.snapshotToken !== session!.recoverySnapshotToken) ||
        owner.generation !== input.ownerGeneration ||
        snapshot.transport.machine.profileId !== this.ssh.state.profile?.id ||
        owner.state === 'unknown'
      )
        return yield* this.recoveryError(
          'action',
          'The Studio action registry owner could not be verified.',
        )
      const planner = object(owner.clientRecovery)
      const action = object(planner.action)
      const kinds: Record<string, NativeRecoveryActionRequest['kind']> = {
        'read-source': 'source-read',
        'apply-source': 'source-apply',
        'apply-settings': 'settings-apply',
        'apply-extension': 'extension-apply',
        'reload-source': 'reload',
      }
      const intent = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(action.intent).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('action', 'The registered Studio action intent is invalid.', cause),
        ),
      )
      const requestedIntent = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
        input.intent,
      ).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('action', 'The requested Studio action intent is invalid.', cause),
        ),
      )
      if (
        planner.sessionId !== input.sessionId ||
        planner.profileId !== snapshot.transport.machine.profileId ||
        planner.provider !== snapshot.transport.provider ||
        action.id !== input.actionId ||
        kinds[string(action.kind)] !== input.kind ||
        !['intended', 'started', 'succeeded', 'failed'].includes(string(action.status)) ||
        nativeRecoveryActionIntentHash({ ...input, intent }) !==
          nativeRecoveryActionIntentHash({ ...input, intent: requestedIntent })
      )
        return yield* this.recoveryError(
          'action',
          'The Studio action does not match the exact recorded intent.',
        )
      return planner.phase === 'finished' || planner.terminal !== undefined
        ? ('reconcile-only' as const)
        : ('perform' as const)
    }.bind(this),
  )
  assertRecoveryActionOwner(input: NativeRecoveryActionRequest) {
    return runEffect(this.assertRecoveryActionOwnerEffect(input))
  }
  acknowledgeRecoveryHistory(receipt: unknown) {
    return runEffect(
      this.nativeRecoverySupportEffect('history-ack')
        .pipe(Effect.flatMap(() => Schema.decodeUnknownEffect(recoveryReceiptSchema)(receipt)))
        .pipe(
          Effect.mapError((cause) =>
            this.recoveryError('history-ack', 'The renderer history receipt is invalid.', cause),
          ),
          Effect.flatMap((decoded) =>
            this.recovery.acknowledgeHistoryEffect(decoded, this.recoveryConsumers),
          ),
        ),
    )
  }
  readonly detachEffect = Effect.fn('Agents.detach')(
    function* (this: Agents) {
      yield* this.recovery.flushEffect()
      for (const claim of [...this.freshProviderChannels.values()])
        yield* this.failFreshProviderChannelEffect(
          claim.channel,
          new Error('Life detached from its original provider opening.'),
        )
      for (const [id, { channel }] of this.ownerlessClaudeAttachments)
        yield* Effect.tryPromise({
          try: () => channel.detach?.() || Promise.resolve(),
          catch: (cause) =>
            this.recoveryError(
              'detach',
              'The original ownerless Claude attachment could not be detached.',
              cause,
            ),
        }).pipe(Effect.ensuring(Effect.sync(() => this.removeOwnerlessClaudeObserver(id))))
      for (const [channel] of this.pendingProviderExits)
        if (channel.detach)
          yield* Effect.tryPromise({
            try: () => channel.detach!(),
            catch: (cause) =>
              this.recoveryError(
                'detach',
                'The retiring native attachment could not be detached.',
                cause,
              ),
          })
      for (const rpc of this.codexTransports) yield* rpc.detachEffect()
      for (const session of this.sessions.values()) {
        session.titleTask?.abort()
        const channel = session.channel as DurableChannel | undefined
        if (channel?.detach)
          yield* Effect.tryPromise({
            try: () => channel.detach!(),
            catch: (cause) =>
              this.recoveryError('detach', 'Native attachment could not be detached.', cause),
          })
      }
      if (this.nativeRecovery) yield* this.nativeRecovery.flushEffect()
    }.bind(this),
  )
  detach() {
    return runEffect(this.detachEffect())
  }
  async flushRecovery(joinAcquisitions = true) {
    if (joinAcquisitions) await Promise.allSettled([...this.pendingCodexAcquisitions.values()])
    await Promise.allSettled([...this.pendingOwnerUpdates, ...this.pendingReceiptReconciliations])
    const channels = new Set<DurableChannel>([
      ...this.openingCodexChannels.keys(),
      ...[...this.freshProviderChannels.values()].map((owner) => owner.channel),
      ...[...this.ownerlessClaudeAttachments.values()].map((owner) => owner.channel),
      ...[...this.deferredRecoveryAttachments.values()].map((owner) => owner.channel),
      ...this.pendingProviderExits.keys(),
      ...[...this.codexTransports].map((rpc) => rpc.channel as DurableChannel),
    ])
    for (const session of this.sessions.values()) {
      if (session.channel) channels.add(session.channel as DurableChannel)
      if (session.codexRPC) channels.add(session.codexRPC.channel as DurableChannel)
    }
    const flushed = await runEffect(
      Effect.forEach(
        channels,
        (channel) =>
          Effect.tryPromise({
            try: () => channel.flushRecovery?.() ?? Promise.resolve(),
            catch: (cause) =>
              cause instanceof NativeRecoveryError
                ? cause
                : this.recoveryError(
                    'flush',
                    'An accepted native input could not be durably flushed.',
                    cause,
                  ),
          }).pipe(Effect.exit),
        { concurrency: 'unbounded' },
      ),
    )
    await runEffect(this.recovery.flushEffect())
    for (const result of flushed)
      if (Exit.isFailure(result)) await runEffect(Effect.failCause(result.cause))
  }
  readonly authorizeRecoveryReceiptEffect = Effect.fn('Agents.authorizeRecoveryReceipt')(
    function* (
      this: Agents,
      candidate: ConversationRecoveryProof,
      admissions: readonly ConversationProjectionAdmission[] = [],
    ) {
      yield* this.nativeRecoverySupportEffect('history-prepare')
      return yield* this.recovery.authorizeRecoveryReceiptEffect(candidate, admissions)
    }.bind(this),
  )
  readonly acknowledgeRecoveredHistoryProofEffect = Effect.fn(
    'Agents.acknowledgeRecoveredHistoryProof',
  )(
    function* (this: Agents, proof: ConversationRecoveryProof) {
      yield* this.nativeRecoverySupportEffect('history-proof')
      yield* this.recovery.acknowledgeRecoveredHistoryProofEffect(proof)
    }.bind(this),
  )
  acknowledgeRecoveredHistoryProof(proof: ConversationRecoveryProof) {
    return runEffect(this.acknowledgeRecoveredHistoryProofEffect(proof))
  }
  readonly admitLoadedHistoryProofEffect = Effect.fn('Agents.admitLoadedHistoryProof')(
    function* (this: Agents, proof: ConversationRecoveryProof) {
      yield* this.nativeRecoverySupportEffect('history-load')
      return yield* this.recovery.admitLoadedHistoryProofEffect(proof)
    }.bind(this),
  )
  readonly prepareRecoveryCacheEffect = Effect.fn('Agents.prepareRecoveryCache')(
    function* (this: Agents, value: unknown) {
      yield* this.nativeRecoverySupportEffect('cache-prepare')
      const input = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          snapshotId: Schema.NonEmptyString,
          hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          savedAt: recoveryNatural,
          projectionAdmissions: Schema.Array(recoveryProjectionAdmissionSchema),
          membershipAdmissions: Schema.optionalKey(Schema.Array(recoveryProjectionAdmissionSchema)),
        }),
      )(value).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('cache-prepare', 'The native cache preparation is invalid.', cause),
        ),
      )
      yield* this.recovery.prepareRecoveryCacheEffect(input)
    }.bind(this),
  )
  prepareRecoveryCache(value: unknown) {
    return runEffect(this.prepareRecoveryCacheEffect(value))
  }
  readonly attestRecoveryCacheEffect = Effect.fn('Agents.attestRecoveryCache')(
    function* (this: Agents, value: unknown) {
      yield* this.nativeRecoverySupportEffect('cache-attest')
      const input = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
      )(value).pipe(
        Effect.mapError((cause) =>
          this.recoveryError('cache-attest', 'The native cache hash is invalid.', cause),
        ),
      )
      return yield* this.recovery.attestRecoveryCacheEffect(input)
    }.bind(this),
  )
  attestRecoveryCache(value: unknown) {
    return runEffect(this.attestRecoveryCacheEffect(value))
  }
  detachForShutdown() {
    return this.detach()
  }
  /** Renderer replacement changes delivery admission, never native process ownership. */
  pauseRendererRecovery() {
    this.rendererSuspended = true
    this.recoveryConsumers = []
    this.recoveryMembershipAdmissions = []
  }
  suspendRendererConsumers() {
    this.pauseRendererRecovery()
  }
  finalizeRendererSuspension() {
    this.recovery.revokeDeliveryTokens()
  }
  readonly acknowledgeCommittedHistoryEffect = Effect.fn('Agents.acknowledgeCommittedHistory')(
    function* (this: Agents, ack: ConversationCheckpointAck) {
      yield* this.nativeRecoverySupportEffect('history-commit')
      yield* this.recovery.acknowledgeMainHistoryEffect(ack)
    }.bind(this),
  )
  acknowledgeCommittedHistory(ack: ConversationCheckpointAck) {
    const pending = [...this.pendingHistoryReceipts, ack]
    this.pendingHistoryReceipts = pending
    return runEffect(
      Effect.forEach(pending, (receipt) => this.acknowledgeCommittedHistoryEffect(receipt)),
    ).then(() => {
      this.pendingHistoryReceipts = this.pendingHistoryReceipts.filter(
        (receipt) => !pending.includes(receipt),
      )
    })
  }
  private getCodex(machine = this.machineIdentity()): Promise<RPC> {
    this.assertEnvironmentAdmission(machine)
    if (machine !== this.machineIdentity())
      throw new Error('Reconnect to this agent’s saved machine before acquiring Codex')
    const priorRelease = this.idleProviderRelease
    let allocationRegistered!: () => void
    const allocation = new Promise<void>((resolve) => {
      allocationRegistered = () => {
        this.registeredCodexAllocations.add(allocation)
        resolve()
      }
    })
    const acquisition = Promise.resolve().then(() =>
      this.getCodexOwned(priorRelease, allocationRegistered, allocation, machine),
    )
    this.pendingCodexAcquisitions.set(acquisition, allocation)
    void acquisition
      .finally(() => {
        allocationRegistered()
        this.pendingCodexAcquisitions.delete(acquisition)
      })
      .catch(() => {})
    return acquisition
  }
  private async getCodexOwned(
    priorRelease: Promise<boolean[]> | undefined,
    allocationRegistered: () => void,
    allocation: Promise<void>,
    expectedMachine: string,
  ): Promise<RPC> {
    if (priorRelease) await priorRelease
    await runEffect(this.providerDiscoveryEffect())
    if (this.ssh.state.status !== 'connected' || this.machineIdentity() !== expectedMachine)
      throw new Error('The connected machine changed before acquiring Codex')
    await this.ensureNativeRecovery()
    if (this.ssh.state.status !== 'connected' || this.machineIdentity() !== expectedMachine)
      throw new Error('The connected machine changed while recovering Codex')
    this.assertRecovered('')
    const transportFailure = this.recoveryFailures.get(`transport:${this.machineIdentity()}`)
    if (transportFailure) throw this.recoveryError('codex.recover', transportFailure)
    this.refreshModelCatalogIdentity()
    const machine = this.machineIdentity()
    this.assertProviderRetirement('codex', machine)
    if (
      [...this.deferredRecoveryAttachments.values()].some(
        (attachment) => attachment.machine === machine,
      )
    )
      throw this.recoveryError(
        'delivery',
        'The original Codex attachment is awaiting its exact native input and initialization proof. Life retained it read-only.',
      )
    for (const closing of this.intentionalIdleClosing)
      if (this.codexTransportMachines.get(closing) === machine) {
        const id = (closing.channel as DurableChannel).recoveryId
        const snapshot =
          id && this.nativeRecovery
            ? await runEffect(this.nativeRecovery.readTransport(id))
            : undefined
        if (this.ssh.state.status !== 'connected' || this.machineIdentity() !== expectedMachine)
          throw new Error(
            'The connected machine changed while confirming original Codex retirement',
          )
        if (!snapshot?.outputs.some(isConfirmedNativeExit))
          throw this.recoveryError(
            'closing',
            'The previous Codex process has not produced its terminal receipt. Life did not open a replacement writer.',
          )
        this.intentionalIdleClosing.delete(closing)
        this.codexTransports.delete(closing)
        if (this.codexByMachine.get(machine) === closing) this.codexByMachine.delete(machine)
      }
    const cliVersion = this.ssh.state.codex || ''
    const openingKey = JSON.stringify([machine, cliVersion])
    const existing = this.codexByMachine.get(machine)
    if (
      existing &&
      !existing.closed &&
      ((existing.channel as DurableChannel).recoveryId ||
        this.codexTransportVersions.get(existing) === cliVersion)
    ) {
      if ((existing.channel as DurableChannel).hasUnconfirmedRecoveryInputs)
        throw this.recoveryError(
          'delivery',
          'The original Codex input is awaiting its exact delivery or processing proof. Life retained the same connection read-only.',
        )
      if (this.codex !== existing) this.clearCodexModelCatalogs()
      this.codex = existing
      allocationRegistered()
      return existing
    }
    const opening = this.codexStartingByMachine.get(openingKey)
    if (opening) {
      const registered = this.codexStartingAllocationByMachine.get(openingKey)
      if (registered) void registered.then(allocationRegistered)
      else allocationRegistered()
      return opening
    }
    this.codexStartingAllocationByMachine.set(openingKey, allocation)
    const generation = this.generation
    ++this.codexGeneration
    const starting = (async () => {
      const version = /codex(?:-cli)?\s+(\d+)\.(\d+)/.exec(this.ssh.state.codex || '')
      const supportsLiveSettings = version && (Number(version[1]) > 0 || Number(version[2]) >= 162)
      let openingChannel: DurableChannel | undefined
      let channel: ClientChannel
      try {
        channel = await this.providerChannel(
          `cd ${shellQuote(this.ssh.state.workspace || this.ssh.state.home || '/')} && exec codex app-server --listen stdio://${supportsLiveSettings ? ' -c features.step_model_switching=true' : ''}`,
          (opened) => {
            openingChannel = opened as DurableChannel
            this.openingCodexChannels.set(openingChannel, machine)
            allocationRegistered()
          },
          'codex',
          machine,
        )
      } finally {
        if (openingChannel) this.openingCodexChannels.delete(openingChannel)
      }
      allocationRegistered()
      if ((channel as DurableChannel).isClosing) {
        const error = new Error('Life closed its idle Codex connection.')
        await this.failFreshProviderChannel(channel as DurableChannel, error)
        throw error
      }
      if (this.generation !== generation) {
        const error = new Error('SSH connection cancelled')
        await this.failFreshProviderChannel(channel as DurableChannel, error)
        if (!(channel as DurableChannel).recoveryId) channel.close()
        throw error
      }
      const rpc = new RPC(
        channel,
        (message) => {
          if (this.generation === generation && this.codexTransports.has(rpc))
            this.handleCodexWire(message, rpc)
        },
        (error) => {
          if (this.intentionalIdleClosing.has(rpc)) return
          const recoveryId = (channel as DurableChannel).recoveryId
          if (recoveryId && this.terminalTransports.has(recoveryId)) return
          if ((channel as DurableChannel).recoveryId) {
            for (const [id, session] of this.sessions)
              if (session.codexRPC === rpc || this.hasCodexChildren(id, rpc))
                this.markRecoveryUnknown(id, error.message)
            return
          }
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
            if (session.codexRPC === rpc || this.hasCodexChildren(id, rpc)) {
              this.finishCodexChildren(id, session, 'failed', rpc)
              this.resolveCodexRequests(id, session, rpc)
              if (session.codexRPC === rpc && session.remoteId)
                this.threads.delete(session.remoteId)
              for (const [remoteId, child] of this.childThreads)
                if (child.sessionId === id && child.rpc === rpc) this.childThreads.delete(remoteId)
              if (session.codexRPC === rpc && session.busy && !session.stopRequested) {
                session.busy = false
                this.event(id, { type: 'error', text: error.message })
              }
            }
        },
        {
          onResponse: (message, semantic) => {
            const id = (channel as DurableChannel).recoveryId
            if (id) this.orphanCodexResponse(id, rpc, message, semantic)
          },
        },
      )
      if ((channel as DurableChannel).recoveryId)
        this.codexRecoveryIds.set(rpc, (channel as DurableChannel).recoveryId!)
      this.codexTransportVersions.set(rpc, cliVersion)
      this.codexTransportMachines.set(rpc, machine)
      this.codexTransports.add(rpc)
      this.transportEvents(channel, () =>
        [...this.sessions].filter(
          ([, session]) => session.machineIdentity === machine && session.codexRPC === rpc,
        ),
      )
      try {
        const recoveryId = (channel as DurableChannel).recoveryId
        if (recoveryId && this.nativeRecovery)
          await runEffect(
            this.nativeRecovery.updateTransport(recoveryId, {
              initialization: { status: 'pending', requestId: rpc.nextRequestId },
            }),
          )
        await rpc.request('initialize', {
          clientInfo: { name: 'life_desktop', title: 'Life', version: LIFE_VERSION },
          capabilities: { experimentalApi: true },
        })
        if (this.generation !== generation) throw new Error('SSH connection cancelled')
        await rpc.sendAndWait({ method: 'initialized', params: {} })
        if (recoveryId && this.nativeRecovery)
          await runEffect(
            this.nativeRecovery.updateTransport(recoveryId, {
              initialization: { status: 'complete' },
            }),
          )
        if (recoveryId) this.recoveryLoaded.add(recoveryId)
        this.adoptFreshProviderChannel(channel as DurableChannel)
        if (machine === this.machineIdentity() && cliVersion === (this.ssh.state.codex || '')) {
          this.codexByMachine.set(machine, rpc)
          if (this.codex !== rpc) this.clearCodexModelCatalogs()
          this.codex = rpc
        }
        return rpc
      } catch (error) {
        await this.failFreshProviderChannel(channel as DurableChannel, error)
        rpc.close(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })()
    this.codexStarting = starting
    this.codexStartingByMachine.set(openingKey, starting)
    try {
      return await starting
    } finally {
      if (this.codexStarting === starting) this.codexStarting = undefined
      if (this.codexStartingByMachine.get(openingKey) === starting) {
        this.codexStartingByMachine.delete(openingKey)
        this.codexStartingAllocationByMachine.delete(openingKey)
      }
    }
  }
  async models(provider: Provider): Promise<ModelOption[]> {
    this.assertEnvironmentAdmission()
    const machine = this.machineIdentity()
    if (this.ssh.state.providerVersionsStatus === 'checking')
      await runEffect(this.providerDiscoveryEffect())
    this.assertEnvironmentAdmission()
    if (machine !== this.machineIdentity())
      throw new Error('The connected machine changed while checking providers')
    return this.readModels(provider)
  }
  private async readModels(provider: Provider): Promise<ModelOption[]> {
    if (this.ssh.state.providerVersionsStatus === 'checking')
      await runEffect(this.providerDiscoveryEffect())
    if (this.ssh.state.status !== 'connected') throw new Error('Connect to a machine first')
    this.refreshModelCatalogIdentity()
    if (provider === 'claude') return this.discoverClaudeModels()
    const generation = this.generation
    const machine = this.machineIdentity()
    const cliVersion = this.ssh.state.codex
    const rpc = await this.getCodex()
    const catalogGeneration = this.catalogGeneration
    const codexCatalogGeneration = this.codexCatalogGeneration
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
      cliVersion !== this.ssh.state.codex ||
      catalogGeneration !== this.catalogGeneration ||
      codexCatalogGeneration !== this.codexCatalogGeneration
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
  async usage(provider: Provider): Promise<ProviderUsageSnapshot> {
    this.assertEnvironmentAdmission()
    const machine = this.machineIdentity()
    if (this.ssh.state.providerVersionsStatus === 'checking')
      await runEffect(this.providerDiscoveryEffect())
    this.assertEnvironmentAdmission()
    if (machine !== this.machineIdentity())
      throw new Error('The connected machine changed while checking providers')
    const unavailable = (message: string): ProviderUsageSnapshot => ({
      provider,
      machineIdentity: machine,
      status: 'unavailable',
      fetchedAt: Date.now(),
      limits: [],
      message,
    })
    if (this.ssh.state.status !== 'connected')
      return unavailable('Connect to a machine to read provider account limits.')
    if (provider === 'claude')
      try {
        return await this.readClaudeAccountUsage()
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : String(error))
      }
    const generation = this.generation
    try {
      const rpc = await this.getCodex()
      const accountRevision = this.codexAccountRevisions.get(rpc) || 0
      const response = await rpc.request('account/rateLimits/read', {}, 15000)
      if (machine !== this.machineIdentity() || generation !== this.generation)
        throw new Error('The connected machine changed while reading account limits.')
      if (accountRevision !== (this.codexAccountRevisions.get(rpc) || 0))
        throw new Error('Codex account changed while reading limits. Refresh account limits.')
      const snapshot = { ...codexUsageSnapshot(response), machineIdentity: machine }
      this.codexUsageSnapshots.set(rpc, snapshot)
      return snapshot
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }
  private async readClaudeAccountUsage(): Promise<ProviderUsageSnapshot> {
    const machine = this.machineIdentity()
    const generation = this.generation
    const current = () => {
      if (
        machine !== this.machineIdentity() ||
        generation !== this.generation ||
        this.ssh.state.status !== 'connected'
      )
        throw new Error('The connected machine changed while reading Claude account limits.')
    }
    const session = [...this.sessions.values()].find(
      (item) =>
        item.input.provider === 'claude' &&
        item.machineIdentity === machine &&
        !item.stopRequested &&
        item.phase === 'running' &&
        item.channel &&
        !item.channel.destroyed,
    )
    if (session) {
      const controller = new AbortController()
      const cancelled = () => controller.abort()
      this.ssh.on('disconnected', cancelled)
      this.ssh.on('workspace-changing', cancelled)
      try {
        const response = await this.claudeControl(
          session,
          { subtype: 'get_usage', skip_behaviors: true },
          15000,
          controller.signal,
        )
        current()
        return {
          ...normalizeClaudeUsageSnapshot(response, Date.now(), {
            ...session.claudeAccount,
            subscriptionType: session.claudeSubscriptionType,
          }),
          machineIdentity: machine,
        }
      } finally {
        this.ssh.off('disconnected', cancelled)
        this.ssh.off('workspace-changing', cancelled)
      }
    }
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
    this.discoveryChannels.add(channel)
    const controls = claudeMetadataControls(channel)
    const cancelled = () => {
      controls.close()
      try {
        channel.signal('TERM')
      } catch {}
      try {
        channel.close()
      } catch {}
    }
    this.ssh.on('disconnected', cancelled)
    this.ssh.on('workspace-changing', cancelled)
    try {
      current()
      const initialized = await controls.request({ subtype: 'initialize', hooks: null }, 60000)
      current()
      const response = await controls.request({ subtype: 'get_usage', skip_behaviors: true })
      current()
      return {
        ...normalizeClaudeUsageSnapshot(response, Date.now(), initialized.account),
        machineIdentity: machine,
      }
    } finally {
      this.ssh.off('disconnected', cancelled)
      this.ssh.off('workspace-changing', cancelled)
      controls.close()
      this.discoveryChannels.delete(channel)
      try {
        channel.signal('TERM')
      } catch {}
      try {
        channel.close()
      } catch {}
    }
  }
  private async validateCodexAttachments(
    model: string | undefined,
    attachments?: AgentAttachment[],
  ) {
    if (!attachments?.length) return
    const images = codexUserInput('', attachments).some((item) => item.type === 'localImage')
    if (!images) return
    if (!this.codexModels) await this.models('codex')
    const capability = this.codexModels?.find((item) => item.id === (model || ''))
    if (capability?.inputModalities && !capability.inputModalities.includes('image'))
      throw new Error(
        `${capability.name} does not support image input. Choose a model that accepts images or remove the image attachments.`,
      )
  }
  private async discoverClaudeModels(): Promise<ModelOption[]> {
    this.refreshModelCatalogIdentity()
    if (this.claudeModels) return this.claudeModels
    if (this.claudeModelsStarting) return this.claudeModelsStarting
    const generation = this.generation
    const machine = this.machineIdentity()
    const cliVersion = this.ssh.state.claude
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
      const controls = claudeMetadataControls(channel)
      try {
        const result = await controls.request({ subtype: 'initialize', hooks: null }, 60000)
        if (
          generation !== this.generation ||
          machine !== this.machineIdentity() ||
          cliVersion !== this.ssh.state.claude ||
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
        controls.close()
        this.discoveryChannels.delete(channel)
        try {
          channel.signal('TERM')
        } catch {}
        try {
          channel.close()
        } catch {}
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
    const codexCatalogGeneration = this.codexCatalogGeneration
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
        catalogGeneration !== this.catalogGeneration ||
        codexCatalogGeneration !== this.codexCatalogGeneration
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
    this.assertEnvironmentAdmission()
    if (this.pendingStartAdmissions.has(input.sessionId))
      throw new Error('This thread is already starting')
    this.pendingStartAdmissions.set(input.sessionId, {
      machine: this.machineIdentity(),
      provider: input.provider,
    })
    const priorRelease =
      input.provider === 'codex' ? this.idleProviderRelease : this.idleClaudeProviderRelease
    const starting = this.startSession(input, this.generation, this.machineIdentity(), priorRelease)
    this.pendingNativeOperations.add(starting)
    this.pendingNativeOperationMachines.set(starting, this.machineIdentity())
    try {
      await starting
    } finally {
      this.pendingNativeOperations.delete(starting)
      this.pendingStartAdmissions.delete(input.sessionId)
    }
  }
  private async startSession(
    input: StartInput,
    generation: number,
    machine: string,
    priorRelease?: Promise<boolean[]>,
  ) {
    const assertCurrent = () => {
      if (
        this.generation !== generation ||
        this.machineIdentity() !== machine ||
        this.ssh.state.status !== 'connected'
      )
        throw new Error('Agent startup cancelled because its environment changed')
    }
    if (priorRelease) await priorRelease
    if (this.ssh.state.providerVersionsStatus === 'checking')
      await runEffect(this.providerDiscoveryEffect())
    await runEffect(this.freshProviderSupportEffect())
    assertCurrent()
    this.assertProviderRetirement(input.provider, machine)
    const prior = this.sessions.get(input.sessionId)
    if (
      prior?.recoveryTransportId &&
      this.terminalTransports.has(prior.recoveryTransportId) &&
      (prior.stopping || this.recoveredStops.has(input.sessionId))
    )
      await this.continueRecoveredStop(prior)
    if (prior) this.assertRecovered(input.sessionId)
    if (prior?.stopping || this.recoveredStops.has(input.sessionId))
      throw this.recoveryError(
        'start',
        'The original native Stop has not settled. Wait for its terminal completion before sending another turn.',
      )
    await this.ensureNativeRecovery()
    assertCurrent()
    this.assertRecovered(input.sessionId)
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
    if (old?.stopping || this.recoveredStops.has(input.sessionId))
      throw this.recoveryError(
        'start',
        'The original native Stop has not settled. Wait for its terminal completion before sending another turn.',
      )
    const reservation = this.recoveryReservations.get(input.sessionId)
    const reservedOwner = reservation?.transport.owners.find(
      (owner) => owner.kind === 'root' && owner.sessionId === input.sessionId,
    )
    let nativeStartIntentId: string | undefined
    if (reservation && reservedOwner && this.nativeRecovery) {
      if (
        input.scope !== 'life-customization' ||
        input.provider !== reservation.transport.provider ||
        input.prompt !== object(reservedOwner.clientRecovery).request ||
        input.localTurn !== reservedOwner.localTurn ||
        reservedOwner.linkedTransportId
      )
        throw this.recoveryError(
          'start',
          'This provider start does not match the private Studio preparation.',
        )
      nativeStartIntentId = reservedOwner.nativeStartIntentId || randomUUID()
      await runEffect(
        this.recovery.updateOwnerEffect(reservation.transport.id, {
          ...reservedOwner,
          nativeStartClaimed: true,
          nativeStartIntentId,
        }),
      )
      assertCurrent()
      const updatedReservation = await runEffect(
        this.nativeRecovery.readTransport(reservation.transport.id),
      )
      assertCurrent()
      this.recoveryReservations.set(input.sessionId, updatedReservation)
    }
    assertCurrent()
    if (old?.busy) throw new Error('This thread is already running')
    if (old && old.input.provider !== input.provider)
      throw new Error('Start a new thread to change providers')
    if (old && old.input.scope !== input.scope)
      throw new Error('This conversation belongs to a different workspace view')
    if (old && old.machineIdentity !== this.machineIdentity())
      throw new Error('Reconnect to this thread’s saved machine before continuing it')
    this.stopCompletions.delete(input.sessionId)
    this.recoveredStops.delete(input.sessionId)
    this.refreshModelCatalogIdentity()
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
      recoveryGeneration:
        Math.max(old?.recoveryGeneration ?? -1, reservedOwner?.generation ?? -1) + 1,
      nativeStartIntentId,
      recoverySnapshotToken: randomUUID(),
      input,
      machineIdentity: this.machineIdentity(),
      codexRPC: undefined,
      busy: true,
      approvals:
        input.provider === 'codex'
          ? new Map(
              [...(old?.approvals || [])].filter(([, approval]) =>
                this.childThreads.has(string(approval.params.threadId)),
              ),
            )
          : new Map(),
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
      claudeMessageIds: new Map(old?.claudeMessageIds || []),
      claudeAgentNames: old?.claudeAgentNames || new Map(),
      claudeStateAware: old?.claudeStateAware,
      claudeState: old?.claudeState,
      claudeUsageCallId: old?.claudeUsageCallId,
      claudeCodeVersion: old?.claudeCodeVersion,
      claudeAccount: old?.claudeAccount,
      claudeSubscriptionType: old?.claudeSubscriptionType,
      claudeActiveChildren: old?.claudeActiveChildren,
      claudeTaskRuns: old?.claudeTaskRuns,
      claudeFastModeNeedsOptIn: old?.claudeFastModeNeedsOptIn,
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
      !old.claudeRestartForSettings &&
      old.workspace ===
        (input.scope ? input.workspace || old.workspace : this.ssh.state.workspace) &&
      JSON.stringify(old.input.providerOptions || {}) ===
        JSON.stringify(input.providerOptions || {})
    const activeSession = reuseClaude
      ? Object.assign(old, session, { controls: old.controls, approvals: old.approvals })
      : session
    if (!reuseClaude && old?.input.provider === 'claude') {
      this.resolveClaudeRequests(input.sessionId, old)
    }
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
      assertCurrent()
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
    if (session.machineIdentity !== this.machineIdentity()) return
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
    this.assertEnvironmentAdmission(session?.machineIdentity)
    const steering = this.steerSession(input)
    this.pendingNativeOperations.add(steering)
    this.pendingNativeOperationMachines.set(
      steering,
      session?.machineIdentity || this.machineIdentity(),
    )
    try {
      await steering
    } finally {
      this.pendingNativeOperations.delete(steering)
    }
  }
  private async steerSession(input: AgentSteerInput): Promise<void> {
    this.assertRecovered(input.sessionId)
    const session = this.sessions.get(input.sessionId)
    if (!session?.busy || session.stopRequested)
      throw new Error('The active turn has finished. Send this message as the next turn.')
    await session.startup
    this.assertRecovered(input.sessionId)
    if (this.sessions.get(input.sessionId) !== session || !session.busy || session.stopRequested)
      throw new Error('The active turn has finished. Your message was not sent.')
    if (session.input.provider === 'codex') {
      const rpc = session.codexRPC
      const turnId = session.turnId
      if (!rpc || rpc.closed || !turnId || !session.remoteId)
        throw new Error('The Codex turn is not ready for steering')
      await this.validateCodexAttachments(
        session.appliedModel || session.input.model,
        input.attachments,
      )
      if (this.sessions.get(input.sessionId) !== session || !session.busy || session.stopRequested)
        throw new Error('The active turn has finished. Your message was not sent.')
      await rpc.request(
        'turn/steer',
        {
          threadId: session.remoteId,
          expectedTurnId: turnId,
          input: codexUserInput(input.prompt, input.attachments),
        },
        60000,
        undefined,
        this.recoverySemantic(session, 'steer', { details: { prompt: input.prompt } }),
      )
    } else {
      const channel = session.channel
      if (!channel || channel.destroyed) throw new Error('Claude Code is disconnected')
      const content = await claudeUserContent(this.ssh, input.prompt, input.attachments)
      if (session.channel !== channel || !session.busy || session.stopRequested)
        throw new Error('The active turn has finished. Your message was not sent.')
      // `next` delivers at a provider boundary. `now` would interrupt Claude's
      // current generation; it is deliberately not used for steering.
      await this.writeClaudeAndWait(
        session,
        {
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          priority: 'next',
        },
        this.recoverySemantic(session, 'steer', { details: { prompt: input.prompt } }),
      )
    }
  }
  async configure(input: AgentSettingsInput): Promise<AgentConfigureResult> {
    this.assertRecovered(input.sessionId)
    const session = this.sessions.get(input.sessionId)
    this.assertEnvironmentAdmission(session?.machineIdentity)
    if (!session)
      return { applied: 'next-request', ...input, note: 'Used when this thread starts.' }
    const previous = session.configuration || Promise.resolve()
    let resolveOperation!: () => void
    const current = new Promise<void>((resolve) => {
      resolveOperation = resolve
    })
    session.configuration = current
    this.pendingNativeOperations.add(current)
    this.pendingNativeOperationMachines.set(current, session.machineIdentity)
    await previous.catch(() => {})
    try {
      await session.startup
      this.assertRecovered(input.sessionId)
      if (this.sessions.get(input.sessionId) !== session || session.stopRequested)
        throw new Error('This agent session changed. Try updating its settings again.')
      return await this.configureSession(session, input)
    } finally {
      resolveOperation()
      this.pendingNativeOperations.delete(current)
      if (session.configuration === current) session.configuration = undefined
    }
  }
  private async configureSession(
    session: Session,
    input: AgentSettingsInput,
  ): Promise<AgentConfigureResult> {
    this.refreshModelCatalogIdentity()
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
        const permissions =
          input.mode !== undefined ? codexPermissions(input.mode, session.writableRoot) : undefined
        const patch = {
          ...(input.model !== undefined ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(input.serviceTier !== undefined
            ? { serviceTier: input.serviceTier || this.codexDefaultTiers.get(model || '') || null }
            : {}),
          ...(permissions
            ? {
                approvalPolicy: permissions.approvalPolicy,
                approvalsReviewer: permissions.approvalsReviewer,
                sandboxPolicy: permissions.sandboxPolicy,
              }
            : {}),
        }
        const requestedSettings = {
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.reasoningEffort !== undefined
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
          ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        }
        const previousPermissions = codexPermissions(session.input.mode, session.writableRoot)
        const permissionBoundaryChanged = Boolean(
          permissions &&
          (permissions.approvalPolicy !== previousPermissions.approvalPolicy ||
            JSON.stringify(permissions.sandboxPolicy) !==
              JSON.stringify(previousPermissions.sandboxPolicy)),
        )
        const settingsSemantic = (nativeSettings: Wire) =>
          this.recoverySemantic(session, 'settings', {
            details: JSON.parse(
              JSON.stringify({ requestedSettings, permissionBoundaryChanged, nativeSettings }),
            ),
          })
        try {
          await rpc.request(
            'thread/settings/update',
            { threadId: session.remoteId, ...patch },
            15000,
            undefined,
            settingsSemantic(patch),
          )
          if (!ownsSession()) throw new Error('Agent session changed while applying settings')
          if (session.busy && session.turnId) {
            // The running-turn API accepts reviewer/model settings, but not
            // approvalPolicy or sandboxPolicy. Publish supported changes now.
            const {
              approvalPolicy: _approvalPolicy,
              sandboxPolicy: _sandboxPolicy,
              ...turnPatch
            } = patch
            try {
              const live = await rpc.request(
                'turn/settings/update',
                {
                  threadId: session.remoteId,
                  turnId: session.turnId,
                  ...turnPatch,
                },
                15000,
                undefined,
                settingsSemantic(turnPatch),
              )
              if (!ownsSession()) throw new Error('Agent session changed while applying settings')
              if (live.status === 'applied') {
                if (input.model !== undefined) session.appliedModel = model
                result.applied = permissionBoundaryChanged ? 'next-request' : 'live'
                result.note = permissionBoundaryChanged
                  ? 'Model and reviewer changes are live; sandbox changes apply to the next turn.'
                  : 'Applied at the next model step in this running turn.'
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
          } else result.note = 'Saved in the Codex thread without starting a turn.'
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
            mode: claudePermissionMode(input.mode),
          },
          15000,
          undefined,
          { requestedSettings: { mode: input.mode } },
        )
      if (input.model !== undefined)
        await this.claudeControl(
          session,
          { subtype: 'set_model', model: input.model || 'default' },
          15000,
          undefined,
          { requestedSettings: { model: input.model } },
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
      const fastNeedsRestart = settings.fastMode === true && session.claudeFastModeNeedsOptIn
      if (fastNeedsRestart) {
        session.claudeRestartForSettings = true
        session.input = { ...session.input, serviceTier: input.serviceTier }
        await this.recordRecoveryOwner(session, session.channel)
        delete settings.fastMode
      }
      if (Object.keys(settings).length)
        await this.claudeControl(
          session,
          { subtype: 'apply_flag_settings', settings },
          15000,
          undefined,
          {
            requestedSettings: {
              ...(input.reasoningEffort !== undefined
                ? { reasoningEffort: input.reasoningEffort }
                : {}),
              ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
            },
            claudeRestartForSettings: session.claudeRestartForSettings,
          },
        )
      if (!ownsSession()) throw new Error('Agent session changed while applying settings')
      result.applied = 'live'
      if (fastNeedsRestart) {
        result.applied = 'next-request'
        result.note =
          'Fast mode requires Claude session opt-in. The next turn will resume this conversation with Fast enabled.'
      } else if (input.serviceTier !== undefined) {
        result.applied = 'next-request'
        result.note =
          'Accepted without interrupting. Claude changes speed on the next turn; model and effort change at subsequent model requests.'
      } else result.note = 'Applied at Claude’s next model request without interrupting this turn.'
    }
    if (!ownsSession()) throw new Error('Agent session changed while applying settings')
    session.input = { ...session.input, ...input }
    if (session.input.provider === 'codex') {
      if (input.model !== undefined) session.appliedModel = input.model
      if (input.reasoningEffort !== undefined)
        session.appliedReasoningEffort = input.reasoningEffort
    }
    this.event(input.sessionId, {
      type: 'settings',
      status: result.applied,
      text: result.note,
      details: result,
    })
    const channel = session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
    if (channel) await this.recordRecoveryOwner(session, channel)
    return result
  }
  private assertSessionMachine(
    session: Session,
    channel = session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel,
  ) {
    const transport = channel as
      | (ClientChannel & { readonly machineIdentity?: string; readonly transportState?: string })
      | undefined
    // A socket can disappear after admission while the original durable
    // channel is opening. Keep its machine binding; never acquire a new one offline.
    const ownedTransport =
      transport?.machineIdentity === session.machineIdentity &&
      (transport.transportState === 'connected' || transport.transportState === 'suspended') &&
      !transport.destroyed
    if (
      session.machineIdentity !== this.machineIdentity() ||
      (this.ssh.state.status !== 'connected' && !ownedTransport)
    )
      throw new Error('The connected machine changed before this agent’s native startup')
  }
  private async startCodex(session: Session) {
    this.assertSessionMachine(session)
    const rpc = await this.getCodex(session.machineIdentity)
    this.assertSessionMachine(session, rpc.channel)
    session.codexRPC = rpc
    const { input } = session
    if (this.sessions.get(input.sessionId) !== session || session.stopRequested) return
    const { approvalPolicy, approvalsReviewer, sandbox, sandboxPolicy } = codexPermissions(
      input.mode,
      session.writableRoot,
    )
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
    await this.validateCodexAttachments(turnModel, input.attachments)
    this.assertSessionMachine(session)
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    const threadParams = {
      ...input.providerOptions?.thread,
      ...(session.remoteId ? { threadId: session.remoteId, excludeTurns: true } : {}),
      cwd: session.workspace,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
      ...(threadModel ? { model: threadModel } : {}),
    }
    const initialTurnParams = {
      ...input.providerOptions?.turn,
      input: codexUserInput(input.prompt, input.attachments),
      cwd: session.workspace,
      approvalPolicy,
      approvalsReviewer,
      ...(turnModel ? { model: turnModel } : {}),
      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      ...(input.serviceTier !== undefined
        ? { serviceTier: input.serviceTier || this.codexDefaultTiers.get(turnModel || '') || null }
        : {}),
      sandboxPolicy,
    }
    session.nativeStartPlan = {
      provider: 'codex',
      thread: { method: session.remoteId ? 'thread/resume' : 'thread/start', params: threadParams },
      turn: { params: initialTurnParams },
    }
    await this.recordRecoveryOwner(session, rpc.channel)
    if (!session.remoteId || this.threadTransports.get(session.remoteId) !== rpc) {
      const resuming = Boolean(session.remoteId)
      this.event(input.sessionId, {
        type: 'status',
        text: resuming ? 'Reopening the saved Codex conversation…' : 'Starting Codex…',
      })
      const result = await rpc.request(
        session.remoteId ? 'thread/resume' : 'thread/start',
        threadParams,
        60000,
        session.initialization.signal,
        this.recoverySemantic(session, 'transport'),
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
      if (!(rpc.channel as DurableChannel).recoveryId)
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
    const turnParams = {
      ...initialTurnParams,
      threadId: session.remoteId,
      ...(effort ? { effort } : {}),
      ...(input.serviceTier !== undefined
        ? { serviceTier: input.serviceTier || this.codexDefaultTiers.get(turnModel || '') || null }
        : {}),
    }
    session.nativeStartPlan = { ...session.nativeStartPlan, turn: { params: turnParams } }
    await this.recordRecoveryOwner(session, rpc.channel)
    const result = await rpc.request(
      'turn/start',
      turnParams,
      60000,
      undefined,
      this.recoverySemantic(session, 'user-prompt'),
    )
    if (effort) session.appliedReasoningEffort = effort
    session.turnId = string(object(result.turn).id)
    session.appliedModel = turnModel
    session.phase = 'running'
    await this.recordRecoveryOwner(session, rpc.channel)
  }
  private receiveCodex(message: Wire, rpc: RPC) {
    const method = string(message.method)
    const params = object(message.params)
    if (method === 'account/updated') {
      this.codexAccountRevisions.set(rpc, (this.codexAccountRevisions.get(rpc) || 0) + 1)
      const snapshot: ProviderUsageSnapshot = {
        provider: 'codex',
        status: 'unavailable',
        fetchedAt: Date.now(),
        limits: [],
        ...(string(params.planType) ? { accountType: string(params.planType) } : {}),
        message: 'Codex account changed. Refresh account limits.',
      }
      this.codexUsageSnapshots.set(rpc, snapshot)
      if (this.codexByMachine.get(this.machineIdentity()) === rpc) {
        const ownedSnapshot = { ...snapshot, machineIdentity: this.machineIdentity() }
        this.codexUsageSnapshots.set(rpc, ownedSnapshot)
        this.emit({
          sessionId: '',
          provider: 'codex',
          type: 'account-usage',
          details: ownedSnapshot,
        })
      }
      return
    }
    if (method === 'account/rateLimits/updated') {
      const snapshot = codexUsageSnapshot(params, this.codexUsageSnapshots.get(rpc), true)
      this.codexUsageSnapshots.set(rpc, snapshot)
      if (this.codexByMachine.get(this.machineIdentity()) === rpc) {
        const ownedSnapshot = { ...snapshot, machineIdentity: this.machineIdentity() }
        this.codexUsageSnapshots.set(rpc, ownedSnapshot)
        this.emit({
          sessionId: '',
          provider: 'codex',
          type: 'account-usage',
          details: ownedSnapshot,
        })
      }
      return
    }
    const thread = object(params.thread)
    const remoteId = string(params.threadId || thread.id)
    if (method === 'thread/started' && thread.parentThreadId) {
      const parentId = string(thread.parentThreadId)
      const owner = this.threads.get(parentId) || this.childThreads.get(parentId)?.sessionId
      if (
        owner &&
        (this.sessions.get(owner)?.codexRPC === rpc || this.childThreads.get(parentId)?.rpc === rpc)
      )
        this.childThreads.set(remoteId, {
          sessionId: owner,
          agentName: string(thread.agentNickname || thread.agentRole || thread.name) || undefined,
          rpc,
          busy: object(thread.status).type !== 'idle',
          ignoredTurns: this.childThreads.get(remoteId)?.ignoredTurns || new Set(),
          owner:
            this.childThreads.get(remoteId)?.owner ||
            this.childThreads.get(parentId)?.owner ||
            (this.sessions.get(owner) ? this.recoveryOwner(this.sessions.get(owner)!) : undefined),
        })
    }
    if (method === 'thread/closed') {
      const childOwner = this.childThreads.get(remoteId)?.sessionId
      const owner = this.threads.get(remoteId) || childOwner
      if (
        this.threadTransports.get(remoteId) === rpc ||
        this.childThreads.get(remoteId)?.rpc === rpc
      ) {
        const session = owner ? this.sessions.get(owner) : undefined
        const child = this.childThreads.get(remoteId)
        if (child?.busy && owner)
          this.event(owner, {
            type: 'subagent',
            provider: 'codex',
            agentId: remoteId,
            itemId: `agent-${remoteId}`,
            agentName: child.agentName,
            title: child.agentName || 'Subagent',
            status: 'interrupted',
            details: { lifecycle: 'turn', nativeTurnId: child.turnId },
          })
        if (session && owner)
          for (const [requestId, approval] of session.approvals)
            if (approval.params.threadId === remoteId) {
              session.approvals.delete(requestId)
              this.event(owner, {
                type: 'request-resolved',
                requestId,
                status: 'provider-resolved',
                provider: 'codex',
                ...(childOwner ? { agentId: remoteId } : {}),
              })
            }
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
        this.recoveryCodexSend(rpc, {
          id: message.id,
          error: { code: -32601, message: 'Unsupported server request' },
        })
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.codexRPC !== rpc && child?.rpc !== rpc) {
      if (message.id != null && method)
        this.recoveryCodexSend(rpc, {
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
    // Requests can be cleared by the provider even after the turn stops. Match
    // its wire ID rather than treating the notification as an active item.
    if (method === 'serverRequest/resolved') {
      for (const [requestId, approval] of session.approvals)
        if (
          approval.wireId === params.requestId &&
          (approval.rpc || session.codexRPC) === rpc &&
          (!approval.params.threadId || approval.params.threadId === remoteId)
        ) {
          session.approvals.delete(requestId)
          emit({ type: 'request-resolved', requestId, status: 'provider-resolved' })
        }
      return
    }
    if (method === 'currentTime/read' && message.id != null) {
      this.recoveryCodexSend(rpc, {
        id: message.id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      })
      return
    }
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
        details: {
          tokenUsage: params.tokenUsage,
          usageScope: 'session',
          usageSessionId: remoteId,
          usageObservedAt: Date.now(),
        },
      })
      return
    }
    if (method === 'thread/status/changed') {
      const status = object(params.status)
      if (isChild && child) child.busy = status.type === 'active'
      if (
        !isChild &&
        session.stopRequested &&
        session.phase === 'running' &&
        session.turnId &&
        this.nativeInterruptAcks
          .get(session.recoveryTransportId || '')
          ?.has(JSON.stringify([session.remoteId, session.turnId])) &&
        status.type === 'idle'
      )
        session.busy = false
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags : []
      emit({
        type: 'status',
        status: flags.includes('waitingOnApproval')
          ? 'awaiting-approval'
          : flags.includes('waitingOnUserInput')
            ? 'awaiting-input'
            : string(status.type),
        details: { threadStatus: params.status },
      })
      return
    }
    const turnId = string(params.turnId || object(params.turn).id)
    if (method === 'turn/started' && session.stopRequested && turnId) {
      if (isChild && child && !child.ignoredTurns.has(turnId)) child.turnId = turnId
      else if (
        !isChild &&
        !session.ignoredTurns.has(turnId) &&
        (!session.turnId || session.turnId === turnId)
      ) {
        session.turnId = turnId
        session.phase = 'running'
      }
    }
    if (method === 'turn/completed' && session.stopRequested) {
      if (isChild && child && child.turnId && child.turnId === turnId) child.busy = false
      if (!isChild && session.turnId && session.turnId === turnId) session.busy = false
    }
    if (
      isChild &&
      child &&
      (session.stopRequested ||
        (turnId &&
          (child.ignoredTurns.has(turnId) ||
            (method !== 'turn/started' && child.turnId && child.turnId !== turnId))))
    ) {
      if (message.id != null && method)
        this.recoveryCodexSend(rpc, {
          id: message.id,
          error: { code: -32000, message: 'The child turn is no longer active' },
        })
      return
    }
    if (
      !isChild &&
      (!session.busy ||
        (turnId &&
          (session.ignoredTurns.has(turnId) || (session.turnId && session.turnId !== turnId))))
    ) {
      if (message.id != null && method)
        this.recoveryCodexSend(rpc, {
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
    if (method === 'model/rerouted') {
      if (!isChild && typeof params.toModel === 'string') session.appliedModel = params.toModel
      emit({
        type: 'status',
        text: `Codex switched from ${string(params.fromModel)} to ${string(params.toModel)}.`,
        details: { modelReroute: params },
      })
    }
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
          this.childThreads.set(receiver, {
            sessionId,
            rpc,
            busy: true,
            ignoredTurns: new Set(),
            owner: this.recoveryOwner(session),
          })
      for (const receiver of receivers) {
        const receiverChild = this.childThreads.get(receiver)
        const state = object(object(item.agentsStates)[receiver])
        if (receiverChild?.rpc === rpc && typeof state.status === 'string') {
          receiverChild.busy = ['pendingInit', 'running'].includes(state.status)
          if (!receiverChild.busy && receiverChild.turnId)
            receiverChild.ignoredTurns.add(receiverChild.turnId)
        }
      }
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
      if (isChild && child) {
        child.busy = true
        child.turnId = turnId
      }
      if (isChild)
        emit({
          type: 'subagent',
          itemId: `agent-${remoteId}`,
          agentId: remoteId,
          title: child?.agentName || 'Subagent',
          status: 'running',
          details: { ...thread, lifecycle: 'turn', nativeTurnId: turnId },
        })
      else session.turnId = string(object(params.turn).id)
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn)
      for (const [requestId, approval] of session.approvals)
        if (
          (approval.rpc || session.codexRPC) === rpc &&
          (!approval.params.threadId || approval.params.threadId === remoteId)
        ) {
          session.approvals.delete(requestId)
          emit({ type: 'request-resolved', requestId, status: 'provider-resolved' })
        }
      if (isChild) {
        if (child) {
          child.busy = false
          if (turnId) child.ignoredTurns.add(turnId)
        }
        emit({
          type: 'subagent',
          itemId: `agent-${remoteId}`,
          agentId: remoteId,
          title: child?.agentName || 'Subagent',
          status: string(turn.status),
          text: string(object(turn.error).message),
          details: { lifecycle: 'turn', nativeTurnId: turnId },
        })
        return
      }
      if (turnId) session.ignoredTurns.add(turnId)
      if (session.stopRequested) return
      session.busy = false
      emit({
        type: turn.status === 'failed' ? 'error' : 'complete',
        status: string(turn.status),
        text: string(object(turn.error).message),
      })
      if (!this.isReplaying(rpc.channel))
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
        details: {
          error: params.error,
          willRetry: params.willRetry,
          ...(params.willRetry === true ? { recoverable: true } : {}),
        },
      })
    if (message.id != null && method) {
      const transport =
        this.codexRecoveryIds.get(rpc) || (rpc.channel as DurableChannel).recoveryId || ''
      if (
        this.isAnsweredReplayPermission(
          transport,
          message.id,
          sessionId,
          child?.owner?.generation ?? session.recoveryGeneration ?? 0,
          params,
          rpc.receivedMessageSequence,
        )
      )
        return
      const requestId = this.permissionLocalId(
        session,
        message.id,
        transport
          ? `${transport}:request:${typeof message.id}:${String(message.id)}`
          : randomUUID(),
        rpc.receivedMessageSequence,
        params,
        method,
      )
      if (session.approvals.has(requestId)) return
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'item/permissions/requestApproval'
      ) {
        session.approvals.set(requestId, {
          wireId: message.id,
          wireOrdinal: rpc.receivedMessageSequence,
          method,
          params,
          rpc,
          owner: child?.owner || this.recoveryOwner(session),
        })
        emit({
          type: 'approval',
          requestId,
          itemId,
          ...codexApprovalPresentation(method, params),
          ...codexApprovalChoices(method, params),
          details: { method, ...params },
        })
      } else if (method === 'item/tool/requestUserInput') {
        session.approvals.set(requestId, {
          wireId: message.id,
          wireOrdinal: rpc.receivedMessageSequence,
          method,
          params,
          rpc,
          owner: child?.owner || this.recoveryOwner(session),
        })
        emit({
          type: 'question',
          requestId,
          itemId,
          questions: array(params.questions) as unknown as AgentQuestion[],
          details: { method, ...params },
        })
      } else if (method === 'mcpServer/elicitation/request') {
        try {
          const urlMode = params.mode === 'url'
          const questions = urlMode ? undefined : codexElicitationQuestions(params)
          session.approvals.set(requestId, {
            wireId: message.id,
            wireOrdinal: rpc.receivedMessageSequence,
            method,
            params,
            rpc,
            owner: child?.owner || this.recoveryOwner(session),
          })
          emit({
            type: urlMode ? 'approval' : 'question',
            requestId,
            itemId,
            title: urlMode ? 'Confirm the MCP connection flow?' : 'MCP server needs your input',
            text: [string(params.message), urlMode ? string(params.url) : '']
              .filter(Boolean)
              .join('\n\n'),
            ...(questions ? { questions } : {}),
            details: { method, ...params },
          })
        } catch (error) {
          this.recoveryCodexSend(rpc, {
            id: message.id,
            result: { action: 'decline', content: null, _meta: null },
          })
          emit({
            type: 'status',
            text: error instanceof Error ? error.message : String(error),
            details: { method, serverName: params.serverName, declined: true },
          })
        }
      } else
        this.recoveryCodexSend(rpc, {
          id: message.id,
          error: { code: -32601, message: 'Life does not support this server request yet' },
        })
    }
  }
  private async startClaude(session: Session, reuse = false) {
    this.assertSessionMachine(session)
    const { input } = session
    if (reuse) {
      claudeMessageBlocks.get(session)?.resetRoot()
      session.claudeMessageIds.delete('root')
    } else {
      if (session.channel) this.finishClaudeChildren(input.sessionId, session, 'interrupted')
      claudeMessageBlocks.set(session, new ClaudeMessageBlocks())
      session.claudeActiveChildren = new Map()
      session.claudeTaskRuns = new Map()
    }
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
    this.assertSessionMachine(session)
    this.validateModelChoices(effectiveOptions, this.claudeModels)
    if (session.stopRequested || this.sessions.get(input.sessionId) !== session) return
    if (reuse && session.channel) {
      const channel = session.channel
      const content = await claudeUserContent(
        this.ssh,
        input.prompt,
        input.attachments,
        session.initialization.signal,
      )
      this.assertSessionMachine(session)
      const reusedSettings = {
        ...(input.reasoningEffort !== undefined
          ? { effortLevel: input.reasoningEffort || null }
          : {}),
        ...(input.serviceTier !== undefined
          ? { fastMode: input.serviceTier ? input.serviceTier === 'fast' : null }
          : {}),
      }
      if (reusedSettings.fastMode === true && session.claudeFastModeNeedsOptIn) {
        session.claudeRestartForSettings = true
        delete reusedSettings.fastMode
      }
      const controls: Wire[] = [
        { request: { subtype: 'set_permission_mode', mode: claudePermissionMode(input.mode) } },
        {
          request: { subtype: 'set_model', model: input.model || 'default' },
          details: { requestedSettings: { model: input.model || '' } },
        },
        ...(Object.keys(reusedSettings).length
          ? [
              {
                request: { subtype: 'apply_flag_settings', settings: reusedSettings },
                details: JSON.parse(
                  JSON.stringify({
                    requestedSettings: {
                      ...(input.reasoningEffort !== undefined
                        ? { reasoningEffort: input.reasoningEffort }
                        : {}),
                      ...(input.serviceTier !== undefined
                        ? { serviceTier: input.serviceTier }
                        : {}),
                    },
                    claudeRestartForSettings: session.claudeRestartForSettings,
                  }),
                ),
              },
            ]
          : []),
      ]
      session.nativeStartPlan = {
        provider: 'claude',
        initialize: { subtype: 'initialize', hooks: null, forwardSubagentText: true },
        controls,
        user: {
          type: 'user',
          session_id: session.remoteId || '',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        },
      }
      await this.recordRecoveryOwner(session, channel)
      if (
        session.stopRequested ||
        session.channel !== channel ||
        this.sessions.get(input.sessionId) !== session
      )
        return
      await this.claudeControl(
        session,
        {
          subtype: 'set_permission_mode',
          mode: claudePermissionMode(input.mode),
        },
        15000,
      )
      await this.configureSession(session, {
        sessionId: input.sessionId,
        model: input.model || '',
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      })
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      await this.recordRecoveryOwner(session, channel)
      await this.writeClaudeAndWait(
        session,
        object(session.nativeStartPlan.user),
        this.recoverySemantic(session, 'user-prompt'),
      )
      return
    }
    if (session.channel) {
      const oldChannel = session.channel as DurableChannel
      session.channel = undefined
      if (
        oldChannel.recoveryId &&
        oldChannel.signalNativeAndWait &&
        oldChannel.closeNativeAndWait &&
        this.nativeRecovery
      ) {
        const snapshot = await runEffect(this.nativeRecovery.readTransport(oldChannel.recoveryId))
        const owner = snapshot.transport.owners.find(
          (value) => value.kind === 'root' && value.sessionId === input.sessionId,
        )
        if (!owner)
          throw this.recoveryError(
            'settings-close',
            'The original Claude writer has no registered owner.',
          )
        const semantic = {
          sessionId: owner.sessionId,
          ownerGeneration: owner.generation ?? 0,
          ...(owner.nativeSessionId ? { nativeThreadId: owner.nativeSessionId } : {}),
        }
        await oldChannel.signalNativeAndWait('TERM', {
          kind: 'transport',
          ...semantic,
          method: 'life/settings-restart-signal',
        })
        const exited = await oldChannel.closeNativeAndWait({
          kind: 'close',
          ...semantic,
          method: 'life/settings-restart-close',
        })
        if (!exited) {
          session.channel = oldChannel
          session.recoveryTransportId = oldChannel.recoveryId
          this.markRecoveryUnknown(
            input.sessionId,
            'The original Claude writer is still closing. Life did not launch a replacement.',
          )
          throw this.recoveryError(
            'settings-close',
            'Wait for the original Claude process to exit before sending another turn.',
          )
        }
      } else {
        try {
          oldChannel.signal('TERM')
        } catch {}
        oldChannel.end()
        oldChannel.close()
      }
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
      claudePermissionMode(input.mode),
    ]
    if (input.scope === 'research' && session.writableRoot !== session.workspace)
      args.push('--add-dir', session.writableRoot)
    if (input.model) args.push(`--model=${input.model}`)
    if (input.reasoningEffort) args.push(`--effort=${input.reasoningEffort}`)
    if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings))
    args.push(...(input.providerOptions?.args || []))
    if (session.remoteId) args.push(`--resume=${session.remoteId}`)
    const content = await claudeUserContent(
      this.ssh,
      input.prompt,
      input.attachments,
      session.initialization.signal,
    )
    this.assertSessionMachine(session)
    session.nativeStartPlan = {
      provider: 'claude',
      initialize: { subtype: 'initialize', hooks: null, forwardSubagentText: true },
      user: {
        type: 'user',
        session_id: session.remoteId || '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      },
    }
    session.claudeUsageCallId = randomUUID()
    const channel = await this.providerChannel(
      claudeLaunchCommand(session.workspace, args),
      undefined,
      'claude',
      session.machineIdentity,
    )
    if (
      this.sessions.get(input.sessionId) !== session ||
      session.stopRequested ||
      this.machineIdentity() !== session.machineIdentity
    ) {
      await this.failFreshProviderChannel(
        channel as DurableChannel,
        new Error('The original provider opening was cancelled before owner admission.'),
      )
      if (!(channel as DurableChannel).recoveryId) channel.close()
      return
    }
    session.channel = channel
    await this.recordRecoveryOwner(session, channel)
    if (session.recoveryTransportId)
      session.claudeUsageCallId = `${session.recoveryTransportId}:generation:${session.recoveryGeneration}`
    this.bindClaudeParser(session, channel)
    try {
      await this.claudeControl(session, object(session.nativeStartPlan.initialize), 60000)
      if (session.stopRequested || session.channel !== channel) return
      if (session.stopRequested || session.channel !== channel) return
      session.phase = 'running'
      session.nativeStartPlan = {
        ...session.nativeStartPlan,
        user: { ...object(session.nativeStartPlan.user), session_id: session.remoteId || '' },
      }
      await this.recordRecoveryOwner(session, channel)
      await this.writeClaudeAndWait(
        session,
        object(session.nativeStartPlan.user),
        this.recoverySemantic(session, 'user-prompt'),
      )
    } catch (error) {
      channel.close()
      throw error
    }
  }
  private isReplaying(channel: ClientChannel) {
    const id = (channel as DurableChannel).recoveryId
    return Boolean(
      (channel as DurableChannel).hasUnconfirmedRecoveryInputs ||
      (id && (this.replayingTransports.has(id) || this.recoveringCodexInitialization.has(id))),
    )
  }
  private recoveryCodexSend(rpc: RPC, message: Wire) {
    const id = this.codexRecoveryIds.get(rpc) || (rpc.channel as DurableChannel).recoveryId
    if (rpc.isReplaying || this.isReplaying(rpc.channel)) return
    rpc.send(message)
  }
  private applyClaudeInitialization(session: Session, initialized: Wire) {
    if (session.recoveryTransportId) {
      const initialization = this.replayInitialization.get(session.recoveryTransportId)
      if (initialization) initialization.response = true
    }
    const result = applyNativeClaudeControl({
      session,
      request: { subtype: 'initialize' },
      payload: initialized,
      success: true,
      fallbackCodeVersion: this.ssh.state.claude,
    })
    if (result.settingsEvent) this.event(session.input.sessionId, result.settingsEvent)
  }
  private bindClaudeParser(session: Session, channel: ClientChannel) {
    if (this.claudeParsers.has(session)) return
    const id = session.input.sessionId
    this.transportEvents(channel, () => [[id, session]])
    const failed = (error: Error) => {
      if (session.channel !== channel || this.sessions.get(id) !== session) return
      const transportId = (channel as DurableChannel).recoveryId
      if (transportId && this.terminalTransports.has(transportId)) {
        session.channel = undefined
        this.claudeParsers.delete(session)
        return
      }
      if (session.recoveryTransportId) {
        this.markRecoveryUnknown(id, error.message)
        void (channel as DurableChannel).detach?.().catch(() => {})
        return
      }
      for (const pending of session.controls.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      session.controls.clear()
      session.channel = undefined
      try {
        channel.signal('TERM')
      } catch {}
      try {
        channel.close()
      } catch {}
      this.resolveClaudeRequests(id, session)
      this.finishClaudeChildren(id, session, session.stopRequested ? 'interrupted' : 'failed')
      if (session.busy && !session.stopRequested) {
        session.busy = false
        this.event(id, { type: 'error', text: error.message })
      }
    }
    const lines = new JsonLines(
      (message) => {
        if (session.channel !== channel || this.sessions.get(id) !== session) return
        const transportId = session.recoveryTransportId
        const sequence = (this.claudeWireSequences.get(session) || 0) + 1
        this.claudeWireSequences.set(session, sequence)
        if (transportId)
          this.recovery.beginWire(
            transportId,
            sequence,
            this.replayOutputCursors.get(transportId) ??
              (channel as DurableChannel).outputCursor ??
              0,
            this.replayingTransports.has(transportId),
          )
        try {
          if (message.type === 'control_response') {
            const response = object(message.response)
            const requestId = string(response.request_id)
            const pending = session.controls.get(requestId)
            const original = transportId
              ? this.replayInputs.get(transportId)?.get(requestId)
              : undefined
            if (!pending && !original) return
            const declaredSuccess =
              response.subtype === 'success' &&
              response.response !== null &&
              typeof response.response === 'object' &&
              !Array.isArray(response.response)
            const declaredError = response.subtype === 'error' && typeof response.error === 'string'
            if (!declaredSuccess && !declaredError) return
            this.confirmNativeInputProcessing(channel as DurableChannel, original)
            session.controls.delete(requestId)
            clearTimeout(pending?.timer)
            const controlDetails = object(pending?.details || original?.semantic.details)
            const startControlIndex = controlDetails.startControlIndex
            if (response.subtype !== 'success') {
              if (transportId && typeof startControlIndex === 'number')
                this.markRecoveryUnknown(
                  id,
                  string(response.error) ||
                    'The captured native startup control failed. Life retained the original provider owner.',
                )
              pending?.reject(new Error(string(response.error) || 'Claude control request failed'))
            } else {
              if (transportId && typeof startControlIndex === 'number') {
                const acknowledgements =
                  this.nativeStartControlAcks.get(transportId) || new Set<string>()
                acknowledgements.add(
                  JSON.stringify([
                    original?.semantic.ownerGeneration ?? session.recoveryGeneration ?? 0,
                    startControlIndex,
                  ]),
                )
                this.nativeStartControlAcks.set(transportId, acknowledgements)
              }
              const result = object(response.response)
              if (
                original?.semantic.kind === 'interrupt' ||
                pending?.request.subtype === 'interrupt'
              ) {
                if (transportId) {
                  const acknowledgements =
                    this.nativeInterruptAcks.get(transportId) || new Set<string>()
                  acknowledgements.add('claude')
                  this.nativeInterruptAcks.set(transportId, acknowledgements)
                }
              }
              if (
                original?.semantic.requestType === 'initialize' ||
                pending?.request.subtype === 'initialize'
              )
                this.applyClaudeInitialization(session, result)
              else {
                const details = object(original?.semantic.details)
                const reduced = applyNativeClaudeControl({
                  session,
                  request: pending?.request || object(details.request),
                  payload: result,
                  success: true,
                  details: pending?.details || (details as NativeClaudeControlDetails),
                  fallbackCodeVersion: this.ssh.state.claude,
                })
                if (reduced.settingsEvent)
                  this.event(session.input.sessionId, reduced.settingsEvent)
              }
              for (const request of [
                ...array(response.pending_permission_requests),
                ...array(response.pending_user_dialog_requests),
              ])
                if (request.type === 'control_request') this.receiveClaude(session, request)
              pending?.resolve(result)
            }
          } else this.receiveClaude(session, message)
        } catch (cause) {
          failed(cause instanceof Error ? cause : new Error(String(cause)))
          if (transportId && this.replayingTransports.has(transportId)) throw cause
        } finally {
          if (transportId) this.recovery.endWire(transportId)
          if (transportId && !this.replayingTransports.has(transportId)) {
            this.queueNativeAttachmentReconciliation(transportId)
            this.queueRecoveredStops(transportId)
            this.queueRecoveredStarts(transportId)
          }
        }
      },
      (line) => {
        const error = claudeProtocolError(line)
        if (error) failed(error)
      },
    )
    this.claudeParsers.set(session, lines)
    channel.on('data', (chunk: Buffer) => lines.push(chunk))
    channel.stderr.on('data', (chunk: Buffer) => {
      if (session.channel === channel)
        session.stderr = (session.stderr + chunk.toString()).slice(-8192)
    })
    channel.on('error', failed)
    channel.on('close', () =>
      failed(
        new Error(
          session.stderr ||
            'Claude Code exited before completing this turn. Check its remote login.',
        ),
      ),
    )
  }
  private claudeControl(
    session: Session,
    request: Wire,
    timeout: number,
    signal?: AbortSignal,
    details?: NativeClaudeControlDetails,
  ): Promise<Wire> {
    const channel = session.channel
    if (channel && this.isReplaying(channel))
      return Promise.reject(
        this.recoveryError('claude.replay', 'Native controls are disabled during recovery replay.'),
      )
    if (!channel || channel.destroyed)
      return Promise.reject(new Error('Claude Code is disconnected'))
    const requestId = randomUUID()
    const index =
      session.phase === 'initializing'
        ? array(session.nativeStartPlan?.controls).findIndex(
            (control) => JSON.stringify(control.request) === JSON.stringify(request),
          )
        : -1
    const nativeDetails = index >= 0 ? { ...details, startControlIndex: index } : details
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', cancelled)
      const cancelled = () => {
        const pending = session.controls.get(requestId)
        session.controls.delete(requestId)
        clearTimeout(pending?.timer)
        cleanup()
        reject(new Error('Claude metadata request cancelled'))
      }
      if (signal?.aborted) {
        cancelled()
        return
      }
      signal?.addEventListener('abort', cancelled, { once: true })
      const expire = () => {
        session.controls.delete(requestId)
        cleanup()
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
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer,
        remaining: timeout,
        started: Date.now(),
        expire,
        request,
        details: nativeDetails,
      })
      try {
        this.writeClaude(
          session,
          { type: 'control_request', request_id: requestId, request },
          this.recoverySemantic(
            session,
            request.subtype === 'initialize'
              ? 'initialize'
              : request.subtype === 'interrupt'
                ? 'interrupt'
                : 'settings',
            {
              requestId,
              requestType: string(request.subtype),
              details: JSON.parse(JSON.stringify({ request, ...nativeDetails })),
            },
          ),
        )
      } catch (error) {
        clearTimeout(timer)
        session.controls.delete(requestId)
        cleanup()
        reject(error)
      }
    })
  }
  private receiveClaude(session: Session, message: Wire) {
    if (session.recoveryTransportId && !string(message.uuid))
      message = {
        ...message,
        uuid: `${session.recoveryTransportId}:wire:${this.claudeWireSequences.get(session) || 0}`,
      }
    const id = session.input.sessionId
    const parentItemId = string(message.parent_tool_use_id) || undefined
    const directAgentId = string(message.agent_id) || undefined
    const childStreamId = parentItemId || directAgentId
    const requestAgentId = string(object(message.request).agent_id) || undefined
    const rootSessionId = string(message.session_id)
    if (
      rootSessionId &&
      session.remoteId &&
      !childStreamId &&
      !requestAgentId &&
      !string(message.agent_id) &&
      !(message.type === 'system' && /^task_/.test(string(message.subtype))) &&
      rootSessionId !== session.remoteId
    )
      throw new Error(
        'Claude Code returned a different conversation. Your saved thread is unchanged. Check the remote session and retry.',
      )
    const emit = (event: Omit<AgentEvent, 'sessionId'>) => {
      const native = {
        provider: 'claude',
        ...(parentItemId
          ? {
              parentItemId,
              agentId: parentItemId,
              agentName: session.claudeAgentNames.get(parentItemId),
            }
          : {}),
        ...(directAgentId
          ? { agentId: directAgentId, agentName: session.claudeAgentNames.get(directAgentId) }
          : {}),
        ...event,
      } as Omit<AgentEvent, 'sessionId'>
      if (native.agentId) {
        const originatingOwner =
          session.claudeActiveChildren?.get(native.agentId)?.owner || this.recoveryOwner(session)
        const terminal =
          native.type === 'subagent' &&
          ['completed', 'failed', 'interrupted', 'stopped', 'killed'].includes(native.status || '')
        if (terminal) {
          session.claudeActiveChildren?.delete(native.agentId)
          claudeMessageBlocks.get(session)?.retireStream(native.agentId)
        } else if (['subagent', 'text', 'tool', 'approval', 'question'].includes(native.type)) {
          const previous = session.claudeActiveChildren?.get(native.agentId)
          session.claudeActiveChildren?.set(native.agentId, {
            itemId:
              native.type === 'subagent'
                ? native.itemId || `agent-${native.agentId}`
                : previous?.itemId || `agent-${native.agentId}`,
            title: native.agentName || previous?.title || native.title,
            parentItemId: native.parentItemId || previous?.parentItemId,
            owner: previous?.owner || originatingOwner,
          })
        }
        this.event(id, native, originatingOwner)
        return
      }
      this.event(id, native)
    }
    if (
      childStreamId &&
      (message.type === 'result' ||
        (message.type === 'system' && message.subtype === 'session_state_changed'))
    ) {
      emit({
        type: 'subagent',
        itemId: `agent-${childStreamId}`,
        title: session.claudeAgentNames.get(childStreamId) || 'Subagent',
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
      if (message.type === 'result' || message.state === 'idle')
        this.resolveClaudeRequests(id, session, [childStreamId], 'provider-resolved')
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
      !childStreamId &&
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
    const advisory = claudeAdvisoryEvent(message)
    if (advisory) {
      const agentId = string(message.agent_id)
      emit({
        ...advisory,
        ...(agentId ? { agentId, agentName: session.claudeAgentNames.get(agentId) } : {}),
      })
      return
    }
    if (
      message.type === 'system' &&
      /^task_(started|progress|notification|updated)$/.test(string(message.subtype))
    ) {
      if (message.skip_transcript === true || message.ambient === true) return
      const patch = object(message.patch)
      const agentId = string(message.task_id || message.tool_use_id)
      const runId = string(message.run_id)
      const previousRun = session.claudeTaskRuns?.get(agentId)
      if (runId && previousRun && runId < previousRun) return
      if (runId) session.claudeTaskRuns?.set(agentId, runId)
      const parent =
        string(message.tool_use_id) ||
        session.claudeActiveChildren?.get(agentId)?.parentItemId ||
        parentItemId
      const name =
        string(message.description || patch.description || message.task_type) ||
        session.claudeActiveChildren?.get(agentId)?.title ||
        (parent ? session.claudeAgentNames.get(parent) : undefined) ||
        string(message.summary) ||
        ''
      if (parent && name) session.claudeAgentNames.set(parent, name)
      const status =
        string(message.status || patch.status) ||
        (message.subtype === 'task_notification' ? 'completed' : 'running')
      const terminal = ['completed', 'failed', 'interrupted', 'stopped', 'killed'].includes(status)
      emit({
        type: 'subagent',
        itemId: `task-${agentId}`,
        agentId,
        agentName: name || undefined,
        parentItemId: parent || undefined,
        title: name || 'Subagent',
        text: string(message.summary || message.description || patch.error),
        status: status === 'stopped' || status === 'killed' ? 'interrupted' : status,
        details: { ...message, ...(terminal ? { lifecycle: 'turn' } : {}) },
      })
      if (terminal) {
        if (parent) {
          session.claudeActiveChildren?.delete(parent)
          claudeMessageBlocks.get(session)?.retireStream(parent)
        }
        this.resolveClaudeRequests(
          id,
          session,
          [agentId, ...(parent ? [parent] : [])],
          'provider-resolved',
        )
      }
      return
    }
    if (message.type === 'control_cancel_request') {
      const wireId = string(message.request_id)
      for (const [requestId, approval] of session.approvals)
        if (approval.wireId === wireId) {
          session.approvals.delete(requestId)
          emit({ type: 'request-resolved', requestId, status: 'cancelled' })
        }
      return
    }
    if (!session.busy && message.type !== 'system' && !childStreamId && !requestAgentId) return
    if (rootSessionId && !childStreamId && !requestAgentId && rootSessionId !== session.remoteId) {
      session.remoteId = rootSessionId
      emit({ type: 'session', remoteId: rootSessionId })
    }
    if (message.type === 'stream_event') {
      let event = object(message.event)
      const stream = childStreamId || 'root'
      if (session.recoveryTransportId && !session.claudeMessageIds.has(stream)) {
        const fallback = `${session.recoveryTransportId}:message:${this.claudeWireSequences.get(session) || 0}:${stream}`
        session.claudeMessageIds.set(stream, fallback)
        claudeMessageBlocks
          .get(session)
          ?.stream({ type: 'message_start', message: { id: fallback } }, childStreamId)
      }
      if (event.type === 'message_start') {
        const messageId =
          string(object(event.message).id) || session.claudeMessageIds.get(stream) || randomUUID()
        if (!string(object(event.message).id))
          event = { ...event, message: { ...object(event.message), id: messageId } }
        session.claudeMessageIds.set(stream, messageId)
        if (!childStreamId) session.messageId = messageId
      }
      for (const output of claudeMessageBlocks.get(session)?.stream(event, childStreamId) || []) {
        if (output.type === 'text' && output.itemId) {
          session.streamed.add(output.itemId)
          if (!childStreamId) session.messageId = output.itemId
        }
        emit(output)
      }
    }
    if (message.type === 'assistant') {
      const content = object(message.message)
      const blocks = claudeMessageBlocks.get(session)
      if (string(message.uuid) && blocks?.hasEnvelope(string(message.uuid), childStreamId)) return
      for (const output of blocks?.assistant(content, string(message.uuid), childStreamId) || []) {
        if (!childStreamId && output.type === 'text') session.messageId = output.itemId
        emit(output)
      }
      if (!childStreamId && blocks)
        session.claudeReply = blocks.text(string(content.id) || undefined)
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
          status: result.is_error
            ? 'failed'
            : [...(session.claudeActiveChildren?.values() || [])].some(
                  (child) => child.parentItemId === string(result.tool_use_id),
                )
              ? 'running'
              : 'completed',
          details: result,
        })
    if (message.type === 'control_request') {
      const request = object(message.request)
      const wireId = string(message.request_id)
      const permissionParams = {
        ...request,
        ...(childStreamId ? { agent_id: string(request.agent_id) || childStreamId } : {}),
        ...(parentItemId ? { parent_tool_use_id: parentItemId } : {}),
      }
      const wireOrdinal = this.claudeWireSequences.get(session) || 0
      if (
        this.isAnsweredReplayPermission(
          session.recoveryTransportId || '',
          wireId,
          id,
          session.claudeActiveChildren?.get(string(request.agent_id) || childStreamId || '')?.owner
            ?.generation ??
            session.recoveryGeneration ??
            0,
          permissionParams,
          wireOrdinal,
        )
      )
        return
      const requestId = this.permissionLocalId(
        session,
        wireId,
        wireId,
        wireOrdinal,
        permissionParams,
        request.subtype === 'elicitation' ? 'elicitation' : string(request.tool_name),
      )
      if (request.subtype === 'can_use_tool') {
        if (session.approvals.has(requestId)) return
        const agentId = string(request.agent_id) || childStreamId
        const requestMetadata = agentId
          ? { agentId, agentName: session.claudeAgentNames.get(agentId), parentItemId }
          : {}
        session.approvals.set(requestId, {
          wireId,
          wireOrdinal,
          method: string(request.tool_name),
          params: permissionParams,
          owner:
            (agentId ? session.claudeActiveChildren?.get(agentId)?.owner : undefined) ||
            this.recoveryOwner(session),
        })
        const toolInput = object(request.input)
        if (request.tool_name === 'AskUserQuestion')
          emit({
            type: 'question',
            requestId,
            ...requestMetadata,
            questions: array(toolInput.questions).map((q, i) => ({
              id: string(q.question) || String(i),
              question: string(q.question),
              header: string(q.header),
              ...(q.multiSelect === true ? { multiple: true } : {}),
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
            ...requestMetadata,
            title:
              string(request.title) ||
              `Allow ${string(request.display_name || request.tool_name)}?`,
            text: string(toolInput.command) || JSON.stringify(toolInput, null, 2),
            details: request,
          })
      } else if (request.subtype === 'elicitation') {
        if (session.approvals.has(requestId)) return
        const agentId = string(request.agent_id) || childStreamId
        const requestMetadata = agentId
          ? { agentId, agentName: session.claudeAgentNames.get(agentId), parentItemId }
          : {}
        try {
          const urlMode = request.mode === 'url'
          const questions = urlMode ? undefined : claudeElicitationQuestions(request)
          session.approvals.set(requestId, {
            wireId,
            wireOrdinal,
            method: 'elicitation',
            params: permissionParams,
            owner:
              (agentId ? session.claudeActiveChildren?.get(agentId)?.owner : undefined) ||
              this.recoveryOwner(session),
          })
          emit({
            type: urlMode ? 'approval' : 'question',
            requestId,
            ...requestMetadata,
            title:
              string(request.title) ||
              (urlMode ? 'Confirm the MCP connection flow?' : 'MCP server needs your input'),
            text: [string(request.message), urlMode ? string(request.url) : '']
              .filter(Boolean)
              .join('\n\n'),
            ...(questions ? { questions } : {}),
            details: request,
          })
        } catch (error) {
          if (!session.channel || !this.isReplaying(session.channel))
            session.channel?.write(
              JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: wireId,
                  response: { action: 'decline' },
                },
              }) + '\n',
            )
          emit({
            type: 'status',
            ...requestMetadata,
            text: error instanceof Error ? error.message : String(error),
            details: {
              subtype: 'elicitation',
              serverName: request.mcp_server_name,
              declined: true,
            },
          })
        }
      } else if (request.subtype === 'request_user_dialog') {
        // Life declares no supportedDialogKinds. An undeclared dialog can be
        // replayed by initialize or belong to another native consumer; leave it
        // pending there. `cancelled` would falsely report a user dismissal.
        return
      } else if (!session.channel || !this.isReplaying(session.channel))
        session.channel?.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: wireId,
              error: 'Unsupported control request',
            },
          }) + '\n',
        )
    }
    if (message.type === 'result') {
      if (session.stopRequested) {
        session.claudeResult = message
        if (
          (!session.claudeStateAware || session.claudeState === 'idle') &&
          !(typeof message.queued_turn_count === 'number' && message.queued_turn_count > 0)
        )
          session.busy = false
        return
      }
      if (
        !message.is_error &&
        Object.hasOwn(message, 'structured_output') &&
        message.structured_output !== undefined
      )
        emit({
          type: 'text',
          itemId: `structured-result-${string(message.uuid) || session.messageId || randomUUID()}`,
          text: JSON.stringify(message.structured_output, null, 2),
          status: 'replace',
          details: { structuredOutput: message.structured_output },
        })
      if (
        !message.is_error &&
        string(message.result) &&
        message.result !== session.claudeReply &&
        !claudeMessageBlocks.get(session)?.matchesText(string(message.result))
      )
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
          details: {
            ...metrics,
            usageScope: 'session',
            usageSessionId: session.remoteId,
            usageCallId: session.claudeUsageCallId,
            usageRestoresSessionTotals: claudeRestoresUsageTotals(
              session.claudeCodeVersion || this.ssh.state.claude || '',
            ),
            usageObservedAt: Date.now(),
            usageResultSubtype: message.subtype,
          },
        })
      session.claudeResult = message
      if (!session.claudeStateAware || session.claudeState === 'idle')
        this.finishClaudeResult(session, message)
    }
  }
  private finishClaudeResult(session: Session, message: Wire) {
    if (typeof message.queued_turn_count === 'number' && message.queued_turn_count > 0) return
    if (session.stopRequested) {
      session.busy = false
      session.claudeResult = undefined
      return
    }
    if (!session.busy) return
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
  respond(
    sessionId: string,
    requestId: string,
    accepted: boolean,
    answers?: Record<string, string[]>,
    decisionId?: string,
  ) {
    return this.respondOnce(sessionId, requestId, accepted, answers, decisionId)
  }
  private async respondOnce(
    sessionId: string,
    requestId: string,
    accepted: boolean,
    answers?: Record<string, string[]>,
    decisionId?: string,
    nativeStop = false,
  ) {
    const key = JSON.stringify([sessionId, requestId])
    if (this.pendingPermissionResponses.has(key))
      throw this.recoveryError(
        'permission',
        'This exact native permission response is already being admitted.',
      )
    const promise = Promise.resolve().then(() =>
      this.respondNative(sessionId, requestId, accepted, answers, decisionId, nativeStop),
    )
    this.pendingPermissionResponses.set(key, { sessionId, promise })
    try {
      await promise
    } finally {
      this.pendingPermissionResponses.delete(key)
    }
  }
  private async respondNative(
    sessionId: string,
    requestId: string,
    accepted: boolean,
    answers?: Record<string, string[]>,
    decisionId?: string,
    nativeStop = false,
  ) {
    this.assertRecovered(sessionId, nativeStop)
    const session = this.sessions.get(sessionId)
    const approval = session?.approvals.get(requestId)
    if (!session || !approval) throw new Error('This request is no longer pending')
    if (accepted && session.stopRequested)
      throw this.recoveryError(
        'permission',
        'This native Stop is already recorded. Its pending permission cannot be granted.',
      )
    let approvalOutcome: 'approved' | 'declined' | 'cancelled' | undefined
    const status = () =>
      approvalOutcome ||
      (accepted
        ? [
            'AskUserQuestion',
            'elicitation',
            'item/tool/requestUserInput',
            'mcpServer/elicitation/request',
          ].includes(approval.method)
          ? 'answered'
          : 'approved'
        : 'declined')
    const details =
      decisionId === undefined
        ? undefined
        : {
            decisionId,
            approvalDecisionLabel: codexApprovalChoices(
              approval.method,
              approval.params,
            ).approvalChoices?.find((choice) => choice.id === decisionId)?.label,
          }
    const semantic = () =>
      this.recoverySemantic(session, 'permission-response', {
        permissionRequestId: approval.wireId as string | number,
        requestType: approval.method,
        ownerGeneration: approval.owner?.generation ?? session.recoveryGeneration ?? 0,
        ...(string(approval.params.threadId)
          ? { nativeThreadId: string(approval.params.threadId) }
          : {}),
        responseBinding: JSON.parse(
          JSON.stringify({
            requestId,
            ...(approval.wireOrdinal !== undefined ? { wireOrdinal: approval.wireOrdinal } : {}),
            params: approval.params,
            status: status(),
            ...(details ? { details } : {}),
          }),
        ),
      })
    if (session.input.provider === 'codex') {
      const result = codexRequestResponse(
        approval.method,
        approval.params,
        accepted,
        answers,
        decisionId,
      )
      approvalOutcome = codexApprovalResponseOutcome(result)
      const rpc = approval.rpc || session.codexRPC
      if (!rpc || rpc.closed) throw new Error('Codex is disconnected')
      await rpc.sendAndWait({ id: approval.wireId, result }, semantic())
    } else {
      if (decisionId !== undefined)
        throw new Error('This request does not offer native Codex approval choices.')
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
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: approval.wireId,
          response:
            approval.method === 'elicitation'
              ? claudeElicitationResponse(approval.params, accepted, answers)
              : accepted
                ? { behavior: 'allow', updatedInput }
                : { behavior: 'deny', message: 'The user declined this action' },
        },
      }
      const channel = session.channel as DurableChannel
      if (channel.writeNativeAndWait) await channel.writeNativeAndWait(response, semantic())
      else this.writeClaude(session, response, semantic())
    }
    if (session.approvals.get(requestId) === approval) session.approvals.delete(requestId)
    const resolved: AgentEvent = {
      sessionId,
      type: 'request-resolved',
      requestId,
      status: status(),
      ...(details ? { details } : {}),
    }
    if (session.recoveryTransportId && this.nativeRecovery) {
      const snapshot = await runEffect(
        this.nativeRecovery.readTransport(session.recoveryTransportId),
      )
      const original = [...snapshot.inputs]
        .reverse()
        .find(
          (input) =>
            input.semantic.kind === 'permission-response' &&
            input.semantic.permissionRequestId === approval.wireId &&
            object(input.semantic.responseBinding).requestId === requestId,
        )
      if (!original)
        throw this.recoveryError(
          'permission',
          'The native permission response was not durably admitted.',
        )
      this.recovery.event(
        session.recoveryTransportId,
        resolved,
        approval.owner || this.recoveryOwner(session),
        {
          outputCursor: snapshot.outputCursor,
          eventId: `${session.recoveryTransportId}:input:${original.sequence}:request-resolved`,
        },
      )
    } else this.emit(resolved)
    await this.flushRecovery()
  }
  async stop(sessionId: string) {
    const pendingCompletion = this.stopCompletions.get(sessionId)
    if (pendingCompletion) return runEffect(Deferred.await(pendingCompletion))
    this.assertRecovered(sessionId)
    const session = this.sessions.get(sessionId)
    const reservation = this.recoveryReservations.get(sessionId)
    if (reservation) {
      const owner = reservation.transport.owners.find(
        (value) => value.kind === 'root' && value.sessionId === sessionId,
      )!
      await runEffect(
        this.recovery.updateOwnerEffect(reservation.transport.id, {
          ...owner,
          stopRequested: true,
        }),
      )
      this.recoveryReservations.set(
        sessionId,
        await runEffect(this.nativeRecovery!.readTransport(reservation.transport.id)),
      )
      if (session?.recoveryTransportId === reservation.transport.id) session.stopRequested = true
      return
    }
    if (
      !session ||
      (!session.busy && !session.claudeActiveChildren?.size && !this.hasCodexChildren(sessionId))
    )
      return
    if (session.recoveryTransportId && this.nativeRecovery) {
      const completion = Deferred.makeUnsafe<void, NativeRecoveryError>()
      this.stopCompletions.set(sessionId, completion)
      this.recoveredStops.add(sessionId)
      session.stopRequested = true
      session.titleTask?.abort()
      if (session.phase === 'initializing') session.initialization.abort()
      const channel =
        session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
      try {
        if (channel) await this.recordRecoveryOwner(session, channel)
        await this.continueRecoveredStop(session)
      } catch (cause) {
        Deferred.doneUnsafe(
          completion,
          Effect.fail(this.recoveryError('stop', 'The original Stop remains unresolved.', cause)),
        )
        throw cause
      }
      return runEffect(Deferred.await(completion))
    }
    if (session.stopping) return session.stopping
    session.stopRequested = true
    const stopping = (async () => {
      const channel =
        session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
      if (channel) await this.recordRecoveryOwner(session, channel)
      await this.stopSession(sessionId, session, session.busy)
    })()
    session.stopping = stopping
    try {
      await stopping
      const channel =
        session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
      if (channel) await this.recordRecoveryOwner(session, channel)
      await this.flushRecovery()
    } finally {
      if (session.stopping === stopping) session.stopping = undefined
    }
  }
  private hasCodexChildren(sessionId: string, rpc?: RPC) {
    return [...this.childThreads.values()].some(
      (child) => child.sessionId === sessionId && child.busy && (!rpc || child.rpc === rpc),
    )
  }
  private resolveCodexRequests(sessionId: string, session: Session, rpc?: RPC, threadId?: string) {
    for (const [requestId, approval] of session.approvals) {
      if (rpc && (approval.rpc || session.codexRPC) !== rpc) continue
      if (threadId && approval.params.threadId !== threadId) continue
      session.approvals.delete(requestId)
      const agentId = string(approval.params.threadId)
      this.event(sessionId, {
        type: 'request-resolved',
        provider: 'codex',
        requestId,
        status: 'cancelled',
        ...(agentId && agentId !== session.remoteId ? { agentId } : {}),
      })
    }
  }
  private finishCodexChildren(
    sessionId: string,
    session: Session,
    status: 'failed' | 'interrupted',
    rpc?: RPC,
  ) {
    for (const [agentId, child] of this.childThreads) {
      if (child.sessionId !== sessionId || (rpc && child.rpc !== rpc)) continue
      if (child.busy)
        this.event(sessionId, {
          type: 'subagent',
          provider: 'codex',
          agentId,
          itemId: `agent-${agentId}`,
          agentName: child.agentName,
          title: child.agentName || 'Subagent',
          status,
          details: { lifecycle: 'turn', nativeTurnId: child.turnId },
        })
      child.busy = false
      if (child.turnId) child.ignoredTurns.add(child.turnId)
      this.resolveCodexRequests(sessionId, session, child.rpc, agentId)
    }
  }
  private finishClaudeChildren(
    sessionId: string,
    session: Session,
    status: 'failed' | 'interrupted',
  ) {
    for (const [agentId, child] of session.claudeActiveChildren || []) {
      claudeMessageBlocks.get(session)?.retireStream(child.parentItemId || agentId)
      this.event(sessionId, {
        type: 'subagent',
        provider: 'claude',
        agentId,
        itemId: child.itemId,
        title: child.title || 'Subagent',
        agentName: child.title,
        parentItemId: child.parentItemId,
        status,
        details: { lifecycle: 'turn' },
      })
    }
    session.claudeActiveChildren?.clear()
  }
  private resolveClaudeRequests(
    sessionId: string,
    session: Session,
    agentIds?: string[],
    status = 'cancelled',
  ) {
    for (const [requestId, approval] of session.approvals) {
      const agentId =
        string(approval.params.agent_id || approval.params.parent_tool_use_id) || undefined
      if (agentIds && (!agentId || !agentIds.includes(agentId))) continue
      session.approvals.delete(requestId)
      this.event(sessionId, {
        type: 'request-resolved',
        provider: 'claude',
        requestId,
        status,
        ...(agentId ? { agentId, agentName: session.claudeAgentNames.get(agentId) } : {}),
      })
    }
  }
  private async stopSession(sessionId: string, session: Session, interruptRoot: boolean) {
    const generation = this.generation
    const rpc = session.codexRPC
    const ownsSession = () =>
      this.generation === generation && this.sessions.get(sessionId) === session
    // No user prompt has been sent during initialization. Finish immediately;
    // the startup checks the turn identity before issuing any remote work.
    if (session.phase === 'initializing') session.initialization.abort()
    if (session.phase === 'initializing' && !this.hasCodexChildren(sessionId)) {
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
      if (session.input.provider === 'codex') {
        this.finishCodexChildren(sessionId, session, 'interrupted')
        this.resolveCodexRequests(sessionId, session)
      }
      session.approvals.clear()
      if (session.input.provider === 'claude')
        this.finishClaudeChildren(sessionId, session, 'interrupted')
      this.event(sessionId, { type: 'complete', status: 'interrupted' })
      return
    }
    await session.startup?.catch(() => {})
    if (!ownsSession()) return
    for (const id of [...session.approvals.keys()]) {
      if (!ownsSession()) return
      if (session.approvals.has(id)) {
        const approval = session.approvals.get(id)
        try {
          const decisionId =
            session.input.provider === 'codex' && approval
              ? codexApprovalStopDecisionId(approval.method, approval.params)
              : undefined
          // With no advertised non-grant decision, the acknowledged interrupt
          // below resolves the request without inventing a provider response.
          if (decisionId === null) continue
          await this.respond(sessionId, id, false, undefined, decisionId)
          if (session.input.provider === 'codex' && approval) {
            const agentId = string(approval.params.threadId)
            this.event(sessionId, {
              type: 'request-resolved',
              provider: 'codex',
              requestId: id,
              status: 'cancelled',
              ...(agentId && agentId !== session.remoteId ? { agentId } : {}),
            })
          }
        } catch (error) {
          if (!ownsSession()) return
          throw error
        }
      }
      if (!ownsSession()) return
    }
    if (
      session.input.provider === 'codex' &&
      interruptRoot &&
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
    if (session.input.provider === 'codex') {
      const children = [...this.childThreads].filter(
        ([, child]) => child.sessionId === sessionId && child.busy,
      )
      for (const [threadId, child] of children) {
        if (!ownsSession()) return
        try {
          await child.rpc.request(
            'turn/interrupt',
            {
              threadId,
              ...(child.turnId ? { turnId: child.turnId } : {}),
            },
            10000,
          )
        } catch (error) {
          if (!ownsSession()) return
          child.rpc.close(error instanceof Error ? error : new Error(String(error)))
          this.event(sessionId, {
            type: 'status',
            text: `Codex subagent interruption failed; its connection was closed. ${(error as Error).message}`,
          })
        }
      }
      if (!ownsSession()) return
      this.finishCodexChildren(sessionId, session, 'interrupted')
      this.resolveCodexRequests(sessionId, session)
    }
    if (!ownsSession()) return
    session.busy = false
    session.approvals.clear()
    if (session.input.provider === 'claude')
      this.finishClaudeChildren(sessionId, session, 'interrupted')
    if (interruptRoot) this.event(sessionId, { type: 'complete', status: 'interrupted' })
  }
  async dispose(sessionId: string) {
    this.assertRecovered(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.stop(sessionId)
    if (this.sessions.get(sessionId) !== session) return
    session.stopRequested = true
    session.initialization.abort()
    session.titleTask?.abort()
    if (session.recoveryTransportId)
      await runEffect(
        this.recovery.updateOwnerEffect(session.recoveryTransportId, {
          ...this.recoveryOwner(session),
          state: 'complete',
        }),
      )
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
    return (
      [...this.childThreads.values()].some((child) => child.busy) ||
      [...this.sessions.values()].some(
        (session) =>
          session.busy ||
          !!session.claudeActiveChildren?.size ||
          session.startup !== undefined ||
          session.stopping !== undefined,
      )
    )
  }
  hasPendingRendererWork(): boolean {
    return (
      this.pendingNativeOperations.size > 0 ||
      this.pendingProviderExits.size > 0 ||
      this.hasRunningSessions() ||
      this.pendingCodexAcquisitions.size > 0 ||
      this.pendingStartAdmissions.size > 0 ||
      this.pendingPermissionResponses.size > 0 ||
      [...this.pendingRecoveryDecisions.values()].some((entries) => entries.size > 0) ||
      this.durableOpening > 0 ||
      this.freshProviderChannels.size > 0 ||
      this.failedFreshProviders.size > 0 ||
      this.discoveryChannels.size > 0 ||
      this.recoveryStarting !== undefined ||
      [...this.sessions.values()].some((session) =>
        Boolean(
          session.recoveryUnknown ||
          session.configuration ||
          session.approvals.size ||
          session.controls.size ||
          this.channelHasPendingDelivery(session.channel as DurableChannel | undefined),
        ),
      ) ||
      [...this.codexTransports].some((rpc) => !this.codexTransportIdle(rpc))
    )
  }
  /** A registered active provider can survive document replacement; allocation gaps cannot. */
  hasUntrackedRunningSessions(): boolean {
    if (
      this.pendingNativeOperations.size ||
      this.pendingProviderExits.size ||
      this.pendingCodexAcquisitions.size ||
      this.deferredRecoveryAttachments.size ||
      this.pendingStartAdmissions.size ||
      this.pendingPermissionResponses.size ||
      [...this.pendingRecoveryDecisions.values()].some((entries) => entries.size > 0) ||
      this.durableOpening ||
      this.freshProviderChannels.size ||
      this.failedFreshProviders.size ||
      this.discoveryChannels.size ||
      this.recoveryStarting ||
      this.recoveryAdmissionDepth
    )
      return true
    for (const [sessionId, session] of this.sessions) {
      const active =
        session.recoveryUnknown ||
        session.busy ||
        this.hasCodexChildren(sessionId) ||
        session.claudeActiveChildren?.size ||
        session.approvals.size ||
        session.startup ||
        session.stopping ||
        session.configuration ||
        session.controls.size
      if (!active) continue
      const channel = (
        session.input.provider === 'codex' ? session.codexRPC?.channel : session.channel
      ) as DurableChannel | undefined
      if (
        !this.nativeRecovery ||
        this.recovery.failure ||
        this.recoveryFailures.has('*') ||
        this.recoveryFailures.has(sessionId) ||
        session.recoveryUnknown ||
        !session.recoveryTransportId ||
        !session.recoverySnapshotToken ||
        !this.recoveryLoaded.has(session.recoveryTransportId) ||
        !channel ||
        channel.recoveryId !== session.recoveryTransportId ||
        channel.isClosing ||
        channel.destroyed ||
        session.startup ||
        session.stopping ||
        session.configuration ||
        this.recoveredStarts.has(sessionId) ||
        this.recoveredStops.has(sessionId) ||
        (session.busy && session.phase !== 'running')
      )
        return true
      if (
        session.input.provider === 'codex' &&
        (!session.codexRPC || session.codexRPC.closed || session.codexRPC.hasPendingMutation)
      )
        return true
    }
    return false
  }
  readonly rendererHandoffAdmittedEffect = Effect.fn('Agents.rendererHandoffAdmitted')(
    function* (this: Agents) {
      if (this.hasUntrackedRunningSessions()) return false
      yield* Effect.tryPromise({
        try: () => this.flushRecovery(),
        catch: (cause) =>
          this.recoveryError(
            'renderer-handoff',
            'Native ownership could not be flushed for renderer replacement.',
            cause,
          ),
      })
      if (this.hasUntrackedRunningSessions()) return false
      if (!this.nativeRecovery) return !this.hasRunningSessions()
      yield* this.nativeRecovery.flushEffect()
      const snapshots = yield* this.nativeRecovery.listTransports()
      if (
        snapshots.some(
          (snapshot) =>
            (snapshot.closeInputSequence !== undefined ||
              snapshot.outputs.some(
                (frame) => frame.type === 'exit' && frame.nativeExitConfirmed === false,
              )) &&
            !snapshot.outputs.some(isConfirmedNativeExit),
        )
      )
        return false
      for (const [sessionId, session] of this.sessions) {
        if (!(
          session.busy ||
          this.hasCodexChildren(sessionId) ||
          session.claudeActiveChildren?.size ||
          session.approvals.size
        ))
          continue
        const snapshot = snapshots.find(
          (candidate) => candidate.transport.id === session.recoveryTransportId,
        )
        const owner = snapshot?.transport.owners.find(
          (candidate) => candidate.kind === 'root' && candidate.sessionId === sessionId,
        )
        if (
          !snapshot ||
          !owner ||
          owner.generation !== session.recoveryGeneration ||
          owner.snapshotToken !== session.recoverySnapshotToken ||
          owner.workspace !== session.workspace ||
          this.recoveryMachine(snapshot) !== session.machineIdentity ||
          owner.state === 'unknown' ||
          snapshot.closeInputSequence !== undefined ||
          snapshot.outputs.some(
            (frame) => frame.type === 'exit' && frame.nativeExitConfirmed === false,
          ) ||
          (session.remoteId && session.remoteId !== (owner.nativeThreadId || owner.nativeSessionId))
        )
          return false
        if (
          snapshot.inputs.some(
            (input) =>
              input.semantic.sessionId === sessionId &&
              input.semantic.ownerGeneration === session.recoveryGeneration &&
              !input.written &&
              !this.hasNativeInputProcessingProof(snapshot.transport.id, input) &&
              ['user-prompt', 'initialize', 'settings'].includes(input.semantic.kind),
          )
        )
          return false
        const historicalOwners = snapshot.records.flatMap((record) =>
          record.kind === 'create'
            ? [...record.transport.owners]
            : record.kind === 'transport'
              ? [...(record.patch.owners || [])]
              : [],
        )
        const owns = (origin?: NativeRecoveryOwner) =>
          Boolean(
            origin &&
            [...historicalOwners, ...snapshot.transport.owners].some(
              (candidate) =>
                candidate.ownerId === origin.ownerId &&
                candidate.sessionId === origin.sessionId &&
                candidate.generation === origin.generation &&
                candidate.snapshotToken === origin.snapshotToken &&
                candidate.workspace === origin.workspace,
            ),
          )
        for (const [requestId, approval] of session.approvals)
          if (
            !owns(approval.owner) ||
            !snapshot.events.some(
              (stored) =>
                stored.event.sessionId === sessionId &&
                stored.event.requestId === requestId &&
                ['approval', 'question'].includes(string(stored.event.type)),
            )
          )
            return false
        for (const [agentId, child] of this.childThreads)
          if (
            child.sessionId === sessionId &&
            child.busy &&
            (!owns(child.owner) ||
              !snapshot.events.some(
                (stored) =>
                  stored.event.sessionId === sessionId &&
                  stored.event.type === 'subagent' &&
                  (stored.event.agentId === agentId ||
                    (Array.isArray(object(stored.event.details).receiverThreadIds) &&
                      (object(stored.event.details).receiverThreadIds as unknown[]).includes(
                        agentId,
                      ))),
              ))
          )
            return false
        for (const [agentId, child] of session.claudeActiveChildren || [])
          if (
            !owns(child.owner) ||
            !snapshot.events.some(
              (stored) => stored.event.sessionId === sessionId && stored.event.agentId === agentId,
            )
          )
            return false
      }
      return !this.hasUntrackedRunningSessions()
    }.bind(this),
  )
  rendererHandoffAdmitted(): Promise<boolean> {
    return runEffect(this.rendererHandoffAdmittedEffect())
  }
  /** Current and retiring provider channels still requiring terminal confirmation. */
  hasProviderRetirementTargets(): boolean {
    return (
      this.pendingCodexAcquisitions.size > 0 ||
      this.freshProviderChannels.size > 0 ||
      this.ownerlessClaudeAttachments.size > 0 ||
      this.openingCodexChannels.size > 0 ||
      this.codexTransports.size > 0 ||
      this.pendingProviderExits.size > 0 ||
      [...this.sessions.values()].some(
        (session) => session.input.provider === 'claude' && session.channel !== undefined,
      )
    )
  }
  private codexMachineStarting(machine: string) {
    return (
      [...this.pendingStartAdmissions.values()].some(
        (entry) => entry.machine === machine && entry.provider === 'codex',
      ) ||
      [...this.sessions.values()].some(
        (session) =>
          session.input.provider === 'codex' &&
          session.machineIdentity === machine &&
          (session.busy ||
            session.startup !== undefined ||
            session.stopping !== undefined ||
            session.configuration !== undefined ||
            session.approvals.size > 0),
      )
    )
  }
  private codexTransportIdle(rpc: RPC) {
    const channel = rpc.channel as DurableChannel
    if (
      rpc.closed ||
      this.channelHasPendingDelivery(channel) ||
      (channel.recoveryId && this.recoveringCodexInitialization.has(channel.recoveryId)) ||
      rpc.hasPendingMutation
    )
      return false
    const machine = this.codexTransportMachines.get(rpc)
    if (
      [...this.pendingStartAdmissions.values()].some(
        (entry) => entry.provider === 'codex' && entry.machine === machine,
      )
    )
      return false
    if ([...this.childThreads.values()].some((child) => child.rpc === rpc && child.busy))
      return false
    return ![...this.sessions.values()].some((session) => {
      if (session.codexRPC === rpc && session.recoveryUnknown) return true
      if (
        [...session.approvals.values()].some(
          (approval) => (approval.rpc || session.codexRPC) === rpc,
        )
      )
        return true
      return (
        session.input.provider === 'codex' &&
        (session.codexRPC === rpc || (!session.codexRPC && session.machineIdentity === machine)) &&
        (session.busy ||
          session.startup !== undefined ||
          session.stopping !== undefined ||
          session.configuration !== undefined)
      )
    })
  }
  private claudeSessionIdle(session: Session) {
    return !(
      session.busy ||
      session.startup ||
      session.stopping ||
      session.configuration ||
      session.approvals.size ||
      session.controls.size ||
      this.channelHasPendingDelivery(session.channel as DurableChannel | undefined) ||
      session.recoveryUnknown ||
      (session.channel as DurableChannel | undefined)?.isClosing ||
      session.claudeActiveChildren?.size
    )
  }
  private forgetRetiredCodex(channel: DurableChannel) {
    for (const rpc of this.codexTransports) {
      if (rpc.channel !== channel) continue
      this.intentionalIdleClosing.delete(rpc)
      this.codexTransports.delete(rpc)
      const machine = this.codexTransportMachines.get(rpc)
      if (machine && this.codexByMachine.get(machine) === rpc) this.codexByMachine.delete(machine)
      if (this.codex === rpc) {
        this.codex = undefined
        this.clearCodexModelCatalogs()
      }
      for (const [remoteId, owner] of this.threadTransports)
        if (owner === rpc) this.threadTransports.delete(remoteId)
      for (const [remoteId, child] of this.childThreads)
        if (child.rpc === rpc) this.childThreads.delete(remoteId)
      for (const session of this.sessions.values())
        if (session.codexRPC === rpc) session.codexRPC = undefined
    }
  }
  private readonly releaseProviderEffect = Effect.fnUntraced(
    function* (
      this: Agents,
      provider: Provider,
      channel: DurableChannel,
      release: () => Effect.Effect<boolean, NativeRecoveryError | CodexTransportError>,
    ) {
      let owner = this.pendingProviderExits.get(channel)
      if (!owner) {
        const onExit = () => {
          if (this.pendingProviderExits.get(channel)?.onExit === onExit)
            this.pendingProviderExits.delete(channel)
          channel.off('exit', onExit)
          const id = channel.recoveryId
          if (id) this.terminalTransports.add(id)
          this.forgetRetiredCodex(channel)
        }
        const rpc = [...this.codexTransports].find((candidate) => candidate.channel === channel)
        const machine =
          this.openingCodexChannels.get(channel) ??
          (rpc && this.codexTransportMachines.get(rpc)) ??
          [...this.sessions.values()].find((session) => session.channel === channel)
            ?.machineIdentity ??
          this.machineIdentity()
        owner = { provider, machine, onExit }
        this.pendingProviderExits.set(channel, owner)
        channel.once('exit', onExit)
      }
      const confirmed = yield* release()
      if (confirmed) {
        owner.onExit()
        const id = channel.recoveryId
        if (id) this.terminalTransports.add(id)
        this.forgetRetiredCodex(channel)
      }
      return confirmed
    }.bind(this),
  )
  private retryProviderExits(provider: Provider) {
    return [...this.pendingProviderExits]
      .filter(([, owner]) => owner.provider === provider)
      .map(([channel, owner]) =>
        Effect.suspend(() => {
          if (this.pendingProviderExits.get(channel) !== owner) return Effect.succeed(true)
          if (provider === 'codex') {
            const rpc = [...this.codexTransports].find((candidate) => candidate.channel === channel)
            if (rpc && !this.intentionalIdleClosing.has(rpc) && !this.codexTransportIdle(rpc))
              return Effect.succeed(false)
          } else if (
            [...this.sessions.values()].some(
              (session) => session.channel === channel && !this.claudeSessionIdle(session),
            )
          )
            return Effect.succeed(false)
          return this.releaseProviderEffect(
            provider,
            channel,
            () => channel.closeAndWaitEffect?.() ?? Effect.succeed(false),
          )
        }),
      )
  }
  private localEnvironmentRetirementTargets(machine: string) {
    const retained = [...this.pendingProviderExits]
      .filter(([, owner]) => owner.machine === machine)
      .map(([channel, owner]) =>
        Effect.suspend(() => {
          if (this.pendingProviderExits.get(channel) !== owner) return Effect.succeed(true)
          const rpc = [...this.codexTransports].find((candidate) => candidate.channel === channel)
          if (
            (rpc && !this.intentionalIdleClosing.has(rpc) && !this.codexTransportIdle(rpc)) ||
            [...this.sessions.values()].some(
              (session) => session.channel === channel && !this.claudeSessionIdle(session),
            )
          )
            return Effect.succeed(undefined)
          return this.releaseProviderEffect(
            owner.provider,
            channel,
            () => channel.closeAndWaitEffect?.() ?? Effect.succeed(false),
          )
        }),
      )
    if (
      [...this.pendingNativeOperations].some(
        (operation) => this.pendingNativeOperationMachines.get(operation) === machine,
      )
    )
      return retained
    const opening = [...this.openingCodexChannels]
      .filter(
        ([channel, owner]) =>
          owner === machine &&
          !this.pendingProviderExits.has(channel) &&
          !this.channelHasPendingDelivery(channel) &&
          !this.codexMachineStarting(machine),
      )
      .map(([channel]) =>
        Effect.suspend(() =>
          this.codexMachineStarting(machine) || this.channelHasPendingDelivery(channel)
            ? Effect.succeed(undefined)
            : this.releaseProviderEffect(
                'codex',
                channel,
                () => channel.closeAndWaitEffect?.() ?? Effect.succeed(false),
              ),
        ),
      )
    const registered = [...this.codexTransports]
      .filter(
        (rpc) =>
          this.codexTransportMachines.get(rpc) === machine &&
          !this.pendingProviderExits.has(rpc.channel as DurableChannel) &&
          this.codexTransportIdle(rpc),
      )
      .map((rpc) =>
        Effect.suspend(() =>
          this.codexTransportIdle(rpc)
            ? this.releaseProviderEffect('codex', rpc.channel as DurableChannel, () =>
                this.retireCodexEffect(rpc),
              )
            : Effect.succeed(undefined),
        ),
      )
    const claude = [...this.sessions.entries()]
      .filter(
        ([, session]) =>
          session.machineIdentity === machine &&
          session.input.provider === 'claude' &&
          session.channel &&
          !this.pendingProviderExits.has(session.channel as DurableChannel) &&
          this.claudeSessionIdle(session),
      )
      .map(([id, session]) =>
        Effect.suspend(() => {
          const channel = session.channel as DurableChannel | undefined
          if (!channel || this.sessions.get(id) !== session || !this.claudeSessionIdle(session))
            return Effect.succeed(undefined)
          return this.releaseProviderEffect('claude', channel, () => {
            session.channel = undefined
            return channel.closeAndWaitEffect
              ? channel.closeAndWaitEffect()
              : Effect.sync(() => {
                  channel.close()
                  return false
                })
          })
        }),
      )
    return [...retained, ...opening, ...registered, ...claude]
  }
  /** Retire idle Local owners while their host remains available, then commit the change. */
  readonly withEnvironmentChangeEffect = Effect.fn('Agents.withEnvironmentChange')(
    function* <A, E, R>(
      this: Agents,
      operation: Effect.Effect<A, E, R>,
      ownsRequest: () => boolean = () => true,
    ): Effect.fn.Return<
      A,
      E | AgentEnvironmentError | NativeRecoveryError | CodexTransportError,
      R | Scope.Scope
    > {
      const ownsEnvironment = this.ssh.captureEnvironmentOwnership()
      const current = () => ownsEnvironment() && ownsRequest()
      const changed = () =>
        new AgentEnvironmentError({
          reason: 'changed',
          message: 'The selected environment or Life interface changed. Try again.',
          cause: undefined,
        })
      if (!current()) return yield* changed()
      if (this.ssh.state.status === 'connected' && this.ssh.state.profile?.transport === 'local') {
        const machine = this.machineIdentity()
        const token = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              this.assertEnvironmentAdmission(machine)
              const token = {}
              this.environmentChanges.set(machine, token)
              return token
            },
            catch: changed,
          }),
          (token) =>
            Effect.sync(() => {
              if (this.environmentChanges.get(machine) === token)
                this.environmentChanges.delete(machine)
            }),
        )
        const allocations = [...this.pendingCodexAcquisitions.values()].filter(
          (allocation) => !this.registeredCodexAllocations.has(allocation),
        )
        if (allocations.length) yield* Effect.promise(() => Promise.allSettled(allocations))
        for (;;) {
          if (!current() || this.environmentChanges.get(machine) !== token) return yield* changed()
          const targets = this.localEnvironmentRetirementTargets(machine)
          if (!targets.length) break
          const results = yield* Effect.all(targets, { concurrency: 'unbounded' })
          if (results.some((confirmed) => confirmed === false))
            return yield* new AgentEnvironmentError({
              reason: 'retirement',
              message:
                'Life could not confirm that an idle Local provider exited. The environment is unchanged; retry the switch.',
              cause: undefined,
            })
          if (results.every((confirmed) => confirmed === undefined)) break
          yield* Effect.yieldNow
        }
      }
      return yield* Effect.suspend<
        A,
        E | AgentEnvironmentError | NativeRecoveryError | CodexTransportError,
        R
      >(() => (current() ? operation : Effect.fail(changed())))
    }.bind(this),
    Effect.scoped,
  )
  private readonly retireCodexEffect = Effect.fnUntraced(
    function* (this: Agents, rpc: RPC) {
      if ((rpc.channel as DurableChannel).recoveryId) this.intentionalIdleClosing.add(rpc)
      return yield* rpc.releaseEffect()
    }.bind(this),
  )
  /** An active root, child, startup, or native permission owns its entire shared RPC. */
  readonly releaseIdleProvidersEffect = Effect.fn('Agents.releaseIdleProviders')(
    function* (
      this: Agents,
      acquisitions: readonly Promise<void>[] = [...this.pendingCodexAcquisitions.values()],
    ) {
      const unregistered = acquisitions.filter(
        (allocation) => !this.registeredCodexAllocations.has(allocation),
      )
      if (unregistered.length) yield* Effect.promise(() => Promise.allSettled(unregistered))
      const retained = this.retryProviderExits('codex')
      const opening = [...this.openingCodexChannels]
        .filter(([channel]) => !this.pendingProviderExits.has(channel))
        .map(([channel, machine]) =>
          Effect.suspend(() =>
            !this.codexMachineStarting(machine) && !this.channelHasPendingDelivery(channel)
              ? this.releaseProviderEffect(
                  'codex',
                  channel,
                  () => channel.closeAndWaitEffect?.() ?? Effect.succeed(false),
                )
              : Effect.succeed(false),
          ),
        )
      const registered = [...this.codexTransports]
        .filter((rpc) => !this.pendingProviderExits.has(rpc.channel as DurableChannel))
        .map((rpc) =>
          Effect.suspend(() =>
            this.codexTransportIdle(rpc)
              ? this.releaseProviderEffect('codex', rpc.channel as DurableChannel, () =>
                  this.retireCodexEffect(rpc),
                )
              : Effect.succeed(false),
          ),
        )
      return yield* Effect.all([...retained, ...opening, ...registered], {
        concurrency: 'unbounded',
      })
    }.bind(this),
  )
  releaseIdleProviders(): Promise<boolean[]> {
    if (this.idleProviderRelease) return this.idleProviderRelease
    const acquisitions = [...this.pendingCodexAcquisitions.values()]
    const releasing = runEffect(this.releaseIdleProvidersEffect(acquisitions))
    const settled = releasing.finally(() => {
      if (this.idleProviderRelease === settled) this.idleProviderRelease = undefined
    })
    this.idleProviderRelease = settled
    return settled
  }
  /** Native quit releases completed Claude daemons without touching live work or requests. */
  readonly releaseIdleClaudeProvidersEffect = Effect.fn('Agents.releaseIdleClaudeProviders')(
    function* (this: Agents) {
      const retained = this.retryProviderExits('claude')
      const idle = [...this.sessions.entries()]
        .filter(([, session]) => session.input.provider === 'claude' && session.channel)
        .map(([id, session]) =>
          Effect.suspend(() => {
            const channel = session.channel as DurableChannel | undefined
            if (
              session.input.provider !== 'claude' ||
              !channel ||
              !this.claudeSessionIdle(session) ||
              this.sessions.get(id) !== session
            )
              return Effect.succeed(false)
            // Late output/close callbacks cannot revise an already completed turn.
            // The native session ID stays available for a later --resume invocation.
            return this.releaseProviderEffect('claude', channel, () => {
              session.channel = undefined
              return channel.closeAndWaitEffect
                ? channel.closeAndWaitEffect()
                : Effect.sync(() => {
                    channel.close()
                    return false
                  })
            })
          }),
        )
      return yield* Effect.all([...retained, ...idle], { concurrency: 'unbounded' })
    }.bind(this),
  )
  releaseIdleClaudeProviders(): Promise<boolean[]> {
    if (this.idleClaudeProviderRelease) return this.idleClaudeProviderRelease
    const releasing = runEffect(this.releaseIdleClaudeProvidersEffect())
    const settled = releasing.finally(() => {
      if (this.idleClaudeProviderRelease === settled) this.idleClaudeProviderRelease = undefined
    })
    this.idleClaudeProviderRelease = settled
    return settled
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
    for (const [id, session] of this.sessions) {
      if (session.input.provider === 'codex') {
        this.finishCodexChildren(id, session, 'failed')
        this.resolveCodexRequests(id, session)
      }
      if (session.input.provider === 'claude') {
        this.resolveClaudeRequests(id, session)
        this.finishClaudeChildren(id, session, 'failed')
      }
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
    this.childThreads.clear()
    this.sessions.clear()
  }
}
