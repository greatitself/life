import type { Message, Thread } from './state'
import {
  conversationMessageAppendHasPendingMutation,
  assertConversationMessageAppendMutationData,
  bindConversationMessageAppendSource,
  conversationMessageAppendMutationEpoch,
  conversationMessageAppendSourceMutationEpoch,
  conversationMessageAppendWasMutated,
  getConversationMessageAppendSource,
  observeConversationMessageAppendSource,
  projectConversationMessageAppendSource,
} from './conversation-message-appends'

const threadSource = Symbol('Life conversation recovery source')
const valueSource = Symbol('Life conversation recovery value')
const ownedThreadSources = new WeakSet<object>()
const ownedValueSources = new WeakSet<object>()
const lifecycleIntent = Symbol('Life conversation lifecycle intent')
const emptyPending: Thread['pending'] = []
const lifecycleFields = ['busy', 'turnStatus', 'agentStatus'] as const
type LifecycleField = (typeof lifecycleFields)[number]

type RecordValue = Record<string, unknown>
type ValueSource = object
interface ThreadSource {
  raw: RecordValue
  baseline: RecordValue
  order?: number
  group?: object
  acknowledgedAt: number
  acknowledgedAppendMutationEpoch?: number
}
interface LifecycleIntent {
  source: ThreadSource
  owner: object
  turn: number
  values: Pick<Thread, LifecycleField>
  fields: readonly LifecycleField[]
}
const lifecycleOwners = new WeakMap<ThreadSource, object>()
const lifecycleIntents = new WeakMap<object, LifecycleIntent>()
interface ArraySource {
  raw: unknown[]
  positions: number[]
  rawLength: number
}
export interface ConversationSourceOptions {
  /** The original persisted ordering is independent of the sorted display. */
  order?: number
  group?: object
}
const arraySources = new WeakMap<unknown[], ArraySource>()
interface ValueCapture {
  normalized: RecordValue
  raw: RecordValue
  occurrence?: boolean
}
interface Projection {
  value: Thread
  source?: ThreadSource
  lifecycleOwner?: object
  raw?: RecordValue
  acknowledgedAt?: number
  captures: ValueCapture[]
  appendMutationEpoch?: number
  globalAppendMutationEpoch?: number
}
const projections = new WeakMap<Thread, Projection>()
const projectedViews = new WeakMap<Thread, Thread>()
const projectedHistoryViews = new WeakMap<Thread[], Thread[]>()

