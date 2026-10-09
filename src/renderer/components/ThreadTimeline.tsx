import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileCode2, Folder } from 'lucide-react'
import type { Message, Thread } from '../state'
import { reportedFileChanges, type ThreadFileChange } from '../thread-activity'
import { MessageView } from './MessageView'
import { ProviderIcon } from './Icons'
import { ThreadActivityRows } from './ThreadActivityRows'
import './thread-experience.css'

interface TurnGroup {
  key: string
  turn: number
  user?: Message
  messages: Message[]
}
function groupTurns(messages: Message[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: TurnGroup | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      current = { key: message.id, turn: message.turn, user: message, messages: [] }
      groups.push(current)
    } else {
      if (!current) {
        current = { key: `history:${message.id}`, turn: message.turn, messages: [] }
        groups.push(current)
      }
      current.messages.push(message)
    }
  }
  return groups
}
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`
}

function WorkActivity({
  group,
  busy,
  provider,
}: {
  group: TurnGroup
  busy: boolean
  provider: Thread['provider']
}) {
  const [now, setNow] = useState(Date.now)
  const started = group.user?.createdAt
  const ended = group.user?.finishedAt
  useEffect(() => {
    if (!busy || !started) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy, started])
  let finalIndex = -1
  for (let index = group.messages.length - 1; index >= 0; index--)
    if (group.messages[index].role === 'assistant') {
      finalIndex = index
      break
    }
  if (busy) finalIndex = -1
  const activity = group.messages.filter(
    (message, index) => index !== finalIndex && message.role !== 'error',
  )
  const elapsed =
    started && (busy || ended)
      ? duration(Math.max(0, (busy ? Math.max(now, started) : ended!) - started))
      : undefined
  const label = busy
    ? elapsed
      ? `Working for ${elapsed}`
      : 'Working'
    : elapsed
      ? `Worked for ${elapsed}`
      : 'Activity'
  const files = useMemo(
    () => reportedFileChanges(group.messages, group.user?.fileChanges),
    [group.messages, group.user?.fileChanges],
  )
  const final = finalIndex >= 0 ? group.messages[finalIndex] : undefined
  return (
    <>
      {activity.length || elapsed || busy ? (
        <details className="thread-work-activity" open>
          <summary>
            <span
              className="thread-work-provider"
              title={provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'}
            >
              <ProviderIcon provider={provider} brand size={16} />
            </span>
            <span>{label}</span>
            <ChevronRight size={14} aria-hidden="true" />
            {group.user?.finishStatus === 'failed' || group.user?.finishStatus === 'interrupted' ? (
              <small>{group.user.finishStatus === 'failed' ? 'Failed' : 'Interrupted'}</small>
            ) : null}
          </summary>
          <div className="thread-work-content">
            {activity.length ? (
              <ThreadActivityRows messages={activity} provider={provider} />
            ) : (
              <p>
                {busy
                  ? 'Waiting for the first update…'
                  : 'No tool activity was reported for this turn.'}
              </p>
            )}
          </div>
        </details>
      ) : null}
      {final ? <MessageView message={final} provider={provider} /> : null}
      {group.messages
        .filter((message) => message.role === 'error')
        .map((message) => (
          <MessageView key={message.id} message={message} provider={provider} />
        ))}
      {files.length ? (
        <ChangedFiles files={files} source={Boolean(group.user?.fileChanges?.length)} />
      ) : null}
    </>
  )
}

function Counts({ files }: { files: ThreadFileChange[] }) {
  const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0)
  const removals = files.reduce((sum, file) => sum + (file.removals || 0), 0)
  const counted = files.some((file) => file.additions !== undefined || file.removals !== undefined)
  return counted ? (
    <span className="thread-change-counts" title="Reported line additions and removals">
      <span className="thread-lines-added">+{additions.toLocaleString()}</span>
      <span className="thread-lines-removed">−{removals.toLocaleString()}</span>
    </span>
  ) : null
}
function ChangedFile({ file, prefix = '' }: { file: ThreadFileChange; prefix?: string }) {
  const name = prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path
  return (
    <details className="thread-changed-file">
      <summary title={file.path}>
        <ChevronRight size={12} aria-hidden="true" />
        <FileCode2 size={14} aria-hidden="true" />
        <span>{name}</span>
        <Counts files={[file]} />
      </summary>
      {file.diff ? (
        <pre>{file.diff}</pre>
      ) : (
        <p>{file.kind ? `${file.kind} · ` : ''}This tool reported the path without a line diff.</p>
      )}
      {file.truncated ? (
        <p>
          Diff preview {file.diff ? 'shortened' : 'omitted for this large edit'}. The complete tool
          output remains in Activity.
        </p>
      ) : null}
    </details>
  )
}
function ChangedFiles({ files, source }: { files: ThreadFileChange[]; source: boolean }) {
  const groups = useMemo(() => {
    const folders = new Map<string, ThreadFileChange[]>()
    for (const file of files) {
      const folder =
        file.path.includes('/') && !file.path.startsWith('/') ? file.path.split('/')[0] : ''
      const items = folders.get(folder) || []
      items.push(file)
      folders.set(folder, items)
    }
    return [...folders.entries()].sort(([a], [b]) =>
      a ? (b ? a.localeCompare(b) : -1) : b ? 1 : 0,
    )
  }, [files])
  return (
    <details className="thread-changes" open>
      <summary>
        <strong>
          {files.length} changed {files.length === 1 ? 'file' : 'files'}
        </strong>
        <Counts files={files} />
        <ChevronRight size={14} aria-hidden="true" />
      </summary>
      <p className="thread-changes-caption">
        {source ? 'Applied Life source changes' : 'File edits reported by this turn'}
      </p>
      <div className="thread-changes-tree">
        {groups.map(([folder, items]) =>
          folder ? (
            <details className="thread-changes-folder" key={folder}>
              <summary>
                <ChevronRight size={12} aria-hidden="true" />
                <Folder size={15} aria-hidden="true" />
                <span>{folder}</span>
                <Counts files={items} />
              </summary>
              <div>
                {items.map((file) => (
                  <ChangedFile key={file.path} file={file} prefix={`${folder}/`} />
                ))}
              </div>
            </details>
          ) : (
            items.map((file) => <ChangedFile key={file.path} file={file} />)
          ),
        )}
      </div>
    </details>
  )
}

const TimelineTurn = memo(
  function TimelineTurn({
    group,
    busy,
    provider,
  }: {
    group: TurnGroup
    busy: boolean
    provider: Thread['provider']
  }) {
    return (
      <section className="thread-timeline-turn" aria-label={`Turn ${group.turn || 1}`}>
        {group.user ? <MessageView message={group.user} provider={provider} /> : null}
        <WorkActivity group={group} busy={busy} provider={provider} />
      </section>
    )
  },
  (previous, next) =>
    previous.busy === next.busy &&
    previous.provider === next.provider &&
    previous.group.user === next.group.user &&
    previous.group.messages.length === next.group.messages.length &&
    previous.group.messages.every((message, index) => message === next.group.messages[index]),
)

export function ThreadTimeline({ thread }: { thread: Thread }) {
  const groups = useMemo(() => groupTurns(thread.messages), [thread.messages])
  return (
    <div className="thread-timeline">
      {groups.map((group) => (
        <TimelineTurn
          key={group.key}
          group={group}
          busy={thread.busy && group.turn === thread.turn}
          provider={thread.provider}
        />
      ))}
    </div>
  )
}
