import { parseLifeConfigPatch } from '../shared/customization'
import { parseExtensionManifest } from '../shared/extensions'
import { parseLifeSourcePatch } from '../shared/source-code'
import type { NativeRecoveryOwnerState, Provider } from '../shared/types'
import { normalizeThreadAttachments } from './attachments'
import type { LifeThreadResponse } from './life-thread'
import type { Message, Thread } from './state'
import { applyNativeRecoveryOwner, normalizeNativeRecovery } from './state'
import { parseStudioPlannerRecovery, restoreStudioPlannerRecovery } from './studio-planner-recovery'
import { normalizeSourceChange } from './source-presentation'
import { loadPendingSourceApply, type PendingSourceApply } from './source-session'
import { normalizeFileChanges } from './thread-activity'
import { normalizeMessageMetadata, normalizeThreadMetadata } from './thread-metadata'
import { normalizeQueuedMessages } from './thread-queue'
import { copyConversationSourceJson } from './conversation-source'
import {
  assertStudioJson as assertHistoryJson,
  ownStudioJson,
  projectStudioSession,
  registerStudioValue,
  reconcileStudioSessionLifecycle,
  studioSourceOwner,
  StudioSourceStore,
  type StudioSourceProjection,
} from './studio-source'

/** Studio conversations have their own store and never enter the project thread rail. */
export const STUDIO_HISTORY_KEY = 'life.studio.sessions.v1'
export const maximumStudioRequestCharacters = 1_000_000

export type StudioStage =
  'draft' | 'planning' | 'review' | 'applying' | 'complete' | 'interrupted' | 'failed'

export type StudioProposal = Exclude<
  LifeThreadResponse,
  { kind: 'message' | 'source-read' | 'error' }
>

export interface StudioSession {
  id: string
  thread: Thread
  stage: StudioStage
  /** The user's request is saved verbatim, including leading and trailing whitespace. */
  request?: string
  changes?: string[]
  /** An unapplied proposal can be reviewed after a restart; it is never replayed. */
  proposal?: StudioProposal
  createdAt: number
  updatedAt: number
}
/** Native-owned first-start evidence repairs a cache that predates the accepted user turn. */
export function restoreNativeStudioSession(
  sessions: readonly StudioSession[],
  owner: NativeRecoveryOwnerState,
): StudioSession[] {
  let planner
  try {
    planner = parseStudioPlannerRecovery(owner.clientRecovery)
  } catch {
    return [...sessions]
  }
  const bound = restoreStudioPlannerRecovery(owner, {
    sessionId: owner.sessionId,
    profileId: planner.profileId,
    provider: planner.provider,
  })
  if (!bound) return [...sessions]
  const matching = sessions.filter((session) => session.id === owner.sessionId)
  if (matching.length > 1) return [...sessions]
  let session = matching[0]
  if (
    session &&
    (session.thread.profileId !== planner.profileId || session.thread.provider !== planner.provider)
  )
    return [...sessions]
  if (!session && planner.sessionSeed) {
    const seed = planner.sessionSeed
    session = normalizeStudioSessions([
      { ...seed, thread: { ...seed.thread }, request: planner.request, stage: 'interrupted' },
    ])[0]
  }
  if (!session) return [...sessions]
  const user = planner.userMessage
  const nativeTurn = user?.turn ?? planner.input.localTurn
  const prior = user ? session.thread.messages.find((message) => message.id === user.id) : undefined
  if (prior && (prior.role !== 'user' || prior.text !== user!.text || prior.turn !== user!.turn))
    return [...sessions]
  const repaired: StudioSession = reconcileStudioSessionLifecycle({
    ...session,
    ...(nativeTurn !== undefined && session.thread.turn > nativeTurn
      ? {}
      : { request: planner.request }),
    thread: applyNativeRecoveryOwner(
      {
        ...session.thread,
        turn: Math.max(
          session.thread.turn,
          user?.turn ?? planner.input.localTurn ?? session.thread.turn,
        ),
        ...(owner.remoteId ? { remoteId: owner.remoteId } : {}),
        messages:
          user && !prior ? [...session.thread.messages, { ...user }] : session.thread.messages,
      },
      owner,
    ),
  })
  return matching.length
    ? sessions.map((candidate) => (candidate === session ? repaired : candidate))
    : [...sessions, repaired]
}

