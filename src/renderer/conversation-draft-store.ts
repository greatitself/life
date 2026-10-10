import {
  getAttachmentFile,
  normalizeThreadAttachments,
  saveAttachmentFiles,
  type DraftAttachment,
  type ThreadAttachment,
} from './attachments'

export interface UnavailableDraftAttachment extends ThreadAttachment {
  error: string
}
export interface ConversationDraftEntry {
  draft: string
  attachments: DraftAttachment[]
  unavailableAttachments: UnavailableDraftAttachment[]
  pendingAttachments: ThreadAttachment[]
}
export interface ConversationDraftSnapshot {
  draft: string
  attachments: DraftAttachment[]
  unavailableAttachments: UnavailableDraftAttachment[]
  restoring: boolean
}
interface DraftStorage {
  readFile: (id: string) => Promise<Blob | undefined>
  saveFiles: (items: DraftAttachment[]) => Promise<void>
  onError: (message: string) => void
}
const empty = (): ConversationDraftEntry => ({
  draft: '',
  attachments: [],
  unavailableAttachments: [],
  pendingAttachments: [],
})
function metadata(entry: ConversationDraftEntry): ThreadAttachment[] {
  const unique = new Map<string, ThreadAttachment>()
  for (const item of [
    ...entry.pendingAttachments,
    ...entry.unavailableAttachments,
    ...entry.attachments,
  ])
    unique.set(item.id, { id: item.id, name: item.name, mime: item.mime, size: item.size })
  return [...unique.values()]
}

/** Entries retain their identity when a new draft is promoted to a thread. */
export class ConversationDraftStore {
  private readonly entries = new Map<string, ConversationDraftEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly savedFiles = new WeakSet<File>()
  private readonly saves = new Set<Promise<void>>()
  private restoring?: Promise<void>
  private revision = 0
  private dirtyRevision = -1
  private dirtyThreadIds = new Set<string>()
  private readonly storage: DraftStorage

