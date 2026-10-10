import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from 'react'
import type { DraftAttachment } from './attachments'
import { ConversationDraftStore } from './conversation-draft-store'
export type { UnavailableDraftAttachment } from './conversation-draft-store'
const storageKey = 'life.conversation-drafts.v1'
function readSaved(): unknown {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '{}')
  } catch {
    return {}
  }
}

export function useConversationDrafts(
  key: string,
  onError: (message: string) => void,
  enabled = true,
) {
  const error = useRef(onError)
  error.current = onError
  const [store] = useState(
    () =>
      new ConversationDraftStore(readSaved(), {
        onError: (message) => error.current(message),
      }),
  )
  const revision = useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision)
  const warned = useRef(false)
  const savingEnabled = useRef(enabled)
  savingEnabled.current = enabled
  const selected = store.entry(key)
  const persist = useCallback(() => {
    if (!savingEnabled.current) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(store.serialize()))
      warned.current = false
    } catch {
      if (!warned.current)
        error.current(
          'Drafts are preserved in this window, but browser storage could not save them.',
        )
      warned.current = true
    }
  }, [store])
  useEffect(() => {
    void store.restoreAttachments()
  }, [store])
  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(persist, 300)
    return () => window.clearTimeout(timer)
  }, [enabled, revision, persist])
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('beforeunload', persist)
    return () => window.removeEventListener('beforeunload', persist)
  }, [enabled, persist])
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      store.setDraft(selected, value)
    },
    [selected, store],
  )
  const setAttachments = useCallback(
    (value: SetStateAction<DraftAttachment[]>) => {
      store.setAttachments(selected, value)
    },
    [selected, store],
  )
  const clear = useCallback(
    (name: string) => {
      store.clear(name)
      persist()
    },
    [store, persist],
  )
  const move = useCallback(
    (from: string, to: string) => {
      store.move(from, to)
      persist()
    },
    [store, persist],
  )
  const restoreSubmission = useCallback(
    (prompt: string, files: DraftAttachment[]) => {
      store.restoreSubmission(selected, prompt, files)
      persist()
    },
    [selected, store, persist],
  )
  const removeUnavailable = useCallback(
    (id: string) => store.removeUnavailable(selected, id),
    [selected, store],
  )
  const snapshot = useCallback((name: string) => store.snapshot(name), [store])
  const hasContent = useCallback((name: string) => store.hasContent(name), [store])
  const retainedAttachmentIds = useCallback(() => store.retainedAttachmentIds(), [store])
  const draftThreadIds = store.draftThreadIds()
  const flush = useCallback(async () => {
    await store.flushAttachmentSaves()
    persist()
  }, [store, persist])
  return {
    draft: selected.draft,
    attachments: selected.attachments,
    setDraft,
    setAttachments,
    clear,
    move,
    unavailableAttachments: selected.unavailableAttachments,
    restoring: selected.pendingAttachments.length > 0,
    restoreSubmission,
    removeUnavailable,
    snapshot,
    hasContent,
    retainedAttachmentIds,
    draftThreadIds,
    revision,
    flush,
  }
}