const stages = new Set<StudioStage>([
  'draft',
  'planning',
  'review',
  'applying',
  'complete',
  'interrupted',
  'failed',
])

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set) return
  }
  return value as Record<string, unknown>
}

export function studioSessionIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}
const identifier = studioSessionIdentifier

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function choice(value: unknown): string {
  return typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : ''
}

function message(value: unknown, interruptedTurn?: number): Message | undefined {
  const row = record(value)
  if (
    !row ||
    !identifier(row.id) ||
    typeof row.role !== 'string' ||
    !['user', 'assistant', 'tool', 'error'].includes(row.role) ||
    typeof row.text !== 'string'
  )
    return
  const turn = Number.isInteger(row.turn) && Number(row.turn) >= 0 ? Number(row.turn) : 0
  const interrupted = row.status === 'running'
  return registerStudioValue(
    {
      ...normalizeMessageMetadata(row),
      ...(record(row.nativeRecovery) && typeof record(row.nativeRecovery)?.transportId === 'string'
        ? { nativeRecovery: record(row.nativeRecovery) as Message['nativeRecovery'] }
        : {}),
      id: row.id,
      role: row.role as Message['role'],
      text: row.text,
      turn,
      ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof row.input === 'string' ? { input: row.input } : {}),
      ...(typeof row.status === 'string'
        ? { status: interrupted ? 'interrupted' : row.status }
        : {}),
      ...(time(row.createdAt) > 0 ? { createdAt: time(row.createdAt) } : {}),
      ...(time(row.finishedAt) > 0 ? { finishedAt: time(row.finishedAt) } : {}),
      ...(typeof row.finishStatus === 'string'
        ? { finishStatus: row.finishStatus }
        : row.role === 'user' && turn === interruptedTurn
          ? { finishStatus: 'interrupted' }
          : {}),
      ...(row.attachments !== undefined
        ? { attachments: normalizeThreadAttachments(row.attachments) }
        : {}),
      ...(row.fileChanges !== undefined
        ? { fileChanges: normalizeFileChanges(row.fileChanges) }
        : {}),
      ...(row.sourceChange !== undefined
        ? { sourceChange: normalizeSourceChange(row.sourceChange) }
        : {}),
    },
    row,
  )
}

function proposal(value: unknown): StudioProposal | undefined {
  const row = record(value)
  if (!row || typeof row.message !== 'string') return
  try {
    if (row.kind === 'settings')
      return { kind: 'settings', patch: parseLifeConfigPatch(row.patch), message: row.message }
    if (row.kind === 'source')
      return { kind: 'source', patch: parseLifeSourcePatch(row.patch), message: row.message }
    if (row.kind === 'extension')
      return {
        kind: 'extension',
        manifest: parseExtensionManifest(row.manifest),
        message: row.message,
      }
  } catch {
    // An invalid stored proposal must not become an executable or automatic update.
  }
}

export function createStudioSession(
  provider: Provider,
  now = Date.now(),
  id: string = crypto.randomUUID(),
): StudioSession {
  return {
    id,
    stage: 'draft',
    createdAt: now,
    updatedAt: now,
    thread: {
      id,
      purpose: 'customization',
      profileId: '',
      provider,
      title: 'New customization',
      messages: [],
      busy: false,
      model: '',
      mode: 'plan',
      updatedAt: now,
      turn: 0,
      pending: [],
    },
  }
}

