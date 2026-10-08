import { FolderTree, LoaderCircle } from 'lucide-react'
import type { Thread } from '../state'
import { ProviderIcon } from './Icons'

function threadAge(updatedAt: number): string {
  if (!updatedAt) return 'New'
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function SidebarThread({
  thread,
  projectName,
  active,
  onSelect,
}: {
  thread: Thread
  projectName: string
  active: boolean
  onSelect: () => void
}) {
  const workspaceLabel = thread.workspace
    ?.split(/[\\/]+/)
    .filter(Boolean)
    .slice(-2)
    .join('/')
  return (
    <button
      className={`thread-row thread-card ${active ? 'active' : ''}`}
      aria-label={thread.title}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="thread-card-project" aria-hidden="true">
        <ProviderIcon provider={thread.provider} size={14} />
        <span>{projectName}</span>
        <time title={thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : undefined}>
          {threadAge(thread.updatedAt)}
        </time>
      </span>
      <span className="thread-card-title">{thread.title}</span>
      <span className="thread-card-meta" aria-hidden="true">
        <FolderTree size={12} />
        <span title={thread.workspace}>
          {workspaceLabel || (thread.lifeScope ? 'Life extension' : 'Project thread')}
        </span>
        {thread.busy ? (
          <LoaderCircle size={13} className="spinning" />
        ) : (
          <ProviderIcon provider={thread.provider} size={13} />
        )}
      </span>
    </button>
  )
}
