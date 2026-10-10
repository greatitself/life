import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useId,
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
import {
  approvalRequestPresentation,
  prepareQuestionAnswers,
  questionAllowsOther,
  questionChoiceSentinel,
  questionOptionValue,
} from '../question-answers'
import './thread-output.css'
import './question-answers.css'

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
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [customQuestions, setCustomQuestions] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [urlCompleted, setURLCompleted] = useState(false)
  const sending = useRef(false)
  const responded = useRef(false)
  const requestKey = `${event.sessionId}:${event.requestId || ''}`
  const currentRequest = useRef(requestKey)
  currentRequest.current = requestKey
  const formId = useId()
  useEffect(() => {
    setAnswers({})
    setCustomAnswers({})
    setCustomQuestions({})
    setLoading(false)
    setSubmitted(false)
    setError('')
    setURLCompleted(false)
    sending.current = false
    responded.current = false
  }, [requestKey])
  const draft = { ...answers }
  for (const question of event.questions || []) {
    if (customQuestions[question.id])
      draft[question.id] = [
        ...(question.multiple ? draft[question.id] || [] : []),
        customAnswers[question.id] || '',
      ]
  }
  const validation = prepareQuestionAnswers(event.questions || [], draft)
  const presentation = approvalRequestPresentation(event)
  const disabled = loading || submitted
  const cannotAccept =
    disabled ||
    (event.type === 'question' && !validation.valid) ||
    (presentation.urlRequest && (!presentation.url || !urlCompleted))
  const respond = async (accepted: boolean) => {
    if (sending.current || responded.current || submitted || (accepted && cannotAccept)) return
    sending.current = true
    setLoading(true)
    setError('')
    try {
      await onRespond(
        accepted,
        accepted && event.type === 'question' ? validation.answers : undefined,
      )
      if (currentRequest.current === requestKey) {
        responded.current = true
        setSubmitted(true)
      }
    } catch (error) {
      if (currentRequest.current === requestKey)
        setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (currentRequest.current === requestKey) {
        sending.current = false
        setLoading(false)
      }
    }
  }
  return (
    <div className="approval-card" aria-busy={loading}>
      <div className="approval-title">
        <Terminal size={16} />
        <strong>
          {event.type === 'question' ? 'Your input is needed' : event.title || 'Approval requested'}
        </strong>
        <span className="badge">
          {submitted ? 'Response sent' : loading ? 'Sending' : 'Waiting for you'}
        </span>
      </div>
      {event.type === 'question' && event.text ? <pre>{event.text}</pre> : null}
      {event.type === 'question' ? (
        event.questions?.map((q, index) => {
          const inputId = `${formId}-question-${index}`
          const errorId = `${inputId}-error`
          const fieldError = validation.errors[q.id]
          const showError = Boolean(
            fieldError && (answers[q.id]?.length || customAnswers[q.id]?.length),
          )
          const allowsOther = Boolean(q.options?.length && questionAllowsOther(q))
          const isCustom = Boolean(customQuestions[q.id])
          const emptyValue = questionChoiceSentinel(q, 'empty')
          const otherValue = questionChoiceSentinel(q, 'other')
          const setAnswer = (value: string) =>
            setAnswers((current) => ({ ...current, [q.id]: [value] }))
          const customInput = isCustom ? (
            <label className="question thread-custom-answer">
              <span>
                {q.multiple ? 'Additional answer' : 'Your answer'} · {q.question}
              </span>
              {q.isSecret ? (
                <input
                  disabled={disabled}
                  type="password"
                  autoComplete="off"
                  value={customAnswers[q.id] || ''}
                  aria-invalid={showError || undefined}
                  aria-describedby={showError ? errorId : undefined}
                  onChange={(e) =>
                    setCustomAnswers((current) => ({ ...current, [q.id]: e.target.value }))
                  }
                />
              ) : (
                <textarea
                  disabled={disabled}
                  rows={3}
                  value={customAnswers[q.id] || ''}
                  aria-invalid={showError || undefined}
                  aria-describedby={showError ? errorId : undefined}
                  onChange={(e) =>
                    setCustomAnswers((current) => ({ ...current, [q.id]: e.target.value }))
                  }
                />
              )}
            </label>
          ) : null
          const prompt = (
            <>
              {q.question}
              {q.required === false ? (
                <span className="thread-question-optional"> (optional)</span>
              ) : null}
            </>
          )
          return (
            <div className="thread-question-card" key={q.id}>
              {q.multiple && q.options?.length ? (
                <fieldset
                  className="question thread-question-multiple"
                  disabled={disabled}
                  aria-describedby={showError ? errorId : undefined}
                >
                  <legend>
                    {q.header ? <strong>{q.header}</strong> : null}
                    {prompt}
                  </legend>
                  {q.options.map((option, optionIndex) => {
                    const value = questionOptionValue(option)
                    return (
                      <label className="thread-question-choice" key={optionIndex}>
                        <input
                          type="checkbox"
                          checked={answers[q.id]?.includes(value) || false}
                          onChange={(e) =>
                            setAnswers((current) => ({
                              ...current,
                              [q.id]: e.target.checked
                                ? [...(current[q.id] || []), value]
                                : (current[q.id] || []).filter((entry) => entry !== value),
                            }))
                          }
                        />
                        <span>
                          <strong>{option.label}</strong>
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                      </label>
                    )
                  })}
                  {allowsOther ? (
                    <label className="thread-question-choice">
                      <input
                        type="checkbox"
                        checked={isCustom}
                        onChange={(e) =>
                          setCustomQuestions((current) => ({
                            ...current,
                            [q.id]: e.target.checked,
                          }))
                        }
                      />
                      <span>Other answer</span>
                    </label>
                  ) : null}
                </fieldset>
              ) : (
                <label className="question" htmlFor={inputId}>
                  {q.header ? <strong>{q.header}</strong> : null}
                  <span>{prompt}</span>
                  {q.options?.length || q.inputType === 'boolean' ? (
                    <select
                      id={inputId}
                      disabled={disabled}
                      value={isCustom ? otherValue : (answers[q.id]?.[0] ?? emptyValue)}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? errorId : undefined}
                      onChange={(e) => {
                        const value = e.target.value
                        setCustomQuestions((current) => ({
                          ...current,
                          [q.id]: value === otherValue,
                        }))
                        setAnswers((current) => ({
                          ...current,
                          [q.id]: value === emptyValue || value === otherValue ? [] : [value],
                        }))
                      }}
                    >
                      <option value={emptyValue}>
                        {q.required === false ? 'Leave unanswered' : 'Choose an answer'}
                      </option>
                      {q.options?.length ? (
                        q.options.map((option, optionIndex) => (
                          <option key={optionIndex} value={questionOptionValue(option)}>
                            {option.label}
                            {option.description ? ` — ${option.description}` : ''}
                          </option>
                        ))
                      ) : (
                        <>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </>
                      )}
                      {allowsOther ? <option value={otherValue}>Other answer</option> : null}
                    </select>
                  ) : !q.isSecret && (!q.inputType || q.inputType === 'text') ? (
                    <textarea
                      id={inputId}
                      disabled={disabled}
                      rows={3}
                      placeholder="Your answer"
                      value={answers[q.id]?.[0] || ''}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? errorId : undefined}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  ) : (
                    <input
                      id={inputId}
                      disabled={disabled}
                      placeholder="Your answer"
                      type={
                        q.isSecret
                          ? 'password'
                          : q.inputType === 'number' || q.inputType === 'integer'
                            ? 'number'
                            : 'text'
                      }
                      step={
                        q.inputType === 'integer' ? 1 : q.inputType === 'number' ? 'any' : undefined
                      }
                      autoComplete={q.isSecret ? 'off' : undefined}
                      value={answers[q.id]?.[0] || ''}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? errorId : undefined}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  )}
                </label>
              )}
              {q.allowEmpty ? (
                <label className="thread-question-choice">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={
                      Object.hasOwn(answers, q.id) &&
                      (q.multiple
                        ? answers[q.id].length === 0
                        : answers[q.id].length === 1 && answers[q.id][0] === '') &&
                      !isCustom
                    }
                    onChange={(e) => {
                      setCustomQuestions((current) => ({ ...current, [q.id]: false }))
                      setAnswers((current) => {
                        const next = { ...current }
                        if (e.target.checked) next[q.id] = q.multiple ? [] : ['']
                        else delete next[q.id]
                        return next
                      })
                    }}
                  />
                  <span>
                    {q.multiple ? 'Select none' : 'Use an empty answer'} · {q.question}
                  </span>
                </label>
              ) : null}
              {customInput}
              {!q.multiple && q.options?.some((option) => option.description) ? (
                <ul className="thread-question-options" aria-label="Answer descriptions">
                  {q.options.map((option, optionIndex) => (
                    <li key={optionIndex}>
                      <strong>{option.label}</strong>
                      {option.description ? <span>{option.description}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {showError ? (
                <p id={errorId} className="thread-approval-error" role="alert">
                  {fieldError}
                </p>
              ) : null}
            </div>
          )
        })
      ) : (
        <>
          {event.text &&
          !presentation.fields.length &&
          !presentation.textIsJSON &&
          !presentation.fields.some((field) => field.text === event.text) ? (
            <p className="thread-approval-context">{event.text}</p>
          ) : null}
          {event.text &&
          (presentation.textIsJSON ||
            (presentation.fields.length > 0 &&
              !presentation.fields.some((field) => field.text === event.text))) ? (
            <details className="thread-approval-provider-details">
              <summary>Full provider request</summary>
              <pre>{event.text}</pre>
            </details>
          ) : null}
          {presentation.fields.length ? (
            <dl className="thread-approval-details">
              {presentation.fields.map((field) => (
                <div key={field.label}>
                  <dt>{field.label}</dt>
                  <dd>{field.text}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {presentation.permissionsRequest ? (
            <p className="thread-approval-context">
              Allowing this request grants the displayed permissions for this turn.
            </p>
          ) : null}
          {presentation.urlRequest ? (
            <div className="thread-approval-url">
              <p>
                Open the link to complete the provider request, then confirm when you are finished.
              </p>
              {presentation.url ? (
                <a href={presentation.url} target="_blank" rel="noopener noreferrer">
                  Open requested link · {presentation.rawURL}
                </a>
              ) : (
                <>
                  <p role="alert">The provider did not supply a valid HTTP or HTTPS link.</p>
                  {presentation.rawURL ? <pre>{presentation.rawURL}</pre> : null}
                </>
              )}
              <label className="thread-question-choice">
                <input
                  type="checkbox"
                  disabled={disabled || !presentation.url}
                  checked={urlCompleted}
                  onChange={(e) => setURLCompleted(e.target.checked)}
                />
                <span>I completed this request in the browser</span>
              </label>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p className="thread-approval-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approval-actions">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => void respond(false)}
        >
          Decline
        </button>
        <button
          className="button primary"
          disabled={cannotAccept}
          onClick={() => void respond(true)}
        >
          {loading
            ? 'Sending…'
            : submitted
              ? 'Response sent'
              : event.type === 'question'
                ? 'Send answers'
                : presentation.urlRequest
                  ? 'Confirm completed'
                  : presentation.permissionsRequest
                    ? 'Allow for this turn'
                    : 'Allow once'}
        </button>
      </div>
    </div>
  )
}