/** Restore only Studio-shaped records, never legacy project or research conversations. */
function restoreStudioSessions(value: unknown[], owner: StudioSourceStore): StudioSession[] {
  const result: StudioSession[] = []
  const ids = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || descriptor.get || descriptor.set) continue
    const raw: unknown = descriptor.value
    try {
      assertHistoryJson(raw)
    } catch {
      continue
    }
    const row = record(raw)
    const thread = record(row?.thread)
    if (
      !row ||
      !identifier(row.id) ||
      ids.has(row.id) ||
      !thread ||
      thread.id !== row.id ||
      thread.purpose === 'research' ||
      thread.researchContext !== undefined ||
      typeof thread.profileId !== 'string' ||
      (thread.provider !== 'codex' && thread.provider !== 'claude') ||
      !Array.isArray(thread.messages)
    )
      continue
    const turn = Number.isInteger(thread.turn) && Number(thread.turn) >= 0 ? Number(thread.turn) : 0
    const interrupted =
      thread.busy === true ||
      row.stage === 'planning' ||
      row.stage === 'applying' ||
      (typeof thread.turnStatus === 'string' &&
        ['running', 'reconnecting', 'unknown'].includes(thread.turnStatus))
    const storedProposal = proposal(row.proposal)
    const storedStage = stages.has(row.stage as StudioStage) ? (row.stage as StudioStage) : 'draft'
    const queue = thread.queue === undefined ? undefined : normalizeQueuedMessages(thread.queue)
    if (queue && Array.isArray(thread.queue)) {
      let next = 0
      for (const rawQueued of thread.queue.slice(0, 32)) {
        const admitted = normalizeQueuedMessages([rawQueued])[0]
        if (!admitted || admitted.id !== queue[next]?.id) continue
        const queuedSource = record(rawQueued)
        if (queuedSource) registerStudioValue(queue[next++], queuedSource)
      }
    }
    const restoredThread: Thread = {
      ...normalizeThreadMetadata(thread),
      ...(normalizeNativeRecovery(thread.nativeRecovery)
        ? { nativeRecovery: normalizeNativeRecovery(thread.nativeRecovery) }
        : {}),
      ...(thread.nativeRecovery && interrupted ? { nativeRecoveryStatus: 'unknown' as const } : {}),
      id: row.id,
      purpose: 'customization',
      profileId: thread.profileId,
      provider: thread.provider as Provider,
      title:
        typeof thread.title === 'string' && thread.title.trim()
          ? thread.title
          : 'New customization',
      ...(identifier(thread.remoteId) ? { remoteId: thread.remoteId } : {}),
      ...(typeof thread.workspace === 'string' &&
      thread.workspace.startsWith('/') &&
      !/[\x00-\x1f]/.test(thread.workspace)
        ? { workspace: thread.workspace }
        : {}),
      ...(thread.workspaceUnknown === true ? { workspaceUnknown: true } : {}),
      messages: thread.messages.flatMap((value) => {
        const restored = message(value, interrupted ? turn : undefined)
        return restored ? [restored] : []
      }),
      busy: false,
      pending: [],
      ...(interrupted
        ? { turnStatus: 'interrupted' }
        : typeof thread.turnStatus === 'string' &&
            ['completed', 'interrupted', 'failed'].includes(thread.turnStatus)
          ? { turnStatus: thread.turnStatus as Thread['turnStatus'] }
          : {}),
      ...(typeof thread.agentStatus === 'string' ? { agentStatus: thread.agentStatus } : {}),
      ...(typeof thread.statusText === 'string' ? { statusText: thread.statusText } : {}),
      ...(record(thread.statusDetails) ? { statusDetails: record(thread.statusDetails) } : {}),
      ...(record(thread.agentSettings) ? { agentSettings: record(thread.agentSettings) } : {}),
      ...(queue !== undefined ? { queue } : {}),
      model: choice(thread.model),
      ...(thread.reasoningEffort !== undefined
        ? { reasoningEffort: choice(thread.reasoningEffort) }
        : {}),
      ...(thread.serviceTier !== undefined ? { serviceTier: choice(thread.serviceTier) } : {}),
      mode: permissionModes.some((mode) => mode === thread.mode)
        ? (thread.mode as Thread['mode'])
        : 'plan',
      updatedAt: time(thread.updatedAt),
      turn,
    }
    const restoredSession: StudioSession = {
      id: row.id,
      thread: restoredThread,
      stage: interrupted
        ? 'interrupted'
        : storedStage === 'review' && !storedProposal
          ? 'failed'
          : storedStage,
      ...(typeof row.request === 'string' ? { request: row.request } : {}),
      ...(Array.isArray(row.changes)
        ? { changes: row.changes.filter((change): change is string => typeof change === 'string') }
        : {}),
      ...(storedProposal ? { proposal: storedProposal } : {}),
      createdAt: time(row.createdAt),
      updatedAt: time(row.updatedAt),
    }
    owner.bind(restoredSession, row, index)
    result.push(restoredSession)
    ids.add(row.id)
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

