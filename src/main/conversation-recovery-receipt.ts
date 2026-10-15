import { randomUUID } from 'node:crypto'
import { Option, Predicate, Schema } from 'effect'
import type {
  ConversationHistorySnapshot,
  ConversationNativeRecoveryReceipt,
} from '../shared/conversations'

const natural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const cursorSchema = Schema.Struct({
  appliedRevision: natural,
  snapshotToken: Schema.NonEmptyString,
  ownerGeneration: natural,
})
const ownerSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  provider: Schema.Literals(['codex', 'claude']),
  profileId: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString.check(Schema.isPattern(/^\//)),
  remoteId: Schema.NonEmptyString,
  nativeRecovery: Schema.Record(Schema.NonEmptyString, cursorSchema),
})
const decodeId = Schema.decodeUnknownOption(Schema.NonEmptyString)
const decodeOwner = Schema.decodeUnknownOption(ownerSchema)

/** Project own data properties only; neither accessors nor unrelated transcript fields are read. */
function own(value: unknown, key: string): unknown {
  if (!Predicate.isObject(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined
}

/**
 * Called only after atomic commit, against the worker's canonical JSON tree.
 * This receipt reports membership; the native ledger still checks issued tokens
 * and exact native ownership before acknowledging or pruning any events.
 */
export function conversationRecoveryReceipt(
  snapshot: ConversationHistorySnapshot,
): ConversationNativeRecoveryReceipt | undefined {
  try {
    const identities = new Map<string, number>()
    for (const thread of snapshot.threads) {
      const id = decodeId(own(thread, 'id'))
      if (Option.isSome(id)) identities.set(id.value, (identities.get(id.value) ?? 0) + 1)
    }
    const owners: ConversationNativeRecoveryReceipt['owners'] = []
    for (const thread of snapshot.threads) {
      const id = decodeId(own(thread, 'id'))
      if (Option.isNone(id) || identities.get(id.value) !== 1) continue
      const unknownWorkspace = Object.getOwnPropertyDescriptor(thread, 'workspaceUnknown')
      if (unknownWorkspace && (!('value' in unknownWorkspace) || unknownWorkspace.value !== false))
        continue
      const recovery = own(thread, 'nativeRecovery')
      if (!Predicate.isObject(recovery)) continue
      const entries = Object.keys(recovery)
      // Record key schemas omit nonmatching keys; reject them before decoding
      // so a malformed transport map cannot silently become a partial receipt.
      if (!entries.length || entries.some((transportId) => Option.isNone(decodeId(transportId))))
        continue
      const cursors = Object.fromEntries(
        entries.map((transportId) => {
          const value = own(recovery, transportId)
          return [
            transportId,
            {
              appliedRevision: own(value, 'appliedRevision'),
              snapshotToken: own(value, 'snapshotToken'),
              ownerGeneration: own(value, 'ownerGeneration'),
            },
          ]
        }),
      )
      const owner = decodeOwner({
        sessionId: id.value,
        provider: own(thread, 'provider'),
        profileId: own(thread, 'profileId'),
        workspace: own(thread, 'workspace'),
        remoteId: own(thread, 'remoteId'),
        nativeRecovery: cursors,
      })
      if (Option.isSome(owner)) owners.push(owner.value)
    }
    if (!owners.length) return undefined
    return { snapshotId: `${snapshot.savedAt}:${randomUUID()}`, owners }
  } catch {
    // Optional receipt generation must never turn a successful history commit
    // into a failed write or authorize any ambiguous recovery metadata.
    return undefined
  }
}
