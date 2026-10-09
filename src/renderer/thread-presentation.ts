import type { Message, Thread } from './state'

export interface TurnGroup {
  key: string
  turn: number
  user?: Message
  messages: Message[]
}

/** A steering request belongs to the running turn, not a new artificial response group. */
export function groupThreadTurns(messages: Message[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const byTurn = new Map<number, TurnGroup>()
  for (const message of messages) {
    let group = byTurn.get(message.turn)
    if (!group) {
      group = { key: `turn:${message.turn}:${message.id}`, turn: message.turn, messages: [] }
      byTurn.set(message.turn, group)
      groups.push(group)
      if (message.role === 'user') {
        group.user = message
        continue
      }
    }
    group.messages.push(message)
  }
  return groups
}

/** Never move a response past a tool, steering request, or error. */
export function threadOutputSequence(group: TurnGroup): Message[] {
  return group.messages
}

/** Keep live and unsuccessful work visible; only a completed parent response replaces activity. */
export function completedTurnResponse(
  group: TurnGroup,
  busy: boolean,
  turnStatus?: string,
): Message | undefined {
  if (busy || group.messages.some((message) => message.role === 'error')) return undefined
  const responses = group.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      !message.agentId &&
      !message.parentItemId &&
      !message.kind &&
      (message.text.trim() || message.attachments?.length || message.sourceChange),
  )
  const final = responses.filter((message) => message.phase === 'final_answer').at(-1)
  const response = final || responses.filter((message) => message.phase !== 'commentary').at(-1)
  const status = group.user?.finishStatus || turnStatus || response?.finishStatus
  return (status ? status === 'completed' : Boolean(final)) ? response : undefined
}

export function isProgressUpdate(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    !message.kind &&
    !message.agentId &&
    !message.parentItemId &&
    message.phase !== 'final_answer'
  )
}

/** Summaries use reported action text instead of exposing reasoning labels or provider metadata. */
export function activitySummary(message: Message): string {
  if (message.kind === 'plan') return 'Updated the plan'
  const title = message.title?.trim()
  if (title && !/^reasoning(?: summary)?$/i.test(title)) return title
  const line = message.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+)|[*`]/g, '').trim())
    .find(Boolean)
  return line ? `${line.slice(0, 120)}${line.length > 120 ? '…' : ''}` : 'Agent activity'
}

/** The finder only links to messages that are mounted in the preview timeline. */
export function previewNavigableMessages(thread: Thread): Message[] {
  return groupThreadTurns(thread.messages).flatMap((group) => {
    const response = completedTurnResponse(
      group,
      thread.busy && group.turn === thread.turn,
      group.turn === thread.turn ? thread.turnStatus : undefined,
    )
    return [
      ...(group.user ? [group.user] : []),
      ...(response
        ? [...group.messages.filter((message) => message.role === 'user'), response]
        : group.messages.filter(
            (message) =>
              message.role === 'user' ||
              isProgressUpdate(message) ||
              (message.role === 'assistant' &&
                !message.kind &&
                !message.agentId &&
                !message.parentItemId &&
                message.phase === 'final_answer'),
          )),
    ]
  })
}

export function messagePhaseLabel(message: Message): string | undefined {
  if (message.kind === 'reasoning') return 'Reasoning summary'
  if (message.kind === 'plan') return 'Plan'
  if (message.phase === 'commentary') return 'Progress update'
  if (message.phase === 'final_answer') return 'Response'
  return undefined
}

export interface PlanStep {
  text: string
  status?: string
}
export function providerPlanSteps(message: Message): PlanStep[] {
  if (message.kind !== 'plan') return []
  const value = message.details?.plan || message.details?.steps
  if (!Array.isArray(value)) return []
  return value.flatMap((value) => {
    const step = record(value)
    const label = text(step.step) || text(step.text) || text(step.content)
    return label ? [{ text: label, status: text(step.status) }] : []
  })
}

export interface ToolOutputSection {
  label: 'Input' | 'Output' | 'Provider details'
  text: string
}
const serializedDetails = new WeakMap<Record<string, unknown>, string>()
export function toolOutputSections(message: Message): ToolOutputSection[] {
  const sections: ToolOutputSection[] = []
  if (message.input) sections.push({ label: 'Input', text: message.input })
  if (message.text && message.text !== message.input)
    sections.push({ label: 'Output', text: message.text })
  if (message.details && Object.keys(message.details).length) {
    let text = serializedDetails.get(message.details)
    if (text === undefined) {
      text = JSON.stringify(message.details, null, 2)
      serializedDetails.set(message.details, text)
    }
    if (text !== message.text && text !== message.input)
      sections.push({ label: 'Provider details', text })
  }
  return sections
}

export interface OutputPreview {
  text: string
  shortened: boolean
  characters: number
}
/** Mount very large raw bodies only on demand; their exact text remains copyable/exportable. */
export function outputPreview(text: string, limit = 6000): OutputPreview {
  limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 6000
  if (text.length <= limit && text.split('\n').length <= 30)
    return { text, shortened: false, characters: text.length }
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  const beginning = text.slice(0, head).split('\n').slice(0, 20).join('\n')
  const ending = tail ? text.slice(-tail).split('\n').slice(-10).join('\n') : ''
  return {
    text: `${beginning}\n\n… ${Math.max(0, text.length - beginning.length - ending.length).toLocaleString()} characters in the full output …\n\n${ending}`,
    shortened: true,
    characters: text.length,
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
function parseInput(message: Message): Record<string, unknown> {
  try {
    return record(JSON.parse(message.input || '{}'))
  } catch {
    return {}
  }
}

export interface SubagentPresentation {
  name: string
  id?: string
  parentItemId?: string
  task?: string
  status: string
  participants: { id: string; name: string; status?: string; message?: string }[]
}
export function subagentPresentation(message: Message): SubagentPresentation {
  const input = parseInput(message)
  const details = record(message.details)
  const id = message.agentId || text(input.agent_id) || text(input.id) || text(details.agentId)
  const name =
    message.agentName ||
    text(input.task_name) ||
    text(input.name) ||
    text(input.description) ||
    text(input.subagent_type) ||
    text(details.agentName) ||
    id ||
    message.title ||
    'Subagent'
  const states = record(details.agentsStates || details.agents_states || details.agents)
  const participants = Object.entries(states).map(([id, value]) => {
    const state = record(value)
    return {
      id,
      name: text(state.agentName) || text(state.name) || id,
      status: text(state.status) || (typeof value === 'string' ? value : undefined),
      message: text(state.message) || text(state.result) || text(state.output),
    }
  })
  return {
    name,
    id,
    parentItemId: message.parentItemId,
    task:
      text(input.prompt) || text(input.message) || text(details.prompt) || text(details.message),
    status: message.status || 'completed',
    participants,
  }
}

/** Stable DOM anchors link nested provider activity without using untrusted IDs as selectors. */
export function activityAnchor(messageId: string): string {
  return `activity-${encodeURIComponent(messageId)}`
}