const historyArrays = new WeakMap<readonly StudioSession[], StudioHistoryStore>()
const historyOwners = new WeakMap<StudioSourceStore, StudioHistoryStore>()

declare const preparedStudioHistoryWrite: unique symbol

export interface PreparedStudioHistoryView {
  readonly session: StudioSession
  readonly row: Readonly<Record<string, unknown>>
  /** Hash these exact row bytes before committing the prepared cache snapshot. */
  readonly encodedRow: string
}

export interface PreparedStudioHistoryWrite {
  readonly [preparedStudioHistoryWrite]: true
  readonly encoded: string
  readonly views: readonly PreparedStudioHistoryView[]
}

export interface StudioRecoveryCacheRowProof {
  readonly encodedRow: string
}

const studioRecoveryCacheRows = new WeakMap<
  Thread,
  { proof: StudioRecoveryCacheRowProof; isCurrent: () => boolean }
>()

/** Only an actual unchanged admitted cache view can expose its private row proof. */
export function studioRecoveryCacheRow(thread: Thread): StudioRecoveryCacheRowProof | undefined {
  const entry = studioRecoveryCacheRows.get(thread)
  return entry?.isCurrent() ? entry.proof : undefined
}

interface StudioDescriptorProof {
  object: object
  prototype: object | null
  extensible: boolean
  keys: PropertyKey[]
  descriptors: PropertyDescriptor[]
}

interface StudioRecoveryCacheBaseline {
  session: StudioSession
  thread: Thread
  row: Record<string, unknown>
  proof: StudioRecoveryCacheRowProof
  descriptors: StudioDescriptorProof[]
}

interface PreparedStudioHistoryState {
  owner: StudioHistoryStore
  epoch: number
  sourceRevision: number
  sessions: readonly StudioSession[]
  projected: StudioSourceProjection
  encoded: string
  views: readonly PreparedStudioHistoryView[]
  proof: StudioDescriptorProof[]
  ownership: {
    session: StudioSession
    owner: StudioSourceStore | undefined
    revision: number | undefined
    row: Record<string, unknown> | undefined
  }[]
  consumed: boolean
}

const preparedStudioHistoryWrites = new WeakMap<
  PreparedStudioHistoryWrite,
  PreparedStudioHistoryState
>()

/** Capture only descriptors: validation has already rejected accessors and hostile JSON. */
function captureStudioDescriptors(
  roots: readonly unknown[],
  shallowRoots: readonly object[] = [],
): StudioDescriptorProof[] {
  const proof: StudioDescriptorProof[] = []
  const seen = new WeakSet<object>()
  const pending = [...roots]
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const keys = Reflect.ownKeys(current)
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(current, key)!)
    proof.push({
      object: current,
      prototype: Object.getPrototypeOf(current),
      extensible: Object.isExtensible(current),
      keys,
      descriptors,
    })
    for (let index = 0; index < keys.length; index++) {
      const descriptor = descriptors[index]
      // Private occurrence tokens are checked by identity, never traversed or copied.
      if (typeof keys[index] === 'string' && Object.hasOwn(descriptor, 'value'))
        pending.push(descriptor.value)
    }
  }
  // Binding records are checked directly; their owner services are not JSON proof graphs.
  for (const current of shallowRoots) {
    if (seen.has(current)) continue
    const keys = Reflect.ownKeys(current)
    proof.push({
      object: current,
      prototype: Object.getPrototypeOf(current),
      extensible: Object.isExtensible(current),
      keys,
      descriptors: keys.map((key) => Object.getOwnPropertyDescriptor(current, key)!),
    })
  }
  return proof
}

/** No property reads, serializers or getters run while checking a prepared snapshot. */
function studioDescriptorsMatch(proof: readonly StudioDescriptorProof[]): boolean {
  for (const { object, prototype, extensible, keys, descriptors } of proof) {
    if (Object.getPrototypeOf(object) !== prototype || Object.isExtensible(object) !== extensible)
      return false
    const currentKeys = Reflect.ownKeys(object)
    if (currentKeys.length !== keys.length) return false
    for (let index = 0; index < keys.length; index++) {
      if (currentKeys[index] !== keys[index]) return false
      const current = Object.getOwnPropertyDescriptor(object, keys[index])
      const prior = descriptors[index]
      if (
        !current ||
        current.get !== prior.get ||
        current.set !== prior.set ||
        current.enumerable !== prior.enumerable ||
        current.configurable !== prior.configurable ||
        current.writable !== prior.writable ||
        !Object.is(current.value, prior.value)
      )
        return false
    }
  }
  return true
}

