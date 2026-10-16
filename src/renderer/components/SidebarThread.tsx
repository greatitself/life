import { memo, useRef, useState, type KeyboardEvent } from 'react'
import * as HoverCard from '@radix-ui/react-hover-card'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  AlarmClockOff,
  Check,
  CircleAlert,
  Clock,
  Cloud,
  GitBranch,
  GitPullRequest,
  Mail,
  MessageCircleQuestion,
  Pin,
  ShieldQuestion,
  SquarePen,
  Undo2,
} from 'lucide-react'
import type { Thread } from '../state'
import { ProviderIcon } from './Icons'
import { ThreadBadge } from './ThreadBadge'
import { ThreadRunStatus } from './ThreadRunStatus'
import { useSidebarMinute } from '../sidebar-clock'
import { conversationTurnCount } from '../sidebar-history'
import {
  isThreadSnoozed,
  threadCanSettle,
  threadCanSnooze,
  threadHasUnreadCompletion,
  threadSection,
} from '../thread-management'
import { ThreadActionsMenu, type ThreadActionHandler } from './ThreadActionsMenu'
import { ThreadSnoozeMenuItems } from './ThreadSnoozeMenu'
import './thread-controls.css'

function threadAge(updatedAt: number): string {
  if (!updatedAt) return 'New'
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
function ThreadAge({ updatedAt }: { updatedAt: number }) {
  useSidebarMinute()
  return threadAge(updatedAt)
}
function navigateRows(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const sidebar = event.currentTarget.closest('.sidebar')
  if (!sidebar) return
  const rows = Array.from(sidebar.querySelectorAll<HTMLButtonElement>('[data-thread-row]')).filter(
    (row) => row.getClientRects().length > 0,
  )
  const index = rows.indexOf(event.currentTarget)
  if (index < 0) return
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  rows[next]?.focus()
}

function parkedWakeTime(until: number) {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000))
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.ceil(minutes / 60)}h`
      : `${Math.ceil(minutes / 1440)}d`
}
function SnoozeRemaining({ until }: { until: number }) {
  useSidebarMinute()
  return parkedWakeTime(until)
}
export const SidebarThread = memo(function SidebarThread({
  thread,
  projectName,
  active,
  onSelect,
  host,
  onArrange,
  onAction,
  compact = false,
  hasDraft = false,
}: {
  thread: Thread
  projectName: string
  active: boolean
  onSelect: (thread: Thread) => void
  host?: string
  onArrange?: (thread: Thread, patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => void
  onAction?: ThreadActionHandler
  compact?: boolean
  hasDraft?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const row = useRef<HTMLButtonElement>(null)
  const returnToRow = useRef(false)
  const branch = thread.gitBranch || (thread.gitObservedAt ? 'No Git branch' : 'Branch not loaded')
  const machine =
    host ||
    thread.gitHost ||
    (thread.profileId === 'life-local' ? 'Local Life' : 'Previous machine')
  const observed = thread.gitObservedAt
    ? `Last checked ${new Date(thread.gitObservedAt).toLocaleString()}`
    : 'Select this project to load its Git branch.'
  const snoozed = isThreadSnoozed(thread)
  const section = threadSection(thread)
  const settled = section === 'settled'
  const canSettle = threadCanSettle(thread)
  const canSnooze = threadCanSnooze(thread)
  const approval = thread.pending.some((request) => request.type === 'approval')
  const input = !approval && thread.pending.length > 0
  const unread = !active && threadHasUnreadCompletion(thread)
  const state = approval
    ? 'Approval needed'
    : input
      ? 'Input needed'
      : thread.busy
        ? 'Working'
        : snoozed
          ? `Snoozed until ${new Date(thread.snoozedUntil!).toLocaleString()}`
          : settled
            ? 'Settled'
            : thread.turnStatus === 'failed'
              ? 'Failed'
              : thread.turnStatus === 'interrupted'
                ? 'Interrupted'
                : unread
                  ? 'Unread completion'
                  : 'Idle'
  const status = approval
    ? 'approval'
    : input
      ? 'input'
      : !thread.busy && thread.turnStatus === 'failed'
        ? 'failed'
        : !thread.busy && unread
          ? 'done'
          : undefined
  const statusLabel = approval
    ? 'Approval'
    : input
      ? 'Input'
      : status === 'failed'
        ? 'Failed'
        : status === 'done'
          ? 'Done'
          : undefined
  const StatusIcon = approval
    ? ShieldQuestion
    : input
      ? MessageCircleQuestion
      : status === 'failed'
        ? CircleAlert
        : Mail
  const statusElement = status ? (
    <span className="life-thread-status" data-status={status}>
      <StatusIcon size={13} aria-hidden="true" />
      <span>{statusLabel}</span>
    </span>
  ) : thread.busy ? (
    <ThreadRunStatus thread={thread} />
  ) : snoozed ? (
    <time title={`Wakes ${new Date(thread.snoozedUntil!).toLocaleString()}`}>
      <SnoozeRemaining until={thread.snoozedUntil!} />
    </time>
  ) : (
    <time title={thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : undefined}>
      <ThreadAge updatedAt={thread.updatedAt} />
    </time>
  )
  const arrange = (patch: Pick<Thread, 'settled' | 'snoozedUntil'>) => {
    if (onAction) {
      if (patch.snoozedUntil !== undefined) onAction(thread, 'snooze', patch.snoozedUntil)
      else if (patch.settled !== undefined) onAction(thread, patch.settled ? 'settle' : 'restore')
      else onAction(thread, 'wake')
    } else onArrange?.(thread, patch)
  }
  return (
    <div
      className={`thread-card-shell ${active ? 'active' : ''} ${compact ? 'thread-card-compact' : ''}`}
      data-unread={unread || undefined}
      data-needs-input={Boolean(thread.pending.length) || undefined}
      data-menu-open={menuOpen || snoozeOpen || undefined}
      data-thread-section={section}
    >
      <HoverCard.Root
        open={hovered && !menuOpen && !snoozeOpen}
        onOpenChange={setHovered}
        openDelay={450}
        closeDelay={120}
      >
        <HoverCard.Trigger asChild>
          <button
            ref={row}
            type="button"
            className={`thread-row thread-card ${active ? 'active' : ''}`}
            data-thread-row={thread.id}
            aria-current={active ? 'page' : undefined}
            aria-label={`${thread.title}, ${thread.provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'}, ${branch}, ${state}${hasDraft && !active ? ', Unsent draft' : ''}${thread.pinnedAt ? ', Pinned' : ''}`}
            onClick={() => onSelect(thread)}
            onContextMenu={
              onAction
                ? (event) => {
                    event.preventDefault()
                    returnToRow.current = true
                    setHovered(false)
                    setMenuOpen(true)
                  }
                : undefined
            }
            onKeyDown={(event) => {
              if (
                onAction &&
                (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
              ) {
                event.preventDefault()
                returnToRow.current = true
                setHovered(false)
                setMenuOpen(true)
              } else navigateRows(event)
            }}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
          >
            <span className="thread-card-project" aria-hidden="true">
              <ThreadBadge thread={thread} />
              {!compact ? <span>{projectName}</span> : null}
              {hasDraft && !active ? (
                <SquarePen size={13} className="life-thread-draft" aria-label="Unsent draft" />
              ) : null}
              {thread.pinnedAt ? (
                <Pin size={12} className="life-thread-pin" aria-label="Pinned" />
              ) : null}
              {!compact ? statusElement : null}
            </span>
            <span className="thread-card-title">{thread.title}</span>
            {compact ? (
              <span className="thread-card-compact-status" aria-hidden="true">
                {statusElement}
              </span>
            ) : (
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
            )}
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
                  {state} · {conversationTurnCount(thread.messages)} conversation turns
                </span>
              )}
              <small>{observed}</small>
            </div>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      {onArrange || onAction ? (
        <div className="life-thread-actions" role="group" aria-label={`Arrange ${thread.title}`}>
          {snoozed ? (
            <button
              type="button"
              className="life-thread-settle life-thread-wake"
              aria-label="Wake thread now"
              title="Wake now"
              onClick={() => arrange({ snoozedUntil: undefined })}
            >
              <AlarmClockOff size={14} aria-hidden="true" />
              <span>Wake</span>
            </button>
          ) : !settled && !thread.archivedAt ? (
            <DropdownMenu.Root
              open={snoozeOpen}
              onOpenChange={(open) => {
                setSnoozeOpen(open)
                if (open) setHovered(false)
              }}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="life-thread-action-icon"
                  aria-label="Snooze thread"
                  title={
                    canSnooze
                      ? 'Snooze thread'
                      : 'Resolve pending responses or queued work before snoozing'
                  }
                  disabled={!canSnooze}
                >
                  <Clock size={14} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="life-thread-menu life-thread-snooze-menu"
                  sideOffset={6}
                  align="end"
                  collisionPadding={12}
                >
                  <ThreadSnoozeMenuItems
                    onSnooze={(until) => arrange({ snoozedUntil: until, settled: false })}
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
          {!thread.archivedAt && !snoozed ? (
            <button
              type="button"
              className="life-thread-settle"
              aria-label={settled ? 'Un-settle thread' : 'Settle thread'}
              title={
                settled
                  ? 'Move back to active threads'
                  : canSettle
                    ? 'Move finished work to Settled'
                    : 'Finish running work and resolve pending responses before settling'
              }
              disabled={!settled && !canSettle}
              onClick={() => arrange({ settled: !settled, snoozedUntil: undefined })}
            >
              {settled ? <Undo2 size={14} /> : <Check size={14} />}
              <span>{settled ? 'Un-settle' : 'Settle'}</span>
            </button>
          ) : null}
          {onAction ? (
            <ThreadActionsMenu
              thread={thread}
              onAction={onAction}
              open={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open)
                if (open) setHovered(false)
              }}
              onCloseAutoFocus={(event) => {
                if (!returnToRow.current) return
                returnToRow.current = false
                event.preventDefault()
                window.requestAnimationFrame(() => row.current?.focus({ preventScroll: true }))
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
