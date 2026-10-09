import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile, ConnectionState } from '../shared/types'
import type { Thread } from './state'
import {
  analyzeResearchMethod,
  applyResearchMethodAction,
  createResearchMethod,
  normalizeResearchMethod,
  validateResearchMethod,
  type ResearchMethod,
  type ResearchMethodAction,
} from '../shared/research-method'
import { useResearchFiles } from './research-files'
import { researchDirectory, researchStorageName, type ResearchScope } from './research-storage'
import { collectLegacyResearch, researchLinkedThreadIds } from './research-legacy'

export { makeResearchScope, researchDirectory, researchScopeMatches } from './research-storage'
export { researchLinkedThreadIds } from './research-legacy'

let legacyDirectoryCache: Set<string> | undefined
export function researchLegacyDirectories(
  threads: Thread[],
  linkedIds = researchLinkedThreadIds(),
): Set<string> {
  legacyDirectoryCache ||= new Set(
    collectLegacyResearch().workspaces.map(
      (workspace) => workspace.replace(/\/+$/, '') + '/.research',
    ),
  )
  const roots = new Set(legacyDirectoryCache)
  for (const thread of threads) {
    if (thread.purpose !== 'research' && !linkedIds.has(thread.id)) continue
    const match = thread.workspace?.match(/^(.*?\/\.research)(?:\/|$)/)
    if (match) roots.add(match[1])
  }
  return roots
}