function stringProperties(value: object): RecordValue {
  return Object.fromEntries(Object.entries(value))
}
function put(target: object, key: PropertyKey, value: unknown): void {
  if (value && typeof value === 'object') {
    if (key === threadSource) ownedThreadSources.add(value)
    if (key === valueSource) ownedValueSources.add(value)
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}
function objectValue(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined
}
function assertKnownMessageMutationData(value: unknown): void {
  const record = objectValue(value)
  if (record) assertConversationMessageAppendMutationData(record)
}
function sourceOf(thread: Thread): ThreadSource | undefined {
  const source = (thread as unknown as { [threadSource]?: ThreadSource })[threadSource]
  return source &&
    source.baseline.id === thread.id &&
    source.baseline.profileId === thread.profileId &&
    source.baseline.provider === thread.provider
    ? source
    : undefined
}
function lifecycleIntentOf(
  thread: Thread,
  source: ThreadSource | undefined,
): LifecycleIntent | undefined {
  const token = (thread as Thread & { [lifecycleIntent]?: object })[lifecycleIntent]
  const intent = token && lifecycleIntents.get(token)
  return intent &&
    intent.source === source &&
    intent.owner === lifecycleOwners.get(intent.source) &&
    intent.turn === thread.turn &&
    Object.is(intent.values.busy, thread.busy) &&
    Object.is(intent.values.turnStatus, thread.turnStatus)
    ? intent
    : undefined
}
function valueSourceOf(value: unknown): ValueSource | undefined {
  return objectValue(value) ? (value as { [valueSource]?: ValueSource })[valueSource] : undefined
}
function arrayIdentity(value: unknown): string | undefined {
  const record = objectValue(value)
  if (!record) return undefined
  for (const key of ['id', 'path', 'name'])
    if (typeof record[key] === 'string') return `${key}:${record[key]}`
  return undefined
}
function matchingPresentationFields(normalized: unknown, raw: unknown): boolean {
  const view = objectValue(normalized)
  const original = objectValue(raw)
  if (!view || !original) return Object.is(normalized, raw)
  for (const key of ['text', 'name', 'path', 'mime', 'kind', 'version', 'size']) {
    if (!Object.hasOwn(view, key) || view[key] === undefined) continue
    const value = view[key]
    const prior = original[key]
    if (Object.is(value, prior)) continue
    if (
      ['name', 'path', 'kind', 'version'].includes(key) &&
      typeof value === 'string' &&
      typeof prior === 'string' &&
      prior.startsWith(value)
    )
      continue
    return false
  }
  return true
}

function readableMessage(value: unknown): boolean {
  const record = objectValue(value)
  return Boolean(
    record &&
    typeof record.id === 'string' &&
    typeof record.text === 'string' &&
    typeof record.role === 'string' &&
    ['user', 'assistant', 'tool', 'error'].includes(record.role),
  )
}

/** Pair normalized array occurrences with source slots without assigning native identifiers. */
function arrayPositions(baseline: unknown[], raw: unknown[], key?: string): number[] {
  const identities = new Map<string, number[]>()
  const references = new Map<unknown, number[]>()
  for (let position = 0; position < raw.length; position++) {
    const value = raw[position]
    if (key === 'messages' && !readableMessage(value)) continue
    const identity = arrayIdentity(value)
    if (identity) {
      const positions = identities.get(identity) ?? []
      positions.push(position)
      identities.set(identity, positions)
    }
    const positions = references.get(value) ?? []
    positions.push(position)
    references.set(value, positions)
  }
  const used = new Set<number>()
  const cursors = new WeakMap<number[], number>()
  const take = (positions: number[] | undefined, value: unknown): number | undefined => {
    if (!positions) return undefined
    let cursor = cursors.get(positions) ?? 0
    while (cursor < positions.length) {
      const position = positions[cursor++]
      cursors.set(positions, cursor)
      if (
        !used.has(position) &&
        ((objectValue(value) &&
          getConversationMessageAppendSource(value as object) === raw[position]) ||
          matchingPresentationFields(value, raw[position]))
      )
        return position
    }
    return undefined
  }
  return baseline.map((value, index) => {
    let position = take(references.get(value), value)
    const source = objectValue(value)
      ? getConversationMessageAppendSource(value as object)
      : undefined
    if (position === undefined && source) position = take(references.get(source), value)
    const identity = arrayIdentity(value)
    if (position === undefined && identity) position = take(identities.get(identity), value)
    // File/source presentation can shorten a path or dependency name. These
    // bounded metadata arrays retain the first matching original occurrence.
    if (position === undefined && identity && !identity.startsWith('id:'))
      position = raw.findIndex((candidate, candidateIndex) => {
        const original = arrayIdentity(candidate)
        return (
          !used.has(candidateIndex) &&
          original?.startsWith(identity) &&
          matchingPresentationFields(value, candidate)
        )
      })
    if (position === undefined && !identity && index < raw.length && !used.has(index))
      position = index
    if (position === undefined || position < 0) return -1
    used.add(position)
    return position
  })
}

/** Capture baselines iteratively; strings and unchanged raw objects retain their references. */
function bindValues(normalized: unknown, raw: unknown, key?: string): void {
  const pending: { normalized: unknown; raw: unknown; key?: string; occurrence?: boolean }[] = [
    { normalized, raw, key },
  ]
  while (pending.length) {
    const pair = pending.pop()!
    if (Object.is(pair.normalized, pair.raw)) continue
    if (Array.isArray(pair.normalized) && Array.isArray(pair.raw)) {
      const positions = arrayPositions(pair.normalized, pair.raw, pair.key)
      arraySources.set(pair.normalized, { raw: pair.raw, positions, rawLength: pair.raw.length })
      for (let index = 0; index < positions.length; index++)
        if (positions[index] >= 0)
          pending.push({
            normalized: pair.normalized[index],
            raw: pair.raw[positions[index]],
            occurrence: true,
          })
      continue
    }
    const normalizedRecord = objectValue(pair.normalized)
    const rawRecord = objectValue(pair.raw)
    if (!normalizedRecord || !rawRecord) continue
    if (pair.occurrence) {
      put(normalizedRecord, valueSource, valueSourceOf(normalizedRecord) ?? {})
      bindConversationMessageAppendSource(normalizedRecord, rawRecord)
    }
    for (const property of Object.keys(rawRecord)) {
      if (!Object.hasOwn(normalizedRecord, property)) continue
      const value = normalizedRecord[property]
      if (value && typeof value === 'object')
        pending.push({ normalized: value, raw: rawRecord[property], key: property })
    }
  }
}

/** The decoder owns these staging arrays until its complete snapshot is admitted. */
export function appendConversationSourceMessages(
  thread: Thread,
  rawAccumulator: unknown[],
  normalizedBatch: Message[],
  rawBatch: unknown[],
): void {
  let captured = arraySources.get(thread.messages)
  if (!captured || captured.raw !== rawAccumulator) {
    if (thread.messages.length || rawAccumulator.length)
      throw new Error('Conversation source batches require matching empty staging arrays.')
    captured = { raw: rawAccumulator, positions: [], rawLength: 0 }
    arraySources.set(thread.messages, captured)
  }
  if (
    captured.positions.length !== thread.messages.length ||
    captured.rawLength !== rawAccumulator.length
  )
    throw new Error('Conversation source staging arrays changed outside the decoder.')
  bindValues(normalizedBatch, rawBatch, 'messages')
  const batch = arraySources.get(normalizedBatch)
  const offset = rawAccumulator.length
  for (const value of rawBatch) rawAccumulator.push(value)
  for (const value of normalizedBatch) thread.messages.push(value)
  for (const position of batch?.positions ?? normalizedBatch.map((_, index) => index))
    captured.positions.push(position < 0 ? position : offset + position)
  captured.rawLength = rawAccumulator.length
  projections.delete(thread)
}

export function attachConversationSource(
  thread: Thread,
  rawThread: RecordValue,
  options: ConversationSourceOptions = {},
): Thread {
  const captured = arraySources.get(thread.messages)
  if (
    !captured ||
    captured.raw !== rawThread.messages ||
    captured.positions.length !== thread.messages.length ||
    captured.rawLength !== captured.raw.length
  )
    bindValues(thread.messages, rawThread.messages, 'messages')
  for (const key of Object.keys(thread)) {
    if (key === 'messages' || key === 'pending') continue
    const value = (thread as unknown as RecordValue)[key]
    if (value && typeof value === 'object' && Object.hasOwn(rawThread, key))
      bindValues(value, rawThread[key], key)
  }
  const existing = sourceOf(thread)
  const source: ThreadSource = existing ?? {
    raw: rawThread,
    baseline: {},
    acknowledgedAt: -1,
  }
  source.raw = rawThread
  source.baseline = stringProperties(thread)
  source.baseline.pending = emptyPending
  // Replacing the admitted raw source expires old intent; durable ACKs do not.
  lifecycleOwners.set(source, {})
  if (options.order !== undefined) source.order = options.order
  if (options.group !== undefined) source.group = options.group
  put(thread, threadSource, source)
  projections.delete(thread)
  return thread
}

/** Cache every visited pair so deeply edited immutable trees remain linear. */
function presentationEquality(changedContainers: WeakSet<object>) {
  const comparisons = new WeakMap<object, WeakMap<object, boolean>>()
  return (left: unknown, right: unknown): boolean => {
    interface Comparison {
      left: unknown
      right: unknown
      parent?: Comparison
      equal: boolean
      finish?: boolean
    }
    const root: Comparison = { left, right, equal: true }
    const pending: Comparison[] = [root]
    while (pending.length) {
      const comparison = pending.pop()!
      const before = comparison.left
      const after = comparison.right
      if (comparison.finish) {
        let byAfter = comparisons.get(before as object)
        if (!byAfter) {
          byAfter = new WeakMap()
          comparisons.set(before as object, byAfter)
        }
        byAfter.set(after as object, comparison.equal)
        if (!comparison.equal && comparison.parent) comparison.parent.equal = false
        continue
      }
      const beforeMutation = Boolean(
        before &&
        before !== after &&
        typeof before === 'object' &&
        conversationMessageAppendWasMutated(before),
      )
      const afterMutation = Boolean(
        after && typeof after === 'object' && conversationMessageAppendWasMutated(after),
      )
      if (beforeMutation) assertKnownMessageMutationData(before)
      if (afterMutation) assertKnownMessageMutationData(after)
      if (
        beforeMutation ||
        afterMutation ||
        (after && typeof after === 'object' && changedContainers.has(after))
      ) {
        comparison.equal = false
        if (comparison.parent) comparison.parent.equal = false
        continue
      }
      if (Object.is(before, after) || before === after) continue
      const beforeSource = valueSourceOf(before)
      const afterSource = valueSourceOf(after)
      if (beforeSource && afterSource && beforeSource !== afterSource) {
        comparison.equal = false
        if (comparison.parent) comparison.parent.equal = false
        continue
      }
      let equal = false
      if (before && after && typeof before === 'object' && typeof after === 'object') {
        const known = comparisons.get(before)?.get(after)
        if (known !== undefined) equal = known
        else {
          const children: { left: unknown; right: unknown }[] = []
          let comparable = false
          if (Array.isArray(before) && Array.isArray(after)) {
            comparable = before.length === after.length
            if (comparable)
              for (let index = 0; index < before.length; index++)
                children.push({
                  left: before[index] === undefined ? null : before[index],
                  right: after[index] === undefined ? null : after[index],
                })
          } else if (!Array.isArray(before) && !Array.isArray(after)) {
            const beforePrototype = Object.getPrototypeOf(before)
            const afterPrototype = Object.getPrototypeOf(after)
            if (
              (beforePrototype === Object.prototype || beforePrototype === null) &&
              (afterPrototype === Object.prototype || afterPrototype === null)
            ) {
              const previous = before as RecordValue
              const next = after as RecordValue
              const beforeKeys = Object.keys(previous).filter((key) => previous[key] !== undefined)
              const afterKeys = Object.keys(next).filter((key) => next[key] !== undefined)
              comparable = beforeKeys.length === afterKeys.length
              if (comparable)
                for (const key of beforeKeys) {
                  if (!Object.hasOwn(next, key) || next[key] === undefined) {
                    comparable = false
                    break
                  }
                  children.push({ left: previous[key], right: next[key] })
                }
            }
          }
          if (comparable) {
            comparison.finish = true
            pending.push(comparison)
            for (const child of children)
              pending.push({ ...child, parent: comparison, equal: true })
            continue
          }
        }
      }
      if (!equal) {
        comparison.equal = false
        if (comparison.parent) comparison.parent.equal = false
      }
    }
    return root.equal
  }
}

/** Changes to the displayed baseline are overlaid on the complete source JSON. */
function mergeValue(
  raw: unknown,
  baseline: unknown,
  current: unknown,
  captures: ValueCapture[],
  changedContainers: WeakSet<object>,
): unknown {
  type Task = () => void
  const tasks: Task[] = []
  let result: unknown
  const samePresentation = presentationEquality(changedContainers)
  const schedule = (
    original: unknown,
    before: unknown,
    after: unknown,
    assign: (value: unknown) => void,
  ): void => {
    tasks.push(() => {
      if (samePresentation(before, after)) {
        assign(original)
        return
      }
      if (Array.isArray(before) && Array.isArray(after) && Array.isArray(original)) {
        // Reject known accessor edits before occurrence matching reads ids.
        for (const value of before) assertKnownMessageMutationData(value)
        for (const value of after) assertKnownMessageMutationData(value)
        const captured = arraySources.get(before)
        const positions =
          captured?.raw === original ? captured.positions : arrayPositions(before, original)
        const sources = new Map<ValueSource, number>()
        const references = new Map<unknown, number[]>()
        const identities = new Map<string, number[]>()
        for (let index = 0; index < before.length; index++) {
          const source = valueSourceOf(before[index])
          if (source) sources.set(source, index)
          const referencesForValue = references.get(before[index]) ?? []
          referencesForValue.push(index)
          references.set(before[index], referencesForValue)
          const identity = arrayIdentity(before[index])
          if (identity) {
            const indexes = identities.get(identity) ?? []
            indexes.push(index)
            identities.set(identity, indexes)
          }
        }
        const used = new Set<number>()
        const take = (indexes: number[] | undefined): number | undefined => {
          while (indexes?.length) {
            const index = indexes.shift()!
            if (!used.has(index)) return index
          }
          return undefined
        }
        const entries = after.map((value, currentIndex) => {
          const source = valueSourceOf(value)
          let index = source ? sources.get(source) : undefined
          if (index !== undefined && used.has(index)) index = undefined
          if (index === undefined) index = take(references.get(value))
          if (index === undefined && !source) {
            const identity = arrayIdentity(value)
            if (identity) index = take(identities.get(identity))
          }
          if (index !== undefined) used.add(index)
          return { value, index, currentIndex }
        })
        const visibleSlots = new Map(positions.map((position, index) => [position, index]))
        const output: unknown[] = []
        const outputPositions: number[] = []
        let next = 0
        const append = (entry: (typeof entries)[number]) => {
          const position = output.length
          outputPositions[entry.currentIndex] = position
          output.push(undefined)
          if (entry.index === undefined || positions[entry.index] < 0) {
            output[position] = entry.value
            const record = objectValue(entry.value)
            if (record) captures.push({ normalized: record, raw: record, occurrence: true })
            return
          }
          schedule(original[positions[entry.index]], before[entry.index], entry.value, (value) => {
            output[position] = value
          })
        }
        tasks.push(() => {
          const merged =
            output.length === original.length &&
            output.every((value, index) => Object.is(value, original[index]))
              ? original
              : output
          arraySources.set(after, {
            raw: merged,
            positions: outputPositions,
            rawLength: merged.length,
          })
          assign(merged)
        })
        for (let position = 0; position < original.length; position++) {
          const visible = visibleSlots.get(position)
          if (visible === undefined) output.push(original[position])
          else if (used.has(visible)) {
            while (next < entries.length && entries[next].index === undefined)
              append(entries[next++])
            if (next < entries.length) append(entries[next++])
          }
        }
        while (next < entries.length) append(entries[next++])
        return
      }
      const beforeRecord = objectValue(before)
      const afterRecord = objectValue(after)
      const originalRecord = objectValue(original)
      if (!beforeRecord || !afterRecord || !originalRecord) {
        assign(after)
        return
      }
      const mutatedMessage = conversationMessageAppendWasMutated(afterRecord)
      if (mutatedMessage) assertKnownMessageMutationData(afterRecord)
      // Newly added source records can share the normalized object. Once it is
      // quarantined, save a distinct raw record so later edits cannot compare
      // against themselves and disappear from recovery.
      let output: RecordValue | undefined =
        mutatedMessage && originalRecord === afterRecord
          ? stringProperties(originalRecord)
          : undefined
      const set = (key: string, value: unknown) => {
        if (value === undefined) {
          if (!Object.hasOwn(originalRecord, key)) return
          output ??= stringProperties(originalRecord)
          delete output[key]
        } else if (!Object.hasOwn(originalRecord, key) || !Object.is(originalRecord[key], value)) {
          output ??= stringProperties(originalRecord)
          put(output, key, value)
        }
      }
      if (mutatedMessage)
        for (const key of ['id', 'text']) {
          const descriptor = Object.getOwnPropertyDescriptor(afterRecord, key)
          if (!descriptor) set(key, undefined)
          else if ('value' in descriptor) set(key, descriptor.value)
        }
      tasks.push(() => {
        const merged = output ?? originalRecord
        projectConversationMessageAppendSource(beforeRecord, originalRecord, afterRecord, merged)
        if (output && valueSourceOf(afterRecord))
          captures.push({ normalized: afterRecord, raw: merged })
        assign(merged)
      })
      const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])
      for (const key of keys) {
        const beforeValue = Object.hasOwn(beforeRecord, key) ? beforeRecord[key] : undefined
        const afterValue = Object.hasOwn(afterRecord, key) ? afterRecord[key] : undefined
        if (
          Object.is(beforeValue, afterValue) &&
          !(afterValue && typeof afterValue === 'object' && changedContainers.has(afterValue))
        )
          continue
        schedule(originalRecord[key], beforeValue, afterValue, (value) => set(key, value))
      }
    })
  }
  schedule(raw, baseline, current, (value) => {
    result = value
  })
  while (tasks.length) tasks.pop()!()
  return result
}

