import type { Provider } from '../shared/types'
import type { Thread } from './state'

export type SidebarThreadSort =
  'recent' | 'oldest' | 'title' | 'project' | 'provider' | 'activity' | 'messages'
export type SidebarThreadGroup =
  'project' | 'machine' | 'provider' | 'status' | 'date' | 'scope' | 'none'
export interface SidebarArrangement {
  provider: 'all' | Provider
  status: 'all' | 'running' | 'waiting' | 'idle'
  sort: SidebarThreadSort
  group: SidebarThreadGroup
}
export const arrangementStorageKey = 'life.sidebar.arrangement.v1'
export function readSidebarArrangement(): SidebarArrangement {
  const defaults: SidebarArrangement = {
    provider: 'all',
    status: 'all',
    sort: 'recent',
    group: 'project',
  }
  try {
    const value = JSON.parse(localStorage.getItem(arrangementStorageKey) || 'null')
    if (!value || typeof value !== 'object') return defaults
    return {
      provider: ['all', 'codex', 'claude'].includes(value.provider)
        ? value.provider
        : defaults.provider,
      status: ['all', 'running', 'waiting', 'idle'].includes(value.status)
        ? value.status
        : defaults.status,
      sort: ['recent', 'oldest', 'title', 'project', 'provider', 'activity', 'messages'].includes(
        value.sort,
      )
        ? value.sort
        : defaults.sort,
      group: ['project', 'machine', 'provider', 'status', 'date', 'scope', 'none'].includes(
        value.group,
      )
        ? value.group
        : defaults.group,
    }
  } catch {
    return defaults
  }
}
export function threadProjectKey(thread: Thread): string {
  return JSON.stringify([thread.profileId, thread.workspace || null])
}
export function threadProjectName(thread: Thread): string {
  return thread.workspace
    ? thread.workspace.split('/').filter(Boolean).pop() || '/'
    : thread.profileId === 'life-local'
      ? 'Life'
      : 'Unassigned project'
}
export function threadStatus(thread: Thread): 'waiting' | 'running' | 'idle' {
  return thread.pending.length ? 'waiting' : thread.busy ? 'running' : 'idle'
}
export function compareSidebarThreads(a: Thread, b: Thread, sort: SidebarThreadSort): number {
  let result = 0
  if (sort === 'oldest') result = a.updatedAt - b.updatedAt
  else if (sort === 'title') result = a.title.localeCompare(b.title)
  else if (sort === 'project')
    result =
      threadProjectName(a).localeCompare(threadProjectName(b)) ||
      threadProjectKey(a).localeCompare(threadProjectKey(b))
  else if (sort === 'provider') result = a.provider.localeCompare(b.provider)
  else if (sort === 'activity') {
    const rank = { waiting: 0, running: 1, idle: 2 }
    result = rank[threadStatus(a)] - rank[threadStatus(b)]
  } else if (sort === 'messages')
    result =
      b.messages.filter((message) => message.role === 'user').length -
      a.messages.filter((message) => message.role === 'user').length
  return result || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}
