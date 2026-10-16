import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronRight,
  CornerDownRight,
  Globe,
  Hammer,
  Minimize2,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { Message, Thread } from '../state'
import { isSubagentLaunch, reportedFileChanges } from '../thread-activity'
import { createActivityRowsProjector } from '../thread-activity-rows'
import {
  activityAnchor,
  activitySummary,
  isProgressUpdate,
  subagentPresentation,
  toolActionSummary,
  toolLifecycle,
  threadRunningChildIds,
  toolOutputSections,
} from '../thread-presentation'
import { MessageView, RawOutput, ToolStatus } from './MessageView'

function ActivityDisclosure({
  summary,
  children,
  label,
  messageIds,
}: {
  summary: ReactNode
  children: ReactNode
  label: string
  messageIds: string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details
      className="thread-action-disclosure"
      aria-label={label}
      data-message-ids={messageIds}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="thread-action-heading">
        <ChevronRight size={13} aria-hidden="true" />
        {summary}
      </summary>
      {expanded ? <div className="thread-action-content">{children}</div> : null}
    </details>
  )
}
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
function describe(messages: Message[], agents: boolean, running: boolean) {
  if (agents) {
    const launches = messages.filter(isSubagentLaunch).length
    return {
      Icon: Bot,
      label: launches
        ? `${running ? 'Running' : 'Ran'} ${plural(launches, 'subagent')}`
        : `Subagent activity · ${plural(messages.length, 'update')}`,
    }
  }
  let commands = 0
  let searches = 0
  let other = 0
  let fileTools = 0
  for (const message of messages) {
    const title = message.title || ''
    if (/web.?search|search_query|web\.run/i.test(title)) searches++
    else if (/^(Editing files|Edit|Write|MultiEdit|apply_patch|fileChange)$/i.test(title))
      fileTools++
    else if (
      /^(Bash|Shell|Terminal|exec_command|execute_command|commandExecution)(?:$|\s|[({])|^(?:\/[\w./-]+\/)?(?:bash|sh|zsh|fish|dash)(?:$|\s)|^(?:git|rg|grep|find|cat|sed|ls|pwd|cd|npm|pnpm|yarn|bun|node|python\d*|pytest|cargo|go|make|curl|wget|echo|printf|env|test|tsc|npx|uv)(?:$|\s)/i.test(
        title,
      )
    )
      commands++
    else other++
  }
  const files = reportedFileChanges(messages)
  const parts: string[] = []
  if (commands) parts.push(`${running ? 'Running' : 'Ran'} ${plural(commands, 'command')}`)
  if (searches)
    parts.push(`${running ? 'searching' : 'searched'} the web ${plural(searches, 'time')}`)
  if (files.length) parts.push(`changed ${plural(files.length, 'file')}`)
  if (other) parts.push(`${parts.length ? 'used' : 'Used'} ${plural(other, 'tool')}`)
  const label =
    parts.join(' and ') ||
    (fileTools ? (running ? 'Editing files' : 'File activity') : 'Tool activity')
  return {
    Icon: files.length || fileTools ? Hammer : commands ? Terminal : searches ? Globe : Wrench,
    label:
      messages.length === 1
        ? toolActionSummary(messages[0])
        : label.charAt(0).toUpperCase() + label.slice(1),
  }
}
const SubagentCard = memo(function SubagentCard({ message }: { message: Message }) {
  const agent = useMemo(() => subagentPresentation(message), [message])
  const sections = useMemo(() => toolOutputSections(message), [message])
  const parentId = agent.parentItemId
    ? agent.parentItemId.startsWith(`${message.turn}:`)
      ? agent.parentItemId
      : `${message.turn}:${agent.parentItemId}`
    : undefined
  return (
    <article
      className="thread-subagent-card"
      data-nested={!!parentId || undefined}
      id={activityAnchor(message.id)}
      data-message-id={message.id}
      tabIndex={-1}
      aria-label={`Subagent ${agent.name}`}
    >
      <header className="thread-subagent-heading">
        <Bot size={16} aria-hidden="true" />
        <strong>{agent.name}</strong>
        <ToolStatus status={agent.status} />
      </header>
      {agent.id ? (
        <p className="thread-subagent-id">
          <code>{agent.id}</code>
        </p>
      ) : null}
      {message.title && message.title !== agent.name ? (
        <p className="thread-subagent-operation">{message.title}</p>
      ) : null}
      {parentId ? (
        <a
          className="thread-subagent-parent"
          href={`#${activityAnchor(parentId)}`}
          title={parentId}
          onClick={(event) => {
            event.preventDefault()
            const parent =
              document.getElementById(activityAnchor(parentId)) ||
              [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find((element) =>
                element.dataset.messageId?.startsWith(`${parentId}:`),
              )
            if (parent) {
              parent.scrollIntoView({ block: 'center', behavior: 'auto' })
              parent.focus()
            }
          }}
        >
          <CornerDownRight size={12} aria-hidden="true" />
          Parent activity
        </a>
      ) : null}
      {agent.task ? <p className="thread-subagent-task">{agent.task}</p> : null}
      {agent.participants.length ? (
        <ul className="thread-subagent-participants" aria-label="Subagent states">
          {agent.participants.map((participant) => (
            <li key={participant.id}>
              <Bot size={12} aria-hidden="true" />
              <span title={participant.id}>{participant.name}</span>
              {participant.status ? <small>{participant.status}</small> : null}
              {participant.message ? <p>{participant.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sections.length ? (
        sections.map((section) => <RawOutput key={section.label} {...section} />)
      ) : (
        <p className="thread-tool-empty">Waiting for a subagent update…</p>
      )}
    </article>
  )
})
const ToolBatch = memo(function ToolBatch({
  messages,
  agents,
  provider,
  compact,
  agentsRunning,
  agentWorkspace,
}: {
  messages: Message[]
  agents: boolean
  provider: Thread['provider']
  compact: boolean
  agentsRunning: boolean
  agentWorkspace: boolean
}) {
  const running = agents
    ? agentsRunning
    : messages.some((message) => toolLifecycle(message.status) === 'active')
  const { Icon, label } = useMemo(
    () => describe(messages, agents, running),
    [messages, agents, running],
  )
  const failures = messages.filter((message) => toolLifecycle(message.status) === 'failed').length
  const interrupted = messages.some((message) => toolLifecycle(message.status) === 'interrupted')
  const current = messages.findLast((message) => toolLifecycle(message.status) === 'active')
  const currentAction =
    current && messages.length > 1 && !agents ? toolActionSummary(current) : undefined
  if (compact) {
    return (
      <ActivityDisclosure
        label={agents ? 'Subagent activity' : 'Tool activity'}
        messageIds={messages.map((message) => encodeURIComponent(message.id)).join(' ')}
        summary={
          <>
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
            {currentAction ? (
              <span className="thread-current-tool" title={currentAction}>
                {currentAction}
              </span>
            ) : null}
            {running ? <i className="thread-run-ring" aria-hidden="true" /> : null}
            {failures ? (
              <small>{plural(failures, 'failure')}</small>
            ) : interrupted ? (
              <small>Interrupted</small>
            ) : null}
          </>
        }
      >
        {messages.map((message) =>
          agents ? (
            <SubagentCard key={message.id} message={message} />
          ) : (
            <MessageView
              key={message.id}
              message={message}
              provider={provider}
              agentWorkspace={agentWorkspace}
            />
          ),
        )}
      </ActivityDisclosure>
    )
  }
  return (
    <section
      className="thread-tool-batch"
      data-running={running || undefined}
      aria-label={agents ? 'Subagent activity' : 'Tool activity'}
    >
      <div className="thread-tool-batch-heading">
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        {currentAction ? (
          <span className="thread-current-tool" title={currentAction}>
            {currentAction}
          </span>
        ) : null}
        {running ? <i className="thread-run-ring" aria-hidden="true" /> : null}
        {failures ? (
          <small>{plural(failures, 'failure')}</small>
        ) : interrupted ? (
          <small>Interrupted</small>
        ) : null}
      </div>
      <div className="thread-tool-batch-content">
        {messages.map((message) =>
          agents ? (
            <SubagentCard key={message.id} message={message} />
          ) : (
            <MessageView
              key={message.id}
              message={message}
              provider={provider}
              agentWorkspace={agentWorkspace}
            />
          ),
        )}
      </div>
    </section>
  )
})
export function ThreadActivityRows({
  messages,
  provider,
  compact = false,
  agentWorkspace = false,
}: {
  messages: Message[]
  provider: Thread['provider']
  compact?: boolean
  agentWorkspace?: boolean
}) {
  const projectRows = useMemo(createActivityRowsProjector, [])
  const rows = useMemo(() => projectRows(messages), [projectRows, messages])
  const activeChildren = useMemo(() => threadRunningChildIds(messages), [messages])
  return (
    <div className="thread-activity-sequence">
      {rows.map((row) => {
        if ('messages' in row)
          return (
            <ToolBatch
              key={row.messages[0].id}
              messages={row.messages}
              agents={row.kind === 'agents'}
              provider={provider}
              compact={compact}
              agentWorkspace={agentWorkspace}
              agentsRunning={
                row.kind === 'agents' &&
                row.messages.some(
                  (message) =>
                    activeChildren.has(message.agentId || message.parentItemId || message.id) ||
                    subagentPresentation(message).participants.some((participant) =>
                      activeChildren.has(participant.id),
                    ),
                )
              }
            />
          )
        if (
          compact &&
          row.message.role !== 'user' &&
          row.message.role !== 'error' &&
          !isProgressUpdate(row.message)
        )
          return (
            <ActivityDisclosure
              key={row.message.id}
              label="Agent activity"
              messageIds={encodeURIComponent(row.message.id)}
              summary={<span>{activitySummary(row.message)}</span>}
            >
              <MessageView
                message={row.message}
                provider={provider}
                minimal
                agentWorkspace={agentWorkspace}
              />
            </ActivityDisclosure>
          )
        if (row.kind === 'context')
          return (
            <section className="thread-context-event" key={row.message.id}>
              <div className="thread-context-heading">
                <Minimize2 size={13} aria-hidden="true" />
                <span>
                  {row.message.kind === 'status'
                    ? row.message.title || 'Agent update'
                    : row.message.status === 'running'
                      ? 'Compacting context'
                      : 'Context compaction'}
                </span>
              </div>
              <MessageView
                message={row.message}
                provider={provider}
                agentWorkspace={agentWorkspace}
              />
            </section>
          )
        return (
          <div className="thread-commentary" key={row.message.id}>
            <MessageView
              message={row.message}
              provider={provider}
              agentWorkspace={agentWorkspace}
            />
          </div>
        )
      })}
    </div>
  )
}