export function hasConversationSource(thread: Thread): boolean {
  return sourceOf(thread) !== undefined
}
export function conversationSourceHasPersistedField(thread: Thread, key: string): boolean {
  const source = sourceOf(thread)
  return Boolean(source && Object.hasOwn(source.raw, key) && source.raw[key] !== undefined)
}
export function getConversationSourceRaw(thread: Thread): Thread {
  return (sourceOf(thread)?.raw ?? thread) as unknown as Thread
}

/** Validate before projection reads properties; copied recovery data has no private markers. */
export function copyConversationSourceJson(thread: Thread): Thread {
  const validate = (root: unknown) => {
    const seen = new WeakSet<object>()
    const pending: { value: unknown; finish?: boolean }[] = [{ value: root }]
    while (pending.length) {
      const entry = pending.pop()!
      const value = entry.value
      if (entry.finish) {
        seen.delete(value as object)
        continue
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
      if (typeof value === 'number' && Number.isFinite(value)) continue
      if (!value || typeof value !== 'object')
        throw new Error('Conversation history must contain JSON data')
      if (seen.has(value))
        throw new Error('Conversation history cannot contain circular references')
      const array = Array.isArray(value)
      const prototype = Object.getPrototypeOf(value)
      if (
        array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
      )
        throw new Error('Conversation history must contain plain objects and arrays')
      seen.add(value)
      pending.push({ value, finish: true })
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (descriptor.get || descriptor.set)
          throw new Error('Conversation history cannot contain getters or setters')
        if (
          (key === threadSource && ownedThreadSources.has(descriptor.value)) ||
          (key === valueSource && ownedValueSources.has(descriptor.value)) ||
          (key === lifecycleIntent && lifecycleIntents.has(descriptor.value))
        )
          continue
        if (typeof key !== 'string')
          throw new Error('Conversation history contains an unsupported key')
        if (array && key === 'length') continue
        if (!array && descriptor.value === undefined) continue
        pending.push({ value: descriptor.value })
      }
    }
  }
  validate(thread)
  const sourceDescriptor = Object.getOwnPropertyDescriptor(thread, threadSource)
  if (sourceDescriptor && ownedThreadSources.has(sourceDescriptor.value))
    validate(sourceDescriptor.value)
  const projected = projectConversationSource(thread)
  validate(projected)
  return JSON.parse(JSON.stringify(projected)) as Thread
}