function preparedStudioOwnershipMatches(state: PreparedStudioHistoryState): boolean {
  return state.ownership.every(
    ({ session, owner, revision, row }) =>
      studioSourceOwner(session) === owner &&
      owner?.revision === revision &&
      owner?.ownedRawRow(session) === row,
  )
}

/** Keep original source ownership outside the actionable Studio conversation list. */
export class StudioHistoryStore {
  readonly sessions: StudioSession[]
  readonly canSave: boolean
  readonly storageError?: string
  private readonly source: StudioSourceStore
  private writeEpoch = 0
  private committing = false
  private readonly recoveryRows = new WeakMap<Record<string, unknown>, string>()
  private readonly recoveryCacheBaselines = new WeakMap<
    Record<string, unknown>,
    StudioRecoveryCacheBaseline
  >()

  constructor(rows: unknown[], storageError?: string) {
    assertHistoryJson(rows)
    this.source = new StudioSourceStore(rows)
    this.sessions = restoreStudioSessions(rows, this.source)
    for (const session of this.sessions) {
      const row = this.source.ownedRawRow(session)!
      try {
        this.captureRecoveryCacheBaseline(session, row, JSON.stringify(row))
      } catch {
        // An archival row can exceed the serializer's depth without becoming unreadable.
        // Preserve it for recovery; no canonical cache proof is admitted for that row.
      }
    }
    this.storageError = storageError
    this.canSave = !storageError
    historyArrays.set(this.sessions, this)
    historyOwners.set(this.source, this)
  }

  encode(sessions: readonly StudioSession[]): string {
    if (!this.canSave) throw new Error(this.storageError)
    return JSON.stringify(this.source.project(sessions).rows)
  }

  private captureRecoveryCacheBaseline(
    session: StudioSession,
    row: Record<string, unknown>,
    encodedRow: string,
  ): void {
    this.recoveryRows.set(row, encodedRow)
    this.recoveryCacheBaselines.set(row, {
      session,
      thread: session.thread,
      row,
      proof: Object.freeze({ encodedRow }),
      descriptors: captureStudioDescriptors([session, row]),
    })
  }

  private recoveryCacheBaselineMatches(baseline: StudioRecoveryCacheBaseline): boolean {
    return (
      this.recoveryCacheBaselines.get(baseline.row) === baseline &&
      studioDescriptorsMatch(baseline.descriptors) &&
      this.source.ownedRawRow(baseline.session) === baseline.row &&
      this.recoveryRows.get(baseline.row) === baseline.proof.encodedRow
    )
  }

  /** Prepare exact bytes while preserving private ownership of their source projection. */
  prepare(sessions: readonly StudioSession[]): PreparedStudioHistoryWrite {
    if (!this.canSave) throw new Error(this.storageError)
    const original = this.source.project(sessions)
    // Projection metadata is private to this receipt; exported row references may stay mutable.
    const projected: StudioSourceProjection = {
      rows: original.rows,
      views: original.views.map((view) => ({
        ...view,
        projection: {
          ...view.projection,
          captures: view.projection.captures.map((capture) => ({ ...capture })),
        },
      })),
    }
    this.source.assertAcknowledgeable(projected)
    const encoded = JSON.stringify(projected.rows)
    const views: PreparedStudioHistoryView[] = projected.views.map(({ session, index }) => {
      const row = projected.rows[index] as Record<string, unknown>
      return { session, row, encodedRow: JSON.stringify(row) }
    })
    const prepared = { encoded, views } as unknown as PreparedStudioHistoryWrite
    const captureRoots = projected.views.flatMap(({ projection }) =>
      projection.captures.flatMap((capture) => [capture.normalized, capture.raw]),
    )
    const ownership = sessions.map((session) => {
      const owner = studioSourceOwner(session)
      return { session, owner, revision: owner?.revision, row: owner?.ownedRawRow(session) }
    })
    const sourceBindings = projected.views.flatMap(({ projection }) =>
      projection.source ? [projection.source] : [],
    )
    preparedStudioHistoryWrites.set(prepared, {
      owner: this,
      epoch: this.writeEpoch,
      sourceRevision: this.source.revision,
      sessions,
      projected,
      encoded,
      views,
      proof: captureStudioDescriptors(
        [
          sessions,
          projected.rows,
          prepared,
          ...captureRoots,
          ...ownership.map(({ row }) => row),
          ...sourceBindings.map(({ baseline }) => baseline),
        ],
        sourceBindings,
      ),
      ownership,
      consumed: false,
    })
    return prepared
  }

