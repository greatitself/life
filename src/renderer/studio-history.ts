import { parseLifeConfigPatch } from '../shared/customization'
import { parseExtensionManifest } from '../shared/extensions'
import { parseLifeSourcePatch } from '../shared/source-code'
import type { Provider } from '../shared/types'
import { normalizeThreadAttachments } from './attachments'
import type { LifeThreadResponse } from './life-thread'
import type { Message, Thread } from './state'
import { normalizeSourceChange } from './source-presentation'
import { loadPendingSourceApply, type PendingSourceApply } from './source-session'
import { normalizeFileChanges } from './thread-activity'
import { normalizeMessageMetadata, normalizeThreadMetadata } from './thread-metadata'
import { normalizeQueuedMessages } from './thread-queue'

/** Studio conversations have their own store and never enter the project thread rail. */
export const STUDIO_HISTORY_KEY = 'life.studio.sessions.v1'

export type StudioStage =
  'draft' | 'planning' | 'review' | 'applying' | 'complete' | 'interrupted' | 'failed'

export type StudioProposal = Exclude<
  LifeThreadResponse,
  { kind: 'message' | 'source-read' | 'error' }
>

export interface StudioSession {
  id: string
  thread: Thread
  stage: StudioStage
  /** The user's request is saved verbatim, including leading and trailing whitespace. */
  request?: string
  changes?: string[]
  /** An unapplied proposal can be reviewed after a restart; it is never replayed. */
  proposal?: StudioProposal
  createdAt: number
  updatedAt: number
}

const stages = new Set<StudioStage>([
  'draft',
  'planning',
  'review',
  'applying',
  'complete',
  'interrupted',
  'failed',
])

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)
    )
      return
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set) return
  }
  return value as Record<string, unknown>
}

/** Optional in-memory fields may be undefined; stored data must never execute getters. */
function assertHistoryJson(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 64) throw new Error('Studio history is nested too deeply')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object') throw new Error('Studio history must contain JSON data')
  if (seen.has(value)) throw new Error('Studio history cannot contain circular references')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null)
    throw new Error('Studio history must contain plain objects')
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)
    )
      throw new Error('Studio history contains an unsupported key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set)
      throw new Error('Studio history cannot contain getters or setters')
    if (array && key === 'length') continue
    if (!array && descriptor?.value === undefined) continue
    assertHistoryJson(descriptor?.value, seen, depth + 1)
  }
  seen.delete(value)
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function choice(value: unknown): string {
  return typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : ''
}

function message(value: unknown, interruptedTurn?: number): Message | undefined {
  const row = record(value)
  if (
    !row ||
    !identifier(row.id) ||
    !['user', 'assistant', 'tool', 'error'].includes(String(row.role)) ||
    typeof row.text !== 'string'
  )
    return
  const turn = Number.isInteger(row.turn) && Number(row.turn) >= 0 ? Number(row.turn) : 0
  const interrupted = row.status === 'running'
  return {
    ...normalizeMessageMetadata(row),
    id: row.id,
    role: row.role as Message['role'],
    text: row.text,
    turn,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.input === 'string' ? { input: row.input } : {}),
    ...(typeof row.status === 'string' ? { status: interrupted ? 'interrupted' : row.status } : {}),
    ...(time(row.createdAt) > 0 ? { createdAt: time(row.createdAt) } : {}),
    ...(time(row.finishedAt) > 0 ? { finishedAt: time(row.finishedAt) } : {}),
    ...(typeof row.finishStatus === 'string'
      ? { finishStatus: row.finishStatus }
      : row.role === 'user' && turn === interruptedTurn
        ? { finishStatus: 'interrupted' }
        : {}),
    ...(row.attachments !== undefined
      ? { attachments: normalizeThreadAttachments(row.attachments) }
      : {}),
    ...(row.fileChanges !== undefined
      ? { fileChanges: normalizeFileChanges(row.fileChanges) }
      : {}),
    ...(row.sourceChange !== undefined
      ? { sourceChange: normalizeSourceChange(row.sourceChange) }
      : {}),
  }
}

