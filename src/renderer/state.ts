import type {
  AgentEvent,
  ConnectionProfile,
  ConnectionState,
  ModelOption,
  PermissionMode,
  Provider,
} from '../shared/types'
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  title?: string
  status?: string
  turn: number
}
export interface Thread {
  id: string
  profileId: string
  /** Canonical remote project folder associated with the provider conversation. */
  workspace?: string
  /** A previous remote conversation had no resolvable project; never adopt a later project's folder. */
  workspaceUnknown?: boolean
  provider: Provider
  title: string
  remoteId?: string
  messages: Message[]
  busy: boolean
  model: string
  reasoningEffort?: string
  serviceTier?: string
  mode: PermissionMode
  updatedAt: number
  turn: number
  pending: AgentEvent[]
  /** Follow-up messages retain Life scope until the user returns to their project. */
  lifeScope?: boolean
}
function validModelChoice(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    ? value
    : ''
}
export function normalizeModelChoices(
  model: ModelOption | undefined,
  choices: { reasoningEffort?: string; serviceTier?: string },
): { reasoningEffort: string; serviceTier: string } {
  const reasoningEffort = validModelChoice(choices.reasoningEffort)
  const serviceTier = validModelChoice(choices.serviceTier)
  return {
    reasoningEffort:
      reasoningEffort &&
      Array.isArray(model?.supportedReasoningEfforts) &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === reasoningEffort)
        ? ''
        : reasoningEffort,
    serviceTier:
      serviceTier &&
      Array.isArray(model?.serviceTiers) &&
      !model.serviceTiers.some((option) => option.id === serviceTier)
        ? ''
        : serviceTier,
  }
}
export function readThreads(): Thread[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem('relay.threads.v1') || '[]')
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.profileId === 'string' &&
          ['codex', 'claude'].includes(t.provider) &&
          Array.isArray(t.messages),
      )
      .map((t) => ({
        id: t.id,
        profileId: t.profileId,
        ...(typeof t.workspace === 'string' &&
        t.workspace.startsWith('/') &&
        !/[\x00-\x1f]/.test(t.workspace)
          ? { workspace: t.workspace }
          : {}),
        ...(t.workspaceUnknown === true ? { workspaceUnknown: true } : {}),
        provider: t.provider as Provider,
        title: typeof t.title === 'string' && t.title.trim() ? t.title : 'Untitled thread',
        remoteId: typeof t.remoteId === 'string' ? t.remoteId : undefined,
        messages: t.messages
          .filter(
            (message: Partial<Message> | null) =>
              message &&
              typeof message.id === 'string' &&
              ['user', 'assistant', 'tool', 'error'].includes(message.role || '') &&
              typeof message.text === 'string',
          )
          .map((message: Message) => ({
            ...message,
            title: typeof message.title === 'string' ? message.title : undefined,
            status:
              message.role === 'tool' && message.status === 'running'
                ? 'interrupted'
                : typeof message.status === 'string'
                  ? message.status
                  : undefined,
            turn: Number.isInteger(message.turn) ? message.turn : 0,
          })),
        busy: false,
        pending: [],
        ...(t.lifeScope === true ? { lifeScope: true } : {}),
        turn: Number.isInteger(t.turn) && t.turn >= 0 ? t.turn : 0,
        mode: ['review', 'edit', 'plan'].includes(t.mode)
          ? (t.mode as PermissionMode)
          : ('review' as const),
        model: typeof t.model === 'string' ? t.model : '',
        ...(t.reasoningEffort !== undefined
          ? { reasoningEffort: validModelChoice(t.reasoningEffort) }
          : {}),
        ...(t.serviceTier !== undefined ? { serviceTier: validModelChoice(t.serviceTier) } : {}),
        updatedAt:
          typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}
export function bindLegacyThreadWorkspace(thread: Thread, connection: ConnectionState): Thread {
  if (
    connection.status !== 'connected' ||
    thread.profileId !== connection.profile?.id ||
    !thread.remoteId ||
    thread.workspace ||
    thread.workspaceUnknown
  )
    return thread
  return connection.lastWorkspace
    ? { ...thread, workspace: connection.lastWorkspace }
    : { ...thread, workspaceUnknown: true }
}
export function applyEvent(thread: Thread, event: AgentEvent): Thread {
  if (event.type === 'session') return { ...thread, remoteId: event.remoteId }
  if (event.type === 'complete')
    return {
      ...thread,
      busy: false,
      pending: [],
      messages: thread.messages.map((m) =>
        m.role === 'tool' && m.status === 'running'
          ? { ...m, status: event.status === 'interrupted' ? 'interrupted' : 'completed' }
          : m,
      ),
    }
  if (event.type === 'approval' || event.type === 'question')
    return {
      ...thread,
      pending: [...thread.pending.filter((p) => p.requestId !== event.requestId), event],
    }
  if (event.type === 'status') return thread
  if (event.type === 'error')
    return {
      ...thread,
      busy: false,
      pending: [],
      messages: [
        ...thread.messages,
        {
          id: crypto.randomUUID(),
          role: 'error',
          text: event.text || 'The agent could not finish this turn.',
          turn: thread.turn,
        },
      ],
    }
  const id = `${thread.turn}:${event.itemId || 'response'}`
  const index = thread.messages.findIndex((m) => m.id === id)
  const previous = index >= 0 ? thread.messages[index] : undefined
  const text =
    event.status === 'replace'
      ? event.text || ''
      : event.type === 'tool'
        ? event.text || previous?.text || ''
        : (previous?.text || '') + (event.text || '')
  const message: Message = {
    id,
    role: event.type === 'text' ? 'assistant' : 'tool',
    text,
    title: event.title || previous?.title,
    status: event.status || previous?.status,
    turn: thread.turn,
  }
  return {
    ...thread,
    messages:
      index >= 0
        ? thread.messages.map((m, i) => (i === index ? message : m))
        : [...thread.messages, message],
  }
}
export const profileName = (profile?: ConnectionProfile) => profile?.name || 'Remote workspace'
