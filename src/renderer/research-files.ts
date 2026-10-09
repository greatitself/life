import { researchCommand } from '../shared/research-command'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  researchOperationCatalog,
  researchOperations,
  type ResearchOperation,
} from '../shared/research-method'
import { researchMethodGuide, researchMethodSchema } from '../shared/research-method-protocol'
import type { ConnectionState } from '../shared/types'
import { api, errorText } from './api'
import {
  normalizeResearch,
  type ResearchGoal,
  type ResearchRecord,
  type ResearchTarget,
} from './workbench'
import { collectLegacyResearch, researchLinkedThreadIds } from './research-legacy'

import {
  makeResearchScope as makeScope,
  researchScopeMatches as matches,
  researchDirectory,
  researchReadme as readme,
  researchInstructions,
  legacyResearchInstructions,
  legacyResearchConversationInstructions,
  researchConversationInstructions,
  researchStorageName,
  researchFileWorker as worker,
  type ResearchScope,
} from './research-storage'
export type { ResearchScope } from './research-storage'
export interface ResearchMapFile {
  format?: 'json' | 'mermaid' | 'html'
  source?: string
  revision?: string
  error?: string
}
interface FileRead {
  text: string
  revision: string | null
}
interface ScanEntry {
  directory: string
  revision: string
  maps: { file: string; revision: string | null }[]
}
interface RemoteGoal {
  goal: ResearchGoal
  revision: string
}
interface Edit {
  directory: string
  before?: ResearchGoal
  after: ResearchGoal
  force?: boolean
}
interface Session {
  key: string
  scope?: ResearchScope
  record: ResearchRecord
  current: { current: ResearchRecord }
  pending: Edit[]
  remote: Map<string, RemoteGoal>
  maps: Map<string, { signature: string; value: ResearchMapFile }>
  ready: boolean
  status: 'offline' | 'loading' | 'saving' | 'saved' | 'error'
  error?: string
  conflict: boolean
  notice?: string
  running?: Promise<void>
  generation: number
  prepared: Map<string, string>
}
const cachePrefix = 'life.research.files.v2:'
const lastScopeKey = 'life.research.selected-scope.v2'
const migrationKey = 'life.research.migrated-to.v2'
const localAssignmentKey = 'life.research.local-assigned-to.v2'
const legacyKey = 'life.research.workbench.v1'
const blank: ResearchRecord = { goals: [] }
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const identifiedRows = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string')
function body(goal: ResearchGoal): ResearchGoal {
  const { directory: _directory, ...value } = goal
  return value
}
function directory(goal: ResearchGoal): string {
  return goal.directory || goal.id
}
function stored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw && raw.length <= 4_000_000 ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}
function loadSession(key: string, fallback: ResearchRecord = blank): Session {
  const cached = stored(cachePrefix + key)
  const row = isObject(cached) ? cached : {}
  const candidate = isObject(row.scope) ? row.scope : {}
  const scope: ResearchScope | undefined =
    typeof candidate.profileId === 'string' &&
    typeof candidate.workspace === 'string' &&
    candidate.workspace.startsWith('/') &&
    !candidate.workspace.includes('\0')
      ? {
          key: JSON.stringify(['research', candidate.profileId, candidate.workspace]),
          profileId: candidate.profileId,
          workspace: candidate.workspace,
          root: researchDirectory(candidate.workspace),
          host: typeof candidate.host === 'string' ? candidate.host : '',
        }
      : undefined
  const record = normalizeResearch(row.record || fallback)
  const pending: Edit[] = Array.isArray(row.pending)
    ? row.pending.slice(0, 1000).flatMap((entry) => {
        if (!isObject(entry) || typeof entry.directory !== 'string') return []
        const after = normalizeResearch({ goals: [entry.after] }).goals[0]
        const before = normalizeResearch({ goals: [entry.before] }).goals[0]
        return after
          ? [{ directory: entry.directory, after, before, force: entry.force === true }]
          : []
      })
    : []
  return {
    key,
    scope,
    record,
    current: { current: record },
    pending,
    remote: new Map(),
    maps: new Map(),
    ready: false,
    status: scope ? 'loading' : 'offline',
    conflict: false,
    ...(typeof row.notice === 'string' ? { notice: row.notice } : {}),
    generation: 0,
    prepared: new Map(),
  }
}
function saveSession(session: Session) {
  const encoded = JSON.stringify({
    scope: session.scope,
    record: session.record,
    pending: session.pending,
    notice: session.notice,
  })
  if (encoded.length > 4_000_000)
    throw new Error(
      'Research browser cache is full. Shorten some findings or export your local edits.',
    )
  localStorage.setItem(cachePrefix + session.key, encoded)
}

