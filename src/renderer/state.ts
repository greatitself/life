import type {
  AgentEvent,
  ConnectionProfile,
  ConnectionState,
  ModelOption,
  PermissionMode,
  Provider,
} from '../shared/types'
import { normalizeThreadAttachments, type ThreadAttachment } from './attachments'
import { normalizeQueuedMessages, pauseQueuedMessages, type QueuedMessage } from './thread-queue'
import { normalizeFileChanges, type ThreadFileChange } from './thread-activity'
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
export interface Message extends MessageMetadata {
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
function validModelChoice(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    ? value
    : ''
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
export function readThreads(): Thread[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem('relay.threads.v1') || '[]')
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.profileId === 'string' &&
          ['codex', 'claude'].includes(t.provider) &&
          Array.isArray(t.messages),
      )
      .map((t) => ({
        id: t.id,
        profileId: t.profileId,
        ...(typeof t.workspace === 'string' &&
        t.workspace.startsWith('/') &&
        !/[\x00-\x1f]/.test(t.workspace)
          ? { workspace: t.workspace }
          : {}),
        ...(t.workspaceUnknown === true ? { workspaceUnknown: true } : {}),
        ...normalizeThreadMetadata(t),
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
        messages: t.messages
          .filter(
            (message: Partial<Message> | null) =>
              message &&
              typeof message.id === 'string' &&
              ['user', 'assistant', 'tool', 'error'].includes(message.role || '') &&
              typeof message.text === 'string',
          )
          .map((message: Message) => ({
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
            finishStatus:
              typeof message.finishStatus === 'string' ? message.finishStatus : undefined,
            input: typeof message.input === 'string' ? message.input : undefined,
            fileChanges: normalizeFileChanges(message.fileChanges),
            sourceChange: normalizeSourceChange(message.sourceChange),
            attachments: normalizeThreadAttachments(message.attachments),
            title: typeof message.title === 'string' ? message.title : undefined,
            status:
              message.role === 'tool' &&
              (message.status === 'running' || message.status === 'waiting')
                ? 'interrupted'
                : typeof message.status === 'string'
                  ? message.status
                  : undefined,
            turn: Number.isInteger(message.turn) ? message.turn : 0,
          })),
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
        mode: ['review', 'edit', 'plan'].includes(t.mode)
          ? (t.mode as PermissionMode)
          : ('review' as const),
        model: typeof t.model === 'string' ? t.model : '',
        ...(t.reasoningEffort !== undefined
          ? { reasoningEffort: validModelChoice(t.reasoningEffort) }
          : {}),
        ...(t.serviceTier !== undefined ? { serviceTier: validModelChoice(t.serviceTier) } : {}),
        updatedAt:
          typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
      }))
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
    thread.workspaceUnknown
  )
    return thread
  return connection.lastWorkspace
    ? { ...thread, workspace: connection.lastWorkspace }
    : { ...thread, workspaceUnknown: true }
}
export function finishThreadTurn(thread: Thread, status: string, at = Date.now()): Thread {
  return {
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
  }
}
export function resolveAgentRequest(
  thread: Thread,
  requestId: string,
  accepted: boolean,
  answers?: Record<string, string[]>,
  at = Date.now(),
): Thread {
  let requestIndex = -1
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]
    if (message.kind === 'event' && message.details?.requestId === requestId) {
      requestIndex = index
      break
    }
  }
  return {
    ...thread,
    pending: thread.pending.filter((request) => request.requestId !== requestId),
    messages: thread.messages.map((message, index) =>
      index === requestIndex
        ? {
            ...message,
            status: accepted
              ? message.details?.requestType === 'question'
                ? 'answered'
                : 'approved'
              : 'declined',
            finishedAt: at,
            details: {
              ...message.details,
              response: { accepted, ...(answers ? { answers } : {}) },
            },
          }
        : message,
    ),
  }
}
function eventMetadata(event: AgentEvent): MessageMetadata {
  return normalizeMessageMetadata({
    ...event,
    details:
      event.type === 'plan' && Array.isArray(event.details)
        ? { plan: event.details }
        : eventDetails(event.details),
    kind: ['reasoning', 'plan', 'subagent', 'status'].includes(event.type) ? event.type : undefined,
  })
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
export function applyEvent(thread: Thread, event: AgentEvent): Thread {
  if (event.sessionId !== thread.id) return thread
  if (event.agentId && (event.type === 'complete' || event.type === 'error'))
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
      ...(providerTitle(event)
        ? { title: providerTitle(event)!, titleSource: 'provider' as const }
        : {}),
    }
  if (event.type === 'title') {
    const title = providerTitle(event)
    return title ? { ...thread, title, titleSource: 'provider' } : thread
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
  if (event.type === 'complete') {
    const status =
      event.status === 'interrupted'
        ? 'interrupted'
        : event.status === 'failed'
          ? 'failed'
          : event.status === 'completed' || !event.status
            ? 'completed'
            : 'unknown'
    return {
      ...finishThreadTurn(thread, status),
      busy: false,
      turnStatus: status,
      agentStatus: status,
      pending: thread.pending.filter((request) => Boolean(request.agentId)),
      queue: status === 'completed' ? thread.queue : pauseQueuedMessages(thread.queue),
    }
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
      createdAt: previous?.createdAt ?? Date.now(),
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
      ...thread,
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
    const failed = finishThreadTurn(thread, 'failed')
    return {
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
          id: crypto.randomUUID(),
          role: 'error',
          text: event.text || 'The agent could not finish this turn.',
          turn: thread.turn,
          createdAt: Date.now(),
        },
      ],
    }
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
  if (
    event.type === 'subagent' &&
    event.agentId &&
    eventDetails(event.details)?.lifecycle === 'turn' &&
    ['completed', 'failed', 'interrupted', 'errored', 'cancelled'].includes(event.status || '')
  ) {
    const finishedAt = Date.now()
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
        if (message.kind === 'event' && message.status === 'waiting')
          return { ...message, finishedAt, status: 'cancelled' }
        if (message.role === 'assistant')
          return {
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
  let id = `${baseId}${metadata.phase ? `:${metadata.phase}` : ''}`
  let index = thread.messages.findIndex((m) => m.id === id)
  if (index < 0 && ['text', 'reasoning', 'plan'].includes(event.type)) {
    // Some providers reveal the phase only on their final item snapshot.
    index = thread.messages.findIndex((message) => message.id === baseId && !message.phase)
    if (index < 0 && !metadata.phase) {
      for (let candidate = thread.messages.length - 1; candidate >= 0; candidate--) {
        const message = thread.messages[candidate]
        if (message.id.startsWith(`${baseId}:`) && message.phase) {
          index = candidate
          break
        }
      }
      if (index >= 0) id = thread.messages[index].id
    }
  }
  const previous = index >= 0 ? thread.messages[index] : undefined
  const text =
    event.status === 'replace'
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
    ['completed', 'failed', 'interrupted', 'errored', 'cancelled'].includes(status)
  const message: Message = {
    ...previous,
    ...metadata,
    id,
    createdAt: previous?.createdAt ?? Date.now(),
    finishedAt: terminalTool
      ? (previous?.finishedAt ?? Date.now())
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
  return {
    ...thread,
    messages:
      index >= 0
        ? thread.messages.map((m, i) => (i === index ? message : m))
        : [...thread.messages, message],
  }
}
export const profileName = (profile?: ConnectionProfile) => profile?.name || 'Remote workspace'
