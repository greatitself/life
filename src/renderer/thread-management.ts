import type { Thread } from './state'
import { threadHasRunningChildren } from './thread-presentation'

export type ThreadAction =
  | 'pin'
  | 'unpin'
  | 'move-up'
  | 'move-down'
  | 'settle'
  | 'restore'
  | 'wake'
  | 'snooze'
  | 'archive'
  | 'unarchive'
  | 'mark-unread'
  | 'mark-read'
  | 'rename'
  | 'export'
  | 'copy'
  | 'delete'
  | 'settings'

export const THREAD_ARRANGEMENT_FIELDS = [
  'pinnedAt',
  'pinOrder',
  'activeOrder',
  'lastReadAt',
  'settled',
  'settledAt',
  'snoozedAt',
  'snoozedUntil',
  'archivedAt',
] as const
export type ThreadArrangementPatch = Partial<
  Pick<Thread, (typeof THREAD_ARRANGEMENT_FIELDS)[number]>
>
export interface ThreadUndoChange {
  id: string
  before: ThreadArrangementPatch
  after: ThreadArrangementPatch
  turn: number
  attentionAt?: number
  completedAt?: number
}
export type ThreadSection = 'archived' | 'snoozed' | 'settled' | 'pinned' | 'active'

export function captureThreadArrangementChanges(
  before: Thread[],
  after: Thread[],
): ThreadUndoChange[] {
  const originals = new Map(before.map((thread) => [thread.id, thread]))
  const snapshot = (thread: Thread): ThreadArrangementPatch =>
    Object.fromEntries(THREAD_ARRANGEMENT_FIELDS.map((field) => [field, thread[field]]))
  return after.flatMap((thread) => {
    const original = originals.get(thread.id)
    if (!original || !THREAD_ARRANGEMENT_FIELDS.some((field) => original[field] !== thread[field]))
      return []
    return [
      {
        id: thread.id,
        before: snapshot(original),
        after: snapshot(thread),
        turn: thread.turn,
        attentionAt: thread.attentionAt,
        completedAt: thread.completedAt,
      },
    ]
  })
}

/** Undo belongs to the work it arranged, never to a later run or attention request. */
export function undoThreadArrangement(threads: Thread[], changes: ThreadUndoChange[]): Thread[] {
  const changesById = new Map(changes.map((change) => [change.id, change]))
  let changed = false
  const restored = threads.map((thread) => {
    const change = changesById.get(thread.id)
    if (
      !change ||
      thread.turn !== change.turn ||
      thread.attentionAt !== change.attentionAt ||
      thread.completedAt !== change.completedAt
    )
      return thread
    let result = thread
    for (const field of THREAD_ARRANGEMENT_FIELDS) {
      if (change.before[field] === change.after[field] || thread[field] !== change.after[field])
        continue
      result = { ...result, [field]: change.before[field] }
    }
    if (result === thread) return thread
    if (result.archivedAt && !threadCanArchive(thread)) return thread
    if ((result.settled || result.snoozedUntil) && !threadCanPark(thread)) return thread
    changed = true
    return result
  })
  return changed ? restored : threads
}

export function threadHasUnreadCompletion(thread: Thread): boolean {
  return (
    typeof thread.completedAt === 'number' &&
    typeof thread.lastReadAt === 'number' &&
    thread.completedAt > thread.lastReadAt
  )
}

export function threadAttentionStatus(thread: Thread): 'waiting' | 'failed' | 'unread' | undefined {
  if (thread.pending.length) return 'waiting'
  if (thread.turnStatus === 'failed') return 'failed'
  return threadHasUnreadCompletion(thread) ? 'unread' : undefined
}

/** A parked conversation must surface when the agent needs the user again. */
export function isThreadSnoozed(thread: Thread, now = Date.now()): boolean {
  if (!thread.snoozedUntil || thread.snoozedUntil <= now || thread.pending.length) return false
  if (
    thread.snoozedAt &&
    Math.max(thread.attentionAt || 0, thread.completedAt || 0) > thread.snoozedAt
  )
    return false
  return true
}

export function threadSection(thread: Thread, now = Date.now()): ThreadSection {
  if (thread.pending.length) return thread.pinnedAt ? 'pinned' : 'active'
  if (thread.archivedAt) return 'archived'
  if (isThreadSnoozed(thread, now)) return 'snoozed'
  if (
    thread.settled &&
    (!thread.settledAt ||
      Math.max(thread.attentionAt || 0, thread.completedAt || 0) <= thread.settledAt)
  )
    return 'settled'
  return thread.pinnedAt ? 'pinned' : 'active'
}

export function threadCanPark(thread: Thread): boolean {
  return thread.pending.length === 0
}

export function threadCanArchive(thread: Thread): boolean {
  return (
    !thread.busy &&
    thread.pending.length === 0 &&
    !threadHasRunningChildren(thread) &&
    !(thread.queue || []).some((message) => !message.paused && !message.error)
  )
}

/** Provider deltas and Git observations do not move a thread around the inbox. */
export function threadOrderTimestamp(thread: Thread): number {
  if (thread.createdAt) return thread.createdAt
  return thread.messages.find((message) => message.createdAt)?.createdAt || thread.updatedAt
}

