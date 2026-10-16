import { memo, useEffect, useMemo, useRef } from 'react'
import { Bot, Check } from 'lucide-react'
import type { Message, Thread } from '../state'
import { subagentPresentation, threadRunningChildIds, toolLifecycle } from '../thread-presentation'
import { savedUsageSessions } from '../usage'
import './agents-panel.css'

type AgentStatus = 'working' | 'idle' | 'completed' | 'failed' | 'stopped' | 'unknown'
interface AgentRow {
  id: string
  name: string
  role?: string
  status: AgentStatus
  nativeStatus?: string
  lifecycleStatus?: string
  unknown: boolean
  startedAt?: number
  finishedAt?: number
  progress?: string
  result?: string
  error?: string
  tool?: string
  model?: string
  totalTokens?: number
}

const statusLabels: Record<AgentStatus, string> = {
  working: 'Working',
  idle: 'Idle · resumable',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  unknown: 'Status unknown',
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
function inputOf(message: Message): Record<string, unknown> {
  try {
    return record(JSON.parse(message.input || '{}'))
  } catch {
    return {}
  }
}

/** Native child identities and lifecycle projections, in their first observed order. */
function projectAgents(thread: Thread): AgentRow[] {
  const rows = new Map<string, AgentRow>()
  const aliases = new Map<string, string>()
  if (thread.provider === 'claude')
    for (const message of thread.messages)
      if (message.kind === 'subagent' && message.agentId && message.parentItemId)
        aliases.set(message.parentItemId, message.agentId)
  const identity = (id: string) => aliases.get(id) || id
  const ensure = (id: string, name?: string) => {
    id = identity(id)
    let row = rows.get(id)
    if (!row) {
      row = { id, name: name || id, status: 'unknown', unknown: true }
      rows.set(id, row)
    }
    if (name && identity(name) !== id) row.name = name
    return row
  }

  for (const message of thread.messages) {
    const presentation = message.kind === 'subagent' ? subagentPresentation(message) : undefined
    const id = message.agentId || message.parentItemId || presentation?.id
    const row = id ? ensure(id, message.agentName || presentation?.name) : undefined
    if (row) {
      const details = record(message.details)
      const input = message.kind === 'subagent' ? inputOf(message) : {}
      row.model = text(details.model) || text(input.model) || row.model
      row.role = text(input.subagent_type) || text(details.agentRole) || row.role
      if (!message.activityStateUnknown) {
        row.unknown = false
        if (message.kind === 'subagent') {
          if (message.status) row.nativeStatus = message.status
          const lifecycle = details.lifecycle === 'turn' || Boolean(text(details.run_id))
          if (lifecycle && message.status) {
            if (
              toolLifecycle(message.status) === 'active' &&
              toolLifecycle(row.lifecycleStatus) !== 'active'
            ) {
              row.startedAt = message.createdAt
              row.finishedAt = undefined
            }
            row.lifecycleStatus = message.status
          }
          if (toolLifecycle(message.status) === 'active' || lifecycle || message.finishedAt)
            row.startedAt ??= message.createdAt
          if (message.finishedAt) row.finishedAt = message.finishedAt
        }
      } else if (!row.nativeStatus) row.nativeStatus = message.status
      // Historical output remains inspectable even when its activity is unverified.
      if (message.kind === 'subagent') {
        row.progress = text(details.progress) || text(details.summary) || row.progress
        row.result = text(details.result) || row.result
        row.error = text(details.error) || row.error
        if (message.text.trim()) {
          if (toolLifecycle(message.status) === 'failed') row.error = message.text
          else if (details.lifecycle === 'turn' && toolLifecycle(message.status) === 'completed')
            row.result = message.text
          else row.progress = message.text
        }
      } else if (message.role === 'error') row.error = text(message.text) || row.error
      else if (message.role === 'assistant' && !message.kind) {
        if (message.phase === 'final_answer') row.result = text(message.text) || row.result
        else row.progress = text(message.text) || row.progress
      } else if (message.role === 'tool' && !message.kind && message.title) row.tool = message.title
    }
    for (const participant of presentation?.participants || []) {
      const member = ensure(participant.id, participant.name)
      if (participant.message) member.result = participant.message
      // Cold snapshots retain old provider details without attesting current activity.
      if (message.activityStateUnknown || toolLifecycle(message.status) === 'interrupted') continue
      member.unknown = false
      if (participant.status) member.nativeStatus = participant.status
    }
  }

  const running = new Set([...threadRunningChildIds(thread.messages)].map(identity))
  for (const request of thread.pending)
    if (request.agentId) {
      const row = ensure(request.agentId, request.agentName)
      row.unknown = false
      running.add(row.id)
    }
  for (const row of rows.values()) {
    const status = row.lifecycleStatus || row.nativeStatus
    const lifecycle = toolLifecycle(status)
    row.status = running.has(row.id)
      ? 'working'
      : row.unknown
        ? lifecycle === 'interrupted'
          ? 'stopped'
          : 'unknown'
        : status?.toLowerCase() === 'idle'
          ? 'idle'
          : lifecycle === 'failed'
            ? 'failed'
            : lifecycle === 'interrupted'
              ? 'stopped'
              : status && lifecycle === 'completed'
                ? 'completed'
                : 'unknown'
  }
  for (const usage of savedUsageSessions([thread])) {
    if (!usage.agentId) continue
    const row = rows.get(identity(usage.agentId))
    if (!row) continue
    if (usage.model !== 'Not reported') row.model = usage.model
    if (usage.tokens.totalTokens !== undefined)
      row.totalTokens = (row.totalTokens ?? 0) + usage.tokens.totalTokens
  }
  return [...rows.values()]
}

function elapsed(agent: AgentRow): string {
  if (agent.startedAt === undefined) return ''
  const end = agent.status === 'working' ? Date.now() : agent.finishedAt
  if (end === undefined) return ''
  const seconds = Math.max(0, Math.floor((end - agent.startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
const tokenFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const tokens = (value: number): string => tokenFormatter.format(value)

export const AgentsPanel = memo(
  function AgentsPanel({ thread, active }: { thread?: Thread; active: boolean }) {
    const lastVisible = useRef<AgentRow[]>([])
    const agents = useMemo(
      () => (!active ? lastVisible.current : thread ? projectAgents(thread) : []),
      [active, thread],
    )
    const rowsRef = useRef(agents)
    const clocks = useRef(new Map<string, HTMLSpanElement>())
    useEffect(() => {
      if (active) lastVisible.current = agents
      rowsRef.current = agents
    }, [active, agents])
    const hasLiveClock = agents.some(
      (agent) => agent.status === 'working' && agent.startedAt !== undefined,
    )
    useEffect(() => {
      if (!active || !hasLiveClock) return
      let timer: ReturnType<typeof setInterval> | undefined
      const update = () => {
        for (const agent of rowsRef.current) {
          const clock = clocks.current.get(agent.id)
          if (clock && agent.status === 'working') clock.textContent = elapsed(agent)
        }
      }
      const visibility = () => {
        clearInterval(timer)
        if (document.hidden) return
        update()
        timer = setInterval(update, 1000)
      }
      visibility()
      document.addEventListener('visibilitychange', visibility)
      return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', visibility)
      }
    }, [active, hasLiveClock, thread?.id])

    if (!agents.length)
      return (
        <div className="agents-panel-empty">
          <Bot size={24} aria-hidden="true" />
          <p>No agents yet</p>
          <span>
            When this thread spawns subagents or runs a workflow, they show up here with live
            status, activity, and token usage.
          </span>
        </div>
      )

    const working = agents.filter((agent) => agent.status === 'working').length
    const idle = agents.filter((agent) => agent.status === 'idle').length
    const unknown = agents.filter((agent) => agent.status === 'unknown').length
    const settled = agents.length - working - idle - unknown
    const knownTokens = agents.flatMap((agent) =>
      agent.totalTokens === undefined ? [] : [agent.totalTokens],
    )
    return (
      <div className="agents-panel">
        <div className="agents-panel-scroll">
          <section className="agents-panel-roster" aria-label="Direct spawns">
            <div className="agents-panel-section-label">Direct spawns</div>
            {agents.map((agent) => {
              const activity =
                agent.status === 'working'
                  ? agent.progress ||
                    (agent.tool ? `▸ ${agent.tool}` : '') ||
                    agent.result ||
                    agent.error
                  : agent.error ||
                    agent.result ||
                    agent.progress ||
                    (agent.tool ? `▸ ${agent.tool}` : '')
              const role =
                agent.role?.toLowerCase() === agent.name.toLowerCase() ? undefined : agent.role
              return (
                <div
                  className="agents-panel-row"
                  data-agent-id={agent.id}
                  data-status={agent.status}
                  key={agent.id}
                >
                  <span className="agents-panel-dot" aria-hidden="true" />
                  <span className="agents-panel-identity">
                    <span className="agents-panel-name" title={agent.id}>
                      {agent.name}
                    </span>
                    {role ? <span className="agents-panel-role">{role}</span> : null}
                  </span>
                  <span className="agents-panel-timing">
                    <span
                      ref={(node) => {
                        if (node) clocks.current.set(agent.id, node)
                        else clocks.current.delete(agent.id)
                      }}
                    >
                      {elapsed(agent)}
                    </span>
                    {agent.status === 'completed' ? <Check size={12} aria-hidden="true" /> : null}
                  </span>
                  <span
                    className="agents-panel-activity"
                    title={activity || statusLabels[agent.status]}
                  >
                    {activity || statusLabels[agent.status]}
                  </span>
                  <span className="agents-panel-metadata">
                    {[
                      agent.model,
                      agent.totalTokens === undefined
                        ? '— tok'
                        : `${tokens(agent.totalTokens)} tok`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="agents-panel-status">{statusLabels[agent.status]}</span>
                </div>
              )
            })}
          </section>
        </div>
        <footer className="agents-panel-footer">
          <span className="agents-panel-counts">
            {working ? <span className="agents-panel-working">● {working} working</span> : null}
            {idle ? <span>{idle} idle</span> : null}
            {settled ? <span>{settled} settled</span> : null}
            {unknown ? <span>{unknown} unknown</span> : null}
          </span>
          <span
            title={
              knownTokens.length < agents.length
                ? 'Some agents have no reported token usage'
                : undefined
            }
          >
            Σ{' '}
            {knownTokens.length ? tokens(knownTokens.reduce((sum, value) => sum + value, 0)) : '—'}{' '}
            tok
          </span>
        </footer>
      </div>
    )
  },
  (previous, next) =>
    (!previous.active && !next.active) ||
    (previous.active === next.active && previous.thread === next.thread),
)
