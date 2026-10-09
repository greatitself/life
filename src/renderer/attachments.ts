import { api } from './api'
import type { ConnectionState } from '../shared/types'

export interface ThreadAttachment {
  id: string
  name: string
  mime: string
  size: number
  remotePath?: string
}
export interface DraftAttachment extends ThreadAttachment {
  file: File
}
/** An independent machine directory never changes the selected Agents project. */
export interface AttachmentUploadContext {
  scope?: 'project' | 'machine'
  workspace?: string
}
export interface AttachmentUploadTarget {
  scope: 'project' | 'machine'
  profileId: string
  home?: string
  workspace: string
}

export function attachmentUploadTarget(
  connection: ConnectionState,
  context: AttachmentUploadContext = {},
): AttachmentUploadTarget {
  const scope = context.scope || 'project'
  const workspace = context.workspace || connection.workspace
  if (connection.status !== 'connected' || !connection.profile)
    throw new Error('Connect to a machine to upload attachments.')
  if (
    !workspace ||
    !workspace.startsWith('/') ||
    /[\x00-\x1f\x7f]/.test(workspace) ||
    workspace.length > 4096
  )
    throw new Error(
      scope === 'machine'
        ? 'Choose a Research directory to upload attachments.'
        : 'Select a project to upload attachments.',
    )
  if (
    scope === 'machine' &&
    (!connection.home?.startsWith('/') || /[\x00-\x1f\x7f]/.test(connection.home))
  )
    throw new Error('The connected machine has no valid root directory for attachments.')
  if (scope === 'project' && workspace !== connection.workspace)
    throw new Error('The selected project changed before uploading attachments.')
  return { scope, profileId: connection.profile.id, home: connection.home, workspace }
}

export function attachmentUploadMatches(
  target: AttachmentUploadTarget,
  state: ConnectionState,
): boolean {
  return (
    state.status === 'connected' &&
    state.profile?.id === target.profileId &&
    state.home === target.home &&
    (target.scope === 'machine' || state.workspace === target.workspace)
  )
}
const maximumFiles = 8
const maximumFileBytes = 10 * 1024 * 1024
const maximumTotalBytes = 25 * 1024 * 1024

export function validateDraftAttachments(items: DraftAttachment[]): void {
  if (items.length > maximumFiles) throw new Error('Attach up to 8 files per message.')
  let total = 0
  for (const item of items) {
    if (
      !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 255 ||
      typeof item.mime !== 'string' ||
      item.mime.length > 200 ||
      !item.file ||
      item.size !== item.file.size ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    )
      throw new Error('The selected attachment metadata is invalid. Select the file again.')
    if (item.file.size > maximumFileBytes)
      throw new Error(`${item.name} exceeds the 10 MB file limit.`)
    total += item.file.size
  }
  if (total > maximumTotalBytes) throw new Error('Attachments must total 25 MB or less.')
}
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

export function selectDraftAttachments(existing: DraftAttachment[], files: File[]) {
  const attachments = [...existing]
  const errors: string[] = []
  let total = attachments.reduce((sum, item) => sum + item.size, 0)
  for (const file of files) {
    if (attachments.length >= maximumFiles) {
      errors.push('Attach up to 8 files per message.')
      break
    }
    if (file.size > maximumFileBytes) {
      errors.push(`${file.name} exceeds the 10 MB file limit.`)
      continue
    }
    if (total + file.size > maximumTotalBytes) {
      errors.push('Attachments must total 25 MB or less.')
      continue
    }
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    attachments.push({
      id: crypto.randomUUID(),
      name: file.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'Attachment',
      mime: file.type || imageTypes[extension] || 'application/octet-stream',
      size: file.size,
      file,
    })
    total += file.size
  }
  return { attachments, errors }
}

export function attachmentMetadata(item: DraftAttachment): ThreadAttachment {
  return { id: item.id, name: item.name, mime: item.mime, size: item.size }
}

export function normalizeThreadAttachments(value: unknown): ThreadAttachment[] {
  if (!Array.isArray(value)) return []
  const result: ThreadAttachment[] = []
  for (const item of value.slice(0, maximumFiles)) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.id)) continue
    if (typeof item.name !== 'string' || !item.name || item.name.length > 255) continue
    if (typeof item.mime !== 'string' || item.mime.length > 200) continue
    if (!Number.isInteger(item.size) || item.size < 0 || item.size > maximumFileBytes) continue
    result.push({
      id: item.id,
      name: item.name,
      mime: item.mime,
      size: item.size,
      ...(typeof item.remotePath === 'string' &&
      item.remotePath.startsWith('/') &&
      item.remotePath.length <= 4096 &&
      !/[\x00-\x1f]/.test(item.remotePath)
        ? { remotePath: item.remotePath }
        : {}),
    })
  }
  return result
}

