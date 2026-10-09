import { useMemo } from 'react'
import { Folder } from 'lucide-react'
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
import './sidebar-project-threads.css'
export type { SidebarThreadSort, SidebarThreadGroup } from '../sidebar-ordering'

interface ThreadGroup {
  id: string
  name: string
  description: string
  threads: Thread[]
  rank?: number
}

export function SidebarProjectThreads({
  threads,
  profiles,
  sort = 'recent',
  group = 'project',
  activeId,
  onSelect,
  onArrange,
}: {
  threads: Thread[]
  profiles: ConnectionProfile[]
  sort?: SidebarThreadSort
  group?: SidebarThreadGroup
  activeId?: string
  onSelect: (thread: Thread) => void
  onArrange?: (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => void
}) {
  const groups = useMemo(() => {
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
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
  }, [threads, profiles, sort, group])

  return (
    <>
      {groups.map((section) => (
        <section
          key={section.id}
          className="sidebar-project-thread-group"
          aria-label={
            section.description ? `${section.name}: ${section.description}` : section.name
          }
        >
          {group !== 'none' ? (
            <>
              <div className="sidebar-project-thread-heading">
                <Folder size={15} aria-hidden="true" />
                <h3 title={section.description || section.name}>{section.name}</h3>
                <span
                  className="sidebar-project-thread-count"
                  title={`${section.threads.length} threads`}
                >
                  {section.threads.length}
                </span>
              </div>
              {section.description ? (
                <p className="sidebar-project-thread-description" title={section.description}>
                  {section.description}
                </p>
              ) : null}
            </>
          ) : null}
          <div className="sidebar-project-thread-list">
            {section.threads.map((thread) => (
              <SidebarThread
                key={thread.id}
                thread={thread}
                projectName={threadProjectName(thread)}
                host={profiles.find((profile) => profile.id === thread.profileId)?.host}
                active={activeId === thread.id}
                onSelect={() => onSelect(thread)}
                onArrange={onArrange}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