/** Preserve independent edits, including unknown agent-owned metadata and problem ordering. */
export function mergeResearchEdit(
  base: unknown,
  local: unknown,
  remote: unknown,
  at = 'goal',
  force = false,
): unknown {
  if (equal(base, local)) return remote
  if (equal(base, remote) || equal(local, remote)) return local
  if (identifiedRows(base) && identifiedRows(local) && identifiedRows(remote)) {
    const before = new Map(base.map((item) => [String(item.id), item]))
    const ours = new Map(local.map((item) => [String(item.id), item]))
    const theirs = new Map(remote.map((item) => [String(item.id), item]))
    const ids = [...new Set([...theirs.keys(), ...ours.keys()])]
    return ids
      .map((id) =>
        mergeResearchEdit(before.get(id), ours.get(id), theirs.get(id), at + '.' + id, force),
      )
      .filter((item) => item !== undefined)
  }
  if (isObject(base) && isObject(local) && isObject(remote)) {
    const result: Record<string, unknown> = {}
    for (const key of new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const value = mergeResearchEdit(base[key], local[key], remote[key], at + '.' + key, force)
      if (value !== undefined) result[key] = value
    }
    return result
  }
  if (force) return local
  throw new Error('Research conflict at ' + at + '. Both Life and the machine changed this field.')
}

async function call<T>(
  scope: ResearchScope,
  input: Record<string, unknown>,
  guard = () => {},
): Promise<T> {
  guard()
  if (!api || !matches(scope, await api.connection.state()))
    throw new Error('Connect to this Research machine before syncing.')
  guard()
  if (import.meta.env?.VITE_LIFE_WEB_PREVIEW === 'true') {
    const { performWebResearchOperation } = await import('./web-research')
    const value = await performWebResearchOperation<T>(scope, input)
    guard()
    return value
  }
  const command = await researchCommand(worker, input)
  guard()
  const output = await api.connection.execute({
    command,
    scope: 'machine',
    workspace: scope.workspace,
    timeoutMs: 30000,
  })
  guard()
  if (!matches(scope, await api.connection.state()))
    throw new Error('The Research machine changed during sync.')
  guard()
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith('LIFE_RESEARCH_RESULT='))
  if (!line)
    throw new Error(
      output.trim().slice(-1000) || 'The Research file operation did not return a result.',
    )
  const result = JSON.parse(line.slice('LIFE_RESEARCH_RESULT='.length)) as {
    value?: T
    error?: string
  }
  if (result.error) throw new Error(result.error)
  return result.value as T
}
async function readFile(
  scope: ResearchScope,
  dir: string,
  file: string,
  expected?: string | null,
  guard = () => {},
): Promise<FileRead> {
  const parts: Uint8Array[] = []
  let offset = 0
  let revision = expected
  for (;;) {
    const result = await call<{ revision: string | null; data: string; done: boolean }>(
      scope,
      {
        op: 'read',
        directory: dir,
        file,
        offset,
        expected: revision,
      },
      guard,
    )
    revision = result.revision
    const part = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0))
    parts.push(part)
    offset += part.length
    if (offset > 4_000_000 || (!result.done && !part.length))
      throw new Error('Invalid Research file transfer.')
    if (result.done) break
  }
  const bytes = new Uint8Array(offset)
  let position = 0
  for (const part of parts) {
    bytes.set(part, position)
    position += part.length
  }
  return { text: new TextDecoder().decode(bytes), revision: revision || null }
}
async function writeGoal(
  scope: ResearchScope,
  dir: string,
  value: ResearchGoal,
  expected: string | null,
  guard = () => {},
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body(value), null, 2) + '\n')
  if (bytes.length > 4_000_000) throw new Error('This goal exceeds the 4 MB file limit.')
  const stage = crypto.randomUUID()
  try {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 16384)))
      await call(scope, { op: 'stage', stage, offset, data }, guard)
    }
    const result = await call<{ revision: string }>(
      scope,
      {
        op: 'commit',
        directory: dir,
        stage,
        expected,
      },
      guard,
    )
    return result.revision
  } finally {
    try {
      await call(scope, { op: 'discard', stage }, guard)
    } catch {
      /* A later connection must never receive cleanup for this machine. */
    }
  }
}
export function parseResearchGoal(text: string, dir: string): ResearchGoal {
  const value: unknown = JSON.parse(text)
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.problems)
  )
    throw new Error('Invalid goal.json in ' + dir)
  if (value.method !== undefined) {
    if (!isObject(value.method) || value.method.version !== 1)
      throw new Error(
        'Invalid research method in ' + dir + '. The previous cached goal is retained.',
      )
    for (const collection of [
      'requirements',
      'assumptions',
      'evidence',
      'candidates',
      'interactions',
      'validations',
      'inquiries',
    ])
      if (value.method[collection] !== undefined && !Array.isArray(value.method[collection]))
        throw new Error(
          'Invalid research ' +
            collection +
            ' in ' +
            dir +
            '. The previous cached goal is retained.',
        )
    if (
      value.method.activeOperation !== undefined &&
      !researchOperations.includes(value.method.activeOperation as ResearchOperation) &&
      !['decompose', 'synthesize', 'challenge'].includes(String(value.method.activeOperation))
    )
      throw new Error(
        'Unknown research operation in ' + dir + '. The previous cached goal is retained.',
      )
  }
  const goal = normalizeResearch({ goals: [{ ...value, directory: dir }] }).goals[0]
  if (!goal) throw new Error('Invalid goal.json in ' + dir)
  return goal
}

