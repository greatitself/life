import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, MessageCircle, X } from 'lucide-react'
import { Effect, Exit } from 'effect'
import type { AgentEvent, AgentQuestion } from '../../shared/types'
import {
  pendingQuestionDrafts,
  pendingQuestionRequestKey,
  questionDraftAnswers,
  type PendingQuestionResponder,
} from '../pending-question-drafts'
import {
  prepareQuestionAnswers,
  questionAllowsOther,
  questionOptionValue,
} from '../question-answers'
import './PendingQuestionPanel.css'

export interface PendingQuestionPanelProps {
  event: AgentEvent
  onRespond: PendingQuestionResponder
  disabled?: boolean
  pendingCount?: number
  active?: boolean
}

export function PendingQuestionPanel({
  event,
  onRespond,
  disabled = false,
  pendingCount = 1,
  active = true,
}: PendingQuestionPanelProps) {
  const requestKey = pendingQuestionRequestKey(event)
  const subscribe = useCallback(
    (listener: () => void) => pendingQuestionDrafts.subscribe(event, listener),
    [requestKey],
  )
  const snapshot = useCallback(() => pendingQuestionDrafts.get(event), [requestKey])
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot)
  const panel = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const cancelAdvance = useRef<(() => void) | undefined>(undefined)
  const formId = useId()
  const questions = event.questions || []
  const step = Math.min(Math.max(0, draft.step), Math.max(0, questions.length - 1))
  const question = questions[step]
  const answers = questionDraftAnswers(event, draft)
  const validation = prepareQuestionAnswers(questions, answers)
  const currentValidation = prepareQuestionAnswers(question ? [question] : [], answers)
  const uncertain = event.status === 'responding'
  const locked = disabled || uncertain || draft.status !== 'idle'
  const policy = event as AgentEvent & { responseMode?: 'native' | 'message'; canDismiss?: boolean }
  const canDismiss = policy.responseMode === 'message' && policy.canDismiss === true
  const stopAdvance = useCallback(() => {
    cancelAdvance.current?.()
    cancelAdvance.current = undefined
  }, [])

  useEffect(() => {
    stopAdvance()
    if (!active || draft.collapsed || locked) return
    const root = panel.current
    if (!root || root.getClientRects().length === 0) return
    // A new step must be keyboard reachable without stealing focus from another
    // editor when a background request first arrives.
    const focused = document.activeElement
    if (
      focused &&
      focused !== document.body &&
      !root.contains(focused) &&
      (focused.matches('textarea, input, select') ||
        (focused instanceof HTMLElement && focused.isContentEditable))
    )
      return
    const target = body.current?.querySelector<HTMLElement>(
      'input:checked, textarea, input, [data-question-next]',
    )
    ;(target || root).focus({ preventScroll: true })
    return stopAdvance
  }, [requestKey, step, active, draft.collapsed, locked, stopAdvance])

  useEffect(() => stopAdvance, [requestKey, stopAdvance])

  function moveTo(next: number) {
    stopAdvance()
    pendingQuestionDrafts.update(event, { step: Math.max(0, Math.min(next, questions.length - 1)) })
  }

  function chooseOption(value: string) {
    if (!question || locked || !active) return
    stopAdvance()
    if (question.multiple) {
      pendingQuestionDrafts.update(event, (current) => {
        const selected = current.answers[question.id] || []
        return {
          answers: {
            ...current.answers,
            [question.id]: selected.includes(value)
              ? selected.filter((entry) => entry !== value)
              : [...selected, value],
          },
        }
      })
      return
    }
    pendingQuestionDrafts.update(event, (current) => ({
      answers: { ...current.answers, [question.id]: [value] },
      customQuestions: { ...current.customQuestions, [question.id]: false },
    }))
    let cancelled = false
    const interrupt = Effect.runCallback(Effect.sleep(200), {
      onExit: (exit) => {
        if (cancelled || !Exit.isSuccess(exit)) return
        const current = pendingQuestionDrafts.get(event)
        if (current.status !== 'idle' || current.step !== step || current.collapsed) return
        if (step < questions.length - 1) {
          pendingQuestionDrafts.update(event, { step: step + 1 })
          return
        }
        const ready = prepareQuestionAnswers(questions, questionDraftAnswers(event, current))
        if (ready.valid) pendingQuestionDrafts.submit(event, onRespond)
        else {
          const incomplete = questions.findIndex((item) => Boolean(ready.errors[item.id]))
          if (incomplete >= 0) pendingQuestionDrafts.update(event, { step: incomplete })
        }
      },
    })
    cancelAdvance.current = () => {
      cancelled = true
      interrupt()
    }
  }

  function toggleCustom() {
    if (!question || locked) return
    stopAdvance()
    pendingQuestionDrafts.update(event, (current) => ({
      customQuestions: {
        ...current.customQuestions,
        [question.id]: !current.customQuestions[question.id],
      },
      ...(!question.multiple ? { answers: { ...current.answers, [question.id]: [] } } : {}),
    }))
  }

  function changeText(value: string, custom = false) {
    if (!question || locked) return
    stopAdvance()
    pendingQuestionDrafts.update(event, (current) =>
      custom
        ? { customAnswers: { ...current.customAnswers, [question.id]: value } }
        : { answers: { ...current.answers, [question.id]: [value] } },
    )
  }

  function submit(accepted: boolean) {
    stopAdvance()
    if (!locked && active) pendingQuestionDrafts.submit(event, onRespond, accepted)
  }

  function handleKeyboard(e: KeyboardEvent<HTMLElement>) {
    if (
      !active ||
      locked ||
      draft.collapsed ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229 ||
      e.repeat ||
      e.shiftKey ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    )
      return
    const target = e.target
    if (
      e.key === 'Enter' &&
      target instanceof HTMLElement &&
      target.matches(
        'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="button"])',
      )
    ) {
      e.preventDefault()
      if (!currentValidation.valid) return
      if (step < questions.length - 1) moveTo(step + 1)
      else submit(true)
      return
    }
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest(
          'textarea, select, input:not([type="radio"]):not([type="checkbox"]):not([type="button"]), [contenteditable]',
        ))
    )
      return
    if (!/^[0-9]$/.test(e.key) || !question) return
    const index = e.key === '0' ? 9 : Number(e.key) - 1
    const options = questionOptions(question)
    if (index >= options.length) return
    e.preventDefault()
    chooseOption(questionOptionValue(options[index]))
  }

  const fieldError = question ? currentValidation.errors[question.id] : undefined
  const touched = Boolean(
    question &&
    (Object.hasOwn(draft.answers, question.id) || Object.hasOwn(draft.customAnswers, question.id)),
  )
  const showError = Boolean(fieldError && touched)
  const errorId = formId + '-question-error'
  const labelId = formId + '-question-label'
  const panelId = formId + '-body'
  const options = question ? questionOptions(question) : []
  const other = Boolean(question?.options?.length && questionAllowsOther(question))
  const custom = Boolean(question && draft.customQuestions[question.id])

  function textField(customField = false) {
    if (!question) return null
    const label = customField
      ? (question.multiple ? 'Additional answer · ' : 'Your answer · ') + question.question
      : question.question
    const value = customField
      ? draft.customAnswers[question.id] || ''
      : draft.answers[question.id]?.[0] || ''
    const shared = {
      id: formId + (customField ? '-custom' : '-answer'),
      'aria-label': label,
      disabled: locked,
      value,
      'aria-invalid': showError || undefined,
      'aria-describedby': showError ? errorId : undefined,
      onChange: (e: { target: { value: string } }) => changeText(e.target.value, customField),
    }
    return (
      <label className="pending-question-input">
        <span>
          {customField ? (question.multiple ? 'Additional answer' : 'Your answer') : 'Your answer'}
        </span>
        {question.isSecret ||
        question.inputType === 'number' ||
        question.inputType === 'integer' ? (
          <input
            {...shared}
            type={question.isSecret ? 'password' : 'number'}
            step={question.inputType === 'integer' ? 1 : 'any'}
            autoComplete={question.isSecret ? 'off' : undefined}
            placeholder={question.isSecret ? 'Enter your private answer' : 'Enter a number'}
          />
        ) : (
          <textarea {...shared} rows={3} placeholder="Type your answer…" />
        )}
      </label>
    )
  }

  return (
    <section
      ref={panel}
      className="pending-question-panel"
      aria-label="Agent questions"
      aria-busy={draft.status === 'sending' || uncertain}
      tabIndex={-1}
      onKeyDown={handleKeyboard}
      data-question-request={requestKey}
    >
      <header className="pending-question-header">
        <MessageCircle size={15} aria-hidden="true" />
        <div>
          <strong>Your input is needed</strong>
          <span aria-live="polite">
            {draft.status === 'submitted'
              ? 'Response sent'
              : draft.status === 'sending' || uncertain
                ? 'Sending your response…'
                : 'Question ' + (step + 1) + ' of ' + Math.max(1, questions.length)}
            {pendingCount > 1 ? ' · ' + pendingCount + ' pending requests' : ''}
          </span>
        </div>
        <button
          type="button"
          className="pending-question-collapse"
          aria-label={draft.collapsed ? 'Expand questions' : 'Collapse questions'}
          aria-expanded={!draft.collapsed}
          aria-controls={panelId}
          onClick={() => {
            stopAdvance()
            pendingQuestionDrafts.update(event, { collapsed: !draft.collapsed })
          }}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </header>
      {!draft.collapsed ? (
        <div id={panelId} ref={body} className="pending-question-body">
          {questions.length > 1 ? (
            <div className="pending-question-tabs" role="tablist" aria-label="Questions">
              {questions.map((item, index) => (
                <button
                  type="button"
                  role="tab"
                  key={item.id}
                  id={formId + '-tab-' + index}
                  aria-controls={formId + '-step-' + index}
                  aria-selected={step === index}
                  tabIndex={step === index ? 0 : -1}
                  disabled={locked}
                  onClick={() => moveTo(index)}
                  onKeyDown={(e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                    e.preventDefault()
                    moveTo(
                      e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? questions.length - 1
                          : (index + (e.key === 'ArrowRight' ? 1 : -1) + questions.length) %
                            questions.length,
                    )
                  }}
                >
                  <span>{index + 1}</span>
                  {item.header || 'Question ' + (index + 1)}
                </button>
              ))}
            </div>
          ) : null}
          {question ? (
            <div
              className="pending-question-step"
              id={formId + '-step-' + step}
              role={questions.length > 1 ? 'tabpanel' : undefined}
              aria-labelledby={questions.length > 1 ? formId + '-tab-' + step : labelId}
            >
              <div className="pending-question-prompt">
                {question.header ? <span>{question.header}</span> : null}
                <h3 id={labelId}>{question.question}</h3>
                {question.required === false ? <small>Optional</small> : null}
              </div>
              {options.length ? (
                <fieldset
                  className="pending-question-options"
                  disabled={locked}
                  aria-labelledby={labelId}
                >
                  <legend className="pending-question-visually-hidden">
                    {question.multiple ? 'Choose one or more answers' : 'Choose one answer'}
                  </legend>
                  {options.map((option, index) => {
                    const value = questionOptionValue(option)
                    const selected =
                      !(!question.multiple && custom) &&
                      Boolean(draft.answers[question.id]?.includes(value))
                    return (
                      <label
                        className="pending-question-option"
                        data-selected={selected || undefined}
                        key={index}
                      >
                        <input
                          type={question.multiple ? 'checkbox' : 'radio'}
                          name={formId + '-' + question.id}
                          checked={selected}
                          onChange={() => chooseOption(value)}
                        />
                        <kbd aria-hidden="true">{index < 10 ? (index + 1) % 10 : '·'}</kbd>
                        <span>
                          <strong>{option.label}</strong>
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                        {selected ? <Check size={15} aria-hidden="true" /> : null}
                      </label>
                    )
                  })}
                  {other ? (
                    <label className="pending-question-option" data-selected={custom || undefined}>
                      <input
                        type={question.multiple ? 'checkbox' : 'radio'}
                        name={formId + '-' + question.id}
                        checked={custom}
                        onChange={toggleCustom}
                      />
                      <span className="pending-question-other-icon" aria-hidden="true">
                        …
                      </span>
                      <span>
                        <strong>Other answer</strong>
                        <small>
                          {question.multiple
                            ? 'Add an answer in your own words.'
                            : 'Write your own answer.'}
                        </small>
                      </span>
                      {custom ? <Check size={15} aria-hidden="true" /> : null}
                    </label>
                  ) : null}
                </fieldset>
              ) : (
                textField()
              )}
              {custom ? textField(true) : null}
              {question.allowEmpty ? (
                <label className="pending-question-empty">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={
                      Object.hasOwn(draft.answers, question.id) &&
                      (question.multiple
                        ? draft.answers[question.id].length === 0
                        : draft.answers[question.id].length === 1 &&
                          draft.answers[question.id][0] === '') &&
                      !custom
                    }
                    onChange={(e) => {
                      stopAdvance()
                      pendingQuestionDrafts.update(event, (current) => {
                        const next = { ...current.answers }
                        if (e.target.checked) next[question.id] = question.multiple ? [] : ['']
                        else delete next[question.id]
                        return {
                          answers: next,
                          customQuestions: { ...current.customQuestions, [question.id]: false },
                        }
                      })
                    }}
                  />
                  {question.multiple ? 'Select none' : 'Use an empty answer'}
                </label>
              ) : null}
              <p className="pending-question-hint">
                Enter to {step < questions.length - 1 ? 'continue' : 'send'} · Shift+Enter for a new
                line
              </p>
              {showError ? (
                <p id={errorId} className="pending-question-error" role="alert">
                  {fieldError}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="pending-question-context">
              {event.text || 'The agent is waiting for your response.'}
            </p>
          )}
          {draft.error ? (
            <p className="pending-question-error" role="alert">
              {draft.error}
            </p>
          ) : null}
          <footer className="pending-question-footer">
            {policy.responseMode !== 'message' || canDismiss ? (
              <button
                type="button"
                className="pending-question-decline"
                disabled={locked}
                onClick={() => submit(false)}
              >
                <X size={13} aria-hidden="true" />
                {canDismiss ? 'Dismiss' : 'Decline'}
              </button>
            ) : (
              <span />
            )}

            <div>
              {step > 0 ? (
                <button
                  type="button"
                  className="button secondary"
                  aria-label="Previous question"
                  disabled={locked}
                  onClick={() => moveTo(step - 1)}
                >
                  <ChevronLeft size={14} aria-hidden="true" /> Back
                </button>
              ) : null}
              {step < questions.length - 1 ? (
                <button
                  type="button"
                  className="button primary"
                  aria-label="Next question"
                  data-question-next
                  disabled={locked || !currentValidation.valid}
                  onClick={() => moveTo(step + 1)}
                >
                  Next <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={locked || !validation.valid}
                  onClick={() => submit(true)}
                >
                  {draft.status === 'submitted'
                    ? 'Response sent'
                    : draft.status === 'sending' || uncertain
                      ? 'Sending…'
                      : 'Send answers'}
                </button>
              )}
            </div>
          </footer>
        </div>
      ) : null}
    </section>
  )
}

function questionOptions(question: AgentQuestion) {
  if (question.options?.length) return question.options
  if (question.inputType === 'boolean')
    return [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ]
  return []
}