/** An admitted native lifecycle event authors these fields even when recovery displayed them already. */
export function reconcileConversationLifecycle(
  thread: Thread,
  fields: readonly LifecycleField[] = lifecycleFields,
): Thread {
  const source = sourceOf(thread)
  const owner = source && lifecycleOwners.get(source)
  if (!source || !owner) return thread
  const previous = lifecycleIntentOf(thread, source)
  return attachLifecycleIntent(
    thread,
    source,
    owner,
    { busy: thread.busy, turnStatus: thread.turnStatus, agentStatus: thread.agentStatus },
    Object.freeze(
      lifecycleFields.filter(
        (field) =>
          fields.includes(field) ||
          (previous?.fields.includes(field) && Object.is(previous.values[field], thread[field])),
      ),
    ),
  )
}

function attachLifecycleIntent(
  thread: Thread,
  source: ThreadSource,
  owner: object,
  values: LifecycleIntent['values'],
  fields: LifecycleIntent['fields'],
): Thread {
  const token = {}
  lifecycleIntents.set(token, {
    source,
    owner,
    turn: thread.turn,
    values,
    fields,
  })
  const reconciled = { ...thread }
  put(reconciled, lifecycleIntent, token)
  return reconciled
}

export function projectConversationSource(thread: Thread): Thread {
  const source = sourceOf(thread)
  const lifecycleOwner = source && lifecycleOwners.get(source)
  const cached = projections.get(thread)
  const hasKnownMutation =
    Boolean(
      source &&
      conversationMessageAppendSourceMutationEpoch(source) !==
        (source.acknowledgedAppendMutationEpoch ?? 0),
    ) ||
    Boolean(
      cached?.captures.some((capture) =>
        conversationMessageAppendHasPendingMutation(capture.normalized),
      ),
    )
  if (
    cached &&
    cached.source === source &&
    cached.lifecycleOwner === lifecycleOwner &&
    cached.raw === source?.raw &&
    cached.acknowledgedAt === source?.acknowledgedAt &&
    cached.globalAppendMutationEpoch === conversationMessageAppendMutationEpoch() &&
    !hasKnownMutation
  )
    return cached.value
  const captures: ValueCapture[] = []
  let projected: Thread
  if (source) {
    const current = stringProperties(thread)
    current.pending = source.baseline.pending
    const changedContainers = new WeakSet<object>()
    if (hasKnownMutation) {
      changedContainers.add(current)
      if (Array.isArray(current.messages)) changedContainers.add(current.messages)
    }
    let merged = mergeValue(
      source.raw,
      source.baseline,
      current,
      captures,
      changedContainers,
    ) as RecordValue
    const intent = lifecycleIntentOf(thread, source)
    if (intent) {
      let authored: RecordValue | undefined
      for (const key of intent.fields) {
        const value = intent.values[key]
        // A later status observation can change agentStatus without revoking completion.
        if (!Object.is(thread[key], value)) continue
        if (value === undefined) {
          if (!Object.hasOwn(merged, key)) continue
          authored ??= stringProperties(merged)
          delete authored[key]
        } else if (!Object.hasOwn(merged, key) || !Object.is(merged[key], value)) {
          authored ??= stringProperties(merged)
          put(authored, key, value)
        }
      }
      merged = authored ?? merged
    }
    projected = merged as unknown as Thread
    for (const capture of captures) {
      observeConversationMessageAppendSource(source, capture.normalized)
    }
  } else {
    // A fork or import with a new owner must not inherit the old hidden slots.
    projected = { ...stringProperties(thread), pending: emptyPending } as unknown as Thread
  }
  projections.set(thread, {
    value: projected,
    source,
    lifecycleOwner,
    raw: source?.raw,
    acknowledgedAt: source?.acknowledgedAt,
    captures,
    appendMutationEpoch: source ? conversationMessageAppendSourceMutationEpoch(source) : undefined,
    globalAppendMutationEpoch: conversationMessageAppendMutationEpoch(),
  })
  projectedViews.set(projected, thread)
  return projected
}