function proposal(value: unknown): StudioProposal | undefined {
  const row = record(value)
  if (!row || typeof row.message !== 'string') return
  try {
    if (row.kind === 'settings')
      return { kind: 'settings', patch: parseLifeConfigPatch(row.patch), message: row.message }
    if (row.kind === 'source')
      return { kind: 'source', patch: parseLifeSourcePatch(row.patch), message: row.message }
    if (row.kind === 'extension')
      return {
        kind: 'extension',
        manifest: parseExtensionManifest(row.manifest),
        message: row.message,
      }
  } catch {
    // An invalid stored proposal must not become an executable or automatic update.
  }
}

export function createStudioSession(
  provider: Provider,
  now = Date.now(),
  id: string = crypto.randomUUID(),
): StudioSession {
  return {
    id,
    stage: 'draft',
    createdAt: now,
    updatedAt: now,
    thread: {
      id,
      purpose: 'customization',
      profileId: '',
      provider,
      title: 'New customization',
      messages: [],
      busy: false,
      model: '',
      mode: 'plan',
      updatedAt: now,
      turn: 0,
      pending: [],
    },
  }
}

/** Restore only Studio-shaped records, never legacy project or research conversations. */
export function normalizeStudioSessions(value: unknown): StudioSession[] {
  if (!Array.isArray(value)) return []
  const result: StudioSession[] = []
  const ids = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || descriptor.get || descriptor.set) continue
    const raw: unknown = descriptor.value
    try {
      assertHistoryJson(raw)
    } catch {
      continue
    }
    const row = record(raw)
    const thread = record(row?.thread)
    if (
      !row ||
      !identifier(row.id) ||
      ids.has(row.id) ||
      !thread ||
      thread.id !== row.id ||
      thread.purpose === 'research' ||
      thread.researchContext !== undefined ||
      typeof thread.profileId !== 'string' ||
      !['codex', 'claude'].includes(String(thread.provider)) ||
      !Array.isArray(thread.messages)
    )
      continue
    const turn = Number.isInteger(thread.turn) && Number(thread.turn) >= 0 ? Number(thread.turn) : 0
    const interrupted =
      thread.busy === true ||
      row.stage === 'planning' ||
      row.stage === 'applying' ||
      ['running', 'reconnecting', 'unknown'].includes(String(thread.turnStatus))
    const storedProposal = proposal(row.proposal)
    const storedStage = stages.has(row.stage as StudioStage) ? (row.stage as StudioStage) : 'draft'
    const restoredThread: Thread = {
      ...normalizeThreadMetadata(thread),
      id: row.id,
      purpose: 'customization',
      profileId: thread.profileId,
      provider: thread.provider as Provider,
      title:
        typeof thread.title === 'string' && thread.title.trim()
          ? thread.title
          : 'New customization',
      ...(identifier(thread.remoteId) ? { remoteId: thread.remoteId } : {}),
      ...(typeof thread.workspace === 'string' &&
      thread.workspace.startsWith('/') &&
      !/[\x00-\x1f]/.test(thread.workspace)
        ? { workspace: thread.workspace }
        : {}),
      ...(thread.workspaceUnknown === true ? { workspaceUnknown: true } : {}),
      messages: thread.messages.flatMap((value) => {
        const restored = message(value, interrupted ? turn : undefined)
        return restored ? [restored] : []
      }),
      busy: false,
      pending: [],
      ...(interrupted
        ? { turnStatus: 'interrupted' }
        : ['completed', 'interrupted', 'failed'].includes(String(thread.turnStatus))
          ? { turnStatus: thread.turnStatus as Thread['turnStatus'] }
          : {}),
      ...(typeof thread.agentStatus === 'string' ? { agentStatus: thread.agentStatus } : {}),
      ...(typeof thread.statusText === 'string' ? { statusText: thread.statusText } : {}),
      ...(record(thread.statusDetails) ? { statusDetails: record(thread.statusDetails) } : {}),
      ...(record(thread.agentSettings) ? { agentSettings: record(thread.agentSettings) } : {}),
      ...(thread.queue !== undefined ? { queue: normalizeQueuedMessages(thread.queue) } : {}),
      model: choice(thread.model),
      ...(thread.reasoningEffort !== undefined
        ? { reasoningEffort: choice(thread.reasoningEffort) }
        : {}),
      ...(thread.serviceTier !== undefined ? { serviceTier: choice(thread.serviceTier) } : {}),
      mode: permissionModes.some((mode) => mode === thread.mode)
        ? (thread.mode as Thread['mode'])
        : 'plan',
      updatedAt: time(thread.updatedAt),
      turn,
    }
    result.push({
      id: row.id,
      thread: restoredThread,
      stage: interrupted
        ? 'interrupted'
        : storedStage === 'review' && !storedProposal
          ? 'failed'
          : storedStage,
      ...(typeof row.request === 'string' ? { request: row.request } : {}),
      ...(Array.isArray(row.changes)
        ? { changes: row.changes.filter((change): change is string => typeof change === 'string') }
        : {}),
      ...(storedProposal ? { proposal: storedProposal } : {}),
      createdAt: time(row.createdAt),
      updatedAt: time(row.updatedAt),
    })
    ids.add(row.id)
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function parseStudioSessions(raw: string | null | undefined): StudioSession[] {
  try {
    return normalizeStudioSessions(raw ? JSON.parse(raw) : [])
  } catch {
    return []
  }
}

