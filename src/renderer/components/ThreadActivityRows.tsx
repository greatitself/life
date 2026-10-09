import { useMemo } from 'react'
import { Bot, ChevronRight, Globe, Hammer, Minimize2, Terminal, Wrench } from 'lucide-react'
import type { Message, Thread } from '../state'
import {
  isSubagentActivity,
  isSubagentLaunch,
  reportedFileChanges,
  subagentTitle,
} from '../thread-activity'
import { MessageView } from './MessageView'

type Row =
  | { kind: 'message' | 'context'; message: Message }
  | { kind: 'tools' | 'agents'; messages: Message[] }
function rowsFor(messages: Message[]): Row[] {
  const rows: Row[] = []
  let batch: Extract<Row, { messages: Message[] }> | undefined
  for (const message of messages) {
    if (message.role !== 'tool' || /context.?compact|compaction/i.test(message.title || '')) {
      batch = undefined
      rows.push({ kind: message.role === 'tool' ? 'context' : 'message', message })
      continue
    }
    const kind = isSubagentActivity(message) ? 'agents' : 'tools'
    if (!batch || batch.kind !== kind) {
      batch = { kind, messages: [] }
      rows.push(batch)
    }
    batch.messages.push(message)
  }
  return rows
}
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
function describe(messages: Message[], agents: boolean) {
  const running = messages.some((message) => message.status === 'running')
  if (agents) {
    const launches = messages.filter(isSubagentLaunch).length
    return {
      Icon: Bot,
      label: launches
        ? `${running ? 'Running' : 'Ran'} ${plural(launches, 'subagent')}`
        : `Subagent activity · ${plural(messages.length, 'call')}`,
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
    label: label.charAt(0).toUpperCase() + label.slice(1),
  }
}
function ToolBatch({
  messages,
  agents,
  provider,
}: {
  messages: Message[]
  agents: boolean
  provider: Thread['provider']
}) {
  const { Icon, label } = useMemo(() => describe(messages, agents), [messages, agents])
  const running = messages.some((message) => message.status === 'running')
  const failures = messages.filter((message) => message.status === 'failed').length
  const interrupted = messages.some((message) => message.status === 'interrupted')
  return (
    <details className="thread-tool-batch" data-running={running || undefined}>
      <summary>
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        {running ? <i className="thread-run-ring" aria-hidden="true" /> : null}
        {failures ? (
          <small>{plural(failures, 'failure')}</small>
        ) : interrupted ? (
          <small>Interrupted</small>
        ) : null}
        <ChevronRight size={13} aria-hidden="true" />
      </summary>
      <div className="thread-tool-batch-content">
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={{
              ...message,
              title: agents ? subagentTitle(message) : message.title,
              text: [message.input, message.text !== message.input ? message.text : undefined]
                .filter(Boolean)
                .join('\n\n'),
            }}
            provider={provider}
          />
        ))}
      </div>
    </details>
  )
}
export function ThreadActivityRows({
  messages,
  provider,
}: {
  messages: Message[]
  provider: Thread['provider']
}) {
  const rows = useMemo(() => rowsFor(messages), [messages])
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
            />
          )
        if (row.kind === 'context')
          return (
            <details className="thread-context-event" key={row.message.id}>
              <summary>
                <Minimize2 size={13} aria-hidden="true" />
                <span>
                  {row.message.status === 'running' ? 'Compacting context' : 'Context compaction'}
                  {row.message.status === 'failed' ? ' · Failed' : ''}
                </span>
              </summary>
              <MessageView message={row.message} provider={provider} />
            </details>
          )
        return (
          <div className="thread-commentary" key={row.message.id}>
            <MessageView message={row.message} provider={provider} />
          </div>
        )
      })}
    </div>
  )
}
