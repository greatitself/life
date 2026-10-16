import type {
  AgentEvent,
  ConnectionProfile,
  ConnectionState,
  ModelOption,
  NativeRecoveryCursor,
  NativeRecoveryOwnerState,
  PermissionMode,
  Provider,
} from '../shared/types'
import { permissionModes } from '../shared/permissions'
import { appendConversationMessageText } from './conversation-message-appends'
import {
  attachConversationSource,
  conversationSourceHasPersistedField,
  reconcileConversationLifecycle,
} from './conversation-source'
import { normalizeThreadAttachments, type ThreadAttachment } from './attachments'
import { normalizeQueuedMessages, pauseQueuedMessages, type QueuedMessage } from './thread-queue'
import { isSubagentActivity, normalizeFileChanges, type ThreadFileChange } from './thread-activity'
import {
  normalizeMessageMetadata,
  normalizeImportedThreadHistory,
  normalizeResearchThreadContext,
  normalizeThreadMetadata,
  type MessageMetadata,
  type ImportedThreadHistory,
  type ResearchThreadContext,
  type ThreadMetadata,
} from './thread-metadata'
import { normalizeSourceChange, type SourceChangeReceipt } from './source-presentation'
import {
  carryNativeProjectionOwnerSnapshot,
  carryNativeProjectionAuthoredTransition,
  hasNativeProjectionCursor,
  registerNativeProjectionBaseline,
  registerNativeProjectionDelivery,
} from './native-projection-admissions'
export interface Message extends MessageMetadata {
  nativeRecovery?: { transportId: string; ownerGeneration?: number }
  /** Restored child snapshots retain history but need a fresh native event to prove liveness. */
  activityStateUnknown?: true
  createdAt?: number
  finishedAt?: number
  finishStatus?: string
  input?: string
  fileChanges?: ThreadFileChange[]
  sourceChange?: SourceChangeReceipt
  attachments?: ThreadAttachment[]
  id: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  title?: string
  status?: string
  turn: number
}
export interface Thread extends ThreadMetadata {
  /** Applied ledger progress is persisted with the exact recovered transcript. */
  nativeRecovery?: Record<string, NativeRecoveryCursor>
  /** Mutation authority is reconciled with the native owner after cold hydration. */
  nativeRecoveryStatus?: NativeRecoveryOwnerState['status']
  nativeRecoveryOwner?: { transportId: string; ownerGeneration?: number; snapshotToken?: string }
  nativeRecoveryAdmissionBlocked?: true
  createdAt?: number
  pinnedAt?: number
  pinOrder?: number
  activeOrder?: number
  lastReadAt?: number
  /** An explicit completed provider turn, never inferred from old history or streamed text. */
  completedAt?: number
  attentionAt?: number
  settledAt?: number
  snoozedAt?: number
  archivedAt?: number
  purpose?: 'research' | 'customization'
  researchContext?: ResearchThreadContext
  importedHistory?: ImportedThreadHistory
  settled?: boolean
  snoozedUntil?: number
  id: string
  profileId: string
  /** Canonical remote project folder associated with the provider conversation. */
  workspace?: string
  /** A previous remote conversation had no resolvable project; never adopt a later project's folder. */
  workspaceUnknown?: boolean
  provider: Provider
  title: string
  titleSource?: 'provider' | 'manual'
  remoteId?: string
  messages: Message[]
  queue?: QueuedMessage[]
  busy: boolean
  /** A disconnected or temporarily idle transport is not a completed provider turn. */
  turnStatus?: 'running' | 'completed' | 'interrupted' | 'failed' | 'reconnecting' | 'unknown'
  agentStatus?: string
  connectionStatus?: 'connected' | 'reconnecting' | 'disconnected'
  statusText?: string
  statusDetails?: Record<string, unknown>
  agentSettings?: Record<string, unknown>
  /** Child agents retain the parent turn that launched them while later turns run. */
  agentTurns?: Record<string, number>
  model: string
  reasoningEffort?: string
  serviceTier?: string
  mode: PermissionMode
  updatedAt: number
  turn: number
  pending: AgentEvent[]
  /** Follow-up messages retain Life scope until the user returns to their project. */
  lifeScope?: boolean
}
function recoveryNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
const liveRecoveryCursors = new WeakSet<NativeRecoveryCursor>()
function admitRecoveryCursor<T extends NativeRecoveryCursor>(cursor: T): T {
  liveRecoveryCursors.add(cursor)
  return cursor
}
export function normalizeNativeRecovery(value: unknown): Thread['nativeRecovery'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const entries: [string, NativeRecoveryCursor][] = []
  for (const transportId of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, transportId)
    const cursor = descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined
    if (!transportId || !cursor || typeof cursor !== 'object' || Array.isArray(cursor)) continue
    const applied = Object.getOwnPropertyDescriptor(cursor, 'appliedRevision')
    if (!applied || applied.get || applied.set || !recoveryNumber(applied.value)) continue
    const token = Object.getOwnPropertyDescriptor(cursor, 'snapshotToken')
    const generation = Object.getOwnPropertyDescriptor(cursor, 'ownerGeneration')
    entries.push([
      transportId,
      {
        appliedRevision: applied.value,
        ...(token && !token.get && !token.set && typeof token.value === 'string' && token.value
          ? { snapshotToken: token.value }
          : {}),
        ...(generation && !generation.get && !generation.set && recoveryNumber(generation.value)
          ? { ownerGeneration: generation.value }
          : {}),
      },
    ])
  }
  return entries.length ? Object.fromEntries(entries) : undefined
}
function validRecoveryEvent(event: AgentEvent): boolean {
  const recovery = event.nativeRecovery
  return (
    recovery === undefined ||
    (Boolean(recovery) &&
      typeof recovery === 'object' &&
      !Array.isArray(recovery) &&
      typeof recovery.transportId === 'string' &&
      Boolean(recovery.transportId) &&
      typeof recovery.eventId === 'string' &&
      Boolean(recovery.eventId) &&
      recoveryNumber(recovery.revision) &&
      recovery.revision > 0 &&
      (recovery.ownerGeneration === undefined || recoveryNumber(recovery.ownerGeneration)) &&
      (recovery.localTurn === undefined || recoveryNumber(recovery.localTurn)) &&
      (recovery.emittedAt === undefined || recoveryNumber(recovery.emittedAt)) &&
      (recovery.snapshotToken === undefined ||
        (typeof recovery.snapshotToken === 'string' && Boolean(recovery.snapshotToken))))
  )
}
export function acceptsAgentEvent(thread: Thread, event: AgentEvent): boolean {
  if (event.sessionId !== thread.id || !validRecoveryEvent(event)) return false
  const recovery = event.nativeRecovery
  if (!recovery) return true
  if (thread.nativeRecoveryAdmissionBlocked) return false
  const prior = Object.hasOwn(thread.nativeRecovery || {}, recovery.transportId)
    ? thread.nativeRecovery?.[recovery.transportId]
    : undefined
  return !prior || recovery.revision > prior.appliedRevision
}
function recoveryCursor(event: AgentEvent): NativeRecoveryCursor {
  const recovery = event.nativeRecovery!
  return admitRecoveryCursor({
    appliedRevision: recovery.revision,
    ...(recovery.snapshotToken ? { snapshotToken: recovery.snapshotToken } : {}),
    ...(recovery.ownerGeneration !== undefined
      ? { ownerGeneration: recovery.ownerGeneration }
      : {}),
  })
}
/** Delivery capabilities stay in private projection bindings, never pending/history JSON. */
export function persistentAgentEvent(event: AgentEvent): AgentEvent {
  if (
    !event.nativeRecovery ||
    (!Object.hasOwn(event.nativeRecovery, 'deliveryToken') &&
      !Object.hasOwn(event.nativeRecovery, 'ownerStatus'))
  )
    return event
  const {
    deliveryToken: _deliveryToken,
    ownerStatus: _ownerStatus,
    ...nativeRecovery
  } = event.nativeRecovery
  return { ...event, nativeRecovery }
}
/** Drop replayed tails before a streaming batch can merge them with new output. */
export function admitAgentEvents(thread: Thread, events: readonly AgentEvent[]): AgentEvent[] {
  const accepted: AgentEvent[] = []
  let admission = thread
  for (const event of events) {
    if (!acceptsAgentEvent(admission, event)) continue
    accepted.push(event)
    if (event.nativeRecovery) {
      const transportId = event.nativeRecovery.transportId
      admission = {
        ...admission,
        nativeRecovery: {
          ...admission.nativeRecovery,
          [transportId]: recoveryCursor(event),
        },
      }
    }
  }
  return accepted
}
export function nativeRecoveryBlocksMutation(thread?: Thread): boolean {
  return thread?.nativeRecoveryStatus === 'recovering' || thread?.nativeRecoveryStatus === 'unknown'
}
export function applyNativeRecoveryOwner(thread: Thread, owner: NativeRecoveryOwnerState): Thread {
  if (thread.id !== owner.sessionId) return thread
  const prior = thread.nativeRecovery?.[owner.transportId]
  const acceptedCursor = normalizeNativeRecovery({
    [owner.transportId]: owner.acceptedAppliedCursor,
  })?.[owner.transportId]
  const acceptedRevision =
    acceptedCursor?.appliedRevision ??
    (recoveryNumber(owner.acceptedAppliedRevision) ? owner.acceptedAppliedRevision : 0)
  const privatelyAdmitted =
    liveRecoveryCursors.has(prior!) || hasNativeProjectionCursor(thread, owner.transportId)
  if (prior && !privatelyAdmitted && prior.appliedRevision > acceptedRevision)
    return {
      ...thread,
      nativeRecoveryStatus: 'unknown',
      nativeRecoveryAdmissionBlocked: true,
      busy: false,
      turnStatus: 'unknown',
      statusText:
        'Saved transcript progress could not be verified. Native recovery must reconcile this history before replay can continue.',
    }
  const projectionBefore = thread
  const currentOwner = thread.nativeRecoveryOwner
  const acceptsOwnerRequests =
    !currentOwner ||
    (currentOwner.transportId === owner.transportId &&
      ((currentOwner.ownerGeneration === owner.ownerGeneration &&
        currentOwner.snapshotToken === owner.snapshotToken) ||
        (recoveryNumber(currentOwner.ownerGeneration) &&
          recoveryNumber(owner.ownerGeneration) &&
          owner.ownerGeneration > currentOwner.ownerGeneration)))
  if (owner.status === 'running' || owner.status === 'idle') {
    for (const child of owner.currentChildren || []) {
      if (
        child.sessionId === thread.id &&
        child.agentId &&
        ['status', 'subagent'].includes(child.type)
      ) {
        const currentTurn = thread.turn
        const childTurn = child.nativeRecovery?.localTurn
        const hydrated = applyAdmittedEvent(
          childTurn === undefined ? thread : { ...thread, turn: childTurn },
          persistentAgentEvent(child),
        )
        thread = { ...hydrated, turn: currentTurn }
      }
    }
    if (owner.pending) {
      const pending = owner.pending
        .filter(
          (request) =>
            request.sessionId === thread.id &&
            Boolean(request.requestId) &&
            (request.type === 'approval' || request.type === 'question'),
        )
        .map(persistentAgentEvent)
      const currentRequests = acceptsOwnerRequests
        ? pending.filter(
            (request) =>
              validRecoveryEvent(request) &&
              request.nativeRecovery?.transportId === owner.transportId &&
              owner.ownerGeneration !== undefined &&
              request.nativeRecovery.ownerGeneration === owner.ownerGeneration &&
              Boolean(owner.snapshotToken) &&
              request.nativeRecovery.snapshotToken === owner.snapshotToken,
          )
        : []
      const needsWake =
        currentRequests.length > 0 &&
        (thread.settled || thread.snoozedUntil !== undefined || thread.archivedAt !== undefined)
      thread = {
        ...(needsWake
          ? raiseThreadAttention(
              thread,
              Math.max(
                ...currentRequests.map(
                  (request) => request.nativeRecovery!.emittedAt ?? Date.now(),
                ),
              ),
            )
          : thread),
        pending,
      }
    }
  }
  const previous = thread.nativeRecovery?.[owner.transportId]
  const recovered = {
    ...thread,
    nativeRecoveryStatus: owner.status,
    nativeRecoveryAdmissionBlocked: undefined,
    nativeRecoveryOwner: {
      transportId: owner.transportId,
      ...(owner.ownerGeneration !== undefined ? { ownerGeneration: owner.ownerGeneration } : {}),
      ...(owner.snapshotToken ? { snapshotToken: owner.snapshotToken } : {}),
    },
    nativeRecovery: {
      ...thread.nativeRecovery,
      [owner.transportId]:
        privatelyAdmitted && previous!.appliedRevision >= acceptedRevision
          ? previous!
          : admitRecoveryCursor(acceptedCursor || { appliedRevision: acceptedRevision }),
    },
    ...(owner.status === 'running'
      ? { busy: true, turnStatus: 'running' as const }
      : owner.status === 'recovering'
        ? { busy: true, turnStatus: 'reconnecting' as const }
        : owner.status === 'unknown'
          ? { busy: false, turnStatus: 'unknown' as const }
          : { busy: false }),
  }
  return registerNativeProjectionBaseline(
    carryNativeProjectionOwnerSnapshot(
      projectionBefore,
      owner.status === 'running'
        ? reconcileConversationLifecycle(recovered, ['busy', 'turnStatus'])
        : owner.status === 'idle'
          ? reconcileConversationLifecycle(recovered, ['busy'])
          : recovered,
    ),
    owner.acceptedProjectionAdmission,
  )
}
/** Repair the accepted user turn from native-owned evidence when history lagged its outbox. */
export function restoreNativeMainOwner(
  threads: readonly Thread[],
  owner: NativeRecoveryOwnerState,
): Thread[] {
  const input = owner.originalInput
  const recovery = input?.clientRecovery
  if (!input || !recovery || typeof recovery !== 'object' || Array.isArray(recovery))
    return [...threads]
  const value = recovery as Record<string, unknown>
  if (value.kind !== 'main' || input.sessionId !== owner.sessionId) return [...threads]
  const user = value.userMessage
  const seed = value.threadSeed
  if (
    !user ||
    typeof user !== 'object' ||
    Array.isArray(user) ||
    !seed ||
    typeof seed !== 'object' ||
    Array.isArray(seed)
  )
    return [...threads]
  const message = user as Record<string, unknown>
  const original = seed as Record<string, unknown>
  const localTurn = owner.localTurn ?? input.localTurn
  if (
    typeof message.id !== 'string' ||
    !message.id ||
    message.role !== 'user' ||
    message.text !== input.prompt ||
    !recoveryNumber(localTurn) ||
    message.turn !== localTurn ||
    original.id !== owner.sessionId ||
    original.provider !== input.provider ||
    typeof original.profileId !== 'string' ||
    !original.profileId ||
    (input.workspace !== undefined && original.workspace !== input.workspace) ||
    !recoveryNumber(message.createdAt)
  )
    return [...threads]
  const matching = threads.filter((thread) => thread.id === owner.sessionId)
  if (matching.length > 1) return [...threads]
  let thread = matching[0]
  if (
    thread &&
    (thread.profileId !== original.profileId ||
      thread.provider !== input.provider ||
      (thread.workspace !== undefined &&
        input.workspace !== undefined &&
        thread.workspace !== input.workspace))
  )
    return [...threads]
  if (!thread) thread = readThreads([{ ...original, messages: [] }])[0]
  if (!thread) return [...threads]
  const previous = thread.messages.find((candidate) => candidate.id === message.id)
  if (
    previous &&
    (previous.role !== 'user' || previous.text !== input.prompt || previous.turn !== localTurn)
  )
    return [...threads]
  const attachments =
    message.attachments === undefined ? undefined : normalizeThreadAttachments(message.attachments)
  if (Array.isArray(message.attachments) && attachments?.length !== message.attachments.length)
    return [...threads]
  const repaired: Thread = {
    ...thread,
    turn: Math.max(thread.turn, localTurn),
    ...(owner.remoteId ? { remoteId: owner.remoteId } : {}),
    messages: previous
      ? thread.messages
      : [
          ...thread.messages,
          {
            id: message.id,
            role: 'user',
            text: input.prompt,
            turn: localTurn,
            createdAt: message.createdAt,
            ...(attachments ? { attachments } : {}),
          },
        ],
  }
  const applied = applyNativeRecoveryOwner(repaired, owner)
  return matching.length
    ? threads.map((candidate) => (candidate === thread ? applied : candidate))
    : [...threads, applied]
}
function validModelChoice(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    ? value
    : ''
}
function normalizeThreadArrangement(value: Record<string, unknown>): Partial<Thread> {
  const result: Partial<Thread> = {}
  for (const key of [
    'createdAt',
    'pinnedAt',
    'lastReadAt',
    'completedAt',
    'attentionAt',
    'settledAt',
    'snoozedAt',
    'archivedAt',
  ] as const) {
    const timestamp = value[key]
    if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 0)
      result[key] = timestamp
  }
  for (const key of ['pinOrder', 'activeOrder'] as const) {
    const rank = value[key]
    if (typeof rank === 'number' && Number.isFinite(rank) && Math.abs(rank) <= 1e12)
      result[key] = rank
  }
  return result
}
function normalizeAgentTurns(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .slice(0, 1000)
    .filter(
      ([id, turn]) =>
        Boolean(id) &&
        id.length <= 2000 &&
        !/[\x00-\x1f\x7f]/.test(id) &&
        typeof turn === 'number' &&
        Number.isSafeInteger(turn) &&
        turn >= 0,
    )
  return entries.length ? (Object.fromEntries(entries) as Record<string, number>) : undefined
}
export function normalizeModelChoices(
  model: ModelOption | undefined,
  choices: { reasoningEffort?: string; serviceTier?: string },
): { reasoningEffort: string; serviceTier: string } {
  const reasoningEffort = validModelChoice(choices.reasoningEffort)
  const serviceTier = validModelChoice(choices.serviceTier)
  return {
    reasoningEffort:
      reasoningEffort &&
      Array.isArray(model?.supportedReasoningEfforts) &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === reasoningEffort)
        ? ''
        : reasoningEffort,
    serviceTier:
      serviceTier &&
      Array.isArray(model?.serviceTiers) &&
      !model.serviceTiers.some((option) => option.id === serviceTier)
        ? ''
        : serviceTier,
  }
}
/** The same admission policy is used by whole-history and bounded batch restoration. */
export function readableThreadMessages(input: unknown): Message[] {
  return Array.isArray(input)
    ? input.filter(
        (message: Partial<Message> | null) =>
          message &&
          typeof message.id === 'string' &&
          ['user', 'assistant', 'tool', 'error'].includes(message.role || '') &&
          typeof message.text === 'string',
      )
    : []
}