  /** Commit only the privately prepared bytes, then acknowledge that exact source projection. */
  commitPrepared(
    prepared: PreparedStudioHistoryWrite,
    storage: Pick<Storage, 'setItem'>,
  ): readonly PreparedStudioHistoryView[] {
    const state = preparedStudioHistoryWrites.get(prepared)
    if (!state || state.owner !== this)
      throw new Error('Studio cache write is not owned by this store')
    if (this.committing) throw new Error('A Studio cache write is already committing')
    if (
      state.consumed ||
      state.epoch !== this.writeEpoch ||
      state.sourceRevision !== this.source.revision
    )
      throw new Error('Prepared Studio cache write is stale')
    if (!studioDescriptorsMatch(state.proof))
      throw new Error('Prepared Studio cache write changed before it was committed')
    if (!preparedStudioOwnershipMatches(state))
      throw new Error('Prepared Studio cache write source ownership is stale')
    this.committing = true
    try {
      storage.setItem(STUDIO_HISTORY_KEY, state.encoded)
      // A successful write consumes its receipt even if a storage adapter changes caller data.
      state.consumed = true
      this.writeEpoch++
      if (
        state.sourceRevision !== this.source.revision ||
        !studioDescriptorsMatch(state.proof) ||
        !preparedStudioOwnershipMatches(state)
      )
        throw new Error(
          'Studio cache bytes were stored, but their source changed before acknowledgment',
        )
      this.source.acknowledge(state.projected)
      for (const { session, row, encodedRow } of state.views)
        this.captureRecoveryCacheBaseline(session, row, encodedRow)
      historyArrays.set(state.sessions, this)
      return state.views
    } finally {
      this.committing = false
    }
  }

  /** Rebase only after the exact localStorage write succeeds. */
  write(
    sessions: readonly StudioSession[],
    storage: Pick<Storage, 'setItem'>,
  ): {
    session: StudioSession
    row: Record<string, unknown>
  }[] {
    const views = this.commitPrepared(this.prepare(sessions), storage)
    // These occurrence bindings come from the exact projection committed above,
    // including when an archival row shares the actionable session's ID.
    return views.map(({ session, row }) => ({
      session,
      row,
    }))
  }

  /** Hash the last acknowledged raw occurrence, never a normalized or edited UI projection. */
  recoveryRow(session: StudioSession): string | undefined {
    const row = this.source.ownedRawRow(session)
    if (!row) return
    assertHistoryJson(row)
    const encodedRow = this.recoveryRows.get(row)
    const baseline = this.recoveryCacheBaselines.get(row)
    if (
      encodedRow &&
      baseline &&
      Object.getOwnPropertyDescriptor(session, 'thread')?.value === baseline.thread &&
      this.recoveryCacheBaselineMatches(baseline)
    )
      studioRecoveryCacheRows.set(baseline.thread, {
        proof: baseline.proof,
        isCurrent: () => this.recoveryCacheBaselineMatches(baseline),
      })
    return encodedRow
  }

  projectSession(session: StudioSession): Record<string, unknown> {
    return projectStudioSession(session)
  }

  hasSession(session: StudioSession): boolean {
    return this.source.ownsSession(session)
  }
}

export function normalizeStudioSessions(value: unknown): StudioSession[] {
  if (!Array.isArray(value)) return []
  const rows: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || descriptor.get || descriptor.set) continue
    try {
      assertHistoryJson(descriptor.value)
      rows.push(descriptor.value)
    } catch {
      /* Hostile live objects are not archival JSON. */
    }
  }
  return new StudioHistoryStore(rows).sessions
}

