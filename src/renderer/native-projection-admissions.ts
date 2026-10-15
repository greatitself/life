import type { ConversationProjectionAdmission } from '../shared/conversations'
import type { AgentEvent } from '../shared/types'
import type { Thread } from './state'
import { getNativeConversationRowLoad } from './conversation-load-provenance'
import {
  conversationSourceHasPersistedField,
  getConversationSourceRaw,
  hasConversationSource,
} from './conversation-source'
import {
  getCachedConversationHistoryRecovery,
  getCachedConversationRowRecovery,
  type CachedHistory,
} from './main-cache-recovery'
import { studioRecoveryCacheRow, type StudioRecoveryCacheRowProof } from './studio-history'

interface OwnerIdentity {
  sessionId: string
  provider: 'codex' | 'claude'
  profileId: string
  workspace: string
  isolatedStudioScope: boolean
  remoteId: string
}
interface ProjectionProof {
  owner: OwnerIdentity
  admission: ConversationProjectionAdmission
  messages: unknown[]
  cursor: object
  cacheHash?: string
}
interface ProjectedProof {
  proof: ProjectionProof
  messages: unknown[]
}
interface AuthoredUserRow {
  owner: OwnerIdentity
  fields: Map<string, unknown>
  generations: Map<string, number>
  control?: { transportId: unknown; ownerGeneration: unknown }
}
interface CapturedRecord {
  value: Record<string, unknown>
  fields: Map<string, unknown>
}
interface MembershipMember {
  value: Thread
  id: string
  records: CapturedRecord[]
  messages: unknown[]
  entries: unknown[]
}
interface MembershipProof {
  admissions: ConversationProjectionAdmission[]
  members: MembershipMember[]
}

