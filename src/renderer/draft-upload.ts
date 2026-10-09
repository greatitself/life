import { useEffect, useSyncExternalStore } from 'react'
import type { ConnectionState } from '../shared/types'
import { api, errorText } from './api'
import {
  saveAttachmentFiles,
  uploadAttachmentFiles,
  type DraftAttachment,
  type ThreadAttachment,
} from './attachments'

export interface AttachmentUploadState {
  state: 'waiting' | 'queued' | 'uploading' | 'ready' | 'error'
  percent: number
  error?: string
}
interface UploadJob extends AttachmentUploadState {
  id: string
  key: string
  profileId: string
  workspace: string
  controller: AbortController
  promise: Promise<ThreadAttachment>
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
function contextKey(connection: ConnectionState) {
  return JSON.stringify([connection.profile?.id || '', connection.workspace || ''])
}
function jobKey(id: string, connection: ConnectionState) {
  return `${contextKey(connection)}:${id}`
}
function matches(job: UploadJob, connection: ConnectionState) {
  return (
    connection.status === 'connected' &&
    job.profileId === connection.profile?.id &&
    job.workspace === connection.workspace
  )
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
function start(item: DraftAttachment, connection: ConnectionState, retry = false): UploadJob {
  const key = jobKey(item.id, connection)
  const existing = jobs.get(key)
  if (existing && (existing.state !== 'error' || !retry)) return existing
  const controller = new AbortController()
  const job: UploadJob = {
    id: item.id,
    key,
    profileId: connection.profile?.id || '',
    workspace: connection.workspace || '',
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
      )
      if (controller.signal.aborted) throw aborted()
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
): Promise<ThreadAttachment[]> {
  const client = api
  if (!client || expected.status !== 'connected' || !expected.profile || !expected.workspace)
    throw new Error('Connect and select a project to upload attachments.')
  const valid = (state: ConnectionState) =>
    state.status === 'connected' &&
    state.profile?.id === expected.profile!.id &&
    state.workspace === expected.workspace
  const progress = () => {
    const total = items.reduce((sum, item) => sum + Math.max(1, item.size), 0)
    const transferred = items.reduce(
      (sum, item) =>
        sum + Math.max(1, item.size) * (jobs.get(jobKey(item.id, expected))?.percent || 0),
      0,
    )
    onProgress(total ? Math.round(transferred / total) : 100)
  }
  const cancel = () => {
    for (const item of items) {
      const job = jobs.get(jobKey(item.id, expected))
      if (job && job.state !== 'ready') cancelAttachmentUpload(item.id)
    }
  }
  signal.addEventListener('abort', cancel)
  const off = subscribe(progress)
  try {
    if (signal.aborted) throw aborted()
    if (!valid(await client.connection.state()))
      throw new Error('The connection or project changed before uploading.')
    for (let attempt = 0; attempt < 2; attempt++) {
      const reused = items.some((item) => jobs.get(jobKey(item.id, expected))?.state === 'ready')
      const selected = items.map((item) => start(item, expected, true))
      progress()
      const result = await Promise.all(selected.map((job) => job.promise))
      if (signal.aborted) throw aborted()
      if (!valid(await client.connection.state()))
        throw new Error('The connection or project changed during the attachment upload.')
      if (reused && result.length) {
        const output = await client.connection.execute({
          workspace: expected.workspace,
          timeoutMs: 15000,
          command:
            result.map((item) => `test -r ${quote(item.remotePath!)}`).join(' && ') +
            " && printf 'LIFE_ATTACHMENT_READY\\n'",
        })
        if (signal.aborted) throw aborted()
        if (!valid(await client.connection.state()))
          throw new Error('The connection or project changed while checking attachments.')
        if (!output.trim().endsWith('LIFE_ATTACHMENT_READY')) {
          for (const item of items) cancelAttachmentUpload(item.id)
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
    signal.removeEventListener('abort', cancel)
  }
}

export function useDraftUploads(
  items: DraftAttachment[],
  connection: ConnectionState,
  enabled: boolean,
) {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (
      !enabled ||
      connection.status !== 'connected' ||
      !connection.profile ||
      !connection.workspace
    )
      return
    for (const item of items) start(item, connection)
  }, [items, enabled, connection.status, connection.profile?.id, connection.workspace])
  useEffect(() => {
    if (!api) return
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
  }, [])
  const states: Record<string, AttachmentUploadState> = {}
  for (const item of items) {
    const job = enabled ? jobs.get(jobKey(item.id, connection)) : undefined
    states[item.id] = job
      ? { state: job.state, percent: job.percent, error: job.error }
      : { state: 'waiting', percent: 0 }
  }
  return {
    states,
    retry: (id: string) => {
      const item = items.find((entry) => entry.id === id)
      if (item && enabled) start(item, connection, true)
    },
  }
}
