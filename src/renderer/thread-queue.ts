import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConnectionState } from '../shared/types'
import { researchOperations, type ResearchOperation } from '../shared/research-method'
import type { Thread } from './state'
import { errorText } from './api'
import { webInterface } from './web-interface'
import {
  attachmentMetadata,
  deleteAttachmentFiles,
  getAttachmentFile,
  normalizeThreadAttachments,
  saveAttachmentFiles,
  type DraftAttachment,
  type ThreadAttachment,
} from './attachments'

export interface QueuedMessage {
  id: string
  text: string
  createdAt: number
  attachments: ThreadAttachment[]
  paused?: boolean
  error?: string
  /** Legacy desktop selection; web messages use only the user's prompt. */
  researchOperation?: ResearchOperation
}
export interface QueuedSubmission {
  threadId: string
  messageId: string
  files: DraftAttachment[]
}
export function normalizeQueuedMessages(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return []
  const result: QueuedMessage[] = []
  const ids = new Set<string>()
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<QueuedMessage>
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) || ids.has(item.id))
      continue
    if (typeof item.text !== 'string' || item.text.length > 1_000_000) continue
    const attachments = normalizeThreadAttachments(item.attachments)
    if (!item.text.trim() && !attachments.length) continue
    ids.add(item.id)
    result.push({
      id: item.id,
      text: item.text,
      createdAt:
        typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      attachments,
      // Restoring history must not replay pending work against a new connection.
      paused: true,
      ...(!webInterface &&
      typeof item.researchOperation === 'string' &&
      researchOperations.includes(item.researchOperation)
        ? { researchOperation: item.researchOperation }
        : {}),
      ...(typeof item.error === 'string' ? { error: item.error.slice(0, 2000) } : {}),
    })
  }
  return result
}
export function pauseQueuedMessages(messages: QueuedMessage[] = []): QueuedMessage[] {
  return messages.map((message) => ({ ...message, paused: true }))
}
function researchEnvironmentMatches(thread: Thread, connection: ConnectionState): boolean {
  const home = connection.home?.startsWith('/')
    ? connection.home.replace(/\/+$/, '') || '/'
    : undefined
  const scopeKey = thread.researchContext?.scopeKey
  if (scopeKey) {
    try {
      const scope: unknown = JSON.parse(scopeKey)
      if (Array.isArray(scope) && scope[0] === 'research')
        return (
          scope.length === 3 &&
          scope[1] === thread.profileId &&
          typeof scope[2] === 'string' &&
          scope[2].startsWith('/') &&
          Boolean(home) &&
          (scope[2].replace(/\/+$/, '') || '/') === home
        )
    } catch {
      // Older research histories did not record the machine's home in their scope key.
    }
  }
  if (home) {
    const base = home === '/' ? '' : home
    return ['/.life/research', '/.research'].some((directory) => {
      const root = base + directory
      return thread.workspace === root || thread.workspace?.startsWith(root + '/')
    })
  }
  // Legacy machine context can only be proven by the folder currently selected on that machine.
  return thread.workspace === connection.workspace
}
export function queueConnectionMatches(thread: Thread, connection: ConnectionState): boolean {
  return (
    connection.status === 'connected' &&
    thread.profileId === connection.profile?.id &&
    Boolean(thread.workspace?.startsWith('/')) &&
    (thread.purpose === 'research'
      ? researchEnvironmentMatches(thread, connection)
      : thread.workspace === connection.workspace)
  )
}
/** Only the provider's completed turn releases an automatic follow-up. */
export function canAutoSendQueuedMessage(
  thread: Thread,
  connection: ConnectionState,
  blocked = false,
): boolean {
  const message = thread.queue?.[0]
  if (
    !message ||
    message.paused ||
    message.error ||
    thread.busy ||
    thread.pending.length ||
    blocked ||
    !queueConnectionMatches(thread, connection)
  )
    return false
  if (thread.turnStatus) return thread.turnStatus === 'completed'
  if (thread.turn === 0) return true
  // A legacy idle flag on its own does not prove that the preceding turn finished.
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const previous = thread.messages[index]
    if (previous.role === 'user') return previous.finishStatus === 'completed'
  }
  return false
}
export function threadAttachmentIds(thread: Thread): string[] {
  return [
    ...thread.messages.flatMap((message) =>
      (message.attachments || []).map((attachment) => attachment.id),
    ),
    ...(thread.queue || []).flatMap((message) =>
      message.attachments.map((attachment) => attachment.id),
    ),
  ]
}
async function loadQueuedAttachmentFiles(message: QueuedMessage): Promise<DraftAttachment[]> {
  return Promise.all(
    message.attachments.map(async (attachment) => {
      const blob = await getAttachmentFile(attachment.id)
      if (!blob)
        throw new Error(
          `The attachment ${attachment.name} is unavailable. Remove this message and attach it again.`,
        )
      return {
        ...attachment,
        file: new File([blob], attachment.name, { type: attachment.mime }),
      }
    }),
  )
}
interface QueueOptions {
  threads: Thread[]
  connection: ConnectionState
  onThreads: Dispatch<SetStateAction<Thread[]>>
  onError: (message: string) => void
  send: (submission: QueuedSubmission) => Promise<boolean | undefined>
  /** Native in-turn input; accepting steering never interrupts or starts a replacement turn. */
  steer?: (submission: QueuedSubmission) => Promise<boolean | undefined>
  /** Older bridges may provide stop, but queue dispatch never calls it. */
  stop?: (thread: Thread) => Promise<void>
  isBlocked: (threadId: string) => boolean
}
export function useThreadQueue(options: QueueOptions) {
  const context = useRef(options)
  context.current = options
  const mounted = useRef(true)
  const saving = useRef(false)
  const pumping = useRef(false)
  const dispatching = useRef(false)
  const cancelled = useRef(new Set<string>())
  const [preparing, setPreparing] = useState(false)
  const [operation, setOperation] = useState<{ threadId: string; id: string }>()
  const [revision, setRevision] = useState(0)
  const wake = useCallback(() => {
    if (mounted.current) setRevision((value) => value + 1)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const pause = useCallback((threadId: string) => {
    context.current.onThreads((previous) =>
      previous.map((thread) =>
        thread.id === threadId ? { ...thread, queue: pauseQueuedMessages(thread.queue) } : thread,
      ),
    )
  }, [])
  const restore = useCallback((threadId: string, message: QueuedMessage, failure: string) => {
    if (!mounted.current || cancelled.current.has(message.id)) return
    context.current.onThreads((previous) =>
      previous.map((thread) => {
        if (thread.id !== threadId) return thread
        const queue = thread.queue || []
        const restored = { ...message, paused: true, error: failure.slice(0, 2000) }
        return {
          ...thread,
          queue: queue.some((item) => item.id === message.id)
            ? queue.map((item) => (item.id === message.id ? restored : item))
            : [restored, ...queue],
        }
      }),
    )
  }, [])
  const enqueue = useCallback(
    async (
      thread: Thread,
      text: string,
      files: DraftAttachment[],
      researchOperation?: ResearchOperation,
    ): Promise<string | undefined> => {
      if (saving.current) return undefined
      const current = context.current.threads.find((item) => item.id === thread.id)
      if (!current) return undefined
      if (
        !webInterface &&
        researchOperation !== undefined &&
        !researchOperations.includes(researchOperation)
      ) {
        context.current.onError(
          'Choose a supported research operation before queueing this message.',
        )
        return undefined
      }
      if ((!text.trim() && !files.length) || text.length > 1_000_000) {
        context.current.onError(
          'Enter a message or attach files, with up to one million characters.',
        )
        return undefined
      }
      if ((current.queue?.length || 0) + (pumping.current ? 1 : 0) >= 32) {
        context.current.onError(
          'This thread has 32 queued messages. Send or remove one before adding another.',
        )
        return undefined
      }
      saving.current = true
      setPreparing(true)
      try {
        await saveAttachmentFiles(files)
        if (!mounted.current) return undefined
        const message: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          createdAt: Date.now(),
          attachments: files.map(attachmentMetadata),
          paused: !queueConnectionMatches(current, context.current.connection),
          ...(!webInterface && researchOperation ? { researchOperation } : {}),
        }
        context.current.onThreads((previous) =>
          previous.map((item) =>
            item.id === current.id
              ? {
                  ...item,
                  ...(item.busy && item.turnStatus !== 'reconnecting'
                    ? { turnStatus: 'running' as const }
                    : {}),
                  queue: [...(item.queue || []), message],
                }
              : item,
          ),
        )
        return message.id
      } catch (error) {
        context.current.onError(errorText(error))
        return undefined
      } finally {
        saving.current = false
        if (mounted.current) setPreparing(false)
        wake()
      }
    },
    [wake],
  )
  const remove = useCallback(
    (threadId: string, messageId: string) => {
      cancelled.current.add(messageId)
      const snapshot = context.current.threads
      const message = snapshot
        .find((thread) => thread.id === threadId)
        ?.queue?.find((item) => item.id === messageId)
      const retained = new Set(
        snapshot.flatMap((thread) => [
          ...thread.messages.flatMap((item) =>
            (item.attachments || []).map((attachment) => attachment.id),
          ),
          ...(thread.queue || [])
            .filter((item) => item.id !== messageId)
            .flatMap((item) => item.attachments.map((attachment) => attachment.id)),
        ]),
      )
      context.current.onThreads((previous) =>
        previous.map((thread) =>
          thread.id === threadId
            ? { ...thread, queue: (thread.queue || []).filter((item) => item.id !== messageId) }
            : thread,
        ),
      )
      const removed = (message?.attachments || [])
        .map((item) => item.id)
        .filter((id) => !retained.has(id))
      void deleteAttachmentFiles(removed).catch((error) =>
        context.current.onError(errorText(error)),
      )
      wake()
    },
    [wake],
  )
  const sendNow = useCallback(
    async (threadId: string, messageId: string) => {
      if (pumping.current || dispatching.current || saving.current) return
      const current = context.current
      const thread = current.threads.find((item) => item.id === threadId)
      const selected = thread?.queue?.find((item) => item.id === messageId)
      if (!thread || !selected || cancelled.current.has(messageId)) return
      if (!queueConnectionMatches(thread, current.connection)) {
        current.onError('Select this thread’s machine and project to send its queued message.')
        return
      }
      if (current.isBlocked(threadId)) return
      dispatching.current = true
      setOperation({ threadId, id: messageId })
      try {
        const files = await loadQueuedAttachmentFiles(selected)
        if (!mounted.current || cancelled.current.has(messageId)) return
        const latest = context.current
        const target = latest.threads.find((item) => item.id === threadId)
        if (!target?.queue?.some((item) => item.id === messageId)) return
        if (!queueConnectionMatches(target, latest.connection) || latest.isBlocked(threadId))
          throw new Error('The connection or project changed. The queued message is paused.')
        const submission = { threadId, messageId, files }
        if (!target.busy) {
          // Explicit sending of a paused follow-up is allowed; automatic sending remains gated.
          const sent = await latest.send(submission)
          if (sent !== true)
            restore(threadId, selected, 'Message was not sent. Use Send now to retry.')
          return
        }
        if (!latest.steer)
          throw new Error(
            'This provider connection cannot accept steering. The message remains queued.',
          )
        const turn = target.turn
        const insertionIndex = target.messages.length
        const sentAt = Date.now()
        const accepted = await latest.steer(submission)
        if (accepted !== true) {
          restore(
            threadId,
            selected,
            'Steering was not accepted. The message remains paused; retry when ready.',
          )
          return
        }
        if (!mounted.current) return
        latest.onThreads((previous) =>
          previous.map((item) => {
            if (item.id !== threadId) return item
            const steeringId = `steering:${selected.id}`
            if (item.messages.some((message) => message.id === steeringId)) return item
            const messages = [...item.messages]
            // Insert before output that arrived while the provider acknowledged this input.
            messages.splice(Math.min(insertionIndex, messages.length), 0, {
              id: steeringId,
              role: 'user',
              text: selected.text,
              turn,
              createdAt: sentAt,
              submission: 'steering',
              attachments: selected.attachments,
              ...(!item.busy && item.turn === turn && item.turnStatus
                ? { finishedAt: Date.now(), finishStatus: item.turnStatus }
                : {}),
            })
            return {
              ...item,
              messages,
              queue: (item.queue || []).filter((entry) => entry.id !== messageId),
              updatedAt: sentAt,
            }
          }),
        )
      } catch (error) {
        restore(threadId, selected, errorText(error))
        context.current.onError(errorText(error))
      } finally {
        dispatching.current = false
        if (mounted.current) setOperation(undefined)
        wake()
      }
    },
    [restore, wake],
  )

  useEffect(() => {
    if (!mounted.current || saving.current || pumping.current || dispatching.current) return
    const candidate = options.threads.find((thread) =>
      canAutoSendQueuedMessage(thread, options.connection, options.isBlocked(thread.id)),
    )
    const message = candidate?.queue?.[0]
    if (!candidate || !message) return
    pumping.current = true
    setOperation({ threadId: candidate.id, id: message.id })
    void (async () => {
      try {
        const files = await loadQueuedAttachmentFiles(message)
        if (!mounted.current || cancelled.current.has(message.id)) return
        const latest = context.current
        const thread = latest.threads.find((item) => item.id === candidate.id)
        if (!thread?.queue?.some((item) => item.id === message.id)) return
        if (thread.queue[0]?.id !== message.id) return
        if (!canAutoSendQueuedMessage(thread, latest.connection, latest.isBlocked(thread.id)))
          throw new Error('The thread is not ready to send. Use Send now to resume this message.')
        const sent = await latest.send({ threadId: thread.id, messageId: message.id, files })
        if (sent !== true)
          restore(thread.id, message, 'Message was not sent. Use Send now to retry.')
      } catch (error) {
        restore(candidate.id, message, errorText(error))
        context.current.onError(errorText(error))
      } finally {
        pumping.current = false
        if (mounted.current) setOperation(undefined)
        wake()
      }
    })()
  }, [options.threads, options.connection, revision, restore, wake])

  return {
    enqueue,
    remove,
    pause,
    sendNow,
    wake,
    preparing,
    actionId: operation?.id,
    sendingThreadId: operation?.threadId,
  }
}
