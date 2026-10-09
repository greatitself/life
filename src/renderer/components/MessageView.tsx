import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  LoaderCircle,
  Terminal,
  AlertCircle,
  Square,
  FileText,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Provider, AgentEvent } from '../../shared/types'
import type { Message } from '../state'
import { streamlinedWorkspace } from '../api'
import { ProviderIcon } from './Icons'
import { AttachmentList } from './ThreadAttachments'
import { splitSourceMessage, withoutSourceReceiptNotice } from '../source-presentation'
import {
  activityAnchor,
  messagePhaseLabel,
  outputPreview,
  providerPlanSteps,
  toolOutputSections,
} from '../thread-presentation'
import { LifeSourceCard } from './LifeSourceCard'
import './thread-output.css'

function useCopy(text: string) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    copied,
    copy: async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1800)
      } catch {
        setCopied(false)
      }
    },
  }
}
function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function RawOutput({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => outputPreview(text), [text])
  const { copied, copy } = useCopy(text)
  return (
    <section className="thread-raw-output" aria-label={label}>
      <div className="thread-raw-heading">
        <span>{label}</span>
        <span className="thread-output-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Download ${label.toLowerCase()}`}
            onClick={() =>
              downloadText(text, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`)
            }
          >
            <Download size={13} />
          </button>
        </span>
      </div>
      <pre tabIndex={0}>{preview.text}</pre>
      {preview.shortened ? (
        <details
          className="thread-full-output"
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            Full {label.toLowerCase()} · {preview.characters.toLocaleString()} characters
          </summary>
          {expanded ? <pre tabIndex={0}>{text}</pre> : null}
        </details>
      ) : null}
    </section>
  )
}
export function ToolStatus({ status }: { status?: string }) {
  const running = ['running', 'in_progress', 'spawning', 'initializing'].includes(status || '')
  const failed = ['failed', 'errored', 'error'].includes(status || '')
  const interrupted = ['interrupted', 'cancelled', 'canceled', 'stopped', 'shutdown'].includes(
    status || '',
  )
  const label = running
    ? 'Running'
    : failed
      ? 'Failed'
      : interrupted
        ? 'Interrupted'
        : !status || ['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)
          ? 'Completed'
          : status.replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
  return (
    <span className="thread-tool-status" data-status={status || 'completed'}>
      {running ? (
        <LoaderCircle size={13} className="spinning" />
      ) : failed ? (
        <AlertCircle size={13} />
      ) : interrupted ? (
        <Square size={11} />
      ) : (
        <Check size={13} />
      )}
      <span>{label}</span>
    </span>
  )
}
function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : '',
    )
    .join('')
}
function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const text = plainText(children)
  const { copied, copy } = useCopy(text)
  const child = Children.toArray(children).find(isValidElement)
  const language = isValidElement<{ className?: string }>(child)
    ? /language-([^ ]+)/.exec(child.props.className || '')?.[1]
    : undefined
  return (
    <div className="thread-code-block">
      <div className="thread-code-heading">
        <span>{language || 'Code'}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy code"
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  )
}
const markdownComponents = {
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer" title={href}>
      {children}
    </a>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
  ),
}

export const MessageView = memo(function MessageView({
  message,
  provider,
  minimal = false,
}: {
  message: Message
  provider: Provider
  minimal?: boolean
}) {
  const [rawOpen, setRawOpen] = useState(false)
  const { copied, copy } = useCopy(message.text)
  const phase =
    streamlinedWorkspace && message.kind === 'reasoning' ? undefined : messagePhaseLabel(message)
  const parts = useMemo(
    () =>
      message.role === 'assistant'
        ? splitSourceMessage(withoutSourceReceiptNotice(message.text, message.sourceChange))
        : [{ kind: 'text' as const, text: message.text }],
    [message.role, message.text, message.sourceChange],
  )
  const sections = useMemo(() => toolOutputSections(message), [message])
  const plan = useMemo(() => providerPlanSteps(message), [message])
  const providerDetails = sections.find((section) => section.label === 'Provider details')
  if (message.role === 'tool')
    return (
      <article
        className={`tool-message thread-tool-card ${message.status === 'failed' ? 'failed' : ''}`}
        id={activityAnchor(message.id)}
        data-message-id={message.id}
        tabIndex={-1}
        aria-label={message.title || 'Agent tool'}
      >
        <header className="thread-tool-heading">
          <Terminal size={14} aria-hidden="true" />
          <strong>{message.title || 'Agent tool'}</strong>
          <ToolStatus status={message.status} />
        </header>
        {message.agentId || message.parentItemId ? (
          <p className="thread-subagent-operation">
            {message.agentName || `Subagent ${message.agentId || ''}`}
          </p>
        ) : null}
        {sections.length ? (
          sections.map((section) => <RawOutput key={section.label} {...section} />)
        ) : (
          <p className="thread-tool-empty">
            {message.status === 'running'
              ? 'Waiting for tool output…'
              : 'The provider reported no output.'}
          </p>
        )}
      </article>
    )
  if (message.role === 'error')
    return (
      <div className="chat-error" role="alert" data-message-id={message.id}>
        <AlertCircle size={17} />
        <span>{message.text}</span>
      </div>
    )
  return (
    <article
      className={`message ${message.role}${message.role === 'user' ? ' life-compact-user-message' : ''}${phase ? ' thread-phased-message' : ''}`}
      data-message-id={message.id}
      id={activityAnchor(message.id)}
      data-phase={message.kind || message.phase}
      data-subagent={
        message.role === 'assistant' && (message.agentId || message.parentItemId)
          ? 'true'
          : undefined
      }
      tabIndex={-1}
      aria-label={message.role === 'user' ? 'Your message' : phase || 'Agent message'}
    >
      {!minimal ? (
        <div className="message-label">
          {message.role !== 'user' ? (
            <>
              <span className={`agent-avatar ${provider}`}>
                <ProviderIcon provider={provider} brand size={16} />
              </span>
              <strong>
                {message.agentName || (provider === 'codex' ? 'Codex' : 'Claude Code')}
              </strong>
            </>
          ) : null}
          {phase ? <span className="thread-message-phase">{phase}</span> : null}
          {message.role === 'assistant' && (message.agentId || message.parentItemId) ? (
            <span className="thread-message-agent">
              {message.agentName || `Subagent ${message.agentId || ''}`}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-button copy-message"
            aria-label="Copy message"
            onClick={() => void copy()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      ) : null}
      <div className="markdown">
        {plan.length ? (
          <ol className="thread-plan-steps" aria-label="Agent plan">
            {plan.map((step, index) => (
              <li key={index} data-status={step.status}>
                {step.status === 'completed' ? (
                  <Check size={14} aria-hidden="true" />
                ) : step.status === 'in_progress' ? (
                  <LoaderCircle size={14} className="spinning" aria-hidden="true" />
                ) : (
                  <span className="thread-plan-number">{index + 1}</span>
                )}
                <span>{step.text}</span>
                {step.status ? <small>{step.status.replace(/[_-]/g, ' ')}</small> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {parts.map((part, index) =>
          part.kind === 'source' ? (
            <LifeSourceCard
              key={index}
              change={part.summary}
              status={part.complete ? 'proposed' : 'receiving'}
              raw={part.raw}
              malformed={part.malformed}
            />
          ) : (
            <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {part.text}
            </ReactMarkdown>
          ),
        )}
        {message.role === 'assistant' && message.sourceChange ? (
          <LifeSourceCard change={message.sourceChange} status={message.sourceChange.status} />
        ) : null}
      </div>
      <AttachmentList attachments={message.attachments || []} />
      {!streamlinedWorkspace && (message.text || providerDetails) ? (
        <details
          className="thread-original-message"
          onToggle={(event) => setRawOpen(event.currentTarget.open)}
        >
          <summary>
            <FileText size={12} aria-hidden="true" />
            Original message
          </summary>
          {rawOpen ? <RawOutput label="Original message" text={message.text} /> : null}
          {rawOpen && providerDetails ? <RawOutput {...providerDetails} /> : null}
        </details>
      ) : null}
    </article>
  )
})
export function ApprovalCard({
  event,
  onRespond,
}: {
  event: AgentEvent
  onRespond: (accepted: boolean, answers?: Record<string, string[]>) => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const respond = async (accepted: boolean) => {
    setLoading(true)
    setError('')
    try {
      await onRespond(accepted, answers)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="approval-card">
      <div className="approval-title">
        <Terminal size={16} />
        <strong>
          {event.type === 'question' ? 'Your input is needed' : event.title || 'Approval requested'}
        </strong>
        <span className="badge">Waiting for you</span>
      </div>
      {event.type === 'question' && event.text ? <pre>{event.text}</pre> : null}
      {event.type === 'question' ? (
        event.questions?.map((q) => (
          <div className="thread-question-card" key={q.id}>
            <label className="question">
              {q.header ? <strong>{q.header}</strong> : null}
              {q.question}
              {q.options?.length ? (
                <select
                  disabled={loading}
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
                  disabled={loading}
                  placeholder="Your answer"
                  value={answers[q.id]?.[0] || ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: [e.target.value] }))}
                />
              )}
            </label>
            {q.options?.some((option) => option.description) ? (
              <ul className="thread-question-options" aria-label="Answer descriptions">
                {q.options.map((option) => (
                  <li key={option.label}>
                    <strong>{option.label}</strong>
                    {option.description ? <span>{option.description}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))
      ) : (
        <pre>{event.text}</pre>
      )}
      {error ? (
        <p className="thread-approval-error" role="alert">
          {error}
        </p>
      ) : null}
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
