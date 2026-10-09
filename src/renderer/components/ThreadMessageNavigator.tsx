import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Search, X } from 'lucide-react'
import type { Message } from '../state'
import './workspace-surfaces.css'

type Preview = { id: string; prompt: string; reply: string; left: number; top: number }
export function ThreadMessageNavigator({
  messages,
  conversation,
  onJump,
}: {
  messages: Message[]
  conversation: RefObject<HTMLDivElement | null>
  onJump: () => void
}) {
  const finderReturnFocus = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const turns = useMemo(() => {
    const result: { id: string; prompt: string; reply: string }[] = []
    for (const message of messages) {
      if (message.role === 'user')
        result.push({ id: message.id, prompt: message.text || 'Attached files', reply: '' })
      else if (message.role === 'assistant' && result.length) {
        const turn = result[result.length - 1]
        turn.reply = message.text
      }
    }
    return result
  }, [messages])
  const waveCenter = preview ? turns.findIndex((turn) => turn.id === preview.id) : -1
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
  const ids = turns.map((turn) => turn.id).join('|')
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
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const id = (visible[0]?.target as HTMLElement | undefined)?.dataset.messageId
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
  function jump(id: string) {
    const root = conversation.current
    const target = Array.from(root?.querySelectorAll<HTMLElement>('[data-message-id]') || []).find(
      (element) => element.dataset.messageId === id,
    )
    if (!root || !target) return
    let ancestor = target.parentElement
    while (ancestor && ancestor !== root) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
      ancestor = ancestor.parentElement
    }
    onJump()
    setCurrent(id)
    setPreview(undefined)
    root.scrollTo({
      top:
        root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 20,
      behavior: 'auto',
    })
    finderReturnFocus.current = target
    target.focus({ preventScroll: true })
    setOpen(false)
  }
  const text = query.trim().toLowerCase()
  const results = messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      (!text || message.text.toLowerCase().includes(text)),
  )
  function show(turn: (typeof turns)[number], element: HTMLElement) {
    const box = element.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 48)
    setPreview({
      ...turn,
      left: Math.min(box.right + 10, window.innerWidth - width - 12),
      top: Math.max(12, Math.min(box.top - 25, window.innerHeight - 200)),
    })
  }
  return (
    <>
      <nav className="thread-message-navigator" aria-label="Thread message navigation">
        <Dialog.Root
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) setQuery('')
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
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="thread-finder-count" role="status">
                {results.length} {results.length === 1 ? 'message' : 'messages'}
                {results.length > 200 ? ' · showing the first 200' : ''}
              </div>
              <div className="thread-finder-results">
                {results.slice(0, 200).map((message) => (
                  <button key={message.id} onClick={() => jump(message.id)}>
                    <small>{message.role === 'user' ? 'Your message' : 'Agent reply'}</small>
                    <span>{message.text || 'Attached files'}</span>
                  </button>
                ))}
                {!results.length ? <p>No matching messages.</p> : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <div className="thread-message-ticks" onMouseLeave={() => setPreview(undefined)}>
          {turns.map((turn, index) => (
            <button
              key={turn.id}
              className="thread-message-tick"
              aria-label={`Jump to message ${index + 1}: ${turn.prompt.slice(0, 100)}`}
              aria-current={current === turn.id ? 'location' : undefined}
              aria-describedby={preview?.id === turn.id ? 'thread-message-preview' : undefined}
              onMouseEnter={(event) => show(turn, event.currentTarget)}
              onFocus={(event) => show(turn, event.currentTarget)}
              onBlur={() => setPreview(undefined)}
              onClick={() => jump(turn.id)}
            >
              <span style={tickStyle(index)} />
            </button>
          ))}
        </div>
      </nav>
      {preview
        ? createPortal(
            <div
              className="thread-message-preview"
              id="thread-message-preview"
              role="tooltip"
              style={{ left: preview.left, top: preview.top }}
            >
              <strong>{preview.prompt.slice(0, 600)}</strong>
              {preview.reply ? <p>{preview.reply.slice(0, 600)}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
