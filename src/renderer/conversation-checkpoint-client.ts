import {
  CONVERSATION_CHECKPOINT_BASE_CHANGED,
  type ConversationCheckpointAck,
  type ConversationCheckpointInput,
  type ConversationCheckpointThread,
  type ConversationMessageFieldCheckpoint,
  type ConversationMessageCheckpoint,
  type ConversationProjectionAdmission,
} from '../shared/conversations'
import type { Message, Thread } from './state'
import { errorText } from './api'
import { samePersistedConversationValue } from './conversation-load-values'
import {
  acknowledgeConversationSources,
  projectConversationSourceHistory,
  refreshConversationSources,
} from './conversation-source'
import {
  acknowledgeConversationMessageAppends,
  assertConversationMessageAppendMutationData,
  conversationMessageAppendMutationEpoch,
  conversationMessageAppendWasMutated,
  createConversationMessageAppendAcknowledgement,
  discardConversationMessageAppendAcknowledgements,
  getConversationMessageAppend,
} from './conversation-message-appends'
import {
  carryNativeProjectionAdmissions,
  nativeProjectionAdmissions,
  projectNativeProjectionAdmissions,
} from './native-projection-admissions'

const appendAcknowledgements = new WeakMap<ConversationCheckpointInput, object[]>()

function fullSaveAppendAcknowledgements(history: Thread[]): object[] {
  const receipts: object[] = []
  // A full save already submits every record. Look up registrations before
  // native I/O so its ACK validates only these endpoints, without rereading
  // settled history or touching unregistered message bodies.
  for (const thread of history) {
    if (!thread || !Array.isArray(thread.messages)) continue
    for (const message of thread.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      const receipt = createConversationMessageAppendAcknowledgement(message)
      assertConversationMessageAppendMutationData(message)
      if (receipt) receipts.push(receipt)
    }
  }
  return receipts
}

export type NativeConversationSave = (
  threads: unknown[],
  savedAt?: number,
  projectionAdmissions?: readonly ConversationProjectionAdmission[],
) => Promise<void>
export type NativeConversationCheckpoint = (
  input: ConversationCheckpointInput,
) => Promise<ConversationCheckpointAck>

export interface ConversationCheckpointOptions {
  /** Enable only when this native bridge explicitly advertises message field support. */
  supportsMessageFields?: boolean
  /** Append packets need independent admission from native message-field support. */
  supportsMessageAppends?: boolean
}

/** Preserve immutable identities and all recoverable source records without serializing settled text. */
export function createHistorySnapshotProjector(): (threads: Thread[]) => Thread[] {
  return (threads) =>
    projectNativeProjectionAdmissions(threads, projectConversationSourceHistory(threads))
}

function sameMetadata(left: Thread, right: Thread): boolean {
  const leftKeys = Object.keys(left).filter((key) => key !== 'messages')
  const rightKeys = Object.keys(right).filter((key) => key !== 'messages')
  if (leftKeys.length !== rightKeys.length) return false
  const previous = left as unknown as Record<string, unknown>
  const next = right as unknown as Record<string, unknown>
  return rightKeys.every(
    (key) => Object.hasOwn(previous, key) && Object.is(previous[key], next[key]),
  )
}

function uniqueThreads(threads: Thread[]): Map<string, Thread> | undefined {
  if (!Array.isArray(threads)) return undefined
  const byId = new Map<string, Thread>()
  for (const thread of threads) {
    if (
      !thread ||
      typeof thread !== 'object' ||
      Array.isArray(thread) ||
      typeof thread.id !== 'string' ||
      !thread.id ||
      byId.has(thread.id) ||
      !Array.isArray(thread.messages)
    )
      return undefined
    byId.set(thread.id, thread)
  }
  return byId
}