export function readThreadMessages(input: unknown): Message[] {
  return readableThreadMessages(input).map((message: Message) => ({
    ...message,
    phase: undefined,
    kind: undefined,
    agentId: undefined,
    agentName: undefined,
    parentItemId: undefined,
    turnId: undefined,
    parentAgentId: undefined,
    provider: undefined,
    details: undefined,
    submission: undefined,
    ...normalizeMessageMetadata(message),
    activityStateUnknown:
      message.activityStateUnknown === true ||
      message.agentId ||
      message.parentItemId ||
      message.kind === 'subagent' ||
      isSubagentActivity(message)
        ? (true as const)
        : undefined,
    createdAt:
      typeof message.createdAt === 'number' &&
      Number.isFinite(message.createdAt) &&
      message.createdAt > 0
        ? message.createdAt
        : undefined,
    finishedAt:
      typeof message.finishedAt === 'number' &&
      Number.isFinite(message.finishedAt) &&
      message.finishedAt > 0
        ? message.finishedAt
        : undefined,
    finishStatus: typeof message.finishStatus === 'string' ? message.finishStatus : undefined,
    input: typeof message.input === 'string' ? message.input : undefined,
    fileChanges: normalizeFileChanges(message.fileChanges),
    sourceChange: normalizeSourceChange(message.sourceChange),
    attachments: normalizeThreadAttachments(message.attachments),
    title: typeof message.title === 'string' ? message.title : undefined,
    status:
      (message.role === 'tool' ||
        message.agentId ||
        message.parentItemId ||
        message.kind === 'subagent') &&
      [
        'running',
        'waiting',
        'inprogress',
        'spawning',
        'initializing',
        'pendinginit',
        'pending',
        'queued',
        'started',
      ].includes(
        (typeof message.status === 'string' ? message.status : '')
          .replace(/[_-]/g, '')
          .toLowerCase(),
      )
        ? 'interrupted'
        : typeof message.status === 'string'
          ? message.status
          : undefined,
    turn: Number.isInteger(message.turn) ? message.turn : 0,
  }))
}

