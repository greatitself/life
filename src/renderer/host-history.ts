import type { HostHistoryPage } from '../shared/agent-history'
import { hostHistoryWorkspacePurpose } from '../shared/agent-history'
import type { Thread } from './state'

/** Import display data while retaining the provider's original resumable ID. */
export function hostHistoryThread(
  page: HostHistoryPage,
  profileId: string,
  machineHome?: string,
): Thread {
  const session = page.session
  const purpose = session.lifePurpose || hostHistoryWorkspacePurpose(session.workspace, machineHome)
  if (session.parentRemoteId)
    throw new Error('Open this subagent’s parent conversation to preserve its provider context.')
  if (purpose === 'research')
    throw new Error(
      'Open this conversation from Research to preserve its goal and problem context.',
    )
  if (purpose === 'customization')
    throw new Error(
      'Open this conversation in Life Studio. Studio sessions stay separate from Agents projects.',
    )
  if (purpose === 'metadata')
    throw new Error('This is an internal conversation-title task, not an Agents project chat.')
  return {
    id: crypto.randomUUID(),
    profileId,
    provider: session.provider,
    remoteId: session.remoteId,
    title: session.title,
    titleSource: 'provider',
    ...(session.workspace ? { workspace: session.workspace } : { workspaceUnknown: true }),
    messages: page.messages.map((message) => ({ ...message })),
    busy: false,
    pending: [],
    queue: [],
    model: session.model || '',
    reasoningEffort: session.reasoningEffort || '',
    mode: 'review',
    updatedAt: session.updatedAt || Date.now(),
    turn: page.messages.reduce((maximum, message) => Math.max(maximum, message.turn), 0),
    importedHistory: {
      provider: session.provider,
      remoteId: session.remoteId,
      importedAt: Date.now(),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
  }
}

export function appendHostHistory(thread: Thread, page: HostHistoryPage): Thread {
  if (thread.provider !== page.session.provider || thread.remoteId !== page.session.remoteId)
    throw new Error('This history page belongs to a different provider conversation.')
  // Life-created threads already have their own display history. Their local
  // message IDs differ from provider transcript IDs; merging would duplicate
  // the same human prompts and model answers when choosing "Open in Life".
  if (!thread.importedHistory) return thread
  // A fresh preview can include turns subsequently created inside Life. Open
  // the saved thread unchanged; only its original frozen continuation merges.
  if (!page.continuationOf || page.continuationOf !== thread.importedHistory.nextCursor)
    return thread
  const prefix = `${thread.provider}:`
  const nativeMessages = thread.messages.filter((message) => message.id.startsWith(prefix))
  const oldNativeTurn = nativeMessages.reduce(
    (maximum, message) => Math.max(maximum, message.turn),
    0,
  )
  const byId = new Map(nativeMessages.map((message) => [message.id, message]))
  for (const message of page.messages) byId.set(message.id, { ...message })
  const newNativeTurn = [...byId.values()].reduce(
    (maximum, message) => Math.max(maximum, message.turn),
    oldNativeTurn,
  )
  const turnShift = Math.max(0, newNativeTurn - oldNativeTurn)
  const lifeMessages = thread.messages
    .filter((message) => !message.id.startsWith(prefix))
    .map((message) => ({
      ...message,
      turn: message.turn + turnShift,
      id:
        turnShift && message.id.startsWith(`${message.turn}:`)
          ? `${message.turn + turnShift}:${message.id.slice(String(message.turn).length + 1)}`
          : message.id,
    }))
  return {
    ...thread,
    messages: [...byId.values(), ...lifeMessages],
    turn: Math.max(thread.turn + turnShift, newNativeTurn),
    ...(thread.agentTurns
      ? {
          agentTurns: Object.fromEntries(
            Object.entries(thread.agentTurns).map(([id, turn]) => [id, turn + turnShift]),
          ),
        }
      : {}),
    importedHistory: {
      provider: page.session.provider,
      remoteId: page.session.remoteId,
      importedAt: thread.importedHistory?.importedAt || Date.now(),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
  }
}
