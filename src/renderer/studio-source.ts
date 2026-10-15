import type { StudioSession } from './studio-history'

const valueSource = Symbol('Life Studio recovery occurrence')
const requestReset = Symbol('Life Studio request reset')
const requestResetIntents = new WeakSet<object>()
const recoveryLifecycle = Symbol('Life Studio native recovery lifecycle')
const recoveryLifecycleIntents = new WeakSet<object>()
const recoveryLifecycleBindings = new WeakMap<
  object,
  { source: SessionSource; turn: number; busy: boolean; turnStatus?: string; stage: string }
>()
type RecordValue = Record<string, unknown>
type ValueSource = object
interface ValueBinding {
  raw: RecordValue
}
interface SessionSource {
  raw: RecordValue
  baseline: RecordValue
  owner: StudioSourceStore
  index: number
  revision: number
}
interface ArraySource {
  raw: unknown[]
  positions: number[]
  rawLength: number
}
interface ValueCapture {
  normalized: RecordValue
  raw: RecordValue
  occurrence?: boolean
}
interface Projection {
  value: RecordValue
  source?: SessionSource
  revision?: number
  captures: ValueCapture[]
}
export interface StudioSourceProjection {
  rows: unknown[]
  views: { session: StudioSession; index: number; projection: Projection }[]
}
const valueBindings = new WeakMap<ValueSource, ValueBinding>()
const sessionSources = new WeakMap<ValueSource, SessionSource>()
const arraySources = new WeakMap<unknown[], ArraySource>()
const projections = new WeakMap<StudioSession, Projection>()
const archiveObjects = new WeakSet<object>()

/** Only JSON.parse results and successfully validated projections become archival data. */
export function ownStudioJson(value: unknown): void {
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || archiveObjects.has(current)) continue
    archiveObjects.add(current)
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && !descriptor.get && !descriptor.set) pending.push(descriptor.value)
    }
  }
}

/** Validate descriptors before reading or stringifying; private owned tokens are not JSON. */
export function assertStudioJson(value: unknown): void {
  validateStudioJson(value, new WeakMap<object, number>())
}

/** A validation batch shares only completed objects; no trust escapes this synchronous operation. */
function validateStudioJson(value: unknown, validated: WeakMap<object, number>): void {
  const seen = new WeakSet<object>()
  const pending: { value: unknown; depth: number; finish?: boolean }[] = [{ value, depth: 0 }]
  while (pending.length) {
    const entry = pending.pop()!
    const current = entry.value
    if (entry.finish) {
      seen.delete(current as object)
      validated.set(
        current as object,
        Math.max(validated.get(current as object) ?? -1, entry.depth),
      )
      continue
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current)) continue
    if (!current || typeof current !== 'object')
      throw new Error('Studio history must contain JSON data')
    if (entry.depth > 64 && !archiveObjects.has(current))
      throw new Error('Studio history is nested too deeply')
    if (seen.has(current)) throw new Error('Studio history cannot contain circular references')
    const previousDepth = validated.get(current)
    if (previousDepth !== undefined && entry.depth <= previousDepth) continue
    const array = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error('Studio history must contain plain objects and arrays')
    seen.add(current)
    pending.push({ ...entry, finish: true })
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!
      if (descriptor.get || descriptor.set)
        throw new Error('Studio history cannot contain getters or setters')
      if (key === valueSource && valueBindings.has(descriptor.value)) continue
      if (key === requestReset && requestResetIntents.has(descriptor.value)) continue
      if (key === recoveryLifecycle && recoveryLifecycleIntents.has(descriptor.value)) continue
      if (
        typeof key !== 'string' ||
        (!archiveObjects.has(current) &&
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key))
      )
        throw new Error('Studio history contains an unsupported key')
      if (array && key === 'length') continue
      if (!array && descriptor.value === undefined) continue
      pending.push({ value: descriptor.value, depth: entry.depth + 1 })
    }
  }
}

/** Bind exact admitted records before any filtered array can guess by native identifier. */
export function registerStudioValue<T extends object>(normalized: T, raw: RecordValue): T {
  const existing = valueSourceOf(normalized)
  if (existing) return normalized
  const source = {}
  valueBindings.set(source, { raw })
  put(normalized, valueSource, source)
  return normalized
}