export function readThreads(input?: unknown): Thread[] {
  try {
    const data: unknown =
      input === undefined ? JSON.parse(localStorage.getItem('relay.threads.v1') || '[]') : input
    if (!Array.isArray(data)) return []
    const sourceGroup = {}
    return data
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.profileId === 'string' &&
          ['codex', 'claude'].includes(t.provider) &&
          Array.isArray(t.messages),
      )
      .map((t, order) =>
        attachConversationSource(
          {
            id: t.id,
            profileId: t.profileId,
            ...(typeof t.workspace === 'string' &&
            t.workspace.startsWith('/') &&
            !/[\x00-\x1f]/.test(t.workspace)
              ? { workspace: t.workspace }
              : {}),
            ...(t.workspaceUnknown === true ? { workspaceUnknown: true } : {}),
            ...normalizeThreadMetadata(t),
            ...normalizeThreadArrangement(t),
            ...(normalizeNativeRecovery(t.nativeRecovery)
              ? { nativeRecovery: normalizeNativeRecovery(t.nativeRecovery) }
              : {}),
            ...(t.nativeRecovery &&
            (t.busy ||
              t.nativeRecoveryStatus === 'recovering' ||
              t.nativeRecoveryStatus === 'unknown' ||
              t.nativeRecoveryStatus === 'running')
              ? { nativeRecoveryStatus: 'unknown' as const }
              : {}),
            ...(t.purpose === 'research' || t.purpose === 'customization'
              ? { purpose: t.purpose }
              : {}),
            ...(normalizeResearchThreadContext(t.researchContext)
              ? { researchContext: normalizeResearchThreadContext(t.researchContext) }
              : {}),
            ...(normalizeImportedThreadHistory(t.importedHistory)
              ? { importedHistory: normalizeImportedThreadHistory(t.importedHistory) }
              : {}),
            ...(t.settled === true ? { settled: true } : {}),
            ...(typeof t.snoozedUntil === 'number' &&
            Number.isFinite(t.snoozedUntil) &&
            t.snoozedUntil > 0
              ? { snoozedUntil: t.snoozedUntil }
              : {}),
            provider: t.provider as Provider,
            title: typeof t.title === 'string' && t.title.trim() ? t.title : 'Untitled thread',
            ...(t.titleSource === 'provider' || t.titleSource === 'manual'
              ? { titleSource: t.titleSource }
              : {}),
            remoteId: typeof t.remoteId === 'string' ? t.remoteId : undefined,
            messages: readThreadMessages(t.messages),
            busy: false,
            ...(t.turnStatus === 'completed' ||
            t.turnStatus === 'interrupted' ||
            t.turnStatus === 'failed'
              ? { turnStatus: t.turnStatus }
              : t.busy || t.turnStatus
                ? { turnStatus: 'unknown' as const }
                : {}),
            ...(typeof t.agentStatus === 'string' ? { agentStatus: t.agentStatus } : {}),
            ...(t.connectionStatus === 'connected' ||
            t.connectionStatus === 'reconnecting' ||
            t.connectionStatus === 'disconnected'
              ? { connectionStatus: t.connectionStatus }
              : {}),
            ...(typeof t.statusText === 'string' ? { statusText: t.statusText } : {}),
            ...(t.statusDetails &&
            typeof t.statusDetails === 'object' &&
            !Array.isArray(t.statusDetails)
              ? { statusDetails: t.statusDetails }
              : {}),
            ...(t.agentSettings &&
            typeof t.agentSettings === 'object' &&
            !Array.isArray(t.agentSettings)
              ? { agentSettings: t.agentSettings }
              : {}),
            ...(normalizeAgentTurns(t.agentTurns)
              ? { agentTurns: normalizeAgentTurns(t.agentTurns) }
              : {}),
            pending: [],
            queue: normalizeQueuedMessages(t.queue),
            ...(t.lifeScope === true ? { lifeScope: true } : {}),
            turn: Number.isInteger(t.turn) && t.turn >= 0 ? t.turn : 0,
            mode: permissionModes.includes(t.mode)
              ? (t.mode as PermissionMode)
              : ('review' as const),
            model: typeof t.model === 'string' ? t.model : '',
            ...(t.reasoningEffort !== undefined
              ? { reasoningEffort: validModelChoice(t.reasoningEffort) }
              : {}),
            ...(t.serviceTier !== undefined
              ? { serviceTier: validModelChoice(t.serviceTier) }
              : {}),
            updatedAt:
              typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
          },
          t,
          { group: sourceGroup, order },
        ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}
export function bindLegacyThreadWorkspace(thread: Thread, connection: ConnectionState): Thread {
  if (
    connection.status !== 'connected' ||
    thread.profileId !== connection.profile?.id ||
    !thread.remoteId ||
    thread.workspace ||
    thread.workspaceUnknown ||
    conversationSourceHasPersistedField(thread, 'workspace')
  )
    return thread
  return connection.lastWorkspace
    ? { ...thread, workspace: connection.lastWorkspace }
    : { ...thread, workspaceUnknown: true }
}
export function finishThreadTurn(thread: Thread, status: string, at = Date.now()): Thread {
  return carryNativeProjectionAuthoredTransition(thread, {
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.turn !== thread.turn || message.agentId || message.kind === 'subagent')
        return message
      if (message.kind === 'event' && message.details?.requestType && message.status === 'waiting')
        return { ...message, finishedAt: at, status: 'cancelled' }
      if (message.role === 'user' || message.role === 'assistant')
        return {
          ...message,
          finishedAt:
            status === 'unknown'
              ? undefined
              : message.finishStatus === 'unknown'
                ? at
                : (message.finishedAt ?? at),
          finishStatus: status,
        }
      if (
        message.role === 'tool' &&
        (message.status === 'running' || message.status === 'inProgress')
      )
        return {
          ...message,
          finishedAt: at,
          status:
            status === 'failed'
              ? 'failed'
              : status === 'interrupted'
                ? 'interrupted'
                : status === 'completed'
                  ? 'completed'
                  : 'unknown',
        }
      return message
    }),
  })
}
export function resolveAgentRequest(
  thread: Thread,
  requestId: string,
  accepted: boolean,
  answers?: Record<string, string[]>,
  at = Date.now(),
  choice?: import('../shared/approval-decisions').ApprovalChoice,
): Thread {
  let requestIndex = -1
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]
    if (message.kind === 'event' && message.details?.requestId === requestId) {
      requestIndex = index
      break
    }
  }
  const recordedQuestions = thread.messages[requestIndex]?.details?.questions
  const secretQuestions = new Set(
    [
      ...(thread.pending.find((request) => request.requestId === requestId)?.questions || []),
      ...(Array.isArray(recordedQuestions) ? recordedQuestions : []),
    ].flatMap((question) =>
      question &&
      typeof question === 'object' &&
      question.isSecret === true &&
      typeof question.id === 'string'
        ? [question.id]
        : [],
    ),
  )
  const recordedAnswers = answers
    ? Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          secretQuestions.has(id) ? values.map(() => '[redacted]') : values,
        ]),
      )
    : undefined
  const approved = choice ? choice.outcome === 'approved' : accepted
  return carryNativeProjectionAuthoredTransition(thread, {
    ...thread,
    pending: thread.pending.filter((request) => request.requestId !== requestId),
    messages: thread.messages.map((message, index) =>
      index === requestIndex
        ? {
            ...message,
            status:
              choice?.outcome === 'cancelled'
                ? 'cancelled'
                : approved
                  ? message.details?.requestType === 'question'
                    ? 'answered'
                    : 'approved'
                  : 'declined',
            finishedAt: at,
            details: {
              ...message.details,
              response: {
                accepted: approved,
                ...(recordedAnswers ? { answers: recordedAnswers } : {}),
                ...(choice
                  ? { decisionId: choice.id, outcome: choice.outcome, label: choice.label }
                  : {}),
              },
            },
          }
        : message,
    ),
  })
}
function eventMetadata(event: AgentEvent): MessageMetadata & Pick<Message, 'nativeRecovery'> {
  return {
    ...normalizeMessageMetadata({
      ...event,
      details:
        event.type === 'plan' && Array.isArray(event.details)
          ? { plan: event.details }
          : eventDetails(event.details),
      kind: ['reasoning', 'plan', 'subagent', 'status'].includes(event.type)
        ? event.type
        : undefined,
    }),
    ...(event.nativeRecovery
      ? {
          nativeRecovery: {
            transportId: event.nativeRecovery.transportId,
            ...(event.nativeRecovery.ownerGeneration !== undefined
              ? { ownerGeneration: event.nativeRecovery.ownerGeneration }
              : {}),
          },
        }
      : {}),
  }
}
function eventDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}
function providerTitle(event: AgentEvent): string | undefined {
  const title = event.title ?? (event.type === 'title' ? event.text : undefined)
  return typeof title === 'string' && title.trim() && !/[\x00-\x1f\x7f]/.test(title)
    ? title.trim()
    : undefined
}
function completedToolText(previous: Message | undefined, output: string | undefined): string {
  if (output === undefined || output === '') return previous?.text || ''
  const retained = previous?.text || ''
  if (!retained || retained === previous?.input) return output
  // Providers can return a final full snapshot after output deltas, or a separate result.
  // Keep both when the result adds information instead of discarding the streamed output.
  if (output.startsWith(retained)) return output
  if (retained.startsWith(output)) return retained
  return `${retained}${retained.endsWith('\n') || output.startsWith('\n') ? '' : '\n'}${output}`
}
function childNativeRun(details: Record<string, unknown> | undefined): string | undefined {
  if (
    details?.lifecycle === 'turn' &&
    typeof details.nativeTurnId === 'string' &&
    details.nativeTurnId
  )
    return JSON.stringify(['nativeTurnId', details.nativeTurnId])
  if (typeof details?.run_id === 'string' && details.run_id)
    return JSON.stringify(['run_id', details.run_id])
  return undefined
}
function raiseThreadAttention(thread: Thread, at = Date.now()): Thread {
  return {
    ...thread,
    attentionAt: Math.max(at, thread.attentionAt || 0),
    archivedAt: undefined,
    settled: false,
    settledAt: undefined,
    snoozedAt: undefined,
    snoozedUntil: undefined,
  }
}
function confirmsChildActivity(event: AgentEvent, details?: Record<string, unknown>): boolean {
  if (event.type !== 'subagent' || !details) return false
  if (
    details.lifecycle === 'turn' ||
    (typeof details.nativeTurnId === 'string' && details.nativeTurnId) ||
    (typeof details.run_id === 'string' && details.run_id)
  )
    return true
  return ['agentsStates', 'agents_states', 'agents'].some((key) => {
    const states = details[key]
    return (
      Object.hasOwn(details, key) &&
      states !== null &&
      typeof states === 'object' &&
      !Array.isArray(states)
    )
  })
}
export function applyEvent(thread: Thread, event: AgentEvent): Thread {
  if (!acceptsAgentEvent(thread, event)) return thread
  const deliveredEvent = event
  event = persistentAgentEvent(event)
  const eventTurn = event.nativeRecovery?.localTurn
  const currentGeneration =
    thread.nativeRecoveryOwner?.transportId === event.nativeRecovery?.transportId
      ? thread.nativeRecoveryOwner?.ownerGeneration
      : undefined
  const historicalGeneration =
    event.nativeRecovery?.ownerGeneration !== undefined &&
    currentGeneration !== undefined &&
    event.nativeRecovery.ownerGeneration < currentGeneration
  const historicalRoot =
    !event.agentId && ((eventTurn !== undefined && eventTurn < thread.turn) || historicalGeneration)
  const projected = applyAdmittedEvent(
    eventTurn === undefined || eventTurn === thread.turn ? thread : { ...thread, turn: eventTurn },
    event,
    !historicalRoot,
  )
  const applied =
    !historicalRoot && (eventTurn === undefined || eventTurn === thread.turn)
      ? projected
      : {
          ...projected,
          turn: Math.max(thread.turn, eventTurn ?? thread.turn),
          ...(historicalRoot
            ? {
                busy: thread.busy,
                turnStatus: thread.turnStatus,
                agentStatus: thread.agentStatus,
                connectionStatus: thread.connectionStatus,
                statusText: thread.statusText,
                statusDetails: thread.statusDetails,
                remoteId: thread.remoteId,
                title: thread.title,
                titleSource: thread.titleSource,
                completedAt: thread.completedAt,
                attentionAt: thread.attentionAt,
                lastReadAt: thread.lastReadAt,
                archivedAt: thread.archivedAt,
                settled: thread.settled,
                settledAt: thread.settledAt,
                snoozedAt: thread.snoozedAt,
                snoozedUntil: thread.snoozedUntil,
                pending: thread.pending,
                queue: thread.queue,
                ...(historicalGeneration
                  ? {
                      messages: projected.messages.map((message, index) => {
                        const prior = thread.messages[index]
                        return prior &&
                          prior.id === message.id &&
                          (prior.nativeRecovery?.transportId !==
                            event.nativeRecovery?.transportId ||
                            prior.nativeRecovery?.ownerGeneration !==
                              event.nativeRecovery?.ownerGeneration)
                          ? prior
                          : message
                      }),
                    }
                  : {}),
              }
            : {}),
        }
  if (!event.nativeRecovery) return carryNativeProjectionAuthoredTransition(thread, applied)
  const transportId = event.nativeRecovery.transportId
  const owner =
    !event.agentId &&
    (applied.nativeRecoveryOwner?.transportId !== transportId ||
      (event.nativeRecovery.ownerGeneration ?? 0) >
        (applied.nativeRecoveryOwner.ownerGeneration ?? 0))
      ? {
          transportId,
          ownerGeneration: event.nativeRecovery.ownerGeneration,
          snapshotToken: event.nativeRecovery.snapshotToken,
        }
      : applied.nativeRecoveryOwner
  return registerNativeProjectionDelivery(
    {
      ...applied,
      ...(owner ? { nativeRecoveryOwner: owner } : {}),
      nativeRecovery: {
        ...applied.nativeRecovery,
        [transportId]: recoveryCursor(event),
      },
    },
    deliveredEvent,
  )
}
function applyAdmittedEvent(thread: Thread, event: AgentEvent, authorLifecycle = true): Thread {
  const reconcileLifecycle = authorLifecycle
    ? reconcileConversationLifecycle
    : (value: Thread) => value
  const at = event.nativeRecovery?.emittedAt ?? Date.now()
  const errorId = event.nativeRecovery
    ? `native-event:${JSON.stringify([event.nativeRecovery.transportId, event.nativeRecovery.eventId])}`
    : undefined
  const recoverableError =
    event.type === 'error' && eventDetails(event.details)?.recoverable === true
  if (event.agentId && (event.type === 'complete' || (event.type === 'error' && !recoverableError)))
    event = {
      ...event,
      type: 'subagent',
      itemId: event.itemId || `agent-${event.agentId}`,
      status: event.type === 'error' ? 'failed' : event.status || 'completed',
      details: { ...eventDetails(event.details), lifecycle: 'turn' },
    }
  if (
    event.agentId &&
    (event.type === 'title' || event.type === 'session' || event.type === 'settings')
  )
    event = {
      ...event,
      type: 'subagent',
      itemId: event.itemId || `agent-${event.agentId}`,
      ...(providerTitle(event) ? { agentName: providerTitle(event) } : {}),
      details: {
        ...eventDetails(event.details),
        ...(event.remoteId ? { remoteId: event.remoteId } : {}),
      },
    }
  if (event.type === 'session')
    return {
      ...thread,
      remoteId: event.remoteId ?? thread.remoteId,
      ...(providerTitle(event) && thread.titleSource !== 'manual'
        ? { title: providerTitle(event)!, titleSource: 'provider' as const }
        : {}),
    }
  if (event.type === 'title') {
    const title = providerTitle(event)
    return title && thread.titleSource !== 'manual'
      ? { ...thread, title, titleSource: 'provider' }
      : thread
  }
  if (event.type === 'settings')
    return {
      ...thread,
      agentSettings: {
        ...thread.agentSettings,
        ...eventDetails(event.details),
        ...(event.text !== undefined ? { note: event.text } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
      },
    }
  if (event.type === 'account-usage')
    return {
      ...thread,
      agentSettings: { ...thread.agentSettings, accountUsage: eventDetails(event.details) },
    }
  if (event.type === 'request-resolved') {
    if (!event.requestId) return thread
    let requestIndex = -1
    for (let index = thread.messages.length - 1; index >= 0; index--) {
      const message = thread.messages[index]
      if (message.kind === 'event' && message.details?.requestId === event.requestId) {
        if (message.status === 'waiting') requestIndex = index
        break
      }
    }
    const pending = thread.pending.filter((request) => request.requestId !== event.requestId)
    if (requestIndex < 0 && pending.length === thread.pending.length) return thread
    const decisionId = eventDetails(event.details)?.decisionId
    const choice = thread.pending
      .find((request) => request.requestId === event.requestId)
      ?.approvalChoices?.find((choice) => choice.id === decisionId)
    if (choice)
      return resolveAgentRequest(
        thread,
        event.requestId,
        choice.outcome === 'approved',
        undefined,
        at,
        choice,
      )
    if (['approved', 'answered', 'declined'].includes(event.status || ''))
      return resolveAgentRequest(
        thread,
        event.requestId,
        event.status !== 'declined',
        undefined,
        at,
      )
    const status = ['cancelled', 'canceled', 'interrupted'].includes(event.status || '')
      ? 'cancelled'
      : 'completed'
    return {
      ...thread,
      pending,
      messages:
        requestIndex < 0
          ? thread.messages
          : thread.messages.map((message, index) =>
              index === requestIndex ? { ...message, status, finishedAt: at } : message,
            ),
    }
  }
  if (event.type === 'complete') {
    const status =
      event.status === 'interrupted'
        ? 'interrupted'
        : event.status === 'failed'
          ? 'failed'
          : event.status === 'completed' || !event.status
            ? 'completed'
            : 'unknown'
    const alreadyFinished = !thread.busy && thread.turnStatus === status
    const finished = finishThreadTurn(thread, status, at)
    return reconcileLifecycle({
      ...(alreadyFinished || status === 'unknown' ? finished : raiseThreadAttention(finished, at)),
      ...(status === 'completed' && !alreadyFinished
        ? { completedAt: at, lastReadAt: thread.lastReadAt ?? Math.max(0, at - 1) }
        : {}),
      busy: false,
      turnStatus: status,
      agentStatus: status,
      pending: thread.pending.filter((request) => Boolean(request.agentId)),
      queue: status === 'completed' ? thread.queue : pauseQueuedMessages(thread.queue),
    })
  }
  if (event.type === 'approval' || event.type === 'question') {
    const pending = thread.pending.find((request) => request.requestId === event.requestId)
    const mergedEvent = {
      ...pending,
      ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)),
    } as AgentEvent
    const questions = mergedEvent.questions
    const requestTurn = event.agentId
      ? ((Object.hasOwn(thread.agentTurns || {}, event.agentId)
          ? thread.agentTurns?.[event.agentId]
          : undefined) ??
        thread.messages.find((message) => message.agentId === event.agentId)?.turn ??
        thread.turn)
      : thread.turn
    const id = `${requestTurn}:request:${event.requestId || event.itemId || event.type}`
    const previous = thread.messages.find((message) => message.id === id)
    // A reconnect can replay the original native request after its answer or cancellation.
    if (previous?.finishedAt && previous.status !== 'waiting') return thread
    const request: Message = {
      ...previous,
      ...eventMetadata(event),
      id,
      role: 'tool',
      kind: 'event',
      title:
        event.title ||
        previous?.title ||
        (event.type === 'approval' ? 'Approval request' : 'Question'),
      text:
        event.text ??
        (event.questions
          ? event.questions.map((question) => question.question).join('\n\n')
          : previous?.text) ??
        questions?.map((question) => question.question).join('\n\n') ??
        event.title ??
        '',
      input: event.input ?? previous?.input,
      status: 'waiting',
      createdAt: previous?.createdAt ?? at,
      turn: requestTurn,
      details: {
        ...previous?.details,
        ...eventDetails(event.details),
        requestType: event.type,
        requestId: event.requestId,
        ...(questions ? { questions } : {}),
      },
    }
    return {
      ...(pending ? thread : raiseThreadAttention(thread, at)),
      pending: [...thread.pending.filter((p) => p.requestId !== event.requestId), mergedEvent],
      messages: previous
        ? thread.messages.map((message) => (message.id === id ? request : message))
        : [...thread.messages, request],
    }
  }
  if (event.type === 'status' && !event.agentId) {
    thread = {
      ...thread,
      ...(event.status ? { agentStatus: event.status } : {}),
      ...(event.text !== undefined ? { statusText: event.text } : {}),
      ...(event.details
        ? { statusDetails: { ...thread.statusDetails, ...eventDetails(event.details) } }
        : {}),
      ...(event.status === 'reconnecting' ||
      event.status === 'disconnected' ||
      event.status === 'suspended'
        ? {
            busy: true,
            turnStatus: 'reconnecting' as const,
            connectionStatus: 'reconnecting' as const,
          }
        : event.status === 'running' || event.status === 'resumed'
          ? {
              busy: true,
              turnStatus: 'running' as const,
              connectionStatus: 'connected' as const,
              messages: thread.messages.map((message) =>
                message.turn === thread.turn && message.finishStatus === 'unknown'
                  ? { ...message, finishedAt: undefined, finishStatus: undefined }
                  : message,
              ),
            }
          : {}),
    }
    if (!event.text) return thread
  }
  if (event.type === 'error') {
    if (recoverableError) {
      const turn = event.agentId
        ? ((Object.hasOwn(thread.agentTurns || {}, event.agentId)
            ? thread.agentTurns?.[event.agentId]
            : undefined) ??
          thread.messages.find((message) => message.agentId === event.agentId)?.turn ??
          thread.turn)
        : thread.turn
      return {
        ...thread,
        messages: [
          ...thread.messages,
          {
            ...eventMetadata(event),
            id: errorId ?? crypto.randomUUID(),
            role: 'error',
            text: event.text || 'The agent encountered a temporary error and is retrying.',
            turn,
            createdAt: at,
          },
        ],
      }
    }
    const failed = raiseThreadAttention(finishThreadTurn(thread, 'failed', at), at)
    return carryNativeProjectionAuthoredTransition(
      failed,
      reconcileLifecycle({
        ...failed,
        busy: false,
        turnStatus: 'failed',
        agentStatus: 'failed',
        pending: thread.pending.filter((request) => Boolean(request.agentId)),
        queue: pauseQueuedMessages(thread.queue),
        messages: [
          ...failed.messages,
          {
            ...eventMetadata(event),
            id: errorId ?? crypto.randomUUID(),
            role: 'error',
            text: event.text || 'The agent could not finish this turn.',
            turn: thread.turn,
            createdAt: at,
          },
        ],
      }),
    )
  }
  const metadata = eventMetadata(event)
  const savedAgentTurn =
    event.agentId && Object.hasOwn(thread.agentTurns || {}, event.agentId)
      ? thread.agentTurns?.[event.agentId]
      : undefined
  const eventTurn = event.agentId
    ? (savedAgentTurn ??
      thread.messages.find((message) => message.agentId === event.agentId)?.turn ??
      thread.turn)
    : thread.turn
  if (event.agentId && savedAgentTurn === undefined)
    thread = { ...thread, agentTurns: { ...thread.agentTurns, [event.agentId]: eventTurn } }
  const nativeRun =
    event.type === 'subagent' ? childNativeRun(eventDetails(event.details)) : undefined
  if (
    event.type === 'subagent' &&
    event.agentId &&
    eventDetails(event.details)?.lifecycle === 'turn' &&
    ['completed', 'failed', 'interrupted', 'errored', 'cancelled', 'stopped', 'killed'].includes(
      event.status || '',
    )
  ) {
    if (nativeRun) {
      const latestRun = thread.messages.findLast(
        (message) =>
          message.kind === 'subagent' &&
          (message.agentId === event.agentId ||
            (event.parentItemId && message.agentId === event.parentItemId)) &&
          childNativeRun(message.details),
      )
      // A delayed completion for an earlier native run must not settle its successor.
      if (latestRun && childNativeRun(latestRun.details) !== nativeRun) return thread
    }
    const finishedAt = at
    thread = {
      ...thread,
      pending: thread.pending.filter(
        (request) =>
          request.agentId !== event.agentId &&
          (!event.parentItemId || request.agentId !== event.parentItemId),
      ),
      messages: thread.messages.map((message) => {
        if (
          message.agentId !== event.agentId &&
          (!event.parentItemId || message.agentId !== event.parentItemId)
        )
          return message
        const messageRun = childNativeRun(message.details)
        if (nativeRun && messageRun && messageRun !== nativeRun) return message
        if (message.kind === 'event' && message.status === 'waiting')
          return { ...message, finishedAt, status: 'cancelled' }
        if (message.role === 'assistant')
          return message.finishedAt && message.finishStatus !== 'unknown'
            ? message
            : {
                ...message,
                finishedAt: message.finishedAt ?? finishedAt,
                finishStatus: event.status,
              }
        if (
          message.role === 'tool' &&
          ['running', 'inProgress', 'unknown'].includes(message.status || '')
        )
          return { ...message, finishedAt, status: event.status }
        return message
      }),
    }
  }
  const scopedItem = event.agentId ? `${event.agentId}:${event.itemId || event.type}` : event.itemId
  const fallbackItem = ['reasoning', 'plan', 'subagent', 'status'].includes(event.type)
    ? event.type
    : 'response'
  const baseId = `${eventTurn}:${scopedItem || fallbackItem}`
  let id = `${baseId}${nativeRun ? `:native-run:${nativeRun}` : ''}${metadata.phase ? `:${metadata.phase}` : ''}`
  let index = thread.messages.findIndex((m) => m.id === id)
  const sameGeneration = (message: Message) =>
    !event.nativeRecovery ||
    !message.nativeRecovery ||
    (message.nativeRecovery.transportId === event.nativeRecovery.transportId &&
      message.nativeRecovery.ownerGeneration === event.nativeRecovery.ownerGeneration)
  if (
    event.nativeRecovery &&
    index >= 0 &&
    thread.messages[index].nativeRecovery?.transportId === event.nativeRecovery.transportId &&
    thread.messages[index].nativeRecovery?.ownerGeneration !== event.nativeRecovery.ownerGeneration
  ) {
    id += `:native-generation:${event.nativeRecovery.ownerGeneration ?? 'unknown'}`
    index = thread.messages.findIndex((message) => message.id === id)
  }
  if (index < 0 && ['text', 'reasoning', 'plan'].includes(event.type)) {
    // Some providers reveal the phase only on their final item snapshot.
    index = thread.messages.findIndex(
      (message) => message.id === baseId && !message.phase && sameGeneration(message),
    )
    if (index < 0 && !metadata.phase) {
      for (let candidate = thread.messages.length - 1; candidate >= 0; candidate--) {
        const message = thread.messages[candidate]
        if (message.id.startsWith(`${baseId}:`) && message.phase && sameGeneration(message)) {
          index = candidate
          break
        }
      }
      if (index >= 0) id = thread.messages[index].id
    }
  }
  const previous = index >= 0 ? thread.messages[index] : undefined
  if (
    nativeRun &&
    event.status === 'running' &&
    previous?.finishedAt &&
    previous.status !== 'unknown'
  )
    return thread
  const appendsText =
    event.status !== 'replace' &&
    !['tool', 'subagent', 'status'].includes(event.type) &&
    (event.type !== 'tool-output' || previous?.text !== previous?.input)
  const text = appendsText
    ? ''
    : event.status === 'replace'
      ? event.text || ''
      : event.type === 'tool'
        ? completedToolText(previous, event.text)
        : event.type === 'tool-output'
          ? (previous?.text === previous?.input ? '' : previous?.text || '') + (event.text || '')
          : event.type === 'subagent' || event.type === 'status'
            ? completedToolText(previous, event.text)
            : (previous?.text || '') + (event.text || '')
  const status =
    event.status === 'running' && previous?.finishedAt && previous.status !== 'unknown'
      ? previous.status
      : event.status || previous?.status
  const terminalTool =
    (event.type === 'tool' || event.type === 'subagent') &&
    status &&
    ['completed', 'failed', 'interrupted', 'errored', 'cancelled', 'stopped', 'killed'].includes(
      status,
    )
  const message: Message = {
    ...previous,
    ...metadata,
    activityStateUnknown:
      previous?.activityStateUnknown && !confirmsChildActivity(event, metadata.details)
        ? true
        : undefined,
    id,
    createdAt: previous?.createdAt ?? at,
    finishedAt: terminalTool
      ? (previous?.finishedAt ?? at)
      : status === 'running' && previous?.status === 'unknown'
        ? undefined
        : previous?.finishedAt,
    input:
      previous?.input ??
      event.input ??
      (event.type === 'tool' && event.status === 'running' && event.text ? event.text : undefined),
    role: ['text', 'reasoning', 'plan'].includes(event.type) ? 'assistant' : 'tool',
    text,
    title: event.title || previous?.title,
    status,
    ...(metadata.details || previous?.details
      ? { details: { ...previous?.details, ...metadata.details } }
      : {}),
    turn: eventTurn,
  }
  const nextMessage = appendsText
    ? appendConversationMessageText(previous, message, event.text || '')
    : message
  return {
    ...thread,
    messages:
      index >= 0
        ? thread.messages.map((m, i) => (i === index ? nextMessage : m))
        : [...thread.messages, nextMessage],
  }
}
export const profileName = (profile?: ConnectionProfile) => profile?.name || 'Remote workspace'
