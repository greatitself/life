import type { AgentEvent, ConnectionProfile, PermissionMode, Provider } from '../shared/types'
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
  provider: Provider
  title: string
  remoteId?: string
  messages: Message[]
  busy: boolean
  model: string
  mode: PermissionMode
  updatedAt: number
  turn: number
  pending: AgentEvent[]
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
        turn: Number.isInteger(t.turn) && t.turn >= 0 ? t.turn : 0,
        mode: ['review', 'edit', 'plan'].includes(t.mode)
          ? (t.mode as PermissionMode)
          : ('review' as const),
        model: typeof t.model === 'string' ? t.model : '',
        updatedAt:
          typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
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