export function projectConversationSourceHistory(threads: Thread[]): Thread[] {
  const projected = threads.map(projectConversationSource)
  const views = [...threads]
  const positions = new Map<object, number[]>()
  for (let index = 0; index < threads.length; index++) {
    const source = sourceOf(threads[index])
    if (source?.group && source.order !== undefined) {
      const group = positions.get(source.group) ?? []
      group.push(index)
      positions.set(source.group, group)
    }
  }
  for (const indexes of positions.values()) {
    const ordered = [...indexes].sort(
      (left, right) => sourceOf(threads[left])!.order! - sourceOf(threads[right])!.order!,
    )
    const values = ordered.map((index) => projected[index])
    const orderedViews = ordered.map((index) => threads[index])
    for (let index = 0; index < indexes.length; index++) {
      projected[indexes[index]] = values[index]
      views[indexes[index]] = orderedViews[index]
    }
  }
  projectedHistoryViews.set(projected, views)
  return projected
}

/** Refresh the exact requested views only after preceding writes have acknowledged their source. */
export function refreshConversationSources(threads: Thread[]): Thread[] {
  const ownedViews = projectedHistoryViews.get(threads)
  if (ownedViews) return projectConversationSourceHistory(ownedViews)
  let changed = false
  const views = threads.map((raw) => projectedViews.get(raw))
  const refreshed = threads.map((raw, index) => {
    const view = views[index]
    const next = view ? projectConversationSource(view) : raw
    changed ||= next !== raw
    return next
  })
  if (views.every((view): view is Thread => view !== undefined))
    projectedHistoryViews.set(refreshed, views)
  return changed ? refreshed : threads
}

