import { ArrowUp, Clock3, LoaderCircle, Paperclip, X } from 'lucide-react'
import type { QueuedMessage } from '../thread-queue'

export function QueuedMessages({
  messages,
  working,
  canSendNow,
  actionId,
  onSendNow,
  onRemove,
}: {
  messages: QueuedMessage[]
  working: boolean
  canSendNow: boolean
  actionId?: string
  onSendNow: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (!messages.length) return null
  return (
    <section className="thread-message-queue" aria-label="Queued follow-up messages">
      {messages.map((message) => (
        <article className="thread-queued-message" key={message.id}>
          <p>{message.text}</p>

          {message.attachments.length ? (
            <div className="thread-queued-files">
              <Paperclip size={13} aria-hidden="true" />
              <span>{message.attachments.map((attachment) => attachment.name).join(', ')}</span>
            </div>
          ) : null}
          <div className="thread-queued-footer">
            {actionId === message.id ? (
              <LoaderCircle size={14} className="spinning" />
            ) : (
              <Clock3 size={14} />
            )}
            <span>
              {actionId === message.id
                ? 'Preparing'
                : message.paused
                  ? 'Paused'
                  : 'After current turn'}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={
                working
                  ? 'Steer current response with this message'
                  : 'Send this queued message now'
              }
              title={
                working
                  ? 'Send steering without stopping the current response'
                  : 'Send now with the selected settings'
              }
              disabled={!canSendNow || Boolean(actionId)}
              onClick={() => onSendNow(message.id)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Remove queued message"
              title="Remove queued message"
              disabled={actionId === message.id}
              onClick={() => onRemove(message.id)}
            >
              <X size={14} />
            </button>
          </div>
          {message.error ? (
            <div className="thread-queued-error" role="status">
              {message.error}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  )
}