export function useResearchFiles(
  connection: ConnectionState,
  enabled: boolean,
  onError: (message: string) => void,
  visible = enabled,
) {
  const [session, setSession] = useState<Session>(() => {
    let key = 'local'
    try {
      key = localStorage.getItem(lastScopeKey) || key
    } catch {
      /* Use the existing local workspace. */
    }
    // Already assigned v1 notes belong to that machine; a fresh connection must
    // not silently adopt them through the unscoped local-draft fallback.
    let unassignedLegacy = false
    try {
      unassignedLegacy = !localStorage.getItem('life.research.migrated-to.v1')
    } catch {
      /* Keep ownership unresolved when storage is unavailable. */
    }
    return loadSession(
      key,
      key === 'local' && unassignedLegacy ? normalizeResearch(stored(legacyKey)) : blank,
    )
  })
  const sessions = useRef(new Map<string, Session>())
  const restoredSessions = useRef(false)
  if (!restoredSessions.current) {
    restoredSessions.current = true
    try {
      let totalLength = 0
      for (let index = 0; index < Math.min(localStorage.length, 1000); index++) {
        const key = localStorage.key(index)
        if (
          !key?.startsWith(cachePrefix) ||
          key.endsWith(':conflict-copy') ||
          key.endsWith(':migration-copy')
        )
          continue
        const raw = localStorage.getItem(key)
        if (!raw || raw.length > 4_000_000) continue
        totalLength += raw.length
        if (totalLength > 16_000_000) break
        const cached = loadSession(key.slice(cachePrefix.length))
        if (cached.scope && cached.key === cached.scope.key)
          sessions.current.set(cached.key, cached)
      }
    } catch {
      /* Research still opens when browser storage is unavailable. */
    }
  }
  sessions.current.set(session.key, session)
  const selected = useRef(session)
  selected.current = session
  const connectionNow = useRef(connection)
  connectionNow.current = connection
  const error = useRef(onError)
  error.current = onError
  const mounted = useRef(true)
  const enabledNow = useRef(enabled)
  enabledNow.current = enabled
  const legacyThreadIds = useRef<Set<string> | undefined>(undefined)
  if (!legacyThreadIds.current) legacyThreadIds.current = researchLinkedThreadIds()
  const [, setRevision] = useState(0)
  function notify(target: Session) {
    if (mounted.current && selected.current === target) setRevision((value) => value + 1)
  }
  function remember(target: Session) {
    try {
      saveSession(target)
    } catch (cause) {
      error.current(errorText(cause))
    }
  }
  function useWorkspace(state: ConnectionState) {
    if (!enabledNow.current) return false
    const scope = makeScope(state)
    if (!scope) return false
    let next = sessions.current.get(scope.key)
    if (!next) {
      next = loadSession(scope.key)
      sessions.current.set(scope.key, next)
    }
    next.scope = scope
    if (selected.current.key === 'local' && selected.current.record.goals.length) {
      try {
        const assigned = localStorage.getItem(localAssignmentKey)
        if (!assigned || assigned === scope.key) {
          const existing = new Set([
            ...next.record.goals.map((goal) => goal.id),
            ...next.pending.map((edit) => edit.after.id),
          ])
          for (const goal of selected.current.record.goals) {
            if (existing.has(goal.id)) continue
            next.pending.push({ directory: directory(goal), after: body(goal) })
            next.record = normalizeResearch({ ...next.record, goals: [...next.record.goals, goal] })
          }
          next.current.current = next.record
          saveSession(next)
          localStorage.setItem(localAssignmentKey, scope.key)
        }
      } catch (cause) {
        error.current(errorText(cause))
        return false
      }
    }
    selected.current = next
    setSession(next)
    try {
      localStorage.setItem(lastScopeKey, scope.key)
      saveSession(next)
    } catch (cause) {
      error.current(errorText(cause))
    }
    notify(next)
    return true
  }
  useLayoutEffect(() => {
    if (enabled && !session.scope && makeScope(connection)) useWorkspace(connection)
  }, [enabled, session, connection.status, connection.profile?.id, connection.home])
  function publish(target: Session) {
    const goals = [...target.remote.values()].map((entry) => entry.goal)
    for (const edit of target.pending) {
      const index = goals.findIndex((goal) => goal.id === edit.after.id)
      if (index < 0) goals.push({ ...edit.after, directory: edit.directory })
      else {
        try {
          goals[index] = {
            ...(mergeResearchEdit(
              edit.before,
              body(edit.after),
              body(goals[index]),
              'goal',
              edit.force,
            ) as ResearchGoal),
            directory: edit.directory,
          }
        } catch {
          goals[index] = { ...edit.after, directory: edit.directory }
        }
      }
    }
    const next = normalizeResearch({ ...target.record, goals })
    const previous = new Map(target.record.goals.map((goal) => [goal.id, goal]))
    // Unchanged file revisions should not recompute dense research analysis on every poll.
    next.goals = next.goals.map((goal) => {
      const before = previous.get(goal.id)
      return before && equal(before, goal) ? before : goal
    })
    target.record =
      next.goals.length === target.record.goals.length &&
      next.goals.every((goal, index) => goal === target.record.goals[index]) &&
      next.goalId === target.record.goalId &&
      next.problemId === target.record.problemId
        ? target.record
        : next
    target.current.current = target.record
    remember(target)
    notify(target)
  }
  async function commitEdit(target: Session, edit: Edit, guard: () => void) {
    const scope = target.scope!
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await readFile(scope, edit.directory, 'goal.json', undefined, guard)
      const remote = latest.revision ? parseResearchGoal(latest.text, edit.directory) : undefined
      if (remote && latest.revision)
        target.remote.set(edit.directory, { goal: remote, revision: latest.revision })
      else target.remote.delete(edit.directory)
      const merged = mergeResearchEdit(
        edit.before,
        body(edit.after),
        remote ? body(remote) : undefined,
        'goal ' + edit.after.title,
        edit.force,
      ) as ResearchGoal
      const next = { ...merged, directory: edit.directory }
      try {
        const revision = await writeGoal(scope, edit.directory, next, latest.revision, guard)
        target.remote.set(edit.directory, { goal: next, revision })
        return
      } catch (cause) {
        if (errorText(cause) !== 'RESEARCH_CHANGED' || attempt === 3) throw cause
      }
    }
  }
  async function loadMap(target: Session, entries: ScanEntry[], guard: () => void) {
    const goal = target.record.goals.find((item) => item.id === target.record.goalId)
    if (!goal) return
    const dir = directory(goal)
    const entry = entries.find((item) => item.directory === dir)
    const files = entry?.maps || []
    const signature = JSON.stringify(files)
    const previous = target.maps.get(dir)
    if (previous?.signature === signature) return
    const chosen = ['map.html', 'map.mmd', 'map.json']
      .map((name) => files.find((file) => file.file === name && file.revision))
      .find(Boolean)
    if (!chosen) {
      target.maps.set(dir, { signature, value: {} })
      return
    }
    try {
      const file = await readFile(target.scope!, dir, chosen.file, chosen.revision, guard)
      if (chosen.file === 'map.json') JSON.parse(file.text)
      const format =
        chosen.file === 'map.html' ? 'html' : chosen.file === 'map.mmd' ? 'mermaid' : 'json'
      target.maps.set(dir, {
        signature,
        value: { format, source: file.text, revision: file.revision || undefined },
      })
    } catch (cause) {
      if (errorText(cause) === 'RESEARCH_CHANGED') throw cause
      target.maps.set(dir, {
        signature,
        value: { ...previous?.value, error: chosen.file + ': ' + errorText(cause) },
      })
    }
  }
  function sync(target = selected.current): Promise<void> {
    if (target.running) return target.running
    if (
      !enabledNow.current ||
      !target.scope ||
      !api ||
      !matches(target.scope, connectionNow.current)
    ) {
      target.status = 'offline'
      notify(target)
      return Promise.reject(
        new Error('Choose or reconnect this Research machine to save its files.'),
      )
    }
    target.status = target.pending.length ? 'saving' : 'loading'
    notify(target)
    const generation = target.generation
    const guard = () => {
      if (!enabledNow.current || target.generation !== generation)
        throw new Error('Research is disabled. Edits remain cached.')
      if (!target.scope || !matches(target.scope, connectionNow.current))
        throw new Error('The Research machine changed during sync.')
    }
    const run = async () => {
      const alreadyMigrated = localStorage.getItem(migrationKey + ':' + target.key)
      const legacy =
        target.ready || alreadyMigrated ? undefined : collectLegacyResearch(target.scope!.profileId)
      if (legacy?.truncated)
        throw new Error(
          'Legacy Research migration is too large to finish automatically. Original caches are preserved; export or split older Research workspaces first.',
        )
      const initialized = await call<{ migrationConflicts?: number }>(
        target.scope!,
        {
          op: 'init',
          readme,
          instructions: researchInstructions,
          previousInstructions: [legacyResearchInstructions],
          methodGuide: researchMethodGuide,
          methodSchema: researchMethodSchema,
          legacyWorkspaces: [...(legacy?.workspaces || []), connectionNow.current.workspace].filter(
            Boolean,
          ),
        },
        guard,
      )
      if (initialized.migrationConflicts)
        target.notice = `${initialized.migrationConflicts} legacy Research copies conflicted with current folders. The alternate files are preserved under .life/research/.legacy-conflicts; migration.json lists their original locations.`
      const scan = await call<{ entries: ScanEntry[] }>(target.scope!, { op: 'scan' }, guard)
      if (scan.entries.length > 100)
        throw new Error('This Research workspace has more than 100 goals.')
      const nextRemote = new Map<string, RemoteGoal>()
      const ids = new Set<string>()
      for (const entry of scan.entries) {
        const cached = target.remote.get(entry.directory)
        const item =
          cached?.revision === entry.revision
            ? cached
            : {
                goal: parseResearchGoal(
                  (
                    await readFile(
                      target.scope!,
                      entry.directory,
                      'goal.json',
                      entry.revision,
                      guard,
                    )
                  ).text,
                  entry.directory,
                ),
                revision: entry.revision,
              }
        if (ids.has(item.goal.id))
          throw new Error('Research goal IDs must be unique: ' + item.goal.id)
        ids.add(item.goal.id)
        nextRemote.set(entry.directory, item)
      }
      target.remote = nextRemote
      if (!target.ready) {
        let migrated: string | null = null
        try {
          migrated = localStorage.getItem(migrationKey + ':' + target.key)
        } catch {
          /* Preserve the legacy data. */
        }
        if (!migrated && legacy) {
          const backup = JSON.stringify(legacy)
          if (backup.length > 4_000_000)
            throw new Error(
              'Legacy Research edits exceed the safe migration size. Original caches were preserved.',
            )
          localStorage.setItem(cachePrefix + target.key + ':migration-copy', backup)
          const queued = new Set(target.pending.map((item) => item.after.id))
          const pendingIds = new Set(legacy.pending.map((item) => item.after.id))
          const destinations = new Map(
            [...nextRemote.values()].map((item) => [item.goal.id, directory(item.goal)]),
          )
          const used = new Set(destinations.values())
          const destination = (goal: ResearchGoal) => {
            if (destinations.has(goal.id)) return destinations.get(goal.id)!
            let name = directory(goal)
            if (
              !name ||
              name.length > 240 ||
              name.startsWith('.') ||
              /[\/\\\0]/.test(name) ||
              used.has(name)
            )
              name = 'goal-' + crypto.randomUUID()
            destinations.set(goal.id, name)
            used.add(name)
            return name
          }
          for (const goal of legacy.goals) {
            if (!ids.has(goal.id) && !queued.has(goal.id) && !pendingIds.has(goal.id)) {
              target.pending.push({ directory: destination(goal), after: body(goal) })
              queued.add(goal.id)
            }
          }
          const initialized = new Set(ids)
          for (const edit of legacy.pending) {
            if (queued.has(edit.after.id)) continue
            const dir = destination(edit.after)
            if (!initialized.has(edit.after.id) && edit.before) {
              target.pending.push({ directory: dir, after: body(edit.before) })
              initialized.add(edit.after.id)
            }
            target.pending.push({
              ...edit,
              directory: dir,
              before: edit.before ? body(edit.before) : undefined,
              after: body(edit.after),
            })
            initialized.add(edit.after.id)
          }
          if (legacy.conflicts.length)
            target.notice = `${legacy.conflicts.length} legacy goal ${legacy.conflicts.length === 1 ? 'has' : 'have'} preserved alternate copies. Download local edits to review them; original caches remain intact.`
          saveSession(target)
          localStorage.setItem(migrationKey + ':' + target.key, target.key)
        }
      }
      while (target.pending.length) {
        const edit = target.pending[0]
        await commitEdit(target, edit, guard)
        if (target.pending[0] === edit) target.pending.shift()
        publish(target)
      }
      publish(target)
      await loadMap(target, scan.entries, guard)
      guard()
      target.ready = true
      target.error = undefined
      target.conflict = false
      target.status = 'saved'
      remember(target)
      notify(target)
    }
    target.running = run()
      .catch((cause) => {
        if (!enabledNow.current || target.generation !== generation) {
          target.status = 'offline'
          notify(target)
          throw cause
        }
        const message = errorText(cause)
        target.status = 'error'
        target.conflict = message.startsWith('Research conflict')
        if (target.error !== message && message !== 'RESEARCH_CHANGED') error.current(message)
        target.error =
          message === 'RESEARCH_CHANGED'
            ? 'Research changed during refresh. Retry to load the latest files.'
            : message
        remember(target)
        notify(target)
        throw cause
      })
      .finally(() => {
        target.running = undefined
        if (
          enabledNow.current &&
          target.pending.length &&
          !target.error &&
          matches(target.scope!, connectionNow.current)
        )
          void sync(target).catch(() => {})
      })
    return target.running
  }
  function kick(target = selected.current) {
    void sync(target).catch(() => {})
  }
  function update(
    change: (previous: ResearchRecord) => ResearchRecord,
    scopeKey?: string,
  ): boolean {
    if (!enabledNow.current) return false
    const target = scopeKey ? sessions.current.get(scopeKey) : selected.current
    if (!target) return false
    const previous = target.record
    const next = normalizeResearch(change(previous))
    const edits: Edit[] = []
    for (const goal of next.goals) {
      const before = previous.goals.find((item) => item.id === goal.id)
      if (!equal(before ? body(before) : undefined, body(goal)))
        edits.push({
          directory: directory(goal),
          before: before ? body(before) : undefined,
          after: body(goal),
        })
    }
    const pending = [...target.pending, ...edits]
    try {
      saveSession({ ...target, record: next, pending })
      target.record = next
      target.current.current = next
      target.pending = pending
      notify(target)
      if (target.scope && edits.length) kick(target)
      else if (target.scope && previous.goalId !== next.goalId) kick(target)
      return true
    } catch (cause) {
      error.current(errorText(cause))
      return false
    }
  }
  async function flush(scopeKey?: string) {
    const target = scopeKey ? sessions.current.get(scopeKey) : selected.current
    if (!target) throw new Error('The Research environment is not available in this window.')
    do {
      await sync(target)
    } while (target.pending.length)
  }
  async function prepareConversation(
    selection: ResearchTarget,
    scopeKey = selected.current.key,
    operation?: ResearchOperation,
  ): Promise<string> {
    const target = sessions.current.get(scopeKey)
    if (!target?.scope)
      throw new Error('Choose this Research machine before preparing its conversation.')
    const generation = target.generation
    const guard = () => {
      if (!enabledNow.current || generation !== target.generation)
        throw new Error('Research is disabled. Its files remain saved.')
      if (!target.scope || !matches(target.scope, connectionNow.current))
        throw new Error('Reconnect this Research machine before preparing its conversation.')
    }
    guard()
    await flush(scopeKey)
    guard()
    const goal = target.record.goals.find((item) => item.id === selection.goal.id)
    const problem = selection.problem
      ? goal?.problems.find((item) => item.id === selection.problem!.id)
      : undefined
    if (!goal || (selection.problem && !problem))
      throw new Error('The Research goal or problem changed before its conversation was prepared.')
    const result = await call<{ directory: string }>(
      target.scope,
      {
        op: 'context',
        directory: directory(goal),
        ...(problem
          ? { problemId: problem.id, problemDirectory: researchStorageName({ id: problem.id }) }
          : {}),
        instructions: researchConversationInstructions,
        previousInstructions: [
          legacyResearchConversationInstructions,
          legacyResearchInstructions,
          researchInstructions,
        ],
        invocationId: crypto.randomUUID(),
        operation:
          researchOperationCatalog.find(
            (row) => row.id === (operation || goal.method?.activeOperation),
          ) || researchOperationCatalog[0],
      },
      guard,
    )
    const key = JSON.stringify([goal.id, directory(goal), problem?.id || null])
    target.prepared.set(key, result.directory)
    notify(target)
    return result.directory
  }
  function resolveConflict(choice: 'local' | 'remote') {
    if (!enabledNow.current) return
    const target = selected.current
    try {
      localStorage.setItem(
        cachePrefix + target.key + ':conflict-copy',
        JSON.stringify({ scope: target.scope, record: target.record, pending: target.pending }),
      )
      target.pending =
        choice === 'remote' ? [] : target.pending.map((edit) => ({ ...edit, force: true }))
      target.error = undefined
      target.conflict = false
      saveSession(target)
      notify(target)
      kick(target)
    } catch (cause) {
      error.current(errorText(cause))
    }
  }
  useEffect(() => {
    if (!enabled || !visible || !session.scope || !matches(session.scope, connection)) return
    let disposed = false
    let timer: number | undefined
    const poll = async () => {
      if (disposed) return
      if (!document.hidden) {
        try {
          await sync(session)
        } catch {
          /* The sidebar exposes the error and retry. */
        }
      }
      if (!disposed) timer = window.setTimeout(poll, 4000)
    }
    void poll()
    const focus = () => kick(session)
    window.addEventListener('focus', focus)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('focus', focus)
    }
  }, [session, enabled, visible, connection.status, connection.profile?.id, connection.home])
  useEffect(() => {
    if (!enabled || !api) return
    return api.onAgent((event) => {
      if (event.type !== 'complete' && event.type !== 'error') return
      for (const target of sessions.current.values()) {
        if (
          target.record.goals.some(
            (goal) =>
              goal.threadId === event.sessionId ||
              goal.problems.some((problem) => problem.threadId === event.sessionId),
          )
        )
          kick(target)
      }
    })
  }, [enabled])
  useEffect(() => {
    if (!enabled || !visible || !session.scope || !matches(session.scope, connection)) return
    const goal = session.record.goals.find((item) => item.id === session.record.goalId)
    const problem = goal?.problems.find((item) => item.id === session.record.problemId)
    if (!goal) return
    const key = JSON.stringify([goal.id, directory(goal), problem?.id || null])
    if (session.prepared.has(key)) return
    let disposed = false
    void prepareConversation({ goal, problem }, session.key).catch((cause) => {
      if (!disposed && enabledNow.current) error.current(errorText(cause))
    })
    return () => {
      disposed = true
    }
  }, [
    enabled,
    visible,
    session,
    session.record.goalId,
    session.record.problemId,
    connection.status,
    connection.profile?.id,
    connection.home,
  ])
  useEffect(() => {
    if (connection.status === 'connected') return
    for (const target of sessions.current.values()) target.prepared.clear()
  }, [connection.status])
  useEffect(() => {
    if (enabled) return
    for (const target of sessions.current.values()) {
      target.generation++
      target.status = 'offline'
    }
  }, [enabled])
  useEffect(() => {
    mounted.current = true
    const persist = () => remember(selected.current)
    window.addEventListener('beforeunload', persist)
    return () => {
      mounted.current = false
      window.removeEventListener('beforeunload', persist)
    }
  }, [])
  const goal = session.record.goals.find((item) => item.id === session.record.goalId)
  const problem = goal?.problems.find((item) => item.id === session.record.problemId)
  const online = Boolean(session.scope && matches(session.scope, connection))
  const linkedThreadIds = new Set(legacyThreadIds.current)
  for (const target of sessions.current.values()) {
    for (const goal of target.record.goals) {
      if (goal.threadId) linkedThreadIds.add(goal.threadId)
      for (const problem of goal.problems)
        if (problem.threadId) linkedThreadIds.add(problem.threadId)
    }
  }
  function contextForThread(threadId: string | undefined) {
    if (!threadId) return
    for (const target of sessions.current.values()) {
      if (!target.scope) continue
      for (const goal of target.record.goals) {
        if (goal.threadId === threadId) return { target: { goal }, scope: target.scope }
        const problem = goal.problems.find((item) => item.threadId === threadId)
        if (problem) return { target: { goal, problem }, scope: target.scope }
      }
    }
  }
  return {
    record: session.record,
    current: session.current,
    update,
    scope: session.scope,
    scopeKey: session.key,
    storageStatus: online ? session.status : 'offline',
    storageError: session.error,
    storageConflict: session.conflict,
    storageNotice: session.notice,
    linkedThreadIds,
    contextForThread,
    map: goal ? session.maps.get(directory(goal))?.value : undefined,
    useWorkspace,
    flush,
    prepareConversation,
    prepareForThread: async (threadId: string, operation?: ResearchOperation) => {
      const context = contextForThread(threadId)
      if (!context) throw new Error('The Research conversation is not linked to a saved goal.')
      return prepareConversation(context.target, context.scope.key, operation)
    },
    conversationDirectory:
      enabled && online && goal
        ? session.prepared.get(JSON.stringify([goal.id, directory(goal), problem?.id || null]))
        : undefined,
    flushForThread: async (threadId: string) => {
      const context = contextForThread(threadId)
      if (!context) throw new Error('The Research conversation is not linked to a saved goal.')
      await flush(context.scope.key)
    },
    resolveConflict,
    refresh: () => {
      if (!enabledNow.current) return
      if (goal) session.maps.delete(directory(goal))
      kick(session)
    },
    exportLocal: () =>
      JSON.stringify(
        {
          app: 'Life',
          format: 'research-local-edits',
          version: 1,
          scope: session.scope,
          record: session.record,
          pending: session.pending,
          legacyMigration: stored(cachePrefix + session.key + ':migration-copy'),
        },
        null,
        2,
      ),
  }
}