// Only accepted native deliveries and native-validated baselines can register
// cursor objects. JSON, exports, and hidden archival source fields carry no
// capability. The capability itself never becomes a thread or cursor property.
const cursorProofs = new WeakMap<object, ProjectionProof>()
const projectedProofs = new WeakMap<object, ProjectedProof[]>()
const authoredUserRows = new WeakMap<object, AuthoredUserRow>()
const membershipProofs = new WeakMap<readonly Thread[], MembershipProof>()

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value)
}
function ownerOf(thread: unknown): OwnerIdentity | undefined {
  if (!record(thread)) return
  const sessionId = own(thread, 'id')
  const provider = own(thread, 'provider')
  const profileId = own(thread, 'profileId')
  for (const key of ['workspace', 'purpose', 'workspaceUnknown']) {
    const field = Object.getOwnPropertyDescriptor(thread, key)
    if (field?.get || field?.set) return
  }
  const workspace = own(thread, 'workspace')
  const workspaceUnknown = own(thread, 'workspaceUnknown')
  if (workspaceUnknown !== undefined && workspaceUnknown !== false) return
  const isolatedStudioScope =
    own(thread, 'purpose') === 'customization' && (workspace === undefined || workspace === '')
  const remoteId = own(thread, 'remoteId')
  if (
    !nonempty(sessionId) ||
    (provider !== 'codex' && provider !== 'claude') ||
    !nonempty(profileId) ||
    (!isolatedStudioScope && !nonempty(workspace)) ||
    !nonempty(remoteId)
  )
    return
  return {
    sessionId,
    provider,
    profileId,
    workspace: isolatedStudioScope ? '' : (workspace as string),
    isolatedStudioScope,
    remoteId,
  }
}
function sameOwner(thread: unknown, expected: OwnerIdentity): boolean {
  const owner = ownerOf(thread)
  return Boolean(
    owner &&
    owner.sessionId === expected.sessionId &&
    owner.provider === expected.provider &&
    owner.profileId === expected.profileId &&
    owner.workspace === expected.workspace &&
    owner.isolatedStudioScope === expected.isolatedStudioScope &&
    owner.remoteId === expected.remoteId,
  )
}
function cursorOf(thread: unknown, transportId: string): Record<string, unknown> | undefined {
  if (!record(thread)) return
  const cursors = own(thread, 'nativeRecovery')
  if (!record(cursors)) return
  const cursor = own(cursors, transportId)
  return record(cursor) ? cursor : undefined
}
function matchesCursor(cursor: unknown, admission: ConversationProjectionAdmission): boolean {
  return Boolean(
    record(cursor) &&
    own(cursor, 'appliedRevision') === admission.appliedRevision &&
    own(cursor, 'snapshotToken') === admission.snapshotToken &&
    own(cursor, 'ownerGeneration') === admission.ownerGeneration,
  )
}
function validAdmission(value: unknown): value is ConversationProjectionAdmission {
  return Boolean(
    record(value) &&
    nonempty(own(value, 'sessionId')) &&
    nonempty(own(value, 'transportId')) &&
    positive(own(value, 'appliedRevision')) &&
    nonempty(own(value, 'snapshotToken')) &&
    nonnegative(own(value, 'ownerGeneration')) &&
    nonempty(own(value, 'deliveryToken')),
  )
}
function copyAdmission(value: ConversationProjectionAdmission): ConversationProjectionAdmission {
  return {
    sessionId: value.sessionId,
    transportId: value.transportId,
    appliedRevision: value.appliedRevision,
    snapshotToken: value.snapshotToken,
    ownerGeneration: value.ownerGeneration,
    deliveryToken: value.deliveryToken,
  }
}
function register(
  thread: Thread,
  admission: ConversationProjectionAdmission,
  cacheHash?: string,
): Thread {
  const owner = ownerOf(thread)
  const messages = own(thread, 'messages')
  const cursor = cursorOf(thread, admission.transportId)
  if (
    !owner ||
    owner.sessionId !== admission.sessionId ||
    !Array.isArray(messages) ||
    !cursor ||
    !matchesCursor(cursor, admission)
  )
    return thread
  const previous = cursorProofs.get(cursor)
  if (
    previous &&
    (!sameOwner(thread, previous.owner) ||
      previous.messages !== messages ||
      !matchesCursor(cursor, previous.admission))
  )
    return thread
  cursorProofs.set(cursor, {
    owner,
    admission: copyAdmission(admission),
    messages,
    cursor,
    ...(cacheHash ? { cacheHash } : {}),
  })
  return thread
}

/** Call only after an actual admitted native event has been applied to this view. */
export function registerNativeProjectionDelivery(thread: Thread, event: AgentEvent): Thread {
  const recovery = event.nativeRecovery
  if (!recovery) return thread
  const admission = {
    sessionId: event.sessionId,
    transportId: recovery.transportId,
    appliedRevision: recovery.revision,
    snapshotToken: recovery.snapshotToken,
    ownerGeneration: recovery.ownerGeneration,
    deliveryToken: recovery.deliveryToken,
  }
  return validAdmission(admission) ? register(thread, admission) : thread
}

/** Native hash attestation grants authority only to rows from the actual native load wrapper. */
export function registerNativeProjectionLoadedBaseline(
  thread: Thread,
  admission: ConversationProjectionAdmission | undefined,
): Thread {
  return validAdmission(admission) && getNativeConversationRowLoad(thread)
    ? register(thread, admission)
    : thread
}

/** Recovery-cache attestation is limited to actual cache rows whose owned byte hash completed. */
export function registerNativeProjectionMainCacheBaseline(
  thread: Thread,
  admission: ConversationProjectionAdmission | undefined,
): Thread {
  const origin = getCachedConversationRowRecovery(thread)
  return validAdmission(admission) && origin ? register(thread, admission, origin.hash) : thread
}