/** Encode current activity intact. Reload, rather than saving, marks interrupted work. */
export function encodeStudioSessions(sessions: readonly StudioSession[]): string {
  assertHistoryJson(sessions)
  return JSON.stringify(sessions)
}

export function readStudioSessions(storage?: Pick<Storage, 'getItem'>): StudioSession[] {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    return parseStudioSessions(source?.getItem(STUDIO_HISTORY_KEY))
  } catch {
    return []
  }
}

/** Copy an interrupted legacy customization into Studio without changing its project history. */
export function migrateLegacyStudioPending(
  raw: string | null | undefined,
  projectThreads: readonly Thread[],
  id: string = `life-studio:${crypto.randomUUID()}`,
  now = Date.now(),
): { session: StudioSession; pending: PendingSourceApply } | undefined {
  const pending = loadPendingSourceApply(raw)
  if (!pending || !raw || !identifier(id) || projectThreads.some((thread) => thread.id === id))
    return
  const original = projectThreads.find(
    (thread) =>
      thread.id === pending.id &&
      thread.turn === pending.turn &&
      thread.profileId === pending.profileId &&
      thread.provider === pending.start.provider &&
      thread.lifeScope === true &&
      thread.purpose !== 'research' &&
      !thread.researchContext,
  )
  if (!original) return
  let request: string
  let originalSnapshot: Thread
  try {
    const stored = record(JSON.parse(raw))
    if (
      typeof stored?.request !== 'string' ||
      !stored.request.trim() ||
      stored.request.length > 900_000
    )
      return
    const originalRequest = original.messages.find(
      (message) => message.role === 'user' && message.turn === pending.turn,
    )?.text
    request =
      typeof originalRequest === 'string' &&
      originalRequest.trim() &&
      originalRequest.length <= 1_000_000
        ? originalRequest
        : stored.request
    assertHistoryJson(original)
    originalSnapshot = JSON.parse(JSON.stringify(original)) as Thread
  } catch {
    return
  }
  // Saved project histories are immutable inputs to this copy. In particular, the new
  // session gets its own provider event ID while retaining the provider's remote ID.
  const copied = normalizeStudioSessions([
    {
      id,
      thread: {
        ...originalSnapshot,
        id,
        purpose: 'customization',
        title: 'Recovered customization',
        busy: false,
        pending: [],
        queue: [],
        updatedAt: now,
      },
      request,
      stage: 'interrupted',
      createdAt: now,
      updatedAt: now,
    },
  ])[0]
  if (!copied) return
  return {
    session: copied,
    pending: {
      ...pending,
      id,
      request,
      start: {
        ...pending.start,
        sessionId: id,
        prompt: request,
        ...(original.remoteId ? { remoteId: original.remoteId } : {}),
      },
    },
  }
}
import { permissionModes } from '../shared/permissions'
