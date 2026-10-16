import { Cause, Effect, Exit, Schema } from 'effect'
import type { AgentEvent } from '../shared/types'
import { errorText } from './api'
import { createQuestionRecord, prepareQuestionAnswers } from './question-answers'

export interface PendingQuestionDraft {
  answers: Record<string, string[]>
  customAnswers: Record<string, string>
  customQuestions: Record<string, boolean>
  step: number
  collapsed: boolean
  status: 'idle' | 'sending' | 'submitted'
  error: string
}

export type PendingQuestionResponder = (
  event: AgentEvent,
  accepted: boolean,
  answers?: Record<string, string[]>,
  decisionId?: string,
) => Promise<void>

type QuestionResponsePolicy = { responseMode?: 'native' | 'message'; canDismiss?: boolean }

class QuestionResponseError extends Schema.TaggedError<QuestionResponseError>()(
  'QuestionResponseError',
  { message: Schema.String },
) {}

/** Delivery revisions can change while the same native question remains pending. */
export function pendingQuestionRequestKey(event: AgentEvent): string {
  const policy = event as AgentEvent & QuestionResponsePolicy
  return JSON.stringify([
    event.sessionId,
    event.requestId,
    event.provider,
    event.agentId,
    event.itemId,
    event.nativeRecovery?.transportId,
    event.nativeRecovery?.ownerGeneration,
    event.nativeRecovery?.snapshotToken,
    event.nativeRecovery?.localTurn,
    policy.responseMode || 'native',
    (event.questions || []).map((question) => [
      question.id,
      question.header,
      question.question,
      question.required,
      question.inputType,
      question.isSecret,
      question.isOther,
      question.multiple,
      question.allowEmpty,
      question.options?.map((option) => [option.label, option.description, option.value]),
    ]),
  ])
}

export function questionDraftAnswers(event: AgentEvent, draft: PendingQuestionDraft) {
  const answers = createQuestionRecord(draft.answers)
  for (const question of event.questions || []) {
    if (Object.hasOwn(draft.customQuestions, question.id) && draft.customQuestions[question.id])
      answers[question.id] = [
        ...(question.multiple ? answers[question.id] || [] : []),
        Object.hasOwn(draft.customAnswers, question.id) ? draft.customAnswers[question.id] : '',
      ]
  }
  return answers
}

const emptyDraft = (): PendingQuestionDraft => ({
  answers: createQuestionRecord<string[]>(),
  customAnswers: createQuestionRecord<string>(),
  customQuestions: createQuestionRecord<boolean>(),
  step: 0,
  collapsed: false,
  status: 'idle',
  error: '',
})

interface DraftEntry {
  snapshot: PendingQuestionDraft
  listeners: Set<() => void>
  sessionId: string
  retired: boolean
}

type DraftPatch =
  Partial<PendingQuestionDraft> | ((draft: PendingQuestionDraft) => Partial<PendingQuestionDraft>)

/** Request ownership outlives a mounted React form; nothing is written to storage. */
export function createPendingQuestionDraftStore() {
  const entries = new Map<string, DraftEntry>()
  const entryFor = (event: AgentEvent) => {
    const key = pendingQuestionRequestKey(event)
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        snapshot: emptyDraft(),
        listeners: new Set(),
        sessionId: event.sessionId,
        retired: false,
      }
      entries.set(key, entry)
    }
    return { key, entry }
  }
  const publish = (entry: DraftEntry, patch: Partial<PendingQuestionDraft>) => {
    entry.snapshot = {
      ...entry.snapshot,
      ...patch,
      ...(patch.answers ? { answers: createQuestionRecord(patch.answers) } : {}),
      ...(patch.customAnswers ? { customAnswers: createQuestionRecord(patch.customAnswers) } : {}),
      ...(patch.customQuestions
        ? { customQuestions: createQuestionRecord(patch.customQuestions) }
        : {}),
    }
    for (const listener of entry.listeners) listener()
  }

  const retire = (key: string, entry: DraftEntry) => {
    entry.retired = true
    const status = entry.snapshot.status === 'sending' ? 'sending' : 'submitted'
    publish(entry, { ...emptyDraft(), status })
    // Keep an in-flight tombstone: a temporary pending-list omission must not
    // unlock a second response while the original native delivery is uncertain.
    if (!entry.listeners.size && status !== 'sending') entries.delete(key)
  }

  return {
    hasDrafts() {
      return entries.size > 0
    },
    get(event: AgentEvent) {
      return entryFor(event).entry.snapshot
    },
    subscribe(event: AgentEvent, listener: () => void) {
      const { key, entry } = entryFor(event)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.retired && !entry.listeners.size && entry.snapshot.status !== 'sending')
          entries.delete(key)
      }
    },
    update(event: AgentEvent, patch: DraftPatch) {
      const { entry } = entryFor(event)
      const next = typeof patch === 'function' ? patch(entry.snapshot) : patch
      if (entry.snapshot.status !== 'idle') {
        if (next.collapsed !== undefined) publish(entry, { collapsed: next.collapsed })
        return
      }
      // Delivery state belongs to submit(), never to a mounted form.
      const { status: _status, error: _error, ...editable } = next
      publish(entry, { ...editable, error: '' })
    },
    submit(event: AgentEvent, onRespond: PendingQuestionResponder, accepted = true) {
      const { key, entry } = entryFor(event)
      if (entry.snapshot.status !== 'idle') return false
      const canCloseUncertain =
        !accepted && event.responseMode === 'message' && event.canDismiss === true
      if (event.status === 'responding' && !canCloseUncertain) return false
      const validation = prepareQuestionAnswers(
        event.questions || [],
        questionDraftAnswers(event, entry.snapshot),
      )
      if (accepted && !validation.valid) return false
      publish(entry, { status: 'sending', error: '' })
      // React/Electron exposes a Promise. Effect owns this one response even if
      // its form is unmounted; cancelling a view must not resend a native reply.
      Effect.runCallback(
        Effect.tryPromise({
          try: () => onRespond(event, accepted, accepted ? validation.answers : undefined),
          catch: (error) => new QuestionResponseError({ message: errorText(error) }),
        }),
        {
          onExit: (exit) => {
            if (entries.get(key) !== entry) return
            if (entry.retired) {
              publish(entry, { ...emptyDraft(), status: 'submitted' })
              if (!entry.listeners.size) entries.delete(key)
              return
            }
            if (Exit.isSuccess(exit)) {
              publish(entry, {
                answers: {},
                customAnswers: {},
                customQuestions: {},
                status: 'submitted',
                error: '',
              })
            } else {
              const failure = Cause.squash(exit.cause)
              publish(entry, { status: 'idle', error: errorText(failure) })
            }
          },
        },
      )
      return true
    },
    forget(event: AgentEvent) {
      const key = pendingQuestionRequestKey(event)
      const entry = entries.get(key)
      if (!entry) return
      retire(key, entry)
    },
    prune(events: readonly AgentEvent[]) {
      const live = new Set(events.map(pendingQuestionRequestKey))
      for (const [key, entry] of entries) {
        if (live.has(key)) continue
        retire(key, entry)
      }
    },
    pruneSession(sessionId: string, events: readonly AgentEvent[]) {
      const live = new Set(
        events.filter((event) => event.sessionId === sessionId).map(pendingQuestionRequestKey),
      )
      for (const [key, entry] of entries) {
        if (entry.sessionId === sessionId && !live.has(key)) retire(key, entry)
      }
    },
  }
}

export const pendingQuestionDrafts = createPendingQuestionDraftStore()