function parseStudioHistory(raw: string | null | undefined): StudioHistoryStore {
  if (raw === null || raw === undefined) return new StudioHistoryStore([])
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows))
      return new StudioHistoryStore(
        [],
        'Stored Studio history has an unrecognized format. The original data is preserved; export this conversation before closing Life.',
      )
    ownStudioJson(rows)
    return new StudioHistoryStore(rows)
  } catch {
    return new StudioHistoryStore(
      [],
      'Stored Studio history could not be read. The original data is preserved; export this conversation before closing Life.',
    )
  }
}

export function parseStudioSessions(raw: string | null | undefined): StudioSession[] {
  return parseStudioHistory(raw).sessions
}

/** Encode real activity while retaining recoverable source JSON for restored sessions. */
export function encodeStudioSessions(sessions: readonly StudioSession[]): string {
  assertHistoryJson(sessions)
  let owner = historyArrays.get(sessions)
  if (!owner) {
    const owners = new Set<StudioHistoryStore>()
    for (const session of sessions) {
      const source = studioSourceOwner(session)
      const history = source ? historyOwners.get(source) : undefined
      if (history) owners.add(history)
    }
    if (owners.size > 1) throw new Error('Combine Studio history through its owning store')
    owner = owners.values().next().value
  }
  return (owner ?? new StudioHistoryStore([])).encode(sessions)
}

export function readStudioHistory(storage?: Pick<Storage, 'getItem'>): StudioHistoryStore {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (!source)
      return new StudioHistoryStore(
        [],
        'Studio history storage is unavailable. Export this conversation before closing Life.',
      )
    return parseStudioHistory(source.getItem(STUDIO_HISTORY_KEY))
  } catch {
    return new StudioHistoryStore(
      [],
      'Studio history storage could not be read. The original data is preserved; export this conversation before closing Life.',
    )
  }
}

export function readStudioSessions(storage?: Pick<Storage, 'getItem'>): StudioSession[] {
  return readStudioHistory(storage).sessions
}

/** Copy an interrupted legacy customization into Studio without changing its project history. */
export function migrateLegacyStudioPending(
  raw: string | null | undefined,
  projectThreads: readonly Thread[],
  id: string = `life-studio:${crypto.randomUUID()}`,
  now = Date.now(),
): { session: StudioSession; pending: PendingSourceApply } | undefined {
  const pending = loadPendingSourceApply(raw)
  if (!pending || !raw || !identifier(id) || projectThreads.some((thread) => thread.id === id))
    return
  const original = projectThreads.find(
    (thread) =>
      thread.id === pending.id &&
      thread.turn === pending.turn &&
      thread.profileId === pending.profileId &&
      thread.provider === pending.start.provider &&
      thread.lifeScope === true &&
      thread.purpose !== 'research' &&
      !thread.researchContext,
  )
  if (!original) return
  let request: string
  let originalSnapshot: Thread
  try {
    const stored = record(JSON.parse(raw))
    if (
      typeof stored?.request !== 'string' ||
      !stored.request.trim() ||
      stored.request.length > 900_000
    )
      return
    originalSnapshot = copyConversationSourceJson(original)
    ownStudioJson(originalSnapshot)
    const originalRequest = originalSnapshot.messages.find((value) => {
      const message = record(value)
      return message?.role === 'user' && message.turn === pending.turn
    })?.text
    request =
      typeof originalRequest === 'string' &&
      originalRequest.trim() &&
      originalRequest.length <= 1_000_000
        ? originalRequest
        : stored.request
  } catch {
    return
  }
  // Saved project histories are immutable inputs to this copy. In particular, the new
  // session gets its own provider event ID while retaining the provider's remote ID.
  const seed = {
    id,
    thread: {
      ...originalSnapshot,
      id,
      purpose: 'customization',
      title: 'Recovered customization',
      busy: false,
      pending: [],
      queue: [],
      updatedAt: now,
    },
    request,
    stage: 'interrupted' as const,
    createdAt: now,
    updatedAt: now,
  }
  ownStudioJson(seed)
  const copied = normalizeStudioSessions([seed])[0]
  if (!copied) return
  return {
    session: copied,
    pending: {
      ...pending,
      id,
      request,
      start: {
        ...pending.start,
        sessionId: id,
        prompt: request,
        ...(original.remoteId ? { remoteId: original.remoteId } : {}),
      },
    },
  }
}
import { permissionModes } from '../shared/permissions'
