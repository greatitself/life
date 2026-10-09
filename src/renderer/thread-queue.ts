import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConnectionState } from '../shared/types'
import type { Thread } from './state'
import { errorText } from './api'
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
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1_000_000) continue
    ids.add(item.id)
    result.push({
      id: item.id,
      text: item.text,
      createdAt:
        typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      attachments: normalizeThreadAttachments(item.attachments),
      // Restoring history must not replay pending work against a new connection.
      paused: true,
      ...(typeof item.error === 'string' ? { error: item.error.slice(0, 2000) } : {}),
    })
  }
  return result
}
export function pauseQueuedMessages(messages: QueuedMessage[] = []): QueuedMessage[] {
  return messages.map((message) => ({ ...message, paused: true }))
}
export function queueConnectionMatches(thread: Thread, connection: ConnectionState): boolean {
  return (
    connection.status === 'connected' &&
    Boolean(connection.workspace) &&
    thread.profileId === connection.profile?.id &&
    thread.workspace === connection.workspace
  )
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
interface QueueOptions {
  threads: Thread[]
  connection: ConnectionState
  onThreads: Dispatch<SetStateAction<Thread[]>>
  onError: (message: string) => void
  send: (submission: QueuedSubmission) => Promise<boolean | undefined>
  stop: (thread: Thread) => Promise<void>
  isBlocked: (threadId: string) => boolean
}
export function useThreadQueue(options: QueueOptions) {
  const context = useRef(options)
  context.current = options
  const mounted = useRef(true)
  const saving = useRef(false)
  const pumping = useRef(false)
  const stopping = useRef(false)
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
    async (thread: Thread, text: string, files: DraftAttachment[]): Promise<string | undefined> => {
      if (saving.current) return undefined
      const current = context.current.threads.find((item) => item.id === thread.id)
      if (!current) return undefined
      if (!text.trim() || text.length > 1_000_000) {
        context.current.onError('Enter a message of up to one million characters.')
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
          paused: stopping.current || !queueConnectionMatches(current, context.current.connection),
        }
        context.current.onThreads((previous) =>
          previous.map((item) =>
            item.id === current.id ? { ...item, queue: [...(item.queue || []), message] } : item,
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
      if (pumping.current || stopping.current || saving.current) return
      const current = context.current
      const thread = current.threads.find((item) => item.id === threadId)
      const selected = thread?.queue?.find((item) => item.id === messageId)
      if (!thread || !selected || cancelled.current.has(messageId)) return
      if (!queueConnectionMatches(thread, current.connection)) {
        current.onError('Select this thread’s machine and project to send its queued message.')
        return
      }
      if (current.isBlocked(threadId)) return
      const previousStatus = new Map((thread.queue || []).map((item) => [item.id, item.paused]))
      stopping.current = true
      setOperation({ threadId, id: messageId })
      try {
        // The bridge resumes the existing provider conversation after interruption.
        await current.stop(thread)
        if (!mounted.current || cancelled.current.has(messageId)) return
        if (!queueConnectionMatches(thread, context.current.connection))
          throw new Error('The connection or project changed. The queued message is paused.')
        context.current.onThreads((previous) =>
          previous.map((item) => {
            if (item.id !== threadId) return item
            const queue = item.queue || []
            const next = queue.find((entry) => entry.id === messageId)
            if (!next) return item
            return {
              ...item,
              queue: [
                { ...next, paused: false, error: undefined },
                ...queue
                  .filter((entry) => entry.id !== messageId)
                  .map((entry) => ({
                    ...entry,
                    paused: previousStatus.has(entry.id) ? previousStatus.get(entry.id) : true,
                  })),
              ],
            }
          }),
        )
      } catch (error) {
        pause(threadId)
        restore(threadId, selected, errorText(error))
        context.current.onError(errorText(error))
      } finally {
        stopping.current = false
        if (mounted.current) setOperation(undefined)
        wake()
      }
    },
    [pause, restore, wake],
  )

  useEffect(() => {
    if (!mounted.current || saving.current || pumping.current || stopping.current) return
    const candidate = options.threads.find((thread) => {
      const message = thread.queue?.[0]
      return (
        message &&
        !message.paused &&
        !message.error &&
        !thread.busy &&
        !thread.pending.length &&
        queueConnectionMatches(thread, options.connection) &&
        !options.isBlocked(thread.id)
      )
    })
    const message = candidate?.queue?.[0]
    if (!candidate || !message) return
    pumping.current = true
    setOperation({ threadId: candidate.id, id: message.id })
    void (async () => {
      try {
        const files = await Promise.all(
          message.attachments.map(async (attachment): Promise<DraftAttachment> => {
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
        if (!mounted.current || cancelled.current.has(message.id)) return
        const latest = context.current
        const thread = latest.threads.find((item) => item.id === candidate.id)
        if (!thread?.queue?.some((item) => item.id === message.id)) return
        if (!queueConnectionMatches(thread, latest.connection) || latest.isBlocked(thread.id))
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