/** Cache attestation belongs to the exact owned Studio row and its native-accepted byte hash. */
export async function registerNativeProjectionCacheBaseline(
  thread: Thread,
  admission: ConversationProjectionAdmission | undefined,
  proof: StudioRecoveryCacheRowProof | undefined,
  acceptedCacheHash: string | undefined,
): Promise<Thread> {
  if (
    !validAdmission(admission) ||
    !proof ||
    studioRecoveryCacheRow(thread) !== proof ||
    typeof acceptedCacheHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(acceptedCacheHash)
  )
    return thread
  let digest: ArrayBuffer
  try {
    digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof.encodedRow))
  } catch {
    return thread
  }
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return hash === acceptedCacheHash && studioRecoveryCacheRow(thread) === proof
    ? register(thread, admission)
    : thread
}

/** Owner reconciliation can renew existing authority; an owner reply cannot admit imported history. */
export function registerNativeProjectionBaseline(
  thread: Thread,
  admission: ConversationProjectionAdmission | undefined,
): Thread {
  if (!validAdmission(admission)) return thread
  const proof = proofsFor(thread).find(
    ({ proof }) => proof.admission.transportId === admission.transportId,
  )
  return proof && cursorOf(thread, admission.transportId) === proof.proof.cursor
    ? register(thread, admission, proof.proof.cacheHash)
    : thread
}

/** Permit reconciliation to retain an actual delivered or hash-attested cursor object. */
export function hasNativeProjectionCursor(thread: Thread, transportId: string): boolean {
  return proofsFor(thread).some(
    ({ proof }) =>
      proof.admission.transportId === transportId && cursorOf(thread, transportId) === proof.cursor,
  )
}

/** The cache hash stays private to the actual admitted lineage and clears on a new native delivery. */
export function nativeProjectionRecoveryCacheHash(thread: Thread): string | undefined {
  const proofs = proofsFor(thread)
  if (!proofs.length || proofs.some(({ proof }) => !proof.cacheHash)) return
  const hashes = new Set(proofs.map(({ proof }) => proof.cacheHash!))
  return hashes.size === 1 ? hashes.values().next().value : undefined
}

const coveredMessageLifecycleFields = new Set([
  'status',
  'title',
  'details',
  'finishedAt',
  'finishStatus',
  'activityStateUnknown',
])
function sameMessageNativeIdentity(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true
  if (!record(before) || !record(after)) return false
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = Object.getOwnPropertyDescriptor(before, key)
    const right = Object.getOwnPropertyDescriptor(after, key)
    if (left?.get || left?.set || right?.get || right?.set) return false
    if (!Object.is(left?.value, right?.value)) return false
  }
  return true
}
function preservesCoveredMessage(
  before: unknown,
  after: unknown,
  attachmentsMayChange = false,
): boolean {
  if (Object.is(before, after)) return true
  if (!record(before) || !record(after)) return false
  if (!sameMessageNativeIdentity(own(before, 'nativeRecovery'), own(after, 'nativeRecovery')))
    return false
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = Object.getOwnPropertyDescriptor(before, key)
    const right = Object.getOwnPropertyDescriptor(after, key)
    if (left?.get || left?.set || right?.get || right?.set) return false
    if (
      key === 'nativeRecovery' ||
      coveredMessageLifecycleFields.has(key) ||
      (attachmentsMayChange && key === 'attachments')
    )
      continue
    if (!Object.is(left?.value, right?.value)) return false
  }
  return true
}

function carryCoveredNativeProjection(before: Thread, after: Thread): Thread {
  const proofs = proofsFor(before)
  if (!proofs.length) return after
  const previousMessages = own(before, 'messages')
  const messages = own(after, 'messages')
  if (
    !Array.isArray(previousMessages) ||
    !Array.isArray(messages) ||
    messages.length < previousMessages.length
  )
    return after
  if (previousMessages !== messages)
    for (let index = 0; index < previousMessages.length; index++)
      if (!preservesCoveredMessage(previousMessages[index], messages[index])) return after
  let carried = false
  for (const { proof } of proofs) {
    const cursor = cursorOf(after, proof.admission.transportId)
    if (
      cursor !== proof.cursor ||
      !sameOwner(after, proof.owner) ||
      !matchesCursor(cursor, proof.admission)
    )
      continue
    cursorProofs.set(cursor, { ...proof, messages })
    carried = true
  }
  if (carried) carryAuthoredUserRows(previousMessages, messages, after)
  return after
}

