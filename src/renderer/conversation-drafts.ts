import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import type { DraftAttachment } from './attachments'

interface DraftEntry {
  draft: string
  attachments: DraftAttachment[]
}
const storageKey = 'life.conversation-drafts.v1'
const empty = (): DraftEntry => ({ draft: '', attachments: [] })
function readEntries(): Map<string, DraftEntry> {
  const entries = new Map<string, DraftEntry>()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved).slice(0, 500)) {
        if (typeof value === 'string') entries.set(key, { draft: value, attachments: [] })
      }
    }
  } catch {
    /* Drafts remain usable without browser storage. */
  }
  return entries
}

export function useConversationDrafts(
  key: string,
  onError: (message: string) => void,
  enabled = true,
) {
  const [entries] = useState(readEntries)
  const [revision, setRevision] = useState(0)
  const error = useRef(onError)
  const warned = useRef(false)
  const savingEnabled = useRef(enabled)
  savingEnabled.current = enabled
  error.current = onError
  let entry = entries.get(key)
  if (!entry) {
    entry = empty()
    entries.set(key, entry)
  }
  const selected = entry
  const changed = useCallback(() => setRevision((value) => value + 1), [])
  const persist = useCallback(() => {
    if (!savingEnabled.current) return
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(
          Object.fromEntries(
            [...entries]
              .filter(([, item]) => Boolean(item.draft))
              .map(([name, item]) => [name, item.draft]),
          ),
        ),
      )
      warned.current = false
    } catch {
      if (!warned.current)
        error.current(
          'Drafts are preserved in this window, but browser storage could not save them.',
        )
      warned.current = true
    }
  }, [entries])
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
      selected.draft = typeof value === 'function' ? value(selected.draft) : value
      changed()
    },
    [selected, changed],
  )
  const setAttachments = useCallback(
    (value: SetStateAction<DraftAttachment[]>) => {
      selected.attachments = typeof value === 'function' ? value(selected.attachments) : value
      changed()
    },
    [selected, changed],
  )
  const clear = useCallback(
    (name: string) => {
      const item = entries.get(name)
      if (item) {
        item.draft = ''
        item.attachments = []
      } else entries.set(name, empty())
      changed()
    },
    [entries, changed],
  )
  const move = useCallback(
    (from: string, to: string) => {
      const item = entries.get(from)
      if (item) entries.set(to, item)
      entries.set(from, empty())
      changed()
    },
    [entries, changed],
  )
  return {
    draft: selected.draft,
    attachments: selected.attachments,
    setDraft,
    setAttachments,
    clear,
    move,
  }
}
