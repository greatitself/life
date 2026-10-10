import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Search,
  Server,
  SlidersHorizontal,
  SquarePen,
} from 'lucide-react'
import type { ConnectionProfile, ConnectionState, Provider } from '../../shared/types'
import type { Thread } from '../state'
import { Modal } from './Modal'
import {
  SidebarProjectThreads,
  type SidebarThreadSort,
  type SidebarThreadGroup,
} from './SidebarProjectThreads'
import { arrangementStorageKey, readSidebarArrangement } from '../sidebar-ordering'
import './sidebar-navigation.css'

interface SidebarFilters {
  provider: 'all' | Provider
  status: 'all' | 'running' | 'waiting' | 'idle'
  sort: SidebarThreadSort
  group: SidebarThreadGroup
}
const initialFilters: SidebarFilters = {
  provider: 'all',
  status: 'all',
  sort: 'recent',
  group: 'project',
}

export function SidebarProjects({
  threads,
  profiles,
  connection,
  activeId,
  onSelect,
  onNewThread,
  onAddProject,
  onOpenProfile,
  shortcutModifier,
  filtersOpen,
  onFiltersOpenChange,
  children,
  onArrange,
  footerTarget,
}: {
  threads: Thread[]
  profiles: ConnectionProfile[]
  connection: ConnectionState
  activeId?: string
  onSelect: (thread: Thread) => void
  onArrange?: (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => void
  onNewThread: () => void
  onAddProject: () => void
  onOpenProfile: (profileId: string) => void
  shortcutModifier: string
  filtersOpen: boolean
  onFiltersOpenChange: (open: boolean) => void
  children?: ReactNode
  footerTarget?: HTMLElement | null
}) {
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<SidebarFilters>(readSidebarArrangement)
  useEffect(() => {
    try {
      localStorage.setItem(arrangementStorageKey, JSON.stringify(filters))
    } catch {
      /* Arrangement still works when local storage is unavailable. */
    }
  }, [filters])
  const searchValue = search.trim().toLowerCase()
  const query = useDeferredValue(searchValue)
  const filtering = filters.provider !== 'all' || filters.status !== 'all'
  const customized = filtering || filters.sort !== 'recent' || filters.group !== 'project'
  const narrowed = Boolean(searchValue) || filtering
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  )
  const occupiedProfiles = useMemo(
    () => new Set(threads.map((thread) => thread.profileId)),
    [threads],
  )
  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) => {
        if (filters.provider !== 'all' && thread.provider !== filters.provider) return false
        const waiting = thread.pending.length > 0
        if (filters.status === 'waiting' && !waiting) return false
        if (filters.status === 'running' && (!thread.busy || waiting)) return false
        if (filters.status === 'idle' && (thread.busy || waiting)) return false
        if (!query) return true
        const description = `${thread.title} ${thread.workspace || ''} ${profileNames.get(thread.profileId) || ''}`
        return (
          description.toLowerCase().includes(query) ||
          thread.messages.some((message) => message.text.toLowerCase().includes(query))
        )
      }),
    [threads, profileNames, query, filters.provider, filters.status],
  )
  const emptyProfiles = useMemo(() => {
    if (filters.provider !== 'all' || filters.status !== 'all') return []
    const result = profiles.filter(
      (profile) =>
        !occupiedProfiles.has(profile.id) &&
        (!query ||
          `${profile.name} ${profile.host} ${profile.workspace}`.toLowerCase().includes(query)),
    )
    if (filters.sort === 'title') result.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }, [profiles, occupiedProfiles, query, filters.provider, filters.status, filters.sort])
  const clearAll = () => {
    setSearch('')
    setFilters({ ...initialFilters })
  }
  const firstProject = !profiles.length && !threads.length && !narrowed
  const { activeThreads, settledThreads, snoozedThreads } = useMemo(() => {
    const activeThreads: Thread[] = []
    const settledThreads: Thread[] = []
    const snoozedThreads: Thread[] = []
    for (const thread of visibleThreads) {
      if (thread.snoozedUntil) snoozedThreads.push(thread)
      else if (thread.settled) settledThreads.push(thread)
      else activeThreads.push(thread)
    }
    return { activeThreads, settledThreads, snoozedThreads }
  }, [visibleThreads])

  return (
    <>
      <div className="sidebar-navigation-toolbar">
        <div className="sidebar-inline-search" role="search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search projects and threads"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search) {
                event.preventDefault()
                event.stopPropagation()
                setSearch('')
              }
            }}
          />
        </div>
        <div
          className="sidebar-navigation-actions"
          role="group"
          aria-label="Project and thread actions"
        >
          <button
            type="button"
            className="icon-button"
            aria-label="Add project"
            title="Add project"
            onClick={onAddProject}
          >
            <FolderPlus size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="New thread"
            title={`New thread (${shortcutModifier}+N)`}
            onClick={onNewThread}
          >
            <SquarePen size={16} />
          </button>
          <button
            type="button"
            className={`icon-button sidebar-filter-toggle ${customized ? 'selected' : ''}`}
            aria-label={
              customized
                ? 'Filters, sorting and arrangement (customized)'
                : 'Filters, sorting and arrangement'
            }
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            title="Filters and sorting"
            onClick={() => onFiltersOpenChange(true)}
          >
            <SlidersHorizontal size={16} />
            {customized ? <i className="sidebar-filter-dot" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>
      {children}
      {narrowed ? (
        <div className="sidebar-navigation-summary">
          <span role="status" aria-live="polite">
            {visibleThreads.length} of {threads.length} threads
          </span>
          <button type="button" onClick={clearAll}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="project-list" aria-label="Project threads" aria-busy={query !== searchValue}>
        {firstProject ? (
          <button className="empty-project" onClick={onAddProject}>
            <span className="empty-project-icon">
              <FolderPlus size={17} />
            </span>
            <span>
              Add your first project<small>Connect a remote project</small>
            </span>
            <ChevronRight size={14} />
          </button>
        ) : null}
        <SidebarProjectThreads
          threads={activeThreads}
          profiles={profiles}
          sort={filters.sort}
          group={filters.group}
          activeId={activeId}
          onSelect={onSelect}
          onArrange={onArrange}
        />
        {emptyProfiles.map((profile) => (
          <button
            className="project-heading"
            key={profile.id}
            onClick={() => onOpenProfile(profile.id)}
          >
            <Folder size={16} />
            <span>{profile.name}</span>
            {connection.profile?.id === profile.id && connection.status === 'connected' ? (
              <span className="status-dot online" />
            ) : (
              <Server size={12} className="muted" />
            )}
          </button>
        ))}
        {!firstProject && !visibleThreads.length && !emptyProfiles.length ? (
          <div className="sidebar-navigation-empty" role="status">
            <p>No matching projects or threads.</p>
            {narrowed ? (
              <button type="button" onClick={clearAll}>
                Clear search and filters
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {footerTarget
        ? createPortal(
            <div
              className="sidebar-arrangement-footer"
              role="region"
              aria-label="Settled and snoozed threads"
              aria-busy={query !== searchValue}
            >
              <details className="life-thread-arrangement-section" open={query ? true : undefined}>
                <summary>
                  <span>Settled ({settledThreads.length})</span>
                  <i />
                  <ChevronRight size={13} />
                </summary>
                <SidebarProjectThreads
                  threads={settledThreads}
                  profiles={profiles}
                  sort={filters.sort}
                  group="none"
                  activeId={activeId}
                  onSelect={onSelect}
                  onArrange={onArrange}
                />
                {!settledThreads.length ? <p>Use Settle to move a thread here.</p> : null}
              </details>
              {snoozedThreads.length ? (
                <details
                  className="life-thread-arrangement-section"
                  open={query ? true : undefined}
                >
                  <summary>
                    <span>Snoozed ({snoozedThreads.length})</span>
                    <i />
                    <ChevronRight size={13} />
                  </summary>
                  <SidebarProjectThreads
                    threads={snoozedThreads}
                    profiles={profiles}
                    sort={filters.sort}
                    group="none"
                    activeId={activeId}
                    onSelect={onSelect}
                    onArrange={onArrange}
                  />
                </details>
              ) : null}
            </div>,
            footerTarget,
          )
        : null}
      <Modal
        open={filtersOpen}
        onOpenChange={onFiltersOpenChange}
        title="Filters, sorting and arrangement"
        description="Choose which threads appear, how they are grouped, and their order. Your arrangement is saved."
        className="sidebar-filters-modal"
      >
        <div className="sidebar-filter-fields">
          <label>
            Agent
            <select
              value={filters.provider}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  provider: event.target.value as SidebarFilters['provider'],
                }))
              }
            >
              <option value="all">All agents</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value as SidebarFilters['status'],
                }))
              }
            >
              <option value="all">All threads</option>
              <option value="running">Running</option>
              <option value="waiting">Waiting for input</option>
              <option value="idle">Idle</option>
            </select>
          </label>
          <label>
            Arrange by
            <select
              value={filters.group}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  group: event.target.value as SidebarThreadGroup,
                }))
              }
            >
              <option value="project">Project</option>
              <option value="machine">Machine</option>
              <option value="provider">Agent</option>
              <option value="status">Status</option>
              <option value="date">Last activity date</option>
              <option value="scope">Life or project</option>
              <option value="none">One list</option>
            </select>
          </label>
          <label>
            Sort by
            <select
              value={filters.sort}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  sort: event.target.value as SidebarThreadSort,
                }))
              }
            >
              <option value="recent">Most recently used</option>
              <option value="oldest">Oldest activity first</option>
              <option value="title">Alphabetical</option>
              <option value="project">Project name</option>
              <option value="provider">Agent</option>
              <option value="activity">Waiting and running first</option>
              <option value="messages">Most conversation turns</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setFilters({ ...initialFilters })}
          >
            Reset
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => onFiltersOpenChange(false)}
          >
            Done
          </button>
        </div>
      </Modal>
    </>
  )
}