function matchesAuthoredRow(row: unknown, mark: AuthoredUserRow): boolean {
  if (!record(row) || own(row, 'nativeRecovery') !== undefined) return false
  for (const key of new Set([...mark.fields.keys(), ...Object.keys(row)])) {
    if (key === 'attachments' || coveredMessageLifecycleFields.has(key)) continue
    const current = Object.getOwnPropertyDescriptor(row, key)
    if (current?.get || current?.set || !Object.is(current?.value, mark.fields.get(key)))
      return false
  }
  return true
}
function sameAuthoredControl(thread: Thread, mark: AuthoredUserRow): boolean {
  const control = own(thread, 'nativeRecoveryOwner')
  if (mark.control) {
    if (!record(control)) return false
    for (const key of ['transportId', 'ownerGeneration'] as const) {
      const current = Object.getOwnPropertyDescriptor(control, key)
      if (current?.get || current?.set || !Object.is(current?.value, mark.control[key]))
        return false
    }
  } else if (control !== undefined) return false
  return true
}
function markHasCurrentProof(thread: Thread, mark: AuthoredUserRow): boolean {
  return (
    sameAuthoredControl(thread, mark) &&
    sameOwner(thread, mark.owner) &&
    proofsFor(thread).some(
      ({ proof }) =>
        mark.generations.get(proof.admission.transportId) === proof.admission.ownerGeneration,
    )
  )
}
function carryAuthoredUserRows(previous: unknown[], next: unknown[], thread: Thread): void {
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]
    const after = next[index]
    const mark = record(before) ? authoredUserRows.get(before) : undefined
    if (
      mark &&
      record(after) &&
      matchesAuthoredRow(before, mark) &&
      matchesAuthoredRow(after, mark) &&
      markHasCurrentProof(thread, mark)
    )
      authoredUserRows.set(after, mark)
  }
}

/** Carry only through genuine native owner snapshots that retain every covered transcript row. */
export function carryNativeProjectionOwnerSnapshot(before: Thread, after: Thread): Thread {
  return carryCoveredNativeProjection(before, after)
}

/** Call only for explicit authored UI transitions that preserve the actual covered native output. */
export function carryNativeProjectionAuthoredTransition(
  before: Thread,
  after: Thread,
  authoredUserMessageId?: string,
): Thread {
  const previous = own(before, 'messages')
  const previousProofs = proofsFor(before)
  carryCoveredNativeProjection(before, after)
  const messages = own(after, 'messages')
  const owner = ownerOf(after)
  const proofs = proofsFor(after)
  if (
    !nonempty(authoredUserMessageId) ||
    !previousProofs.length ||
    !Array.isArray(previous) ||
    !Array.isArray(messages) ||
    messages.length !== previous.length + 1 ||
    !owner ||
    !proofs.some(({ proof }) =>
      previousProofs.some(({ proof: prior }) => prior.cursor === proof.cursor),
    )
  )
    return after
  const row = messages.at(-1)
  if (
    !record(row) ||
    own(row, 'id') !== authoredUserMessageId ||
    own(row, 'role') !== 'user' ||
    own(row, 'turn') !== own(after, 'turn') ||
    !nonnegative(own(row, 'turn')) ||
    own(row, 'nativeRecovery') !== undefined ||
    messages.filter((value) => record(value) && own(value, 'id') === authoredUserMessageId)
      .length !== 1
  )
    return after
  const fields = new Map<string, unknown>()
  for (const key of Object.keys(row)) {
    const field = Object.getOwnPropertyDescriptor(row, key)
    if (field?.get || field?.set) return after
    if (key !== 'attachments' && !coveredMessageLifecycleFields.has(key))
      fields.set(key, field?.value)
  }
  const control = own(after, 'nativeRecoveryOwner')
  authoredUserRows.set(row, {
    owner,
    fields,
    generations: new Map(
      proofs.map(({ proof }) => [proof.admission.transportId, proof.admission.ownerGeneration]),
    ),
    ...(record(control)
      ? {
          control: {
            transportId: own(control, 'transportId'),
            ownerGeneration: own(control, 'ownerGeneration'),
          },
        }
      : {}),
  })
  return after
}

