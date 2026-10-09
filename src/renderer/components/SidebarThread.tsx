import { useState } from 'react'
import * as HoverCard from '@radix-ui/react-hover-card'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, Clock, Cloud, GitBranch, GitPullRequest, Undo2 } from 'lucide-react'
import type { Thread } from '../state'
import { ProviderIcon } from './Icons'
import { ThreadBadge } from './ThreadBadge'
import { ThreadRunStatus } from './ThreadRunStatus'
import './thread-controls.css'

function threadAge(updatedAt: number): string {
  if (!updatedAt) return 'New'
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
function tomorrow() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}
export function SidebarThread({
  thread,
  projectName,
  active,
  onSelect,
  host,
  onArrange,
}: {
  thread: Thread
  projectName: string
  active: boolean
  onSelect: () => void
  host?: string
  onArrange?: (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const branch = thread.gitBranch || (thread.gitObservedAt ? 'No Git branch' : 'Branch not loaded')
  const machine =
    host ||
    thread.gitHost ||
    (thread.profileId === 'life-local' ? 'Local Life' : 'Previous machine')
  const observed = thread.gitObservedAt
    ? `Last checked ${new Date(thread.gitObservedAt).toLocaleString()}`
    : 'Select this project to load its Git branch.'
  const snoozed = Boolean(thread.snoozedUntil && thread.snoozedUntil > Date.now())
  const state = thread.pending.length
    ? 'Waiting for input'
    : thread.busy
      ? 'Working'
      : snoozed
        ? `Snoozed until ${new Date(thread.snoozedUntil!).toLocaleString()}`
        : thread.settled
          ? 'Settled'
          : 'Idle'
  return (
    <div className={`thread-card-shell ${active ? 'active' : ''}`}>
      <HoverCard.Root
        open={hovered && !menuOpen}
        onOpenChange={setHovered}
        openDelay={450}
        closeDelay={120}
      >
        <HoverCard.Trigger asChild>
          <button
            type="button"
            className={`thread-row thread-card ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            aria-label={`${thread.title}, ${thread.provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'}, ${branch}, ${state}`}
            onClick={onSelect}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
          >
            <span className="thread-card-project" aria-hidden="true">
              <ThreadBadge thread={thread} />
              <span>{projectName}</span>
              {thread.busy ? (
                <ThreadRunStatus thread={thread} />
              ) : (
                <time
                  title={thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : undefined}
                >
                  {threadAge(thread.updatedAt)}
                </time>
              )}
            </span>
            <span className="thread-card-title">{thread.title}</span>
            <span className="thread-card-meta" aria-hidden="true">
              <GitBranch size={14} />
              <span title={`${branch} · ${observed}`}>{branch}</span>
              <Cloud size={14} className="thread-cloud-icon" aria-label={machine} />
              <span
                className="thread-card-provider"
                title={thread.provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'}
              >
                <ProviderIcon provider={thread.provider} size={16} />
              </span>
            </span>
          </button>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            className="life-thread-hover"
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
          >
            <strong className="life-thread-hover-title">{thread.title}</strong>
            <div className="life-thread-hover-row">
              <ThreadBadge thread={thread} />
              <span>{projectName}</span>
            </div>
            <div className="life-thread-hover-row">
              <Cloud size={15} />
              <span>{machine}</span>
            </div>
            <div className="life-thread-hover-row" title={observed}>
              <GitBranch size={15} />
              <span>{branch}</span>
            </div>
            <div className="life-thread-hover-row">
              <ProviderIcon provider={thread.provider} size={15} />
              <span>{thread.model || 'Agent default'}</span>
            </div>
            <p className="life-thread-hover-settings">
              {thread.reasoningEffort
                ? `Reasoning: ${thread.reasoningEffort}`
                : 'Default reasoning'}{' '}
              · {thread.serviceTier ? `Speed: ${thread.serviceTier}` : 'Default speed'}
            </p>
            <div className="life-thread-hover-footer">
              {thread.pullRequest ? (
                <div className="life-thread-hover-row">
                  <GitPullRequest size={15} />
                  <span>
                    #{thread.pullRequest.number} · {thread.pullRequest.title}
                  </span>
                </div>
              ) : (
                <span>
                  {state} · {thread.messages.filter((message) => message.role === 'user').length}{' '}
                  conversation turns
                </span>
              )}
              <small>{observed}</small>
            </div>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      {onArrange ? (
        <div className="life-thread-actions" role="group" aria-label={`Arrange ${thread.title}`}>
          <DropdownMenu.Root
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open)
              if (open) setHovered(false)
            }}
          >
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="life-thread-action-icon"
                aria-label={snoozed ? 'Change snooze time or wake thread' : 'Snooze thread'}
                title={snoozed ? 'Change snooze or wake' : 'Snooze thread'}
              >
                <Clock size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="life-thread-menu"
                sideOffset={6}
                align="end"
                collisionPadding={12}
              >
                <DropdownMenu.Label className="life-choice-heading">
                  Snooze thread
                </DropdownMenu.Label>
                {snoozed ? (
                  <DropdownMenu.Item
                    className="life-thread-menu-item"
                    onSelect={() => onArrange(thread, { snoozedUntil: undefined })}
                  >
                    Wake now
                  </DropdownMenu.Item>
                ) : null}
                {[
                  ['30 minutes', 1800000],
                  ['1 hour', 3600000],
                  ['4 hours', 14400000],
                ].map(([label, milliseconds]) => (
                  <DropdownMenu.Item
                    key={label}
                    className="life-thread-menu-item"
                    onSelect={() =>
                      onArrange(thread, {
                        snoozedUntil: Date.now() + Number(milliseconds),
                        settled: false,
                      })
                    }
                  >
                    {label}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Item
                  className="life-thread-menu-item"
                  onSelect={() => onArrange(thread, { snoozedUntil: tomorrow(), settled: false })}
                >
                  Tomorrow at 9:00
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            type="button"
            className="life-thread-settle"
            title={
              thread.settled
                ? 'Move back to active threads'
                : 'Move to Settled; keep the conversation and current run'
            }
            onClick={() => onArrange(thread, { settled: !thread.settled, snoozedUntil: undefined })}
          >
            {thread.settled ? <Undo2 size={14} /> : <Check size={14} />}
            <span>{thread.settled ? 'Restore' : 'Settle'}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
