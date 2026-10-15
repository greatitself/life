import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Search, X } from 'lucide-react'
import type { Message } from '../state'
import './workspace-surfaces.css'

type Preview = { id: string; left: number; top: number }
const ThreadMessageTick = memo(function ThreadMessageTick({
  id,
  prompt,
  index,
  current,
  previewed,
  transform,
  opacity,
  onShow,
  onHide,
  onJump,
}: {
  id: string
  prompt: string
  index: number
  current: boolean
  previewed: boolean
  transform: string
  opacity: number
  onShow: (id: string, element: HTMLElement) => void
  onHide: () => void
  onJump: (id: string) => void
}) {
  return (
    <button
      className="thread-message-tick"
      aria-label={`Jump to message ${index + 1}: ${prompt}`}
      aria-current={current ? 'location' : undefined}
      aria-describedby={previewed ? 'thread-message-preview' : undefined}
      onMouseEnter={(event) => onShow(id, event.currentTarget)}
      onFocus={(event) => onShow(id, event.currentTarget)}
      onBlur={onHide}
      onClick={() => onJump(id)}
    >
      <span style={{ transform, opacity }} />
    </button>
  )
})

export function ThreadMessageNavigator({
  messages,
  searchMessages = messages,
  conversation,
  onJump,
}: {
  messages: Message[]
  searchMessages?: Message[]
  conversation: RefObject<HTMLDivElement | null>
  onJump: () => void
}) {
  const finderReturnFocus = useRef<HTMLElement | null>(null)
  const pendingJump = useRef<MutationObserver | undefined>(undefined)
  const cancelJump = useCallback(() => {
    pendingJump.current?.disconnect()
    pendingJump.current = undefined
  }, [])
  const onJumpRef = useRef(onJump)
  useLayoutEffect(() => {
    onJumpRef.current = onJump
  }, [onJump])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchText = useDeferredValue(query.trim().toLowerCase())
  const [current, setCurrent] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const { turns, ids, turnById } = useMemo(() => {
    const result: { id: string; prompt: string; reply?: Message }[] = []
    for (const message of messages) {
      if (message.role === 'user')
        result.push({ id: message.id, prompt: message.text || 'Attached files' })
      else if (message.role === 'assistant' && result.length) {
        const turn = result[result.length - 1]
        turn.reply = message
      }
    }
    return {
      turns: result,
      ids: JSON.stringify(result.map((turn) => turn.id)),
      turnById: new Map(result.map((turn, index) => [turn.id, { turn, index }])),
    }
  }, [messages])
  useLayoutEffect(() => cancelJump, [cancelJump, conversation, ids])
  const previewTurn = preview ? turnById.get(preview.id) : undefined
  const previewReply = previewTurn?.turn.reply?.text
  const waveCenter = previewTurn?.index ?? -1
  function tickStyle(index: number) {
    const distance = index - waveCenter
    const strength =
      waveCenter >= 0
        ? Math.exp(-(distance * distance) / 4.5)
        : current === turns[index].id
          ? 0.22
          : 0
    return { transform: `scaleX(${1 + 0.85 * strength})`, opacity: 0.45 + 0.55 * strength }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'f'
      )
        return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      event.preventDefault()
      finderReturnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  useEffect(() => {
    const root = conversation.current
    if (!root) return
    const intersecting = new Set<HTMLElement>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          if (entry.isIntersecting) intersecting.add(element)
          else intersecting.delete(element)
        }
        let first: HTMLElement | undefined
        let firstTop = Infinity
        for (const element of intersecting) {
          const top = element.getBoundingClientRect().top
          if (top < firstTop) {
            first = element
            firstTop = top
          }
        }
        const id = first?.dataset.messageId
        if (id) setCurrent(id)
      },
      { root, rootMargin: '-5% 0px -60% 0px', threshold: 0 },
    )
    const wanted = new Set(turns.map((turn) => turn.id))
    root.querySelectorAll<HTMLElement>('[data-message-id]').forEach((element) => {
      if (wanted.has(element.dataset.messageId || '')) observer.observe(element)
    })
    return () => observer.disconnect()
  }, [ids, conversation])
  const jump = useCallback(
    (id: string) => {
      cancelJump()
      const root = conversation.current
      if (!root) return
      const targetSelector = `[data-message-id="${CSS.escape(id)}"]`
      const disclosureSelector = `details[data-message-ids~="${CSS.escape(encodeURIComponent(id))}"]`
      if (!root.querySelector(targetSelector) && !root.querySelector(disclosureSelector)) return
      const revealAndJump = () => {
        if (conversation.current !== root || !root.isConnected) {
          cancelJump()
          return
        }
        const target = root.querySelector<HTMLElement>(targetSelector)
        if (!target) {
          const disclosure = root.querySelector<HTMLDetailsElement>(
            `${disclosureSelector}:not([open])`,
          )
          if (disclosure) disclosure.open = true
          return
        }
        cancelJump()
        let ancestor = target.parentElement
        while (ancestor && ancestor !== root) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
          ancestor = ancestor.parentElement
        }
        // Cancel any following/anchor restoration scheduled by the lazy mount
        // immediately before applying the reader's explicit jump.
        onJumpRef.current()
        setCurrent(id)
        setPreview(undefined)
        root.scrollTo({
          top:
            root.scrollTop +
            target.getBoundingClientRect().top -
            root.getBoundingClientRect().top -
            20,
          behavior: 'auto',
        })
        finderReturnFocus.current = target
        target.focus({ preventScroll: true })
        setOpen(false)
        setQuery('')
      }
      // Native details toggle updates React state asynchronously; finish only after
      // the real message anchor is committed, including nested lazy disclosures.
      pendingJump.current = new MutationObserver(revealAndJump)
      pendingJump.current.observe(root, { childList: true, subtree: true })
      revealAndJump()
    },
    [conversation, cancelJump],
  )
  const results = useMemo(
    () =>
      open
        ? searchMessages.filter(
            (message) =>
              (message.role === 'user' || message.role === 'assistant') &&
              (!searchText || message.text.toLowerCase().includes(searchText)),
          )
        : [],
    [searchMessages, open, searchText],
  )
  const resultButtons = useMemo(
    () =>
      results.slice(0, 200).map((message) => (
        <button key={message.id} onClick={() => jump(message.id)}>
          <small>{message.role === 'user' ? 'Your message' : 'Agent reply'}</small>
          <span>{message.text || 'Attached files'}</span>
        </button>
      )),
    [results, jump],
  )
  const show = useCallback((id: string, element: HTMLElement) => {
    const box = element.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 48)
    setPreview({
      id,
      left: Math.min(box.right + 10, window.innerWidth - width - 12),
      top: Math.max(12, Math.min(box.top - 25, window.innerHeight - 200)),
    })
  }, [])
  const hide = useCallback(() => setPreview(undefined), [])
  return (
    <>
      <nav className="thread-message-navigator" aria-label="Thread message navigation">
        <Dialog.Root
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) {
              cancelJump()
              setQuery('')
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="thread-finder-overlay" />
            <Dialog.Content
              className="thread-finder-dialog"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                if (finderReturnFocus.current?.isConnected)
                  finderReturnFocus.current.focus({ preventScroll: true })
                else
                  conversation.current
                    ?.querySelector<HTMLElement>('[data-message-id]')
                    ?.focus({ preventScroll: true })
              }}
            >
              <div className="thread-finder-heading">
                <Dialog.Title>Find in this thread</Dialog.Title>
                <Dialog.Close asChild>
                  <button className="icon-button" aria-label="Close message finder">
                    <X size={17} />
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Description>
                Search messages and jump to any point in the conversation.
              </Dialog.Description>
              <label className="thread-finder-input">
                <Search size={17} />
                <input
                  aria-label="Search messages in this thread"
                  placeholder="Search messages…"
                  value={query}
                  onChange={(event) => {
                    cancelJump()
                    setQuery(event.target.value)
                  }}
                />
              </label>
              <div className="thread-finder-count" role="status">
                {results.length} {results.length === 1 ? 'message' : 'messages'}
                {results.length > 200 ? ' · showing the first 200' : ''}
              </div>
              <div className="thread-finder-results">
                {resultButtons}
                {!results.length ? <p>No matching messages.</p> : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <div className="thread-message-ticks" onMouseLeave={hide}>
          {turns.map((turn, index) => {
            const style = tickStyle(index)
            return (
              <ThreadMessageTick
                key={turn.id}
                id={turn.id}
                prompt={turn.prompt.slice(0, 100)}
                index={index}
                current={current === turn.id}
                previewed={preview?.id === turn.id}
                transform={style.transform}
                opacity={style.opacity}
                onShow={show}
                onHide={hide}
                onJump={jump}
              />
            )
          })}
        </div>
      </nav>
      {preview && previewTurn
        ? createPortal(
            <div
              className="thread-message-preview"
              id="thread-message-preview"
              role="tooltip"
              style={{ left: preview.left, top: preview.top }}
            >
              <strong>{previewTurn.turn.prompt.slice(0, 600)}</strong>
              {previewReply ? <p>{previewReply.slice(0, 600)}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
