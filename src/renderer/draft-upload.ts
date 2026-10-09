import { useEffect, useSyncExternalStore } from 'react'
import type { ConnectionState } from '../shared/types'
import { api, errorText } from './api'
import {
  attachmentUploadMatches,
  attachmentUploadTarget,
  saveAttachmentFiles,
  uploadAttachmentFiles,
  validateDraftAttachments,
  type AttachmentUploadContext,
  type AttachmentUploadTarget,
  type DraftAttachment,
  type ThreadAttachment,
} from './attachments'

export interface AttachmentUploadState {
  state: 'waiting' | 'queued' | 'uploading' | 'ready' | 'error'
  percent: number
  error?: string
}
interface UploadJob extends AttachmentUploadState, AttachmentUploadTarget {
  id: string
  key: string
  controller: AbortController
  promise: Promise<ThreadAttachment>
  realWorkspace?: string
}
const jobs = new Map<string, UploadJob>()
const listeners = new Set<() => void>()
let revision = 0
let running = 0
const waiting: Array<() => void> = []
function notify() {
  revision++
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function snapshot() {
  return revision
}
function contextKey(target: AttachmentUploadTarget) {
  return JSON.stringify([target.scope, target.profileId, target.home || '', target.workspace])
}
function jobKey(id: string, target: AttachmentUploadTarget) {
  return `${contextKey(target)}:${id}`
}
function matches(job: UploadJob, connection: ConnectionState) {
  return attachmentUploadMatches(job, connection)
}
async function acquire() {
  if (running < 2) {
    running++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}
function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}
function aborted() {
  return new DOMException('Attachment upload cancelled.', 'AbortError')
}
function start(
  item: DraftAttachment,
  connection: ConnectionState,
  context: AttachmentUploadContext = {},
  retry = false,
): UploadJob {
  const target = attachmentUploadTarget(connection, context)
  const key = jobKey(item.id, target)
  const existing = jobs.get(key)
  if (existing && (existing.state !== 'error' || !retry)) return existing
  const controller = new AbortController()
  const job: UploadJob = {
    id: item.id,
    key,
    ...target,
    state: 'queued',
    percent: 0,
    controller,
    promise: Promise.resolve(item),
  }
  jobs.set(key, job)
  job.promise = (async () => {
    await acquire()
    try {
      if (controller.signal.aborted) throw aborted()
      job.state = 'uploading'
      notify()
      await saveAttachmentFiles([item])
      if (controller.signal.aborted) throw aborted()
      const result = await uploadAttachmentFiles(
        [item],
        connection,
        controller.signal,
        (percent) => {
          job.percent = percent
          notify()
        },
        context,
      )
      if (controller.signal.aborted) throw aborted()
      if (job.scope === 'machine' && result[0]?.remotePath) {
        const separator = result[0].remotePath.lastIndexOf('/.life-attachments.')
        if (separator >= 0) job.realWorkspace = result[0].remotePath.slice(0, separator) || '/'
      }
      job.state = 'ready'
      job.percent = 100
      notify()
      return result[0]
    } catch (error) {
      job.state = 'error'
      job.error = errorText(error)
      notify()
      throw error
    } finally {
      release()
    }
  })()
  void job.promise.catch(() => undefined)
  if (jobs.size > 128)
    for (const [oldKey, oldJob] of jobs) {
      if (jobs.size <= 128) break
      if (oldKey !== key && oldJob.state === 'ready') jobs.delete(oldKey)
    }
  notify()
  return job
}
export function cancelAttachmentUpload(id: string) {
  for (const [key, job] of jobs)
    if (job.id === id) {
      job.controller.abort()
      jobs.delete(key)
    }
  notify()
}
function quote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Await existing uploads, rather than uploading the same pasted files again on Send. */
export async function ensureAttachmentUploads(
  items: DraftAttachment[],
  expected: ConnectionState,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
  context: AttachmentUploadContext = {},
): Promise<ThreadAttachment[]> {
  const client = api
  if (!client) throw new Error('Open Life to upload attachments.')
  const target = attachmentUploadTarget(expected, context)
  validateDraftAttachments(items)
  let connectionChanged = false
  const valid = (state: ConnectionState) =>
    !connectionChanged && attachmentUploadMatches(target, state)
  const changed = (phase: string) =>
    new Error(
      target.scope === 'machine'
        ? `The connected machine changed ${phase} attachments.`
        : `The connection or project changed ${phase} attachments.`,
    )
  const progress = () => {
    const total = items.reduce((sum, item) => sum + Math.max(1, item.size), 0)
    const transferred = items.reduce(
      (sum, item) =>
        sum + Math.max(1, item.size) * (jobs.get(jobKey(item.id, target))?.percent || 0),
      0,
    )
    onProgress(total ? Math.round(transferred / total) : 100)
  }
  const cancel = () => {
    for (const item of items) {
      const key = jobKey(item.id, target)
      const job = jobs.get(key)
      if (job && job.state !== 'ready') {
        job.controller.abort()
        jobs.delete(key)
        notify()
      }
    }
  }
  signal.addEventListener('abort', cancel)
  const off = subscribe(progress)
  const offConnection = client.onConnection((state) => {
    if (!attachmentUploadMatches(target, state)) {
      // A reconnect can restore the same IDs before an awaited command settles.
      // That command still belongs to the previous transport and must not send
      // cached attachment paths into a newly connected agent session.
      connectionChanged = true
      cancel()
    }
  })
  try {
    if (signal.aborted) throw aborted()
    if (!valid(await client.connection.state())) throw changed('before uploading')
    for (let attempt = 0; attempt < 2; attempt++) {
      const reused = items.some((item) => jobs.get(jobKey(item.id, target))?.state === 'ready')
      const selected = items.map((item) => start(item, expected, context, true))
      progress()
      const result = await Promise.all(selected.map((job) => job.promise))
      if (signal.aborted) throw aborted()
      if (!valid(await client.connection.state())) throw changed('while uploading')
      if (reused && result.length) {
        const realWorkspaces = [
          ...new Set(
            selected.map((job) => job.realWorkspace).filter((cwd): cwd is string => Boolean(cwd)),
          ),
        ]
        const output = await client.connection.execute({
          workspace: target.workspace,
          scope: target.scope,
          timeoutMs: 15000,
          command:
            'if ' +
            realWorkspaces.map((cwd) => `test "$(pwd -P)" = ${quote(cwd)} && `).join('') +
            result.map((item) => `test -r ${quote(item.remotePath!)}`).join(' && ') +
            "; then printf 'LIFE_ATTACHMENT_READY\\n'; else printf 'LIFE_ATTACHMENT_MISSING\\n'; fi",
        })
        if (signal.aborted) throw aborted()
        if (!valid(await client.connection.state())) throw changed('while checking')
        if (!output.trim().endsWith('LIFE_ATTACHMENT_READY')) {
          for (const item of items) {
            const key = jobKey(item.id, target)
            jobs.get(key)?.controller.abort()
            jobs.delete(key)
          }
          notify()
          if (attempt === 0) continue
          throw new Error('The uploaded files are unavailable. Retry the attachment upload.')
        }
      }
      onProgress(100)
      return result
    }
    throw new Error('Unable to prepare attachments.')
  } finally {
    off()
    offConnection()
    signal.removeEventListener('abort', cancel)
  }
}

export function useDraftUploads(
  items: DraftAttachment[],
  connection: ConnectionState,
  enabled: boolean,
  context: AttachmentUploadContext = {},
) {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (!enabled) {
      let cancelled = false
      for (const [key, job] of jobs) {
        if (job.state !== 'queued' && job.state !== 'uploading') continue
        job.controller.abort()
        jobs.delete(key)
        cancelled = true
      }
      if (cancelled) notify()
      return
    }
    if (
      connection.status !== 'connected' ||
      !connection.profile ||
      !(context.workspace || connection.workspace) ||
      (context.scope === 'machine' && !connection.home)
    )
      return
    try {
      attachmentUploadTarget(connection, context)
    } catch {
      return
    }
    for (const item of items) start(item, connection, context)
  }, [
    items,
    enabled,
    connection.status,
    connection.profile?.id,
    connection.home,
    connection.workspace,
    context.scope,
    context.workspace,
  ])
  useEffect(() => {
    if (!api || !enabled) return
    return api.onConnection((state) => {
      let changed = false
      for (const [key, job] of jobs)
        if (!matches(job, state)) {
          job.controller.abort()
          jobs.delete(key)
          changed = true
        }
      if (changed) notify()
    })
  }, [enabled])
  const states: Record<string, AttachmentUploadState> = {}
  let target: AttachmentUploadTarget | undefined
  if (enabled) {
    try {
      target = attachmentUploadTarget(connection, context)
    } catch {
      /* A reconnect leaves drafts waiting, without throwing during rendering. */
    }
  }
  for (const item of items) {
    const job = target ? jobs.get(jobKey(item.id, target)) : undefined
    states[item.id] = job
      ? { state: job.state, percent: job.percent, error: job.error }
      : { state: 'waiting', percent: 0 }
  }
  return {
    states,
    retry: (id: string) => {
      const item = items.find((entry) => entry.id === id)
      if (item && target) start(item, connection, context, true)
    },
  }
}
