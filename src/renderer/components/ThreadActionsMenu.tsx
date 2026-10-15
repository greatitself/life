import type { PointerEvent, ReactElement } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Ellipsis,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  Settings,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Thread } from '../state'
import {
  isThreadSnoozed,
  threadCanArchive,
  threadCanPark,
  type ThreadAction,
} from '../thread-management'
import './thread-controls.css'

export type ThreadActionHandler = (
  thread: Thread,
  action: ThreadAction,
  value?: number | string,
) => void

function tomorrowMorning(): number {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

// A context-menu gesture opens before the right button is released. Radix's
// dropdown item release handling must not treat that release as a selection.
function ignoreContextRelease(event: PointerEvent<HTMLDivElement>) {
  if (event.button === 0) return
  event.preventDefault()
  event.stopPropagation()
}

/** Sidebar and conversation header use the same actions and availability. */
export function ThreadActionsMenu({
  thread,
  onAction,
  trigger,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  thread: Thread
  onAction: ThreadActionHandler
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const archived = Boolean(thread.archivedAt)
  const snoozed = isThreadSnoozed(thread)
  const needsInput = !threadCanPark(thread)
  const act = (action: ThreadAction, value?: number | string) => onAction(thread, action, value)
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        {trigger || (
          <button
            type="button"
            className="life-thread-action-icon"
            aria-label={`Actions for ${thread.title}`}
            title="Thread actions"
          >
            <Ellipsis size={15} />
          </button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="life-thread-menu life-thread-actions-menu"
          sideOffset={6}
          align="end"
          collisionPadding={12}
          loop
          onCloseAutoFocus={onCloseAutoFocus}
          onPointerUpCapture={ignoreContextRelease}
        >
          <DropdownMenu.Label className="life-choice-heading">Thread actions</DropdownMenu.Label>
          {!archived ? (
            <>
              <DropdownMenu.Item
                className="life-thread-menu-item"
                onSelect={() => act(thread.pinnedAt ? 'unpin' : 'pin')}
              >
                {thread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
                {thread.pinnedAt ? 'Unpin thread' : 'Pin thread'}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="life-thread-menu-item"
                disabled={needsInput}
                onSelect={() => act(thread.settled ? 'restore' : 'settle')}
              >
                {thread.settled ? <Undo2 size={14} /> : <Check size={14} />}
                {thread.settled ? 'Restore thread' : 'Settle thread'}
              </DropdownMenu.Item>
              {snoozed ? (
                <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('wake')}>
                  <Clock size={14} />
                  Wake thread now
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="life-thread-menu-item" disabled={needsInput}>
                    <Clock size={14} />
                    Snooze thread
                    <ChevronRight size={13} />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      className="life-thread-menu"
                      sideOffset={5}
                      onPointerUpCapture={ignoreContextRelease}
                    >
                      {[
                        ['30 minutes', 1800000],
                        ['1 hour', 3600000],
                        ['4 hours', 14400000],
                      ].map(([label, milliseconds]) => (
                        <DropdownMenu.Item
                          key={label}
                          className="life-thread-menu-item"
                          onSelect={() => act('snooze', Date.now() + Number(milliseconds))}
                        >
                          {label}
                        </DropdownMenu.Item>
                      ))}
                      <DropdownMenu.Item
                        className="life-thread-menu-item"
                        onSelect={() => act('snooze', tomorrowMorning())}
                      >
                        Tomorrow at 9:00
                      </DropdownMenu.Item>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              )}
              <DropdownMenu.Separator className="life-thread-menu-separator" />
              <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('move-up')}>
                <ArrowUp size={14} />
                Move up
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="life-thread-menu-item"
                onSelect={() => act('move-down')}
              >
                <ArrowDown size={14} />
                Move down
              </DropdownMenu.Item>
            </>
          ) : null}
          <DropdownMenu.Separator className="life-thread-menu-separator" />
          <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('rename')}>
            <Pencil size={14} />
            Rename thread
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="life-thread-menu-item"
            disabled={!thread.completedAt}
            onSelect={() => act('mark-unread')}
          >
            <Mail size={14} />
            Mark unread
          </DropdownMenu.Item>
          <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('mark-read')}>
            <MailOpen size={14} />
            Mark read
          </DropdownMenu.Item>
          <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('export')}>
            <Download size={14} />
            Export thread
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="life-thread-menu-item"
            onSelect={() => act('export', 'recovery')}
          >
            <Download size={14} />
            Export recovery JSON
          </DropdownMenu.Item>
          <DropdownMenu.Item className="life-thread-menu-item" onSelect={() => act('settings')}>
            <Settings size={14} />
            Settings and undo
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="life-thread-menu-item">
              <Copy size={14} />
              Copy
              <ChevronRight size={13} />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                className="life-thread-menu"
                sideOffset={5}
                onPointerUpCapture={ignoreContextRelease}
              >
                <DropdownMenu.Item
                  className="life-thread-menu-item"
                  disabled={!thread.workspace}
                  onSelect={() => act('copy', 'path')}
                >
                  Project path
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="life-thread-menu-item"
                  disabled={!thread.gitBranch}
                  onSelect={() => act('copy', 'branch')}
                >
                  Branch name
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="life-thread-menu-item"
                  onSelect={() => act('copy', 'id')}
                >
                  Thread ID
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="life-thread-menu-separator" />
          <DropdownMenu.Item
            className="life-thread-menu-item"
            disabled={!archived && !threadCanArchive(thread)}
            onSelect={() => act(archived ? 'unarchive' : 'archive')}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {archived ? 'Restore from archive' : 'Archive thread'}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="life-thread-menu-item life-thread-menu-destructive"
            disabled={!threadCanArchive(thread)}
            onSelect={() => act('delete')}
          >
            <Trash2 size={14} />
            Delete thread
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
