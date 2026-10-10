import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileCode2, Folder } from 'lucide-react'
import type { Message, Thread } from '../state'
import { streamlinedWorkspace } from '../api'
import { reportedFileChanges, type ThreadFileChange } from '../thread-activity'
import { MessageView } from './MessageView'
import { ProviderIcon } from './Icons'
import { ThreadActivityRows } from './ThreadActivityRows'
import {
  completedTurnResponse,
  createTurnGroupProjector,
  threadOutputSequence,
  type TurnGroup,
} from '../thread-presentation'
import './thread-experience.css'

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

function WorkTiming({ started, ended, busy }: { started?: number; ended?: number; busy: boolean }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!busy || !started) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy, started])
  const elapsed =
    started && (busy || ended)
      ? duration(Math.max(0, (busy ? Math.max(now, started) : ended!) - started))
      : undefined
  return (
    <span>
      {busy
        ? elapsed
          ? `Working for ${elapsed}`
          : 'Working'
        : elapsed
          ? `Worked for ${elapsed}`
          : 'Activity'}
    </span>
  )
}

function WorkActivity({
  group,
  busy,
  provider,
  turnStatus,
}: {
  group: TurnGroup
  busy: boolean
  provider: Thread['provider']
  turnStatus?: string
}) {
  const started = group.user?.createdAt
  const ended = group.user?.finishedAt
  const activity = threadOutputSequence(group)
  const elapsed = started && ended ? duration(Math.max(0, ended - started)) : undefined
  const files = useMemo(
    () =>
      streamlinedWorkspace ? [] : reportedFileChanges(group.messages, group.user?.fileChanges),
    [group.messages, group.user?.fileChanges],
  )
  const response = streamlinedWorkspace ? completedTurnResponse(group, busy, turnStatus) : undefined
  if (response) {
    return (
      <div className="thread-completed-work">
        {group.messages
          .filter((message) => message.role === 'user')
          .map((message) => (
            <MessageView key={message.id} message={message} provider={provider} />
          ))}
        <MessageView message={response} provider={provider} minimal />
        <p className="thread-work-summary">{elapsed ? `Worked for ${elapsed}` : 'Worked'}</p>
      </div>
    )
  }
  return (
    <>
      {activity.length || elapsed || busy ? (
        <section className="thread-work-activity" aria-label="Turn activity">
          <div className="thread-work-heading">
            <span
              className="thread-work-provider"
              title={provider === 'codex' ? 'OpenAI · Codex' : 'Claude Code'}
            >
              <ProviderIcon provider={provider} brand size={16} />
            </span>
            <WorkTiming started={started} ended={ended} busy={busy} />
            {group.user?.finishStatus === 'failed' || group.user?.finishStatus === 'interrupted' ? (
              <small>{group.user.finishStatus === 'failed' ? 'Failed' : 'Interrupted'}</small>
            ) : null}
          </div>
          <div className="thread-work-content">
            {activity.length ? (
              <ThreadActivityRows
                messages={activity}
                provider={provider}
                compact={streamlinedWorkspace}
              />
            ) : (
              <p>
                {busy
                  ? 'Waiting for the first update…'
                  : 'No tool activity was reported for this turn.'}
              </p>
            )}
          </div>
        </section>
      ) : null}
      {!streamlinedWorkspace && files.length ? (
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

const TimelineTurn = memo(function TimelineTurn({
  group,
  busy,
  provider,
  turnStatus,
}: {
  group: TurnGroup
  busy: boolean
  provider: Thread['provider']
  turnStatus?: string
}) {
  return (
    <section className="thread-timeline-turn" aria-label={`Turn ${group.turn || 1}`}>
      {group.user ? <MessageView message={group.user} provider={provider} /> : null}
      <WorkActivity group={group} busy={busy} provider={provider} turnStatus={turnStatus} />
    </section>
  )
})

export function ThreadTimeline({ thread }: { thread: Thread }) {
  const projectTurns = useMemo(createTurnGroupProjector, [])
  const groups = useMemo(() => projectTurns(thread.messages), [projectTurns, thread.messages])
  return (
    <div className="thread-timeline">
      {groups.map((group) => (
        <TimelineTurn
          key={group.key}
          group={group}
          busy={thread.busy && group.turn === thread.turn}
          provider={thread.provider}
          turnStatus={group.turn === thread.turn ? thread.turnStatus : undefined}
        />
      ))}
    </div>
  )
}