  constructor(saved: unknown, storage: Partial<DraftStorage> = {}) {
    this.storage = {
      readFile: getAttachmentFile,
      saveFiles: saveAttachmentFiles,
      onError: () => undefined,
      ...storage,
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
    for (const [key, raw] of Object.entries(saved)) {
      if (typeof raw === 'string') {
        this.entries.set(key, { ...empty(), draft: raw })
        continue
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const value = raw as { draft?: unknown; attachments?: unknown }
      // A failed submission can merge its original files with files typed
      // meanwhile. Preserve that recovery draft even when it exceeds the
      // send limit; the composer asks the user to remove extras before sending.
      const attachments = Array.isArray(value.attachments)
        ? value.attachments.flatMap((item) => normalizeThreadAttachments([item]))
        : []
      this.entries.set(key, {
        ...empty(),
        draft: typeof value.draft === 'string' ? value.draft : '',
        // Uploaded paths belong to the previous connection. Restored files
        // go through the current thread's upload checks again.
        pendingAttachments: [
          ...new Map(
            attachments.map((item) => [
              item.id,
              {
                id: item.id,
                name: item.name,
                mime: item.mime,
                size: item.size,
              },
            ]),
          ).values(),
        ],
      })
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = () => this.revision
  private changed() {
    this.revision++
    for (const listener of this.listeners) listener()
  }
  entry(key: string): ConversationDraftEntry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = empty()
      this.entries.set(key, entry)
    }
    return entry
  }
  snapshot(key: string): ConversationDraftSnapshot {
    const entry = this.entry(key)
    return {
      draft: entry.draft,
      attachments: entry.attachments,
      unavailableAttachments: entry.unavailableAttachments,
      restoring: entry.pendingAttachments.length > 0,
    }
  }
  hasContent(key: string): boolean {
    const entry = this.entries.get(key)
    return Boolean(entry && (entry.draft || metadata(entry).length))
  }
  draftThreadIds(): ReadonlySet<string> {
    if (this.dirtyRevision !== this.revision) {
      this.dirtyThreadIds = new Set(
        [...this.entries.keys()]
          .filter(
            (key) => key.startsWith('agents:') && key !== 'agents:new' && this.hasContent(key),
          )
          .map((key) => key.slice('agents:'.length)),
      )
      this.dirtyRevision = this.revision
    }
    return this.dirtyThreadIds
  }
  retainedAttachmentIds(): Set<string> {
    return new Set(
      [...this.entries.values()].flatMap((entry) => metadata(entry).map((item) => item.id)),
    )
  }
  setDraft(entry: ConversationDraftEntry, value: string | ((previous: string) => string)) {
    entry.draft = typeof value === 'function' ? value(entry.draft) : value
    this.changed()
  }
  setAttachments(
    entry: ConversationDraftEntry,
    value: DraftAttachment[] | ((previous: DraftAttachment[]) => DraftAttachment[]),
  ) {
    entry.attachments = typeof value === 'function' ? value(entry.attachments) : value
    const retained = new Set(entry.attachments.map((item) => item.id))
    entry.unavailableAttachments = entry.unavailableAttachments.filter(
      (item) => !retained.has(item.id),
    )
    this.save(entry.attachments)
    this.changed()
  }
  removeUnavailable(entry: ConversationDraftEntry, id: string) {
    entry.unavailableAttachments = entry.unavailableAttachments.filter((item) => item.id !== id)
    entry.pendingAttachments = entry.pendingAttachments.filter((item) => item.id !== id)
    this.changed()
  }
  clear(key: string) {
    const entry = this.entry(key)
    entry.draft = ''
    entry.attachments = []
    entry.unavailableAttachments = []
    entry.pendingAttachments = []
    this.changed()
  }
  move(from: string, to: string) {
    if (from === to) return
    const entry = this.entries.get(from)
    if (entry) this.entries.set(to, entry)
    this.entries.set(from, empty())
    this.changed()
  }
  restoreSubmission(entry: ConversationDraftEntry, prompt: string, files: DraftAttachment[]) {
    if (![...this.entries.values()].includes(entry)) return
    if (!entry.draft) entry.draft = prompt
    else if (entry.draft !== prompt && prompt && !entry.draft.startsWith(`${prompt}\n\n`))
      entry.draft = `${prompt}\n\n${entry.draft}`
    const filesById = new Map(entry.attachments.map((item) => [item.id, item]))
    for (const file of files) if (!filesById.has(file.id)) filesById.set(file.id, file)
    entry.attachments = [...filesById.values()]
    this.save(files)
    this.changed()
  }
  serialize(): Record<string, { draft: string; attachments: ThreadAttachment[] }> {
    return Object.fromEntries(
      [...this.entries]
        .filter(([key]) => this.hasContent(key))
        .map(([key, entry]) => [key, { draft: entry.draft, attachments: metadata(entry) }]),
    )
  }
  private save(items: DraftAttachment[]) {
    const fresh = items.filter((item) => !this.savedFiles.has(item.file))
    if (!fresh.length) return
    for (const item of fresh) this.savedFiles.add(item.file)
    const pending = Promise.resolve()
      .then(() => this.storage.saveFiles(fresh))
      .catch(() => {
        for (const item of fresh) this.savedFiles.delete(item.file)
        this.storage.onError(
          'Draft files are preserved in this window, but could not be saved for a restart. Keep Life open or attach them again after restarting.',
        )
      })
    this.saves.add(pending)
    void pending.finally(() => this.saves.delete(pending))
  }
  async flushAttachmentSaves(): Promise<void> {
    await Promise.all([...this.saves])
  }
  restoreAttachments(): Promise<void> {
    this.restoring ||= Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const pending = [...entry.pendingAttachments]
        if (!pending.length) return
        const restored = await Promise.all(
          pending.map(async (item) => {
            let file: File | undefined
            let failure =
              'This draft file is unavailable. Attach it again or remove it before sending.'
            try {
              const blob = await this.storage.readFile(item.id)
              if (blob && blob.size === item.size)
                file = new File([blob], item.name, { type: item.mime })
            } catch {
              failure =
                'Life could not restore this draft file. Attach it again or remove it before sending.'
            }
            return { item, file, failure }
          }),
        )
        // A clear, removal, or promotion can happen while IndexedDB is read.
        // Promotion retains the entry; a new blank draft has a different one.
        if (![...this.entries.values()].includes(entry)) return
        const files: DraftAttachment[] = []
        for (const { item, file, failure } of restored) {
          if (!entry.pendingAttachments.some((pendingItem) => pendingItem.id === item.id)) continue
          entry.pendingAttachments = entry.pendingAttachments.filter(
            (pendingItem) => pendingItem.id !== item.id,
          )
          if (file) {
            if (!entry.attachments.some((attachment) => attachment.id === item.id)) {
              files.push({ ...item, file })
              this.savedFiles.add(file)
            }
          } else
            entry.unavailableAttachments = [
              ...entry.unavailableAttachments,
              { ...item, error: failure },
            ]
        }
        // Promise completion order never changes the attachment order.
        entry.attachments = [...files, ...entry.attachments]
        this.changed()
      }),
    ).then(() => undefined)
    return this.restoring
  }
}