let database: Promise<IDBDatabase> | undefined
function attachmentDatabase(): Promise<IDBDatabase> {
  if (database) return database
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('life-thread-attachments', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files'))
        request.result.createObjectStore('files', { keyPath: 'id' })
    }
    request.onerror = () => {
      database = undefined
      reject(request.error || new Error('Unable to open attachment storage.'))
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        database = undefined
      }
      resolve(db)
    }
  })
  return database
}

export async function saveAttachmentFiles(items: DraftAttachment[]): Promise<void> {
  if (!items.length) return
  const db = await attachmentDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite')
    const store = transaction.objectStore('files')
    for (const item of items) store.put({ id: item.id, blob: item.file })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error || new Error('Unable to save attachments.'))
    transaction.onabort = () =>
      reject(transaction.error || new Error('Attachment storage is full.'))
  })
}

export async function getAttachmentFile(id: string): Promise<Blob | undefined> {
  const db = await attachmentDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').get(id)
    request.onsuccess = () =>
      resolve(request.result?.blob instanceof Blob ? request.result.blob : undefined)
    request.onerror = () => reject(request.error || new Error('Unable to read this attachment.'))
  })
}

export async function deleteAttachmentFiles(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = await attachmentDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite')
    for (const id of new Set(ids)) transaction.objectStore('files').delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error || new Error('Unable to remove attachments.'))
    transaction.onabort = () =>
      reject(transaction.error || new Error('Unable to remove attachments.'))
  })
}

export function attachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
export function isPreviewImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime)
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Unable to read the selected file.'))
    reader.onabort = () => reject(new DOMException('Attachment upload cancelled.', 'AbortError'))
    reader.readAsDataURL(blob)
  })
}

