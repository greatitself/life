import type { ResearchGoal, ResearchProblem } from './workbench'

export interface LegacyResearchEdit {
  directory: string
  before?: ResearchGoal
  after: ResearchGoal
  force?: boolean
}

export interface LegacyResearchConflict {
  id: string
  /** Every distinct version is retained, including the selected newest version. */
  variants: ResearchGoal[]
}

export interface LegacyResearchCollection {
  goals: ResearchGoal[]
  pending: LegacyResearchEdit[]
  workspaces: string[]
  threadIds: Set<string>
  conflicts: LegacyResearchConflict[]
  /** Original caches remain available; a partial import must not retire them. */
  truncated?: boolean
}

type ResearchStorage = Pick<Storage, 'length' | 'key' | 'getItem'>
const legacyKey = 'life.research.workbench.v1'
const migrationKey = 'life.research.migrated-to.v1'
const cachePrefixes = ['life.research.files.v1:', 'life.research.files.v2:']
const maxEntries = 1_000
const maxLength = 4_000_000
const maxGoals = 100
const maxPending = 1_000
const maxScanBytes = 32_000_000
interface ScanBudget {
  remaining: number
  truncated: boolean
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function normalizeGoal(value: unknown): ResearchGoal | undefined {
  const row = object(value)
  const id = identifier(row?.id)
  const title = text(row?.title, 160)
  if (!row || !id || !title.trim()) return
  const seen = new Set<string>()
  const problems: ResearchProblem[] = []
  for (const entry of (Array.isArray(row.problems) ? row.problems : []).slice(0, 200)) {
    const problem = object(entry)
    const id = identifier(problem?.id)
    const title = text(problem?.title, 160)
    if (!problem || !id || !title.trim() || seen.has(id)) continue
    seen.add(id)
    problems.push({
      ...problem,
      id,
      title,
      description: text(problem.description, 2_000),
      notes: text(problem.notes, 8_000),
      status: problem.status === 'solved' || problem.status === 'blocked' ? problem.status : 'open',
      threadId: identifier(problem.threadId),
      updatedAt: timestamp(problem.updatedAt),
    })
  }
  return {
    ...row,
    id,
    title,
    goal: text(row.goal, 2_000),
    directory: identifier(row.directory),
    threadId: identifier(row.threadId),
    problems,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  }
}

function defaultStorage(): ResearchStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function parseStored(storage: ResearchStorage, key: string, budget: ScanBudget): unknown {
  try {
    if (budget.remaining <= 0) {
      budget.truncated = true
      return
    }
    const raw = storage.getItem(key)
    if (!raw) return
    if (raw.length > maxLength || raw.length > budget.remaining) {
      budget.remaining = Math.max(0, budget.remaining - raw.length)
      budget.truncated = true
      return
    }
    const bytes = new TextEncoder().encode(raw).byteLength
    if (bytes > budget.remaining) {
      budget.remaining = 0
      budget.truncated = true
      return
    }
    budget.remaining -= bytes
    const parsed: unknown = JSON.parse(raw)
    // A damaged cache must not turn migration into an unbounded recursive walk.
    const pending = [{ value: parsed, depth: 0 }]
    let nodes = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++nodes > 100_000 || next.depth > 64) return
      if (next.value && typeof next.value === 'object') {
        for (const value of Object.values(next.value)) {
          pending.push({ value, depth: next.depth + 1 })
        }
      }
    }
    return parsed
  } catch {
    return undefined
  }
}

function storageKeys(storage: ResearchStorage, prefixes: string[], budget: ScanBudget): string[] {
  const keys: string[] = []
  try {
    const count = Math.min(maxEntries, Math.max(0, storage.length))
    if (storage.length > maxEntries) budget.truncated = true
    for (let index = 0; index < count; index++) {
      try {
        const key = storage.key(index)
        if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
      } catch {
        // A single inaccessible entry must not hide other saved Research chats.
      }
    }
  } catch {
    // The direct legacy record remains readable in partially unavailable storage.
  }
  return [...new Set(keys)]
}

function scopeKey(value: unknown): { profileId: string; workspace?: string } | undefined {
  try {
    if (typeof value === 'string' && value.length > 8_000) return
    const parts: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parts)) return
    const offset = parts[0] === 'research' && parts.length >= 3 ? 1 : 0
    const profileId = identifier(parts[offset])
    if (!profileId) return
    const workspace =
      typeof parts[offset + 1] === 'string' && parts[offset + 1].startsWith('/')
        ? parts[offset + 1]
        : undefined
    return { profileId, workspace }
  } catch {
    return undefined
  }
}

function scopeForCache(key: string, row: Record<string, unknown>) {
  const scope = object(row.scope)
  const fromKey = scopeKey(
    key.slice(cachePrefixes.find((prefix) => key.startsWith(prefix))!.length),
  )
  const profileId = identifier(scope?.profileId) || fromKey?.profileId
  const workspace =
    typeof scope?.workspace === 'string' && scope.workspace.startsWith('/')
      ? scope.workspace
      : fromKey?.workspace
  // Conflicting cache ownership is ambiguous; keep the original but never import it elsewhere.
  if (scope?.profileId && fromKey && scope.profileId !== fromKey.profileId) return
  return profileId ? { profileId, workspace } : undefined
}

function addThreadIds(goal: ResearchGoal, ids: Set<string>) {
  if (goal.threadId) ids.add(goal.threadId)
  for (const problem of goal.problems) if (problem.threadId) ids.add(problem.threadId)
}

