import type { ConnectionProfile } from '../shared/types'

export type ResearchStatus = 'active' | 'planned' | 'paused' | 'complete'

export interface ResearchProject {
  id: string
  title: string
  summary: string
  notes: string
  status: ResearchStatus
  tags: string[]
  profileId?: string
  dependencies: string[]
  createdAt: number
  updatedAt: number
}

export interface ResearchGraphOptions {
  direction: 'LR' | 'TB'
  groupBy: 'none' | 'status' | 'machine'
}

export const RESEARCH_STORAGE_KEY = 'life.research.v1'

export const MAX_PROJECTS = 200
const MAX_STORAGE_LENGTH = 4_000_000
const statuses: ResearchStatus[] = ['active', 'planned', 'paused', 'complete']
const statusLabels: Record<ResearchStatus, string> = {
  active: 'Active',
  planned: 'Planned',
  paused: 'Paused',
  complete: 'Complete',
}
const statusClasses: Record<ResearchStatus, string> = {
  active: 'researchActive',
  planned: 'researchPlanned',
  paused: 'researchPaused',
  complete: 'researchComplete',
}

function text(value: unknown, limit: number, multiline = false): string {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(
      multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g,
      '',
    )
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n')
  return Array.from(multiline ? cleaned : cleaned.trim())
    .slice(0, limit)
    .join('')
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) return
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return
  return value.trim()
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function uniqueStrings(value: unknown, limit: number, length: number): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .slice(0, 1_000)
        .map((item) => text(item, length))
        .filter(Boolean),
    ),
  ].slice(0, limit)
}

function normalizeProject(value: unknown, now: number): ResearchProject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const id = identifier(input.id)
  if (!id || typeof input.title !== 'string') return
  const profileId = identifier(input.profileId)
  const createdAt = timestamp(input.createdAt, now)
  return {
    id,
    title: text(input.title, 160) || 'Untitled research',
    summary: text(input.summary, 2_000, true),
    notes: text(input.notes, 8_000, true),
    status: statuses.includes(input.status as ResearchStatus)
      ? (input.status as ResearchStatus)
      : 'planned',
    tags: uniqueStrings(input.tags, 12, 48),
    ...(profileId ? { profileId } : {}),
    dependencies: Array.isArray(input.dependencies)
      ? [
          ...new Set(
            input.dependencies
              .slice(0, 1_000)
              .map(identifier)
              .filter((id): id is string => !!id),
          ),
        ].slice(0, MAX_PROJECTS)
      : [],
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(input.updatedAt, createdAt)),
  }
}

function normalizeProjects(value: unknown): ResearchProject[] {
  if (!Array.isArray(value)) return []
  const now = Date.now()
  const ids = new Set<string>()
  const projects: ResearchProject[] = []
  for (const input of value.slice(0, 1_000)) {
    const project = normalizeProject(input, now)
    if (!project || ids.has(project.id)) continue
    ids.add(project.id)
    projects.push(project)
    if (projects.length >= MAX_PROJECTS) break
  }
  return projects.map((project) => ({
    ...project,
    dependencies: project.dependencies.filter((id) => id !== project.id && ids.has(id)),
  }))
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function createProject(input: Partial<ResearchProject> = {}): ResearchProject {
  const now = Date.now()
  const id =
    identifier(input.id) ||
    globalThis.crypto?.randomUUID?.() ||
    `project-${now.toString(36)}-${Math.random().toString(36).slice(2)}`
  return normalizeProject(
    { ...input, id, title: typeof input.title === 'string' ? input.title : 'Untitled research' },
    now,
  )!
}

/** Infer real workspaces once, while preserving projects and research notes after a machine is removed. */
export function reconcileProjects(
  projects: ResearchProject[],
  profiles: ConnectionProfile[],
): ResearchProject[] {
  const result = normalizeProjects(projects)
  const linkedProfiles = new Set(result.map((project) => project.profileId).filter(Boolean))
  const existingIds = new Set(result.map((project) => project.id))
  for (const profile of profiles) {
    const profileId = identifier(profile.id)
    if (!profileId || linkedProfiles.has(profileId) || result.length >= MAX_PROJECTS) continue
    const id = `profile:${profileId}`
    if (id.length > 180 || existingIds.has(id)) continue
    const workspace = text(profile.workspace, 1_000)
    const basename = workspace.split(/[\\/]/).filter(Boolean).at(-1)
    result.push(
      createProject({
        id,
        title: text(profile.name, 160) || basename || 'Research workspace',
        summary: workspace ? `Workspace: ${workspace}` : '',
        profileId,
        status: 'active',
      }),
    )
    linkedProfiles.add(profileId)
    existingIds.add(id)
  }
  return result
}

export function readProjects(
  profiles: ConnectionProfile[],
  storage?: Pick<Storage, 'getItem'>,
): ResearchProject[] {
  let projects: ResearchProject[] = []
  try {
    const raw = (storage || defaultStorage())?.getItem(RESEARCH_STORAGE_KEY)
    if (raw && raw.length <= MAX_STORAGE_LENGTH) projects = normalizeProjects(JSON.parse(raw))
  } catch {
    // Corrupt or unavailable browser storage must not hide real saved workspaces.
  }
  return reconcileProjects(projects, profiles)
}

export function saveProjects(
  projects: ResearchProject[],
  storage?: Pick<Storage, 'setItem'>,
): void {
  const target = storage || defaultStorage()
  if (!target) return
  const serialized = JSON.stringify(normalizeProjects(projects))
  if (serialized.length > MAX_STORAGE_LENGTH) {
    throw new Error('Research notes are too large to save. Export or shorten some notes first.')
  }
  target.setItem(RESEARCH_STORAGE_KEY, serialized)
}

/** A full backup retains notes and metadata that a rendered diagram cannot carry. */
export function exportResearchBackup(projects: ResearchProject[]): string {
  return JSON.stringify(
    {
      app: 'Life',
      format: 'research-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: normalizeProjects(projects),
    },
    null,
    2,
  )
}

export function importResearchBackup(
  source: string,
  existing: ResearchProject[],
): { projects: ResearchProject[]; added: number; updated: number; skipped: number } {
  if (source.length > MAX_STORAGE_LENGTH * 2) {
    throw new Error('This backup is too large. Choose a Life research backup with fewer notes.')
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('This file is not valid JSON. Choose a Life research backup.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Choose a Life research backup exported with Backup projects.')
  }
  const backup = value as Record<string, unknown>
  if (backup.app !== 'Life' || backup.format !== 'research-backup') {
    throw new Error('Choose a Life research backup exported with Backup projects.')
  }
  if (backup.version !== 1)
    throw new Error('This research backup version is not supported by Life.')
  if (!Array.isArray(backup.projects) || backup.projects.length > MAX_PROJECTS) {
    throw new Error(`A research backup can contain up to ${MAX_PROJECTS} projects.`)
  }

  const merged = new Map(normalizeProjects(existing).map((project) => [project.id, project]))
  const importedIds = new Set<string>()
  const now = Date.now()
  let added = 0
  let updated = 0
  let skipped = 0
  for (const record of backup.projects) {
    const project = normalizeProject(record, now)
    if (!project || importedIds.has(project.id)) {
      skipped++
      continue
    }
    importedIds.add(project.id)
    const previous = merged.get(project.id)
    if (!previous) {
      merged.set(project.id, project)
      added++
    } else if (project.updatedAt > previous.updatedAt) {
      merged.set(project.id, project)
      updated++
    } else {
      // Re-importing a backup keeps newer local work and never duplicates a project.
      skipped++
    }
  }
  if (merged.size > MAX_PROJECTS) {
    throw new Error(`Import would exceed ${MAX_PROJECTS} projects. Remove some projects first.`)
  }
  if (backup.projects.length > 0 && importedIds.size === 0) {
    throw new Error('This backup does not contain any valid research projects.')
  }
  return { projects: normalizeProjects([...merged.values()]), added, updated, skipped }
}

export function updateProject(
  projects: ResearchProject[],
  id: string,
  patch: Partial<ResearchProject>,
): ResearchProject[] {
  const editable = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined || key === 'profileId'),
  )
  return normalizeProjects(
    projects.map((project) =>
      project.id === id
        ? {
            ...project,
            ...editable,
            title: typeof editable.title === 'string' ? editable.title : project.title,
            id: project.id,
            createdAt: project.createdAt,
            updatedAt: Date.now(),
          }
        : project,
    ),
  )
}