/** Only an explicitly authored current user row may adopt actual upload attachment metadata. */
export function carryNativeProjectionAttachmentUpdate(
  before: Thread,
  after: Thread,
  userMessageId: string,
): Thread {
  const proofs = proofsFor(before)
  const previous = own(before, 'messages')
  const messages = own(after, 'messages')
  if (
    !proofs.length ||
    !nonempty(userMessageId) ||
    !Array.isArray(previous) ||
    !Array.isArray(messages) ||
    messages.length !== previous.length ||
    own(before, 'turn') !== own(after, 'turn')
  )
    return after
  const indexes = previous.flatMap((row, index) =>
    record(row) && own(row, 'id') === userMessageId ? [index] : [],
  )
  if (
    indexes.length !== 1 ||
    messages.filter((row) => record(row) && own(row, 'id') === userMessageId).length !== 1
  )
    return after
  const index = indexes[0]
  const target = previous[index]
  const next = messages[index]
  const mark = record(target) ? authoredUserRows.get(target) : undefined
  if (
    !mark ||
    !record(next) ||
    !matchesAuthoredRow(target, mark) ||
    !matchesAuthoredRow(next, mark) ||
    own(target, 'role') !== 'user' ||
    own(target, 'turn') !== own(before, 'turn') ||
    !markHasCurrentProof(before, mark) ||
    !sameAuthoredControl(after, mark) ||
    !sameOwner(after, mark.owner)
  )
    return after
  for (let position = 0; position < previous.length; position++)
    if (!preservesCoveredMessage(previous[position], messages[position], position === index))
      return after
  let carried = false
  for (const { proof } of proofs) {
    const cursor = cursorOf(after, proof.admission.transportId)
    if (
      cursor !== proof.cursor ||
      !sameOwner(after, proof.owner) ||
      !matchesCursor(cursor, proof.admission)
    )
      continue
    cursorProofs.set(cursor, { ...proof, messages })
    carried = true
  }
  if (carried && markHasCurrentProof(after, mark)) {
    authoredUserRows.set(next, mark)
    carryAuthoredUserRows(previous, messages, after)
  }
  return after
}

function proofsFor(thread: unknown): ProjectedProof[] {
  if (!record(thread)) return []
  const messages = own(thread, 'messages')
  if (!Array.isArray(messages)) return []
  const projected = projectedProofs.get(thread)
  // A source projection can reuse a raw object whose cursor reference was once
  // live. Its current unowned view must not regain that old capability through
  // the raw cursor object's identity.
  if (projected && !projected.length) return []
  const result: ProjectedProof[] = []
  const seen = new Set<string>()
  const add = (binding: ProjectedProof) => {
    const { proof } = binding
    if (
      binding.messages !== messages ||
      seen.has(proof.admission.transportId) ||
      !sameOwner(thread, proof.owner) ||
      !matchesCursor(cursorOf(thread, proof.admission.transportId), proof.admission)
    )
      return
    seen.add(proof.admission.transportId)
    result.push(binding)
  }
  const cursors = own(thread, 'nativeRecovery')
  if (record(cursors))
    for (const transportId of Object.keys(cursors)) {
      const cursor = own(cursors, transportId)
      const proof = record(cursor) ? cursorProofs.get(cursor) : undefined
      if (
        proof &&
        proof.admission.transportId === transportId &&
        (!projected || projected.some((binding) => binding.proof.cursor === cursor))
      )
        add({ proof, messages: proof.messages })
    }
  for (const binding of projected || []) add(binding)
  return result
}
function uniqueThreads(threads: readonly Thread[]): Map<string, Thread> {
  const result = new Map<string, Thread>()
  const duplicates = new Set<string>()
  for (const thread of threads) {
    const id = record(thread) ? own(thread, 'id') : undefined
    if (!nonempty(id) || duplicates.has(id)) continue
    if (result.has(id)) {
      result.delete(id)
      duplicates.add(id)
    } else result.set(id, thread)
  }
  return result
}

