import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import type { ConnectionProfile } from '../../shared/types'
import type { Thread } from '../state'
import {
  compareSidebarThreads,
  threadProjectKey,
  threadProjectName,
  threadStatus,
  type SidebarThreadSort,
  type SidebarThreadGroup,
} from '../sidebar-ordering'
import { SidebarThread } from './SidebarThread'
import { useSidebarDay } from '../sidebar-clock'
import type { ThreadAction } from '../thread-management'
import type { ThreadActionHandler } from './ThreadActionsMenu'
import './sidebar-project-threads.css'
export type { SidebarThreadSort, SidebarThreadGroup } from '../sidebar-ordering'

interface ThreadGroup {
  id: string
  name: string
  description: string
  threads: Thread[]
  rank?: number
}
const collapsedStorageKey = 'life.sidebar.collapsed-projects.v1'
function readCollapsedGroups(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(collapsedStorageKey) || '[]')
    return new Set(
      Array.isArray(value)
        ? value.filter((key): key is string => typeof key === 'string').slice(0, 1000)
        : [],
    )
  } catch {
    return new Set()
  }
}

export function SidebarProjectThreads({
  threads,
  profiles,
  sort = 'manual',
  group = 'project',
  activeId,
  onSelect,
  onArrange,
  onAction,
  compact = false,
  draftThreadIds,
}: {
  threads: Thread[]
  profiles: ConnectionProfile[]
  sort?: SidebarThreadSort
  group?: SidebarThreadGroup
  activeId?: string
  onSelect: (thread: Thread) => void
  onArrange?: (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => void
  onAction?: ThreadActionHandler
  compact?: boolean
  draftThreadIds?: ReadonlySet<string>
}) {
  const callbacks = useRef({ onSelect, onArrange, onAction })
  useLayoutEffect(() => {
    callbacks.current = { onSelect, onArrange, onAction }
  }, [onSelect, onArrange, onAction])
  const select = useCallback((thread: Thread) => callbacks.current.onSelect(thread), [])
  const arrange = useCallback(
    (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) =>
      callbacks.current.onArrange?.(thread, patch),
    [],
  )
  const action = useCallback(
    (thread: Thread, action: ThreadAction, value?: number | string) =>
      callbacks.current.onAction?.(thread, action, value),
    [],
  )
  const [collapsed, setCollapsed] = useState(readCollapsedGroups)
  const groupId = useId()
  useEffect(() => {
    try {
      localStorage.setItem(collapsedStorageKey, JSON.stringify([...collapsed].slice(-1000)))
    } catch {
      /* Group visibility remains usable when storage is unavailable. */
    }
  }, [collapsed])
  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  )
  const day = useSidebarDay(group === 'date')
  const groups = useMemo(() => {
    const result = new Map<string, ThreadGroup>()
    const sorted = [...threads].sort((a, b) => compareSidebarThreads(a, b, sort))
    const today = new Date()
    const calendarDay = (date: Date) =>
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
    for (const thread of sorted) {
      const profile = profilesById.get(thread.profileId)
      let id = threadProjectKey(thread)
      let name = threadProjectName(thread)
      let description = [profile?.name, thread.workspace].filter(Boolean).join(' · ')
      let rank: number | undefined
      if (group === 'machine') {
        id = thread.profileId
        name = profile?.name || (thread.profileId === 'life-local' ? 'Life' : 'Previous machine')
        description = profile?.host || ''
      } else if (group === 'provider') {
        id = thread.provider
        name = thread.provider === 'codex' ? 'Codex' : 'Claude Code'
        description = ''
      } else if (group === 'status') {
        id = threadStatus(thread)
        name = id === 'waiting' ? 'Waiting for input' : id === 'running' ? 'Running' : 'Idle'
        rank = id === 'waiting' ? 0 : id === 'running' ? 1 : 2
        description = ''
      } else if (group === 'scope') {
        id = thread.lifeScope ? 'life' : 'project'
        name = thread.lifeScope ? 'Life changes' : 'Project threads'
        description = ''
      } else if (group === 'date') {
        const age = thread.updatedAt
          ? calendarDay(today) - calendarDay(new Date(thread.updatedAt))
          : Infinity
        rank = age <= 0 ? 0 : age === 1 ? 1 : age < 7 ? 2 : 3
        id = String(rank)
        name = ['Today', 'Yesterday', 'Last 7 days', 'Earlier'][rank]
        description = ''
      } else if (group === 'none') {
        id = 'all'
        name = 'All threads'
        description = ''
      }
      let section = result.get(id)
      if (!section) {
        section = { id, name, description, threads: [], rank }
        result.set(id, section)
      }
      section.threads.push(thread)
    }
    const sections = [...result.values()]
    if (group === 'date' || group === 'status')
      sections.sort((a, b) => (a.rank || 0) - (b.rank || 0))
    else if (sort === 'title' || sort === 'project')
      sections.sort(
        (a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description),
      )
    return sections
  }, [threads, profilesById, sort, group, day])

  return (
    <>
      {groups.map((section, index) => {
        const key = `${group}:${section.id}`
        const closed = group !== 'none' && collapsed.has(key)
        const visible = closed
          ? section.threads.filter((thread) => thread.id === activeId || thread.pending.length > 0)
          : section.threads
        return (
          <section
            key={section.id}
            className="sidebar-project-thread-group"
            aria-label={
              section.description ? `${section.name}: ${section.description}` : section.name
            }
          >
            {group !== 'none' ? (
              <>
                <button
                  type="button"
                  className="sidebar-project-thread-heading"
                  aria-expanded={!closed}
                  aria-controls={`${groupId}-${index}`}
                  aria-label={`${closed ? 'Expand' : 'Collapse'} ${section.name} threads`}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                >
                  <ChevronRight
                    size={12}
                    className="sidebar-project-thread-chevron"
                    aria-hidden="true"
                  />
                  <Folder size={15} aria-hidden="true" />
                  <span
                    className="sidebar-project-thread-name"
                    title={section.description || section.name}
                  >
                    {section.name}
                  </span>
                  <span
                    className="sidebar-project-thread-count"
                    title={`${section.threads.length} threads`}
                  >
                    {section.threads.length}
                  </span>
                </button>
                {section.description && !closed ? (
                  <p className="sidebar-project-thread-description" title={section.description}>
                    {section.description}
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="sidebar-project-thread-list" id={`${groupId}-${index}`}>
              {visible.map((thread) => (
                <SidebarThread
                  key={thread.id}
                  thread={thread}
                  projectName={threadProjectName(thread)}
                  host={profilesById.get(thread.profileId)?.host}
                  active={activeId === thread.id}
                  onSelect={select}
                  onArrange={onArrange ? arrange : undefined}
                  onAction={onAction ? action : undefined}
                  compact={compact}
                  hasDraft={draftThreadIds?.has(thread.id)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}
