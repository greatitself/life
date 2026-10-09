import { useEffect, useState } from 'react'
import type { Provider } from '../../shared/types'
import { Modal } from './Modal'
import { useBuiltinFeature } from '../builtin-extensions'

export interface ResearchSidebarFilters {
  status: 'all' | 'open' | 'blocked' | 'solved'
  provider: 'all' | Provider
  activity: 'all' | 'running' | 'waiting' | 'idle'
  sort: 'recent' | 'oldest' | 'title' | 'activity' | 'messages' | 'status'
}
const defaults: ResearchSidebarFilters = {
  status: 'all',
  provider: 'all',
  activity: 'all',
  sort: 'recent',
}
const storageKey = 'life.research.sidebar-filters.v1'
function readFilters(): ResearchSidebarFilters {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return {
      status: ['open', 'blocked', 'solved'].includes(value.status) ? value.status : 'all',
      provider: ['codex', 'claude'].includes(value.provider) ? value.provider : 'all',
      activity: ['running', 'waiting', 'idle'].includes(value.activity) ? value.activity : 'all',
      sort: ['oldest', 'title', 'activity', 'messages', 'status'].includes(value.sort)
        ? value.sort
        : 'recent',
    }
  } catch {
    return { ...defaults }
  }
}
export function useResearchSidebarFilters() {
  const enabled = useBuiltinFeature('research-filters')
  const [filters, setFilters] = useState(readFilters)
  useEffect(() => {
    if (!enabled) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(filters))
    } catch {
      /* Filters still work in memory. */
    }
  }, [enabled, filters])
  return {
    enabled,
    filters: enabled ? filters : defaults,
    setFilters,
    reset: () => setFilters({ ...defaults }),
    customized:
      enabled &&
      (filters.status !== 'all' ||
        filters.provider !== 'all' ||
        filters.activity !== 'all' ||
        filters.sort !== 'recent'),
  }
}
export function ResearchSidebarFilterDialog({
  open,
  onOpenChange,
  state,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: ReturnType<typeof useResearchSidebarFilters>
}) {
  const { filters, setFilters, reset } = state
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Research filters and sorting"
      description="Filter goals and their problems by status, agent, and activity. Your sorting preference is saved."
      className="sidebar-filters-modal"
    >
      <div className="sidebar-filter-fields">
        <label>
          Problem status
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                status: event.target.value as ResearchSidebarFilters['status'],
              }))
            }
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="blocked">Blocked</option>
            <option value="solved">Solved</option>
          </select>
        </label>
        <label>
          Agent
          <select
            value={filters.provider}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                provider: event.target.value as ResearchSidebarFilters['provider'],
              }))
            }
          >
            <option value="all">All agents</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          Activity
          <select
            value={filters.activity}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                activity: event.target.value as ResearchSidebarFilters['activity'],
              }))
            }
          >
            <option value="all">All activity</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting for input</option>
            <option value="idle">Idle</option>
          </select>
        </label>
        <label>
          Sort by
          <select
            value={filters.sort}
            onChange={(event) =>
              setFilters((previous) => ({
                ...previous,
                sort: event.target.value as ResearchSidebarFilters['sort'],
              }))
            }
          >
            <option value="recent">Most recently used</option>
            <option value="oldest">Oldest activity first</option>
            <option value="title">Alphabetical</option>
            <option value="activity">Waiting and running first</option>
            <option value="messages">Most conversation turns</option>
            <option value="status">Problem status</option>
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={reset}>
          Reset
        </button>
        <button type="button" className="button primary" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </div>
    </Modal>
  )
}