function capturedRecord(value: unknown): CapturedRecord | undefined {
  if (!record(value)) return
  const fields = new Map<string, unknown>()
  for (const key of Object.keys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || field.get || field.set) return
    fields.set(key, field.value)
  }
  return { value, fields }
}
function matchesCapturedRecord(captured: CapturedRecord): boolean {
  if (Object.keys(captured.value).length !== captured.fields.size) return false
  for (const [key, value] of captured.fields) {
    const field = Object.getOwnPropertyDescriptor(captured.value, key)
    if (!field || field.get || field.set || !Object.is(field.value, value)) return false
  }
  return true
}
function captureMembershipMembers(history: readonly Thread[]): MembershipMember[] | undefined {
  if (!Array.isArray(history)) return
  const ids = new Set<string>()
  const members: MembershipMember[] = []
  for (let index = 0; index < history.length; index++) {
    const slot = Object.getOwnPropertyDescriptor(history, String(index))
    if (!slot || slot.get || slot.set) return
    const value = slot.value
    const fields = capturedRecord(value)
    const id = fields && own(value, 'id')
    const messages = fields && own(value, 'messages')
    if (!fields || !nonempty(id) || ids.has(id) || !Array.isArray(messages)) return
    ids.add(id)
    const records = [fields]
    const recovery = own(value, 'nativeRecovery')
    if (recovery !== undefined) {
      const map = capturedRecord(recovery)
      if (!map) return
      records.push(map)
      for (const cursor of map.fields.values()) {
        const captured = capturedRecord(cursor)
        if (!captured) return
        records.push(captured)
      }
    }
    const entries: unknown[] = []
    for (let position = 0; position < messages.length; position++) {
      const entry = Object.getOwnPropertyDescriptor(messages, String(position))
      if (!entry || entry.get || entry.set) return
      entries.push(entry.value)
      if (record(entry.value)) {
        const captured = capturedRecord(entry.value)
        if (!captured) return
        records.push(captured)
      }
    }
    members.push({ value, id, records, messages, entries })
  }
  return members
}
function matchesMembershipMembers(
  history: readonly Thread[],
  members: MembershipMember[],
): boolean {
  if (!Array.isArray(history) || history.length !== members.length) return false
  for (let index = 0; index < members.length; index++) {
    const member = members[index]
    const slot = Object.getOwnPropertyDescriptor(history, String(index))
    if (
      !slot ||
      slot.get ||
      slot.set ||
      slot.value !== member.value ||
      member.messages.length !== member.entries.length ||
      !member.records.every(matchesCapturedRecord)
    )
      return false
    for (let position = 0; position < member.entries.length; position++) {
      const entry = Object.getOwnPropertyDescriptor(member.messages, String(position))
      if (!entry || entry.get || entry.set || !Object.is(entry.value, member.entries[position]))
        return false
    }
  }
  return true
}
function membershipProofFor(history: readonly Thread[]): MembershipProof | undefined {
  const proof = membershipProofs.get(history)
  if (!proof || !matchesMembershipMembers(history, proof.members)) return
  const present = new Set(proof.members.map((member) => member.id))
  return proof.admissions.every((admission) => !present.has(admission.sessionId))
    ? proof
    : undefined
}
function uniqueMembershipAdmissions(
  admissions: readonly ConversationProjectionAdmission[],
): ConversationProjectionAdmission[] | undefined {
  const result = new Map<string, ConversationProjectionAdmission>()
  for (const admission of admissions) {
    if (!validAdmission(admission)) return
    const key = JSON.stringify([admission.sessionId, admission.transportId])
    if (result.has(key)) return
    result.set(key, copyAdmission(admission))
  }
  return [...result.values()]
}