export function deleteProject(projects: ResearchProject[], id: string): ResearchProject[] {
  return normalizeProjects(projects.filter((project) => project.id !== id))
}

/** Mermaid decodes numeric entities in quoted labels; user text never becomes graph syntax. */
function graphLabel(value: string): string {
  const label = Array.from(text(value, 160).replace(/\s+/g, ' '))
  const shortened = label.length > 84 ? `${label.slice(0, 83).join('')}…` : label.join('')
  return shortened.replace(
    /["'&<>#\[\]{}()|:;`\\/]/g,
    (character) => `#${character.codePointAt(0)};`,
  )
}

function compareIds(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function buildResearchGraph(
  projects: ResearchProject[],
  options: ResearchGraphOptions,
  profiles: ConnectionProfile[],
): { source: string; nodeIds: Record<string, string> } {
  const sorted = normalizeProjects(projects).sort(compareIds)
  const nodeIds: Record<string, string> = {}
  const nodes = new Map(
    sorted.map((project, index) => {
      const node = `p${index}`
      nodeIds[node] = project.id
      return [project.id, node]
    }),
  )
  const lines = [`flowchart ${options.direction === 'TB' ? 'TB' : 'LR'}`]
  const addNode = (project: ResearchProject, indent = '  ') => {
    lines.push(`${indent}${nodes.get(project.id)}["${graphLabel(project.title)}"]`)
  }

  if (options.groupBy === 'status') {
    for (const [index, status] of statuses.entries()) {
      const group = sorted.filter((project) => project.status === status)
      if (!group.length) continue
      lines.push(`  subgraph status${index}["${statusLabels[status]}"]`)
      for (const project of group) addNode(project, '    ')
      lines.push('  end')
    }
  } else if (options.groupBy === 'machine') {
    const groups = new Map<string, ResearchProject[]>()
    for (const project of sorted) {
      const key = project.profileId || ''
      groups.set(key, [...(groups.get(key) || []), project])
    }
    const keys = [...groups.keys()].sort()
    for (const [index, key] of keys.entries()) {
      const profile = profiles.find((profile) => profile.id === key)
      const label = !key
        ? 'Unassigned'
        : profile
          ? profile.name || profile.host || 'Research workspace'
          : 'Unavailable workspace'
      lines.push(`  subgraph machine${index}["${graphLabel(label)}"]`)
      for (const project of groups.get(key) || []) addNode(project, '    ')
      lines.push('  end')
    }
  } else {
    for (const project of sorted) addNode(project)
  }

  // The arrow points from a prerequisite toward the project that depends on it.
  for (const project of sorted) {
    for (const dependency of [...project.dependencies].sort()) {
      lines.push(`  ${nodes.get(dependency)} --> ${nodes.get(project.id)}`)
    }
    lines.push(`  class ${nodes.get(project.id)} ${statusClasses[project.status]}`)
  }
  return { source: lines.join('\n'), nodeIds }
}
