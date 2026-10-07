import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  LoaderCircle,
  Terminal,
  AlertCircle,
  Square,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Provider, AgentEvent } from '../../shared/types'
import type { Message } from '../state'
import { ProviderIcon } from './Icons'
export function MessageView({ message, provider }: { message: Message; provider: Provider }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  if (message.role === 'tool')
    return (
      <div className={`tool-message ${message.status === 'failed' ? 'failed' : ''}`}>
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {message.status === 'running' ? (
            <LoaderCircle size={14} className="spinning" />
          ) : message.status === 'failed' ? (
            <AlertCircle size={14} />
          ) : message.status === 'interrupted' ? (
            <Square size={12} />
          ) : (
            <Check size={14} />
          )}
          <span>{message.title || 'Agent tool'}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {expanded ? <pre>{message.text || 'No additional output.'}</pre> : null}
      </div>
    )
  if (message.role === 'error')
    return (
      <div className="chat-error" role="alert">
        <AlertCircle size={17} />
        <span>{message.text}</span>
      </div>
    )
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">
        {message.role === 'user' ? (
          <span className="user-avatar">Y</span>
        ) : (
          <span className={`agent-avatar ${provider}`}>
            <ProviderIcon provider={provider} size={16} />
          </span>
        )}
        <strong>
          {message.role === 'user' ? 'You' : provider === 'codex' ? 'Codex' : 'Claude Code'}
        </strong>
        <button
          className="icon-button copy-message"
          aria-label="Copy message"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer" title={href}>
                {children}
              </a>
            ),
          }}
        >
          {message.text}
        </ReactMarkdown>
      </div>
    </article>
  )
}
export function ApprovalCard({
  event,
  onRespond,
}: {
  event: AgentEvent
  onRespond: (accepted: boolean, answers?: Record<string, string[]>) => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const respond = async (accepted: boolean) => {
    setLoading(true)
    try {
      await onRespond(accepted, answers)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="approval-card">
      <div className="approval-title">
        <Terminal size={16} />
        <strong>{event.type === 'question' ? 'Your input is needed' : event.title}</strong>
        <span className="badge">Waiting for you</span>
      </div>
      {event.type === 'question' ? (
        event.questions?.map((q) => (
          <label className="question" key={q.id}>
            {q.question}
            {q.options?.length ? (
              <select
                value={answers[q.id]?.[0] || ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: [e.target.value] }))}
              >
                <option value="">Choose an answer</option>
                {q.options.map((o) => (
                  <option key={o.label} value={o.label}>
                    {o.label}
                    {o.description ? ` — ${o.description}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                placeholder="Your answer"
                value={answers[q.id]?.[0] || ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: [e.target.value] }))}
              />
            )}
          </label>
        ))
      ) : (
        <pre>{event.text}</pre>
      )}
      <div className="approval-actions">
        <button className="button secondary" disabled={loading} onClick={() => void respond(false)}>
          Decline
        </button>
        <button
          className="button primary"
          disabled={
            loading ||
            (event.type === 'question' && event.questions?.some((q) => !answers[q.id]?.[0]))
          }
          onClick={() => void respond(true)}
        >
          {loading ? 'Sending…' : event.type === 'question' ? 'Send answers' : 'Allow once'}
        </button>
      </div>
    </div>
  )
}