async function uploadBatch<T>(tasks: T[], send: (task: T) => Promise<void>): Promise<void> {
  let cursor = 0
  let failure: unknown
  const worker = async () => {
    while (!failure) {
      const index = cursor++
      if (index >= tasks.length) return
      try {
        await send(tasks[index])
      } catch (error) {
        failure = error || new Error('Attachment transfer failed.')
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker))
  if (failure) throw failure
}

export async function uploadAttachmentFiles(
  items: DraftAttachment[],
  expected: ConnectionState,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
  context: AttachmentUploadContext = {},
): Promise<ThreadAttachment[]> {
  const client = api
  if (!client) throw new Error('Open Life to upload attachments.')
  const target = attachmentUploadTarget(expected, context)
  const { workspace, scope } = target
  validateDraftAttachments(items)
  const total = items.reduce((sum, item) => sum + item.size, 0)
  if (!items.length) return []
  let changed = false
  let realUploadWorkspace: string | undefined
  const matches = (state: ConnectionState) => attachmentUploadMatches(target, state)
  const off = client.onConnection((state) => {
    if (!matches(state)) changed = true
  })
  const check = () => {
    if (signal.aborted) throw new DOMException('Attachment upload cancelled.', 'AbortError')
    if (changed)
      throw new Error(
        scope === 'machine'
          ? 'The connected machine changed during the attachment upload.'
          : 'The connection or project changed during the attachment upload.',
      )
  }
  const run = async (command: string) => {
    check()
    const output = await client.connection.execute({
      command: realUploadWorkspace
        ? `test "$(pwd -P)" = ${shellQuote(realUploadWorkspace)} || exit 1\n${command}`
        : command,
      workspace,
      scope,
      timeoutMs: 30000,
    })
    check()
    return output
  }
  const checked = async (command: string) => {
    const output = await run(command)
    if (!output.trim().endsWith('LIFE_ATTACHMENT_OK'))
      throw new Error('The remote machine could not save the attachment. Try sending it again.')
  }
  try {
    if (!matches(await client.connection.state())) changed = true
    check()
    const setup = await run(
      [
        "if printf 'eA==' | base64 -d >/dev/null 2>&1; then",
        "  printf 'LIFE_BASE64=-d\\n'",
        "elif printf 'eA==' | base64 -D >/dev/null 2>&1; then",
        "  printf 'LIFE_BASE64=-D\\n'",
        'else',
        "  printf 'The remote machine needs the base64 utility.\\n' >&2",
        '  exit 1',
        'fi',
        'umask 077',
        ...(scope === 'machine'
          ? [
              'life_attachment_workspace=$(pwd -P) || exit 1',
              'printf \'LIFE_ATTACHMENT_WORKSPACE=%s\\n\' "$life_attachment_workspace"',
              'life_attachment_dir=$(mktemp -d "$life_attachment_workspace/.life-attachments.XXXXXXXXXXXX") || exit 1',
            ]
          : [
              'life_attachment_dir=$(mktemp -d /tmp/life-thread-attachments.XXXXXXXXXXXX) || exit 1',
            ]),
        'printf \'LIFE_ATTACHMENT_DIR=%s\\n\' "$life_attachment_dir"',
      ].join('\n'),
    )
    const directory = setup
      .split(/\r?\n/)
      .find((line) => line.startsWith('LIFE_ATTACHMENT_DIR='))
      ?.slice(20)
    const decoder = setup.includes('LIFE_BASE64=-d')
      ? '-d'
      : setup.includes('LIFE_BASE64=-D')
        ? '-D'
        : undefined
    const realWorkspace = setup
      .split(/\r?\n/)
      .find((line) => line.startsWith('LIFE_ATTACHMENT_WORKSPACE='))
      ?.slice(26)
    const prefix =
      scope === 'machine'
        ? `${realWorkspace?.replace(/\/+$/, '')}/.life-attachments.`
        : '/tmp/life-thread-attachments.'
    if (
      !directory ||
      !decoder ||
      (scope === 'machine' &&
        (!realWorkspace?.startsWith('/') || /[\x00-\x1f\x7f]/.test(realWorkspace))) ||
      !directory.startsWith(prefix) ||
      !/^[a-zA-Z0-9]+$/.test(directory.slice(prefix.length))
    )
      throw new Error('Unable to create a temporary folder for attachments on this machine.')
    if (scope === 'machine') realUploadWorkspace = realWorkspace
    let completed = 0
    let lastPercent = -1
    const files = items.map((item) => {
      const filename = item.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment'
      const path = `${directory}/${item.id}-${filename}`
      const parts = Array.from(
        { length: Math.max(1, Math.ceil(item.size / 65536)) },
        (_, index) => ({
          item,
          start: index * 65536,
          end: Math.min((index + 1) * 65536, item.size),
          path: `${path}.part.${String(index).padStart(4, '0')}`,
        }),
      )
      return { item, path, parts }
    })
    // Independent part files allow concurrent transfers without reordered bytes.
    // Each command remains below the bridge's existing 100 KB script limit.
    await uploadBatch(
      files.flatMap((file) => file.parts),
      async (part) => {
        check()
        const data = await readBase64(part.item.file.slice(part.start, part.end))
        check()
        await checked(
          `umask 077\nprintf '%s' ${shellQuote(data)} | base64 ${decoder} > ${shellQuote(part.path)} && test \"$(wc -c < ${shellQuote(part.path)})\" -eq ${part.end - part.start} && printf 'LIFE_ATTACHMENT_OK\\n'`,
        )
        completed += part.end - part.start
        const percent = Math.min(99, Math.round((completed / Math.max(total, 1)) * 100))
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress(percent)
        }
      },
    )
    await uploadBatch(files, async (file) => {
      check()
      const parts = file.parts.map((part) => shellQuote(part.path)).join(' ')
      await checked(
        `umask 077\ncat ${parts} > ${shellQuote(file.path)} && test \"$(wc -c < ${shellQuote(file.path)})\" -eq ${file.item.size} && rm -f -- ${parts} && printf 'LIFE_ATTACHMENT_OK\\n'`,
      )
    })
    if (!matches(await client.connection.state())) changed = true
    check()
    onProgress(100)
    return files.map((file) => ({ ...attachmentMetadata(file.item), remotePath: file.path }))
  } finally {
    off()
  }
}

/** Compatibility helper: attachments travel as native provider blocks, never as instructions. */
export function attachmentPrompt(prompt: string, _items: ThreadAttachment[]): string {
  return prompt
}