function manualOrder(left: Thread, right: Thread, pinned: boolean): number {
  const first = pinned ? left.pinOrder : left.activeOrder
  const second = pinned ? right.pinOrder : right.activeOrder
  if (first !== undefined || second !== undefined) {
    if (first === undefined) return -1
    if (second === undefined) return 1
    if (first !== second) return first - second
  }
  return (
    (pinned ? (right.pinnedAt || 0) - (left.pinnedAt || 0) : 0) ||
    threadOrderTimestamp(right) - threadOrderTimestamp(left) ||
    left.id.localeCompare(right.id)
  )
}

export function compareManualThreads(left: Thread, right: Thread): number {
  const pinned = Boolean(left.pinnedAt)
  if (pinned !== Boolean(right.pinnedAt)) return pinned ? -1 : 1
  return manualOrder(left, right, pinned)
}

export function threadCanMove(
  threads: Thread[],
  id: string,
  direction: 'move-up' | 'move-down',
  now = Date.now(),
): boolean {
  const thread = threads.find((item) => item.id === id)
  if (!thread) return false
  const section = threadSection(thread, now)
  if (section !== 'pinned' && section !== 'active') return false
  const ordered = threads
    .filter((item) => item.purpose === thread.purpose && threadSection(item, now) === section)
    .sort(compareManualThreads)
  const index = ordered.findIndex((item) => item.id === id)
  return direction === 'move-up' ? index > 0 : index >= 0 && index < ordered.length - 1
}

/** Only arrangement fields change; runs, queued input, files and history remain intact. */
export function applyThreadAction(
  threads: Thread[],
  id: string,
  action: ThreadAction,
  now = Date.now(),
  value?: number | string,
): Thread[] {
  const thread = threads.find((item) => item.id === id)
  if (!thread) return threads
  if (action === 'export' || action === 'copy' || action === 'delete' || action === 'settings')
    return threads
  if (action === 'move-up' || action === 'move-down') {
    if (!threadCanMove(threads, id, action, now)) return threads
    const section = threadSection(thread, now)
    const ordered = threads
      .filter((item) => item.purpose === thread.purpose && threadSection(item, now) === section)
      .sort(compareManualThreads)
    const index = ordered.findIndex((item) => item.id === id)
    const destination = index + (action === 'move-up' ? -1 : 1)
    ;[ordered[index], ordered[destination]] = [ordered[destination], ordered[index]]
    const positions = new Map(ordered.map((item, rank) => [item.id, rank + 1]))
    const field = section === 'pinned' ? 'pinOrder' : 'activeOrder'
    return threads.map((item) =>
      positions.has(item.id) ? { ...item, [field]: positions.get(item.id) } : item,
    )
  }
  let patch: Partial<Thread>
  switch (action) {
    case 'pin':
      patch = {
        pinnedAt: now,
        pinOrder: undefined,
        archivedAt: undefined,
        settled: false,
        settledAt: undefined,
        snoozedAt: undefined,
        snoozedUntil: undefined,
      }
      break
    case 'unpin':
      patch = { pinnedAt: undefined, pinOrder: undefined }
      break
    case 'settle':
      if (!threadCanPark(thread)) return threads
      patch = {
        settled: true,
        settledAt: now,
        activeOrder: undefined,
        pinnedAt: undefined,
        pinOrder: undefined,
        snoozedAt: undefined,
        snoozedUntil: undefined,
      }
      break
    case 'restore':
    case 'wake':
    case 'unarchive':
      patch = {
        archivedAt: undefined,
        settled: false,
        settledAt: undefined,
        snoozedAt: undefined,
        snoozedUntil: undefined,
      }
      break
    case 'snooze':
      if (
        !threadCanPark(thread) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value <= now
      )
        return threads
      patch = {
        snoozedAt: now,
        snoozedUntil: value,
        settled: false,
        settledAt: undefined,
      }
      break
    case 'archive':
      if (!threadCanArchive(thread)) return threads
      patch = {
        archivedAt: now,
        pinnedAt: undefined,
        pinOrder: undefined,
        settled: false,
        settledAt: undefined,
        snoozedAt: undefined,
        snoozedUntil: undefined,
      }
      break
    case 'mark-unread':
      if (!thread.completedAt) return threads
      patch = { lastReadAt: Math.max(0, thread.completedAt - 1) }
      break
    case 'mark-read':
      patch = {
        lastReadAt: Math.max(
          now,
          thread.lastReadAt || 0,
          thread.completedAt || 0,
          thread.attentionAt || 0,
        ),
      }
      break
    case 'rename': {
      const title = typeof value === 'string' ? value.trim() : ''
      if (!title || title.length > 1000 || /[\x00-\x1f\x7f]/.test(title)) return threads
      patch = { title, titleSource: 'manual' }
      break
    }
  }
  if (Object.entries(patch).every(([key, result]) => thread[key as keyof Thread] === result))
    return threads
  const changed = threads.map((item) => (item.id === id ? { ...item, ...patch } : item))
  if ((action === 'restore' || action === 'unarchive') && (thread.settled || thread.archivedAt)) {
    const active = changed
      .filter(
        (item) =>
          item.id !== id &&
          item.purpose === thread.purpose &&
          threadSection(item, now) === 'active',
      )
      .sort(compareManualThreads)
    const positions = new Map(active.map((item, rank) => [item.id, rank + 2]))
    positions.set(id, 1)
    return changed.map((item) =>
      positions.has(item.id) ? { ...item, activeOrder: positions.get(item.id) } : item,
    )
  }
  return changed
}