function hasCheckpointIdentities(history: Thread[]): boolean {
  if (!Array.isArray(history)) return false
  const ids = new Set<string>()
  for (const thread of history) {
    if (
      !thread ||
      typeof thread !== 'object' ||
      Array.isArray(thread) ||
      typeof thread.id !== 'string' ||
      !thread.id ||
      ids.has(thread.id) ||
      typeof thread.profileId !== 'string' ||
      (thread.provider !== 'codex' && thread.provider !== 'claude') ||
      !Array.isArray(thread.messages)
    )
      return false
    ids.add(thread.id)
  }
  return true
}

function changedMessageFields(
  previous: Message,
  next: Message,
  supportsMessageAppends: boolean,
): ConversationMessageFieldCheckpoint | undefined {
  const before = previous as unknown as Record<string, unknown>
  const after = next as unknown as Record<string, unknown>
  const set: Record<string, unknown> = {}
  const remove: string[] = []
  const append: NonNullable<ConversationMessageFieldCheckpoint['append']> = {}
  for (const key of Object.keys(after)) {
    if (key === 'id') continue
    const value = after[key]
    if (value === undefined) continue
    if (Object.hasOwn(before, key) && samePersistedConversationValue(before[key], value)) continue
    const prior = Object.hasOwn(before, key) ? before[key] : undefined
    if (
      supportsMessageAppends &&
      Object.hasOwn(before, key) &&
      typeof prior === 'string' &&
      typeof value === 'string' &&
      prior.length >= 1024 &&
      value.length > prior.length
    ) {
      const owned = key === 'text' ? getConversationMessageAppend(previous, next) : undefined
      const unchangedEndpoints =
        key !== 'text' ||
        (!conversationMessageAppendWasMutated(previous) &&
          !conversationMessageAppendWasMutated(next))
      if (owned || (unchangedEndpoints && value.startsWith(prior))) {
        Object.defineProperty(append, key, {
          value: owned ?? { baseLength: prior.length, value: value.slice(prior.length) },
          enumerable: true,
          configurable: true,
          writable: true,
        })
        continue
      }
    }
    Object.defineProperty(set, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  for (const key of Object.keys(before)) {
    if (
      key !== 'id' &&
      before[key] !== undefined &&
      (!Object.hasOwn(after, key) || after[key] === undefined)
    )
      remove.push(key)
  }
  const hasAppends = Object.keys(append).length > 0
  return Object.keys(set).length || remove.length || hasAppends
    ? { id: next.id, set, remove, ...(hasAppends ? { append } : {}) }
    : undefined
}

/** Exact membership and message deltas; opaque legacy identities retain the full-save path. */
export function createConversationCheckpointProjector() {
  const indexes = new WeakMap<
    Message[],
    { mutationEpoch: number; byId: Map<string, Message> | null }
  >()
  const index = (messages: Message[]): Map<string, Message> | null => {
    const mutationEpoch = conversationMessageAppendMutationEpoch()
    const cached = indexes.get(messages)
    if (cached?.mutationEpoch === mutationEpoch) return cached.byId
    const byId = new Map<string, Message>()
    for (const message of messages) {
      if (message && typeof message === 'object' && !Array.isArray(message))
        assertConversationMessageAppendMutationData(message)
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        typeof message.id !== 'string' ||
        !message.id ||
        byId.has(message.id)
      ) {
        indexes.set(messages, { mutationEpoch, byId: null })
        return null
      }
      byId.set(message.id, message)
    }
    indexes.set(messages, { mutationEpoch, byId })
    return byId
  }
  return (
    previous: Thread[],
    next: Thread[],
    baseSavedAt: number,
    savedAt: number,
    options: ConversationCheckpointOptions = {},
  ): ConversationCheckpointInput | undefined => {
    const previousById = uniqueThreads(previous)
    if (!previousById || !uniqueThreads(next)) return undefined
    const upserts: ConversationCheckpointInput['upserts'] = []
    const receipts: object[] = []
    for (const thread of next) {
      const before = previousById.get(thread.id)
      if (before === thread) continue
      if (before && before.messages === thread.messages && sameMetadata(before, thread)) continue
      const { messages, ...metadata } = thread
      let delta: ConversationMessageCheckpoint
      const oldMessages = before ? index(before.messages) : null
      const currentMessages = index(messages)
      if (
        !before ||
        before.profileId !== thread.profileId ||
        before.provider !== thread.provider ||
        !oldMessages ||
        !currentMessages
      ) {
        delta = { mode: 'replace', values: messages }
      } else {
        const upserts: Message[] = []
        const fields: ConversationMessageFieldCheckpoint[] = []
        let orderChanged = before.messages.length !== messages.length
        for (let position = 0; position < messages.length; position++) {
          const message = messages[position]
          const previous = oldMessages.get(message.id)
          if (previous !== message) {
            const receipt = createConversationMessageAppendAcknowledgement(message)
            if (receipt) receipts.push(receipt)
            if (previous && options.supportsMessageFields === true) {
              const changed = changedMessageFields(
                previous,
                message,
                options.supportsMessageAppends === true,
              )
              if (changed) fields.push(changed)
            } else upserts.push(message)
          }
          if (!orderChanged && before.messages[position]?.id !== message.id) orderChanged = true
        }
        delta = {
          mode: 'patch',
          ...(orderChanged ? { order: messages.map((message) => message.id) } : {}),
          upserts,
          ...(fields.length ? { fields } : {}),
        }
      }
      upserts.push({ thread: metadata as ConversationCheckpointThread, messages: delta })
    }
    const input: ConversationCheckpointInput = {
      version: 1,
      baseSavedAt,
      savedAt,
      order: next.map((thread) => thread.id),
      upserts,
    }
    if (receipts.length) appendAcknowledgements.set(input, receipts)
    return input
  }
}

interface Submission {
  history: Thread[]
  savedAt: number
  save: NativeConversationSave
  checkpoint?: NativeConversationCheckpoint
  options?: ConversationCheckpointOptions
  subscribers: { resolve(savedAt: number): void; reject(error: unknown): void }[]
}

/** Generate each delta from a durable acknowledgement; bound backlog to the newest desired state. */
export class ConversationCheckpointClient {
  private readonly project = createConversationCheckpointProjector()
  private baseline?: { history: Thread[]; savedAt: number; appendMutationEpoch: number }
  private save?: NativeConversationSave
  private checkpoint?: NativeConversationCheckpoint
  private supportsMessageFields = false
  private supportsMessageAppends = false
  private pending?: Submission
  private draining?: Promise<void>
  private running = false

  /** The caller must prove this exact immutable snapshot is already durable through this bridge. */
  adoptDurableBaseline(
    history: Thread[],
    savedAt: number,
    save: NativeConversationSave,
    checkpoint: NativeConversationCheckpoint,
    options: ConversationCheckpointOptions = {},
  ): boolean {
    if (
      this.running ||
      this.draining ||
      this.pending ||
      !Number.isSafeInteger(savedAt) ||
      savedAt < 0 ||
      !hasCheckpointIdentities(history)
    )
      return false
    this.save = save
    this.checkpoint = checkpoint
    this.supportsMessageFields = options.supportsMessageFields === true
    this.supportsMessageAppends = options.supportsMessageAppends === true
    this.baseline = {
      history,
      savedAt,
      appendMutationEpoch: conversationMessageAppendMutationEpoch(),
    }
    return true
  }

  submit(
    history: Thread[],
    savedAt: number,
    save: NativeConversationSave,
    checkpoint?: NativeConversationCheckpoint,
    options?: ConversationCheckpointOptions,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const pending = this.pending
      const subscribers = pending?.subscribers ?? []
      // A newer snapshot supersedes history, while omitted capability options
      // retain the latest explicit settings for this same native bridge.
      const inheritedOptions =
        pending && pending.save === save && pending.checkpoint === checkpoint
          ? pending.options
          : undefined
      const mergedOptions =
        options || inheritedOptions
          ? {
              supportsMessageFields:
                options?.supportsMessageFields ?? inheritedOptions?.supportsMessageFields,
              supportsMessageAppends:
                options?.supportsMessageAppends ?? inheritedOptions?.supportsMessageAppends,
            }
          : undefined
      subscribers.push({ resolve, reject })
      this.pending = { history, savedAt, save, checkpoint, options: mergedOptions, subscribers }
      this.startDrain()
    })
  }

  private startDrain(): void {
    if (this.running) return
    this.running = true
    this.draining = this.drain().finally(() => {
      this.draining = undefined
      this.running = false
      if (this.pending) this.startDrain()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const submission = this.pending
      this.pending = undefined
      try {
        const savedAt = await this.write(submission)
        submission.subscribers.forEach(({ resolve }) => resolve(savedAt))
      } catch (error) {
        this.baseline = undefined
        submission.subscribers.forEach(({ reject }) => reject(error))
        // A caller may durably save and acknowledge synchronous recovery storage
        // after rejection. Let that source rebase settle before refreshing the
        // next queued request.
        await Promise.resolve()
      }
    }
  }

  private async write(submission: Submission): Promise<number> {
    const { savedAt, save, checkpoint, options } = submission
    const history = carryNativeProjectionAdmissions(
      submission.history,
      refreshConversationSources(submission.history),
    )
    const projectionAdmissions = nativeProjectionAdmissions(history)
    const saveHistory = () =>
      projectionAdmissions ? save(history, savedAt, projectionAdmissions) : save(history, savedAt)
    const bridgeChanged = this.save !== save || this.checkpoint !== checkpoint
    if (bridgeChanged) this.baseline = undefined
    this.supportsMessageFields =
      options?.supportsMessageFields ?? (!bridgeChanged && this.supportsMessageFields)
    this.supportsMessageAppends =
      options?.supportsMessageAppends ?? (!bridgeChanged && this.supportsMessageAppends)
    this.save = save
    this.checkpoint = checkpoint
    let appendMutationEpoch = conversationMessageAppendMutationEpoch()
    const delta =
      checkpoint && this.baseline && this.baseline.appendMutationEpoch === appendMutationEpoch
        ? this.project(this.baseline.history, history, this.baseline.savedAt, savedAt, {
            supportsMessageFields: this.supportsMessageFields,
            supportsMessageAppends: this.supportsMessageAppends,
          })
        : undefined
    let receipts = delta
      ? (appendAcknowledgements.get(delta) ?? [])
      : fullSaveAppendAcknowledgements(history)
    // Validation may discover a preexisting mutation while projecting. Capture
    // it before native I/O, so later mutations cannot be cleared by this ACK.
    appendMutationEpoch = conversationMessageAppendMutationEpoch()
    try {
      if (delta && checkpoint) {
        try {
          // The original delta owns Root's exact append receipts. Admissions
          // decorate only the IPC argument, so its acknowledgement still settles
          // the captured endpoints rather than an unregistered clone.
          const acknowledgement = await checkpoint(
            projectionAdmissions ? { ...delta, projectionAdmissions } : delta,
          )
          if (acknowledgement?.savedAt !== savedAt)
            throw new Error(
              'The native checkpoint acknowledgement changed. Retry the latest history.',
            )
        } catch (error) {
          if (!errorText(error).includes(CONVERSATION_CHECKPOINT_BASE_CHANGED)) throw error
          // A restarted worker or a legacy full-save caller can change the base.
          // Re-submit the caller's complete authoritative snapshot through the
          // existing API instead of applying a delta to an unrelated history.
          this.baseline = undefined
          discardConversationMessageAppendAcknowledgements(receipts)
          receipts = fullSaveAppendAcknowledgements(history)
          appendMutationEpoch = conversationMessageAppendMutationEpoch()
          await saveHistory()
        }
      } else await saveHistory()
      acknowledgeConversationMessageAppends(receipts)
    } finally {
      discardConversationMessageAppendAcknowledgements(receipts)
      if (delta) appendAcknowledgements.delete(delta)
    }
    this.baseline = { history, savedAt, appendMutationEpoch }
    acknowledgeConversationSources(history, savedAt)
    return savedAt
  }
}