function recordGoals(value: unknown): ResearchGoal[] {
  const record = object(value)
  return (Array.isArray(record?.goals) ? record.goals : []).slice(0, maxGoals).flatMap((entry) => {
    const goal = normalizeGoal(entry)
    return goal ? [goal] : []
  })
}

function edits(value: unknown): LegacyResearchEdit[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxPending).flatMap((entry) => {
    const row = object(entry)
    const after = normalizeGoal(row?.after)
    const directory = identifier(row?.directory)
    if (!row || !directory || !after) return []
    return [
      {
        directory,
        before: normalizeGoal(row.before),
        after,
        ...(row.force === true ? { force: true } : {}),
      },
    ]
  })
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!object(item)) return item
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    )
  })
}

/** Read old Research data without changing, deleting, or assigning ownership to its original keys. */
export function collectLegacyResearch(
  profileId?: string,
  storage?: ResearchStorage,
): LegacyResearchCollection {
  const result: LegacyResearchCollection = {
    goals: [],
    pending: [],
    workspaces: [],
    threadIds: new Set(),
    conflicts: [],
  }
  const target = storage || defaultStorage()
  if (!target) return result
  const budget: ScanBudget = { remaining: maxScanBytes, truncated: false }
  const versions = new Map<string, Map<string, ResearchGoal>>()
  const chosen = new Map<string, ResearchGoal>()
  const workspaces = new Set<string>()
  const pendingSeen = new Set<string>()
  function collect(goal: ResearchGoal) {
    addThreadIds(goal, result.threadIds)
    if (!versions.has(goal.id) && versions.size >= maxGoals) {
      budget.truncated = true
      return
    }
    const variants = versions.get(goal.id) || new Map<string, ResearchGoal>()
    variants.set(fingerprint(goal), goal)
    versions.set(goal.id, variants)
    const previous = chosen.get(goal.id)
    if (!previous || goal.updatedAt > previous.updatedAt) chosen.set(goal.id, goal)
  }
  function collectRecord(value: unknown) {
    const record = object(value)
    if (Array.isArray(record?.goals) && record.goals.length > maxGoals) budget.truncated = true
    for (const goal of recordGoals(value)) collect(goal)
  }
  const migrated = scopeKey(parseStored(target, migrationKey, budget))
  // The legacy local notebook has no machine identity. Adopt it only when its old migration marker
  // establishes ownership, or when the caller explicitly requests an unfiltered local export.
  if (!profileId || migrated?.profileId === profileId) {
    collectRecord(parseStored(target, legacyKey, budget))
  }
  for (const key of storageKeys(target, [cachePrefixes[0]], budget)) {
    const keyScope = scopeKey(key.slice(cachePrefixes[0].length))
    if (profileId && keyScope && keyScope.profileId !== profileId) continue
    const row = object(parseStored(target, key, budget))
    if (!row) continue
    const scope = scopeForCache(key, row)
    const local = key === cachePrefixes[0] + 'local'
    if (
      profileId &&
      scope?.profileId !== profileId &&
      !(local && migrated?.profileId === profileId)
    )
      continue
    if (scope?.workspace && (!profileId || scope.profileId === profileId))
      workspaces.add(scope.workspace)
    const record = object(row.record)
    if (Array.isArray(record?.goals) && record.goals.length > maxGoals) budget.truncated = true
    if (Array.isArray(row.pending) && row.pending.length > maxPending) budget.truncated = true
    const sourceGoals = new Map(recordGoals(row.record).map((goal) => [goal.id, goal]))
    for (const edit of edits(row.pending)) {
      if (edit.before) addThreadIds(edit.before, result.threadIds)
      addThreadIds(edit.after, result.threadIds)
      // Earlier edits in one pending chain are not conflicting notebook copies. The final edit
      // represents this cache's latest local goal; the original chain remains available below.
      const previous = sourceGoals.get(edit.after.id)
      if (!previous || edit.after.updatedAt >= previous.updatedAt)
        sourceGoals.set(edit.after.id, edit.after)
      const hash = fingerprint(edit)
      if (!pendingSeen.has(hash) && result.pending.length < maxPending) {
        pendingSeen.add(hash)
        result.pending.push(edit)
      } else if (!pendingSeen.has(hash)) {
        budget.truncated = true
      }
    }
    for (const goal of sourceGoals.values()) collect(goal)
  }
  result.goals = [...chosen.values()]
  result.workspaces = [...workspaces]
  result.conflicts = [...versions].flatMap(([id, variants]) =>
    variants.size > 1 ? [{ id, variants: [...variants.values()] }] : [],
  )
  if (budget.truncated) result.truncated = true
  return result
}

/** Classify saved chats using every Research scope, including edits waiting to reach a machine. */
export function researchLinkedThreadIds(storage?: ResearchStorage): Set<string> {
  const target = storage || defaultStorage()
  const ids = new Set<string>()
  if (!target) return ids
  const budget: ScanBudget = { remaining: maxScanBytes, truncated: false }
  for (const goal of recordGoals(parseStored(target, legacyKey, budget))) addThreadIds(goal, ids)
  const keys = storageKeys(target, cachePrefixes, budget)
  keys.sort(
    (a, b) => Number(b.startsWith(cachePrefixes[1])) - Number(a.startsWith(cachePrefixes[1])),
  )
  for (const key of keys) {
    const row = object(parseStored(target, key, budget))
    if (!row) continue
    for (const goal of recordGoals(row.record)) addThreadIds(goal, ids)
    for (const edit of edits(row.pending)) {
      if (edit.before) addThreadIds(edit.before, ids)
      addThreadIds(edit.after, ids)
    }
  }
  return ids
}