/** A real new run owns its request reset, even when the recovered UI was already empty. */
export function resetStudioSessionRequests(session: StudioSession): StudioSession {
  assertStudioJson(session)
  const next = { ...session, thread: { ...session.thread, pending: [] } }
  const intent = {}
  requestResetIntents.add(intent)
  put(next, requestReset, intent)
  return next
}

function resetsStudioRequests(session: StudioSession): boolean {
  const intent = (session as unknown as { [requestReset]?: object })[requestReset]
  return Boolean(intent && requestResetIntents.has(intent))
}
/** Native reconciliation owns lifecycle changes without granting an archival request reset. */
export function reconcileStudioSessionLifecycle(session: StudioSession): StudioSession {
  assertStudioJson(session)
  const source = sessionSourceOf(session)
  if (!source) return session
  if (!source.owner.ownsSession(session))
    throw new Error('Native recovery requires an admitted Studio session occurrence')
  const next = { ...session }
  const intent = {}
  recoveryLifecycleIntents.add(intent)
  recoveryLifecycleBindings.set(intent, {
    source,
    turn: session.thread.turn,
    busy: session.thread.busy,
    turnStatus: session.thread.turnStatus,
    stage: session.stage,
  })
  put(next, recoveryLifecycle, intent)
  return next
}
function reconcilesStudioLifecycle(session: StudioSession): boolean {
  const intent = (session as unknown as { [recoveryLifecycle]?: object })[recoveryLifecycle]
  const binding = intent ? recoveryLifecycleBindings.get(intent) : undefined
  return Boolean(
    binding &&
    binding.source === sessionSourceOf(session) &&
    binding.turn === session.thread.turn &&
    binding.busy === session.thread.busy &&
    binding.turnStatus === session.thread.turnStatus &&
    binding.stage === session.stage,
  )
}
function archiveCopy(value: RecordValue): RecordValue {
  const copy = stringProperties(value)
  if (archiveObjects.has(value)) archiveObjects.add(copy)
  return copy
}
function stringProperties(value: object): RecordValue {
  return Object.fromEntries(Object.entries(value))
}
function put(target: object, key: PropertyKey, value: unknown): void {
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
function valueSourceOf(value: unknown): ValueSource | undefined {
  const source = objectValue(value)
    ? (value as { [valueSource]?: ValueSource })[valueSource]
    : undefined
  return source && valueBindings.has(source) ? source : undefined
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

/** Pair normalized array occurrences with source slots without assigning native identifiers. */
function arrayPositions(baseline: unknown[], raw: unknown[], key?: string): number[] {
  const identities = new Map<string, number[]>()
  const references = new Map<unknown, number[]>()
  for (let position = 0; position < raw.length; position++) {
    const value = raw[position]
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
      if (!used.has(position) && matchingPresentationFields(value, raw[position])) return position
    }
    return undefined
  }
  return baseline.map((value, index) => {
    const source = valueSourceOf(value)
    const sourceRaw = source ? valueBindings.get(source)?.raw : undefined
    let position = sourceRaw === undefined ? undefined : take(references.get(sourceRaw), value)
    if (position === undefined && !source) position = take(references.get(value), value)
    const identity = arrayIdentity(value)
    if (position === undefined && !source && identity)
      position = take(identities.get(identity), value)
    // File/source presentation can shorten a path or dependency name. These
    // bounded metadata arrays retain the first matching original occurrence.
    if (position === undefined && !source && identity && !identity.startsWith('id:'))
      position = raw.findIndex((candidate, candidateIndex) => {
        const original = arrayIdentity(candidate)
        return (
          !used.has(candidateIndex) &&
          original?.startsWith(identity) &&
          matchingPresentationFields(value, candidate)
        )
      })
    if (position === undefined && !source && !identity && index < raw.length && !used.has(index))
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
    registerStudioValue(normalizedRecord, rawRecord)
    for (const property of Object.keys(rawRecord)) {
      if (!Object.hasOwn(normalizedRecord, property)) continue
      const value = normalizedRecord[property]
      if (value && typeof value === 'object')
        pending.push({ normalized: value, raw: rawRecord[property], key: property })
    }
  }
}

function assertCanRegisterStudioValue(value: object): void {
  if (!valueSourceOf(value) && !Object.isExtensible(value))
    throw new Error('A new Studio occurrence must allow its private source binding')
}

/** Mirror the first-bind walk without installing any tokens or array ownership. */
function assertCanBindValues(normalized: unknown, raw: unknown): void {
  const pending: { normalized: unknown; raw: unknown; key?: string }[] = [{ normalized, raw }]
  while (pending.length) {
    const pair = pending.pop()!
    if (Object.is(pair.normalized, pair.raw)) continue
    if (Array.isArray(pair.normalized) && Array.isArray(pair.raw)) {
      const positions = arrayPositions(pair.normalized, pair.raw, pair.key)
      for (let index = 0; index < positions.length; index++)
        if (positions[index] >= 0)
          pending.push({ normalized: pair.normalized[index], raw: pair.raw[positions[index]] })
      continue
    }
    const normalizedRecord = objectValue(pair.normalized)
    const rawRecord = objectValue(pair.raw)
    if (!normalizedRecord || !rawRecord) continue
    assertCanRegisterStudioValue(normalizedRecord)
    for (const key of Object.keys(rawRecord)) {
      if (!Object.hasOwn(normalizedRecord, key)) continue
      const value = normalizedRecord[key]
      if (value && typeof value === 'object')
        pending.push({ normalized: value, raw: rawRecord[key], key })
    }
  }
}

/** Cache every visited pair so deeply edited immutable trees remain linear. */
function presentationEquality() {
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
              const beforeKeys = Object.keys(previous)
              const afterKeys = Object.keys(next)
              comparable = beforeKeys.length === afterKeys.length
              if (comparable)
                for (const key of beforeKeys) {
                  if (!Object.hasOwn(next, key)) {
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
  resetRequests = false,
  recoveredLifecycle = false,
): unknown {
  type Task = () => void
  const tasks: Task[] = []
  let result: unknown
  const samePresentation = presentationEquality()
  const presentationThread = objectValue(baseline)?.thread
  const presentationPending = objectValue(presentationThread)?.pending
  const requestedThread = objectValue(objectValue(current)?.thread)
  const newTurn =
    resetRequests && !Object.is(objectValue(presentationThread)?.turn, requestedThread?.turn)
  const schedule = (
    original: unknown,
    before: unknown,
    after: unknown,
    assign: (value: unknown) => void,
  ): void => {
    tasks.push(() => {
      if (resetRequests && before === presentationPending && Array.isArray(after)) {
        assign(after)
        return
      }
      if (recoveredLifecycle && before === presentationPending) {
        assign(original)
        return
      }
      if (
        !(
          (resetRequests || recoveredLifecycle) &&
          (before === baseline || before === presentationThread)
        ) &&
        samePresentation(before, after)
      ) {
        assign(original)
        return
      }
      if (Array.isArray(before) && Array.isArray(after) && Array.isArray(original)) {
        // Live requests replace archived requests once the user starts or resolves work.
        // Recovery alone leaves the original pending data available for export.
        if (before === presentationPending) {
          assign(after)
          return
        }
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
      let output: RecordValue | undefined
      const set = (key: string, value: unknown) => {
        if (value === undefined) {
          if (!Object.hasOwn(originalRecord, key)) return
          output ??= archiveCopy(originalRecord)
          delete output[key]
        } else if (!Object.hasOwn(originalRecord, key) || !Object.is(originalRecord[key], value)) {
          output ??= archiveCopy(originalRecord)
          put(output, key, value)
        }
      }
      tasks.push(() => {
        const merged = output ?? originalRecord
        if (output && valueSourceOf(afterRecord))
          captures.push({ normalized: afterRecord, raw: merged })
        assign(merged)
      })
      const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])
      for (const key of keys) {
        const beforeOwn = Object.hasOwn(beforeRecord, key)
        const afterOwn = Object.hasOwn(afterRecord, key)
        const beforeValue = beforeOwn ? beforeRecord[key] : undefined
        const afterValue = afterOwn ? afterRecord[key] : undefined
        if (
          (newTurn || recoveredLifecycle) &&
          before === baseline &&
          key === 'stage' &&
          typeof afterValue === 'string'
        ) {
          set(key, afterValue)
          continue
        }
        if (
          (newTurn || recoveredLifecycle) &&
          before === presentationThread &&
          afterOwn &&
          ((key === 'busy' && typeof afterValue === 'boolean') ||
            (key === 'turnStatus' && typeof afterValue === 'string'))
        ) {
          set(key, afterValue)
          continue
        }
        if (beforeOwn === afterOwn && Object.is(beforeValue, afterValue)) continue
        // Explicit undefined removes archived data even if its safe presentation omitted it.
        if (!afterOwn || afterValue === undefined) set(key, undefined)
        else schedule(originalRecord[key], beforeValue, afterValue, (value) => set(key, value))
      }
    })
  }
  schedule(raw, baseline, current, (value) => {
    result = value
  })
  while (tasks.length) tasks.pop()!()
  return result
}

function sessionSourceOf(session: StudioSession): SessionSource | undefined {
  const token = valueSourceOf(session)
  const source = token ? sessionSources.get(token) : undefined
  return source && source.baseline.id === session.id ? source : undefined
}

export function studioSourceOwner(session: StudioSession): StudioSourceStore | undefined {
  return sessionSourceOf(session)?.owner
}

export function projectStudioSession(session: StudioSession): RecordValue {
  const validated = new WeakMap<object, number>()
  validateStudioJson(session, validated)
  const source = sessionSourceOf(session)
  if (source) {
    validateStudioJson(source.raw, validated)
    validateStudioJson(source.baseline, validated)
  }
  const value = computeStudioSession(session, source)
  // Exported projections are mutable references, so even cached output is checked afresh.
  assertStudioJson(value)
  return value
}

function computeStudioSession(session: StudioSession, source?: SessionSource): RecordValue {
  const cached = projections.get(session)
  if (cached && cached.source === source && cached.revision === source?.revision)
    return cached.value
  const captures: ValueCapture[] = []
  const current = stringProperties(session)
  const value = source
    ? (mergeValue(
        source.raw,
        source.baseline,
        current,
        captures,
        resetsStudioRequests(session),
        reconcilesStudioLifecycle(session),
      ) as RecordValue)
    : current
  projections.set(session, { value, source, revision: source?.revision, captures })
  return value
}

/** Store ownership stays alive independently of the currently actionable sessions. */
export class StudioSourceStore {
  private rows: unknown[]
  private admitted = new Map<ValueSource, number>()
  private writeRevision = 0
  constructor(rows: unknown[]) {
    this.rows = rows
  }

  /** Changes to source ownership invalidate receipts prepared against an earlier store. */
  get revision(): number {
    return this.writeRevision
  }

  bind(session: StudioSession, raw: RecordValue, index: number): void {
    this.writeRevision++
    registerStudioValue(session, raw)
    bindValues(session, raw)
    const token = valueSourceOf(session)!
    sessionSources.set(token, {
      raw,
      baseline: stringProperties(session),
      owner: this,
      index,
      revision: 0,
    })
    this.admitted.set(token, index)
    projections.delete(session)
  }

  ownsSession(session: StudioSession): boolean {
    const token = valueSourceOf(session)
    const source = sessionSourceOf(session)
    return Boolean(source?.owner === this && this.admitted.get(token!) === source.index)
  }

  /** Native cache hashes refer to the exact admitted raw occurrence, without UI overlays. */
  ownedRawRow(session: StudioSession): RecordValue | undefined {
    // Raw-row ownership checks never need to evaluate presentation properties or accessors.
    const token = Object.getOwnPropertyDescriptor(session, valueSource)?.value as
      ValueSource | undefined
    const source = token && valueBindings.has(token) ? sessionSources.get(token) : undefined
    if (!source) return
    const id = Object.getOwnPropertyDescriptor(session, 'id')?.value
    const owner = Object.getOwnPropertyDescriptor(source, 'owner')?.value
    const baseline = Object.getOwnPropertyDescriptor(source, 'baseline')?.value as
      RecordValue | undefined
    const index = Object.getOwnPropertyDescriptor(source, 'index')?.value as number | undefined
    const raw = Object.getOwnPropertyDescriptor(source, 'raw')?.value as RecordValue | undefined
    if (
      owner === this &&
      typeof id === 'string' &&
      baseline &&
      Object.getOwnPropertyDescriptor(baseline, 'id')?.value === id &&
      raw &&
      Object.getOwnPropertyDescriptor(raw, 'id')?.value === id &&
      index !== undefined &&
      this.admitted.get(token!) === index &&
      this.rows[index] === raw
    )
      return raw
  }

  project(sessions: readonly StudioSession[]): StudioSourceProjection {
    const validated = new WeakMap<object, number>()
    validateStudioJson(sessions, validated)
    validateStudioJson(this.rows, validated)
    const retained = new Map<number, { session: StudioSession; projection: Projection }>()
    const added: { session: StudioSession; projection: Projection }[] = []
    const tokens = new Set<ValueSource>()
    for (const session of sessions) {
      const source = sessionSourceOf(session)
      const token = valueSourceOf(session)
      const covered =
        source?.owner === this &&
        this.admitted.get(token!) === source.index &&
        this.rows[source.index] === source.raw
      if (source) {
        validateStudioJson(source.baseline, validated)
        if (!covered) validateStudioJson(source.raw, validated)
      }
      const value = computeStudioSession(session, source)
      const projection = projections.get(session)!
      if (token && tokens.has(token))
        throw new Error('A Studio session occurrence cannot appear twice')
      if (token) tokens.add(token)
      if (covered) retained.set(source.index, { session, projection })
      else added.push({ session, projection: { ...projection, value } })
    }
    const admittedIndexes = new Set(this.admitted.values())
    const rows: unknown[] = []
    const views: StudioSourceProjection['views'] = []
    for (let index = 0; index < this.rows.length; index++) {
      const current = retained.get(index)
      if (current) {
        views.push({ ...current, index: rows.length })
        rows.push(current.projection.value)
      } else if (!admittedIndexes.has(index)) rows.push(this.rows[index])
    }
    for (const current of added) {
      views.push({ ...current, index: rows.length })
      rows.push(current.projection.value)
    }
    assertStudioJson(rows)
    return { rows, views }
  }

  /** Reject an impossible token installation before writing bytes or changing admission state. */
  assertAcknowledgeable(projected: StudioSourceProjection): void {
    for (const { session, index, projection } of projected.views) {
      assertCanRegisterStudioValue(session)
      for (const capture of projection.captures) assertCanRegisterStudioValue(capture.normalized)
      if (!projection.source) assertCanBindValues(session, projected.rows[index])
    }
  }

  /** Call only after the exact synchronous storage write succeeds. */
  acknowledge(projected: StudioSourceProjection): void {
    this.assertAcknowledgeable(projected)
    this.writeRevision++
    ownStudioJson(projected.rows)
    this.rows = projected.rows
    this.admitted = new Map()
    for (const { session, index, projection } of projected.views) {
      for (const capture of projection.captures) {
        registerStudioValue(capture.normalized, capture.raw)
        const token = valueSourceOf(capture.normalized)!
        valueBindings.set(token, { raw: capture.raw })
      }
      const raw = projected.rows[index] as RecordValue
      registerStudioValue(session, raw)
      const token = valueSourceOf(session)!
      valueBindings.set(token, { raw })
      // Existing source-backed views already carry exact occurrence bindings.
      // Merge captures update changed/new records; settled message arrays remain untouched.
      if (!projection.source) bindValues(session, raw)
      const prior = sessionSources.get(token)
      sessionSources.set(token, {
        raw,
        baseline: stringProperties(session),
        owner: this,
        index,
        revision: (prior?.revision ?? -1) + 1,
      })
      this.admitted.set(token, index)
      projections.delete(session)
    }
  }
}