/** Only the actual delete operation can authorize absence of a privately admitted native row. */
export function registerNativeProjectionMembershipTransition(
  before: readonly Thread[],
  after: Thread[],
): Thread[] {
  const previous = captureMembershipMembers(before)
  const next = captureMembershipMembers(after)
  if (!previous || !next || next.length >= previous.length) return after
  let position = 0
  for (const member of next) {
    while (position < previous.length && previous[position].value !== member.value) position++
    if (position === previous.length) return after
    position++
  }
  const present = new Set(next.map((member) => member.id))
  const inherited = membershipProofFor(before)?.admissions ?? []
  const deleted = previous
    .filter((member) => !present.has(member.id))
    .flatMap((member) => proofsFor(member.value).map(({ proof }) => copyAdmission(proof.admission)))
  const admissions = uniqueMembershipAdmissions([...inherited, ...deleted])
  if (admissions?.length && admissions.every((admission) => !present.has(admission.sessionId)))
    membershipProofs.set(after, { admissions, members: next })
  return after
}

/** Cold absence admission belongs to the exact actual cache array that native attestation validated. */
export async function registerNativeProjectionCacheMembership(
  history: Thread[],
  admissions: readonly ConversationProjectionAdmission[] | undefined,
  cachedSource: CachedHistory,
): Promise<Thread[]> {
  if (history !== cachedSource.threads || !admissions?.length) return history
  const origin = await getCachedConversationHistoryRecovery(cachedSource)
  if (
    !origin ||
    history !== cachedSource.threads ||
    origin.rows.length !== history.length ||
    origin.rows.some((row, index) => row !== history[index])
  )
    return history
  const members = captureMembershipMembers(history)
  const canonical = uniqueMembershipAdmissions(admissions)
  if (
    members &&
    canonical?.length &&
    canonical.every((admission) => !members.some((member) => member.id === admission.sessionId))
  )
    membershipProofs.set(history, { admissions: canonical, members })
  return history
}

/** Deleted-owner capabilities travel in a separate header; JSON never stores them. */
export function nativeProjectionMembershipAdmissions(
  history: readonly Thread[],
): ConversationProjectionAdmission[] | undefined {
  return membershipProofFor(history)?.admissions.map(copyAdmission)
}

function sharesMembershipSource(before: Thread, after: Thread): boolean {
  for (const value of [before, after])
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (field?.get || field?.set) return false
    }
  return (
    hasConversationSource(before) &&
    hasConversationSource(after) &&
    getConversationSourceRaw(before) === getConversationSourceRaw(after)
  )
}
function preservesMembershipRow(before: MembershipMember, after: MembershipMember): boolean {
  if (before.value === after.value) return true
  const sourceOwned = sharesMembershipSource(before.value, after.value)
  const legacyWorkspace =
    sourceOwned &&
    !proofsFor(before.value).length &&
    !proofsFor(after.value).length &&
    own(before.value, 'workspace') === undefined &&
    !conversationSourceHasPersistedField(before.value, 'workspace') &&
    own(before.value, 'workspaceUnknown') !== true
  for (const key of ['id', 'profileId', 'provider', 'workspace', 'workspaceUnknown', 'purpose']) {
    if (legacyWorkspace && (key === 'workspace' || key === 'workspaceUnknown')) continue
    if (!Object.is(own(before.value, key), own(after.value, key))) return false
  }
  // A genuinely applied native delivery can extend or replace its own projected
  // rows. Its private proof still binds the resulting owner, cursor and body.
  if (proofsFor(after.value).length) return true
  if (!Object.is(own(before.value, 'remoteId'), own(after.value, 'remoteId'))) return false
  const recovery = own(before.value, 'nativeRecovery')
  if (!Object.is(recovery, own(after.value, 'nativeRecovery'))) return false
  if (
    !sourceOwned &&
    before.messages !== after.messages &&
    !record(recovery) &&
    !before.entries.some((entry) => record(entry) && after.entries.includes(entry))
  )
    return false
  if (after.entries.length < before.entries.length) return false
  return before.entries.every((entry, index) =>
    preservesCoveredMessage(entry, after.entries[index]),
  )
}