export interface WorkspaceProject {
  key: string
  profileId: string
  workspace: string
  title: string
  host: string
}
export function workspaceProject(
  profileId: string,
  workspace: string,
  host = '',
): WorkspaceProject {
  return {
    key: JSON.stringify([profileId, workspace]),
    profileId,
    workspace,
    host,
    title: workspace.split(/[\\/]/).filter(Boolean).pop() || workspace,
  }
}
export function workspaceCatalog(
  profiles: ConnectionProfile[],
  threads: Thread[],
  connection: ConnectionState,
  researchDirectories: ReadonlySet<string> = new Set(),
): WorkspaceProject[] {
  const projects = new Map<string, WorkspaceProject>()
  const add = (profileId: string, workspace?: string) => {
    if (
      !workspace ||
      profileId === 'life-local' ||
      researchDirectories.has(workspace.replace(/\/+$/, '') || '/')
    )
      return
    const profile = profiles.find((item) => item.id === profileId)
    const project = workspaceProject(profileId, workspace, profile?.name || profile?.host || '')
    projects.set(project.key, project)
  }
  profiles.forEach((profile) => add(profile.id, profile.workspace))
  threads
    .filter((thread) => !thread.purpose)
    .forEach((thread) => add(thread.profileId, thread.workspace))
  if (connection.profile) add(connection.profile.id, connection.workspace)
  return [...projects.values()].sort(
    (a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key),
  )
}
const mapKey = 'life.map.projects.v1'
const researchKey = 'life.research.workbench.v1'
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const string = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : ''
function read<T>(key: string, fallback: T, normalize: (value: unknown) => T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? normalize(JSON.parse(stored)) : fallback
  } catch {
    return fallback
  }
}
function useRecord<T>(
  key: string,
  fallback: T,
  normalize: (value: unknown) => T,
  onError: (text: string) => void,
  enabled = true,
) {
  const [record, setRecord] = useState<T>(() => read(key, fallback, normalize))
  const current = useRef(record)
  const error = useRef(onError)
  error.current = onError
  current.current = record
  function update(change: (previous: T) => T): boolean {
    if (!enabled) return false
    const next = change(current.current)
    try {
      const encoded = JSON.stringify(next)
      if (encoded.length > 4_000_000)
        throw new Error('This workspace has reached its local storage limit.')
      localStorage.setItem(key, encoded)
      current.current = next
      setRecord(next)
      return true
    } catch (cause) {
      error.current(cause instanceof Error ? cause.message : 'Could not save this workspace.')
      return false
    }
  }
  useEffect(() => {
    if (!enabled) return
    const changed = (event: StorageEvent) => {
      if (event.key !== key) return
      const next = read(key, fallback, normalize)
      current.current = next
      setRecord(next)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [key, enabled])
  return { record, current, update }
}
function normalizeProjects(value: unknown): WorkspaceProject[] {
  if (!Array.isArray(value)) return []
  const projects = new Map<string, WorkspaceProject>()
  value.slice(0, 300).forEach((entry) => {
    const row = object(entry)
    const profileId = string(row.profileId, 240)
    const workspace = string(row.workspace, 4000)
    if (profileId && workspace) {
      const project = workspaceProject(profileId, workspace, string(row.host, 240))
      projects.set(project.key, project)
    }
  })
  return [...projects.values()]
}
export function useLifeMap(onError: (text: string) => void, enabled = true) {
  const data = useRecord(mapKey, [] as WorkspaceProject[], normalizeProjects, onError, enabled)
  return {
    projects: data.record,
    connect: (project: WorkspaceProject) =>
      data.update((previous) =>
        previous.some((item) => item.key === project.key) ? previous : [...previous, project],
      ),
    detach: (key: string) => data.update((previous) => previous.filter((item) => item.key !== key)),
  }
}
export type ProblemStatus = 'open' | 'blocked' | 'solved'
export interface ResearchProblem {
  id: string
  title: string
  description: string
  notes: string
  status: ProblemStatus
  threadId?: string
  requirementIds?: string[]
  updatedAt: number
}
export interface ResearchGoal {
  /** Direct child directory of the machine's .life/research folder. */
  directory?: string
  /** Goal conversations are saved independently of any agent execution folder. */
  threadId?: string
  id: string
  title: string
  goal: string
  problems: ResearchProblem[]
  method?: ResearchMethod
  createdAt: number
  updatedAt: number
}
export interface ResearchRecord {
  goals: ResearchGoal[]
  goalId?: string
  problemId?: string
}
export interface ResearchTarget {
  goal: ResearchGoal
  problem?: ResearchProblem
}
export interface ResearchEditor {
  kind: 'goal' | 'problem'
  goalId?: string
  id?: string
}
const emptyResearch: ResearchRecord = { goals: [] }
export function normalizeResearch(value: unknown): ResearchRecord {
  const record = object(value)
  const ids = new Set<string>()
  const goals = (Array.isArray(record.goals) ? record.goals : []).slice(0, 100).flatMap((entry) => {
    const row = object(entry)
    const id = string(row.id, 240)
    const title = string(row.title, 160)
    if (!id || !title || ids.has(id)) return []
    ids.add(id)
    const problemIds = new Set<string>()
    const problems: ResearchProblem[] = (Array.isArray(row.problems) ? row.problems : [])
      .slice(0, 200)
      .flatMap((entry) => {
        const item = object(entry)
        const problemId = string(item.id, 240)
        const title = string(item.title, 160)
        if (!problemId || !title || problemIds.has(problemId)) return []
        problemIds.add(problemId)
        return [
          {
            ...item,
            id: problemId,
            title,
            description: string(item.description, 2000),
            notes: string(item.notes, 8000),
            requirementIds: Array.isArray(item.requirementIds)
              ? [
                  ...new Set(
                    item.requirementIds
                      .filter((id): id is string => typeof id === 'string')
                      .slice(0, 300),
                  ),
                ]
              : undefined,
            status: item.status === 'blocked' || item.status === 'solved' ? item.status : 'open',
            threadId: string(item.threadId, 240) || undefined,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
          },
        ]
      })
    return [
      {
        ...row,
        directory: researchStorageName({ id, directory: string(row.directory, 240) || undefined }),
        id,
        title,
        goal: string(row.goal, 2000),
        problems,
        method: normalizeResearchMethod(row.method),
        threadId: string(row.threadId, 240) || undefined,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
      },
    ]
  })
  const goalId = goals.some((goal) => goal.id === record.goalId)
    ? String(record.goalId)
    : goals[0]?.id
  const goal = goals.find((goal) => goal.id === goalId)
  const problemId = goal?.problems.some((problem) => problem.id === record.problemId)
    ? String(record.problemId)
    : undefined
  return { goals, goalId, problemId }
}
export function useResearchWorkbench(
  onError: (text: string) => void,
  connection: ConnectionState = { status: 'disconnected' },
  enabled = true,
  visible = enabled,
) {
  const data = useResearchFiles(connection, enabled, onError, visible)
  const [editor, setEditor] = useState<ResearchEditor>()
  const goal = data.record.goals.find((item) => item.id === data.record.goalId)
  const problem = goal?.problems.find((item) => item.id === data.record.problemId)
  const methodAnalysis = useMemo(
    () =>
      goal
        ? analyzeResearchMethod(goal.method || createResearchMethod(), goal.problems)
        : undefined,
    [goal?.method, goal?.problems],
  )
  function selection(): ResearchTarget | undefined {
    const goal = data.current.current.goals.find((item) => item.id === data.current.current.goalId)
    const problem = goal?.problems.find((item) => item.id === data.current.current.problemId)
    return goal ? { goal, problem } : undefined
  }
  function patchProblem(
    goalId: string,
    problemId: string,
    patch: Partial<Pick<ResearchProblem, 'status' | 'notes' | 'threadId' | 'requirementIds'>>,
  ) {
    return data.update((previous) => ({
      ...previous,
      goals: previous.goals.map((goal) =>
        goal.id === goalId
          ? {
              ...goal,
              updatedAt: Date.now(),
              problems: goal.problems.map((problem) =>
                problem.id === problemId
                  ? { ...problem, ...patch, updatedAt: Date.now() }
                  : problem,
              ),
            }
          : goal,
      ),
    }))
  }
  function updateMethod(change: (method: ResearchMethod) => ResearchMethod): boolean {
    const current = selection()
    if (!current) return false
    try {
      const next = change(current.goal.method || createResearchMethod())
      const errors = validateResearchMethod(next)
      if (errors.length) throw new Error(errors[0])
      const normalized = normalizeResearchMethod(next)
      const requirementIds = new Set(normalized.requirements.map((row) => row.id))
      return data.update((previous) => ({
        ...previous,
        goals: previous.goals.map((goal) =>
          goal.id === current.goal.id
            ? {
                ...goal,
                method: normalized,
                problems: goal.problems.map((problem) => ({
                  ...problem,
                  requirementIds: problem.requirementIds?.filter((id) => requirementIds.has(id)),
                })),
                updatedAt: Date.now(),
              }
            : goal,
        ),
      }))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not update this research method.')
      return false
    }
  }
  function methodAction(action: ResearchMethodAction): boolean {
    return updateMethod((method) => applyResearchMethodAction(method, action))
  }
  function saveEditor(title: string, detail: string): boolean {
    if (!editor || !title.trim() || !detail.trim()) return false
    const now = Date.now()
    if (editor.kind === 'goal') {
      if (!editor.id && data.current.current.goals.length >= 100) {
        onError('The research workspace can hold up to 100 goals.')
        return false
      }
      const id = editor.id || crypto.randomUUID()
      const saved = data.update((previous) => ({
        ...previous,
        goalId: id,
        problemId: editor.id === previous.goalId ? previous.problemId : undefined,
        goals: editor.id
          ? previous.goals.map((goal) =>
              goal.id === id
                ? {
                    ...goal,
                    title: title.trim().slice(0, 160),
                    goal: detail.trim().slice(0, 2000),
                    updatedAt: now,
                  }
                : goal,
            )
          : [
              ...previous.goals,
              {
                id,
                title: title.trim().slice(0, 160),
                goal: detail.trim().slice(0, 2000),
                problems: [],
                method: createResearchMethod(),
                createdAt: now,
                updatedAt: now,
              },
            ],
      }))
      if (saved) setEditor(undefined)
      return saved
    }
    const currentGoal = data.current.current.goals.find((goal) => goal.id === editor.goalId)
    if (!currentGoal) return false
    if (!editor.id && currentGoal.problems.length >= 200) {
      onError('This goal can hold up to 200 problems.')
      return false
    }
    const id = editor.id || crypto.randomUUID()
    const saved = data.update((previous) => ({
      ...previous,
      goalId: currentGoal.id,
      problemId: id,
      goals: previous.goals.map((goal) =>
        goal.id === currentGoal.id
          ? {
              ...goal,
              updatedAt: now,
              problems: editor.id
                ? goal.problems.map((problem) =>
                    problem.id === id
                      ? {
                          ...problem,
                          title: title.trim().slice(0, 160),
                          description: detail.trim().slice(0, 2000),
                          updatedAt: now,
                        }
                      : problem,
                  )
                : [
                    ...goal.problems,
                    {
                      id,
                      title: title.trim().slice(0, 160),
                      description: detail.trim().slice(0, 2000),
                      notes: '',
                      status: 'open',
                      updatedAt: now,
                    },
                  ],
            }
          : goal,
      ),
    }))
    if (saved) setEditor(undefined)
    return saved
  }
  return {
    scope: data.scope,
    scopeKey: data.scopeKey,
    storageStatus: data.storageStatus,
    storageError: data.storageError,
    storageConflict: data.storageConflict,
    storageNotice: data.storageNotice,
    linkedThreadIds: data.linkedThreadIds,
    contextForThread: data.contextForThread,
    map: data.map,
    useWorkspace: data.useWorkspace,
    flush: data.flush,
    flushForThread: data.flushForThread,
    prepareForThread: data.prepareForThread,
    prepareConversation: data.prepareConversation,
    conversationDirectory: data.conversationDirectory,
    refresh: data.refresh,
    resolveConflict: data.resolveConflict,
    exportLocal: data.exportLocal,
    goals: data.record.goals,
    method: goal?.method,
    methodAnalysis,
    updateMethod,
    methodAction,
    goal,
    problem,
    editor,
    closeEditor: () => setEditor(undefined),
    newGoal: () => setEditor({ kind: 'goal' }),
    editGoal: () => {
      if (goal) setEditor({ kind: 'goal', id: goal.id })
    },
    newProblem: () => {
      if (goal) setEditor({ kind: 'problem', goalId: goal.id })
      else setEditor({ kind: 'goal' })
    },
    editProblem: () => {
      if (goal && problem) setEditor({ kind: 'problem', goalId: goal.id, id: problem.id })
    },
    selectGoal: (id: string) =>
      data.update((previous) => ({ ...previous, goalId: id, problemId: undefined })),
    selectProblem: (id: string) => data.update((previous) => ({ ...previous, problemId: id })),
    overview: () => data.update((previous) => ({ ...previous, problemId: undefined })),
    saveEditor,
    selection,
    patchProblem,
    linkThread: (goalId: string, problemId: string | undefined, threadId: string) =>
      problemId
        ? patchProblem(goalId, problemId, { threadId })
        : data.update((previous) => ({
            ...previous,
            goals: previous.goals.map((goal) =>
              goal.id === goalId ? { ...goal, threadId, updatedAt: Date.now() } : goal,
            ),
          })),
    unlinkThread: (threadId: string) =>
      data.update((previous) => ({
        ...previous,
        goals: previous.goals.map((goal) => ({
          ...goal,
          threadId: goal.threadId === threadId ? undefined : goal.threadId,
          problems: goal.problems.map((problem) =>
            problem.threadId === threadId ? { ...problem, threadId: undefined } : problem,
          ),
        })),
      })),
    forThread: (threadId?: string): ResearchTarget | undefined =>
      data.contextForThread(threadId)?.target,
  }
}
export type ResearchWorkbenchState = ReturnType<typeof useResearchWorkbench>
/** Research context belongs to files and the execution environment; the user prompt is untouched. */
export function researchPrompt(
  _target: ResearchTarget,
  request: string,
  _workspace?: string,
): string {
  return request
}

export function researchGoalDirectory(target: ResearchTarget, scope: ResearchScope): string {
  return researchDirectory(scope.workspace) + '/' + researchStorageName(target.goal)
}

export function researchConversationDirectory(
  target: ResearchTarget,
  scope: ResearchScope,
): string {
  const goal = researchGoalDirectory(target, scope)
  return target.problem
    ? goal + '/problems/' + researchStorageName({ id: target.problem.id })
    : goal
}

export function researchConversationContext(target: ResearchTarget, scope: ResearchScope) {
  return {
    scopeKey: scope.key,
    goalId: target.goal.id,
    ...(target.problem ? { problemId: target.problem.id } : {}),
  }
}