/** Clearing intentionally removes hidden records as well as the rendered messages. */
export function clearConversationSourceMessages(thread: Thread): Thread {
  const source = sourceOf(thread)
  const intent = lifecycleIntentOf(thread, source)
  const messages: Message[] = []
  const cleared = { ...thread, messages }
  if (source) {
    const clearedSource = {
      ...source,
      raw: { ...source.raw, messages: [] },
      baseline: { ...source.baseline, messages },
    }
    const owner = {}
    lifecycleOwners.set(clearedSource, owner)
    put(cleared, threadSource, clearedSource)
    if (intent)
      return attachLifecycleIntent(cleared, clearedSource, owner, intent.values, intent.fields)
  }
  return cleared
}

/** Rebase only an exact owned durable acknowledgement, never a queued subscriber's stale view. */
export function acknowledgeConversationSources(threads: Thread[], savedAt: number): void {
  const ownedViews = projectedHistoryViews.get(threads)
  for (let index = 0; index < threads.length; index++) {
    const raw = threads[index]
    const view = ownedViews?.[index] ?? projectedViews.get(raw)
    if (!view) continue
    const source = sourceOf(view)
    if (!source || savedAt <= source.acknowledgedAt) continue
    const projection = projections.get(view)
    if (projection?.value === raw)
      for (const capture of projection.captures) {
        const value = valueSourceOf(capture.normalized)
        if (capture.occurrence || value) put(capture.normalized, valueSource, value ?? {})
        bindConversationMessageAppendSource(capture.normalized, capture.raw)
      }
    source.raw = raw as unknown as RecordValue
    source.baseline = stringProperties(view)
    source.baseline.pending = emptyPending
    source.acknowledgedAt = savedAt
    if (projection?.value === raw)
      source.acknowledgedAppendMutationEpoch = projection.appendMutationEpoch
  }
}

/** Unknown message/queue records still protect their attachment blobs from collection. */
export function conversationSourceAttachmentIds(thread: Thread): string[] {
  const raw = projectConversationSource(thread) as unknown as RecordValue
  const ids = new Set<string>()
  const pending: unknown[] = [raw.messages, raw.queue]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item)
      continue
    }
    const record = objectValue(value)
    if (!record) continue
    if (Array.isArray(record.attachments))
      for (const attachment of record.attachments) {
        const metadata = objectValue(attachment)
        if (metadata && typeof metadata.id === 'string') ids.add(metadata.id)
      }
    for (const key of Object.keys(record))
      if (record[key] && typeof record[key] === 'object') pending.push(record[key])
  }
  return [...ids]
}