/** Carry existing absence only across the actual authored update or selected-cache reconciliation. */
export function carryNativeProjectionMembership(
  before: readonly Thread[],
  after: Thread[],
): Thread[] {
  // The authored update may itself have registered a newer explicit deletion.
  if (membershipProofFor(after)) return after
  const proof = membershipProofFor(before)
  if (!proof) return after
  const members = captureMembershipMembers(after)
  if (
    !members ||
    proof.members.some((source) => !members.some((member) => member.id === source.id)) ||
    proof.admissions.some((admission) =>
      members.some((member) => member.id === admission.sessionId),
    ) ||
    members.some((member) => {
      const previous = proof.members.find((source) => source.id === member.id)
      return previous && !preservesMembershipRow(previous, member)
    })
  )
    return after
  membershipProofs.set(after, { admissions: proof.admissions, members })
  return after
}

function carryMembershipProjection(before: readonly Thread[], after: Thread[]): void {
  const proof = membershipProofFor(before)
  if (!proof) {
    membershipProofs.delete(after)
    return
  }
  const members = captureMembershipMembers(after)
  if (
    !members ||
    members.length !== proof.members.length ||
    members.some((member) => !proof.members.some((source) => source.id === member.id)) ||
    proof.admissions.some((admission) =>
      members.some((member) => member.id === admission.sessionId),
    )
  ) {
    membershipProofs.delete(after)
    return
  }
  membershipProofs.set(after, { admissions: proof.admissions, members })
}

/** Pair the actual source projection with the privately owned view that produced it. */
export function projectNativeProjectionAdmissions(
  views: readonly Thread[],
  projected: Thread[],
): Thread[] {
  const source = uniqueThreads(views)
  const targets = uniqueThreads(projected)
  for (const [id, target] of targets) {
    const view = source.get(id)
    const messages = record(target) ? own(target, 'messages') : undefined
    if (!view || !Array.isArray(messages)) {
      projectedProofs.set(target, [])
      continue
    }
    const bindings = proofsFor(view)
      .filter(
        ({ proof }) =>
          sameOwner(target, proof.owner) &&
          matchesCursor(cursorOf(target, proof.admission.transportId), proof.admission),
      )
      .map(({ proof }) => ({ proof, messages }))
    if (bindings.length) projectedProofs.set(target, bindings)
    else projectedProofs.set(target, [])
  }
  carryMembershipProjection(views, projected)
  return projected
}

/** Refreshing an owned source intent may change raw object references after an ACK. */
export function carryNativeProjectionAdmissions(previous: Thread[], next: Thread[]): Thread[] {
  return previous === next ? next : projectNativeProjectionAdmissions(previous, next)
}

/** Metadata travels alongside the exact native write, never inside recoverable JSON. */
export function nativeProjectionAdmissions(
  history: readonly Thread[],
): ConversationProjectionAdmission[] | undefined {
  const admissions: ConversationProjectionAdmission[] = []
  for (const thread of uniqueThreads(history).values())
    for (const { proof } of proofsFor(thread)) admissions.push(copyAdmission(proof.admission))
  return admissions.length ? admissions : undefined
}
