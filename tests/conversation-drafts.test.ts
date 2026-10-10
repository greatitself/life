import { describe, expect, it, vi } from 'vitest'
import { ConversationDraftStore } from '../src/renderer/conversation-draft-store'
import { attachmentMetadata, type DraftAttachment } from '../src/renderer/attachments'

function attachment(id = 'file-a', text = 'hello'): DraftAttachment {
  const file = new File([text], `${id}.txt`, { type: 'text/plain' })
  return { id, name: file.name, mime: file.type, size: file.size, file }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settled) => {
    resolve = settled
  })
  return { promise, resolve }
}
const storage = () => ({
  saveFiles: vi.fn(async (_items: DraftAttachment[]) => undefined),
  readFile: vi.fn(async (_id: string): Promise<Blob | undefined> => undefined),
  onError: vi.fn(),
})

describe('durable conversation drafts', () => {
  it('migrates every old text draft without truncating saved history', () => {
    const saved = Object.fromEntries(
      Array.from({ length: 750 }, (_, index) => [
        `agents:thread-${index}`,
        `  exact text ${index}\n`,
      ]),
    )
    const store = new ConversationDraftStore(saved, storage())
    expect(Object.keys(store.serialize())).toHaveLength(750)
    expect(store.snapshot('agents:thread-749').draft).toBe('  exact text 749\n')
    expect(store.draftThreadIds().has('thread-749')).toBe(true)
  })

  it('keeps an invested new draft when it moves into its own thread', async () => {
    const backend = storage()
    const store = new ConversationDraftStore({}, backend)
    const original = store.entry('agents:new')
    const file = attachment()
    store.setDraft(original, 'Unsent work')
    store.setAttachments(original, [file])
    store.move('agents:new', 'agents:first')
    store.setDraft(store.entry('agents:new'), 'Second task')
    // A setter captured by the original async send still addresses its own draft.
    store.setDraft(original, (current) => current + '\nOriginal follow-up')
    expect(store.snapshot('agents:first').draft).toBe('Unsent work\nOriginal follow-up')
    expect(store.snapshot('agents:new').draft).toBe('Second task')
    expect(store.snapshot('agents:first').attachments[0]).toBe(file)
    expect(store.draftThreadIds()).toEqual(new Set(['first']))
    expect(store.retainedAttachmentIds()).toEqual(new Set(['file-a']))
    await store.flushAttachmentSaves()
    expect(backend.saveFiles).toHaveBeenCalledExactlyOnceWith([file])
  })

  it('saves attachment-only drafts while disconnected and restores their exact bytes after a restart', async () => {
    const blobs = new Map<string, Blob>()
    const backend = {
      ...storage(),
      saveFiles: async (files: DraftAttachment[]) => {
        for (const item of files) blobs.set(item.id, item.file)
      },
      readFile: async (id: string) => blobs.get(id),
    }
    const before = new ConversationDraftStore({}, backend)
    const item = attachment('file-alone', 'saved offline\n')
    before.setAttachments(before.entry('agents:draft'), [item])
    await before.flushAttachmentSaves()
    expect(before.hasContent('agents:draft')).toBe(true)
    const saved = JSON.parse(JSON.stringify(before.serialize()))
    const after = new ConversationDraftStore(saved, backend)
    expect(after.snapshot('agents:draft').restoring).toBe(true)
    await after.restoreAttachments()
    const restored = after.snapshot('agents:draft')
    expect(restored.restoring).toBe(false)
    expect(restored.unavailableAttachments).toEqual([])
    expect(attachmentMetadata(restored.attachments[0])).toEqual(attachmentMetadata(item))
    expect(await restored.attachments[0].file.text()).toBe('saved offline\n')
  })

  it('drops stale remote paths and reports missing, mismatched, and unreadable local files without losing their names', async () => {
    const files = [attachment('missing'), attachment('wrong-size'), attachment('storage-error')]
    const backend = storage()
    backend.readFile.mockImplementation(async (id) => {
      if (id === 'storage-error') throw new Error('Storage denied')
      return id === 'wrong-size' ? new Blob(['different bytes']) : undefined
    })
    const store = new ConversationDraftStore(
      {
        'agents:draft': {
          draft: 'Preserved instructions',
          attachments: files.map((item) => ({
            ...attachmentMetadata(item),
            remotePath: '/previous-machine/file',
          })),
        },
      },
      backend,
    )
    await store.restoreAttachments()
    const restored = store.snapshot('agents:draft')
    expect(restored.draft).toBe('Preserved instructions')
    expect(restored.attachments).toEqual([])
    expect(restored.unavailableAttachments.map((item) => item.id)).toEqual([
      'missing',
      'wrong-size',
      'storage-error',
    ])
    expect(
      restored.unavailableAttachments.every((item) => Boolean(item.error) && !item.remotePath),
    ).toBe(true)
    expect(store.serialize()['agents:draft'].attachments).toEqual(files.map(attachmentMetadata))
    store.removeUnavailable(store.entry('agents:draft'), 'missing')
    expect(store.retainedAttachmentIds().has('missing')).toBe(false)
  })

  it('restores files into a promoted draft while late reads cannot alter the fresh draft', async () => {
    const pending = deferred<Blob | undefined>()
    const item = attachment()
    const store = new ConversationDraftStore(
      { 'agents:new': { draft: 'Old task', attachments: [attachmentMetadata(item)] } },
      {
        ...storage(),
        readFile: () => pending.promise,
      },
    )
    const restoring = store.restoreAttachments()
    store.move('agents:new', 'agents:old')
    const fresh = store.entry('agents:new')
    store.setDraft(fresh, 'Fresh task')
    store.setAttachments(fresh, [attachment('fresh-file')])
    pending.resolve(item.file)
    await restoring
    expect(store.snapshot('agents:old').attachments.map((file) => file.id)).toEqual(['file-a'])
    expect(store.snapshot('agents:new').draft).toBe('Fresh task')
    expect(store.snapshot('agents:new').attachments.map((file) => file.id)).toEqual(['fresh-file'])
  })

  it('keeps restored file order and attachments added during a slow read', async () => {
    const first = attachment('first')
    const second = attachment('second')
    const pending = deferred<Blob | undefined>()
    const store = new ConversationDraftStore(
      { 'agents:draft': { attachments: [attachmentMetadata(first), attachmentMetadata(second)] } },
      {
        ...storage(),
        readFile: async (id) => (id === 'first' ? pending.promise : second.file),
      },
    )
    const restoring = store.restoreAttachments()
    store.setAttachments(store.entry('agents:draft'), [attachment('added')])
    pending.resolve(first.file)
    await restoring
    expect(store.snapshot('agents:draft').attachments.map((file) => file.id)).toEqual([
      'first',
      'second',
      'added',
    ])
  })

  it('does not resurrect attachments cleared while a read was pending', async () => {
    const pending = deferred<Blob | undefined>()
    const file = attachment()
    const store = new ConversationDraftStore(
      { 'agents:draft': { draft: 'Old', attachments: [attachmentMetadata(file)] } },
      {
        ...storage(),
        readFile: () => pending.promise,
      },
    )
    const restoring = store.restoreAttachments()
    store.clear('agents:draft')
    store.setDraft(store.entry('agents:draft'), 'Replacement')
    pending.resolve(file.file)
    await restoring
    expect(store.snapshot('agents:draft')).toEqual({
      draft: 'Replacement',
      attachments: [],
      unavailableAttachments: [],
      restoring: false,
    })
  })

  it('preserves failed input and newly typed text in the original thread without replacing another draft', async () => {
    const store = new ConversationDraftStore({}, storage())
    const original = store.entry('agents:new')
    store.setDraft(original, 'Submitted prompt')
    store.setDraft(original, '')
    store.move('agents:new', 'agents:running')
    store.setDraft(original, 'Follow-up typed during the send')
    store.setDraft(store.entry('agents:new'), 'Different task')
    const originalFile = attachment()
    store.restoreSubmission(original, 'Submitted prompt', [originalFile])
    store.restoreSubmission(original, 'Submitted prompt', [originalFile])
    expect(store.snapshot('agents:running').draft).toBe(
      'Submitted prompt\n\nFollow-up typed during the send',
    )
    expect(store.snapshot('agents:running').attachments).toHaveLength(1)
    expect(store.snapshot('agents:new').draft).toBe('Different task')
    await store.flushAttachmentSaves()
  })

  it('warns about failed durable saves while retaining usable files and retries on the next edit', async () => {
    const backend = storage()
    backend.saveFiles.mockRejectedValueOnce(new Error('Storage full'))
    const store = new ConversationDraftStore({}, backend)
    const file = attachment()
    const entry = store.entry('agents:draft')
    store.setAttachments(entry, [file])
    await store.flushAttachmentSaves()
    expect(store.snapshot('agents:draft').attachments[0].file).toBe(file.file)
    expect(store.serialize()['agents:draft'].attachments[0].name).toBe(file.name)
    expect(backend.onError).toHaveBeenCalledOnce()
    store.setAttachments(entry, (items) => items)
    await store.flushAttachmentSaves()
    expect(backend.saveFiles).toHaveBeenCalledTimes(2)
  })

  it('keeps sidebar draft identities stable while unrelated rendering reads the store', () => {
    const store = new ConversationDraftStore(
      { 'agents:a': 'Draft A', 'research:goal': 'Research draft' },
      storage(),
    )
    const initial = store.draftThreadIds()
    expect(store.draftThreadIds()).toBe(initial)
    store.snapshot('agents:a')
    expect(store.draftThreadIds()).toBe(initial)
    store.clear('agents:a')
    expect(store.draftThreadIds()).toEqual(new Set())
    expect(store.serialize()['research:goal'].draft).toBe('Research draft')
  })

  it('preserves all recovery files across a restart when a failed send merged more than the per-message limit', async () => {
    const files = Array.from({ length: 12 }, (_, index) => attachment(`recovered-${index}`))
    const store = new ConversationDraftStore(
      {
        'agents:recovery': {
          draft: 'Recover these files',
          attachments: files.map(attachmentMetadata),
        },
      },
      { ...storage(), readFile: async (id) => files.find((file) => file.id === id)?.file },
    )
    await store.restoreAttachments()
    expect(store.snapshot('agents:recovery').attachments.map((item) => item.id)).toEqual(
      files.map((item) => item.id),
    )
    expect(store.serialize()['agents:recovery'].attachments).toHaveLength(12)
  })
})
