import type { NativeRecoveryConsumer } from '../shared/types'
import type { ConversationProjectionAdmission } from '../shared/conversations'
import type { Thread } from './state'
import {
  nativeProjectionAdmissions,
  nativeProjectionMembershipAdmissions,
  nativeProjectionRecoveryCacheHash,
} from './native-projection-admissions'

/** Passive archives without an assigned identity cannot register a native consumer. */
export function hasNativeRecoveryConsumerIdentity(sessionId: unknown, profileId: unknown): boolean {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    typeof profileId === 'string' &&
    profileId.length > 0
  )
}

export function mainNativeRecoveryRequest(threads: readonly Thread[]): {
  consumers: NativeRecoveryConsumer[]
  membershipAdmissions: readonly ConversationProjectionAdmission[]
} {
  const consumers = threads
    .filter((thread) => hasNativeRecoveryConsumerIdentity(thread.id, thread.profileId))
    .map((thread): NativeRecoveryConsumer => {
      const cacheHash = nativeProjectionRecoveryCacheHash(thread)
      const projectionAdmissions = nativeProjectionAdmissions([thread])
      return {
        kind: 'main',
        sessionId: thread.id,
        profileId: thread.profileId,
        ...(thread.workspace ? { workspace: thread.workspace } : {}),
        ...(thread.remoteId ? { remoteId: thread.remoteId } : {}),
        ...(thread.nativeRecovery ? { applied: thread.nativeRecovery } : {}),
        ...(cacheHash ? { cacheHash } : {}),
        ...(projectionAdmissions ? { projectionAdmissions } : {}),
      }
    })
  return {
    consumers,
    membershipAdmissions: nativeProjectionMembershipAdmissions(threads) ?? [],
  }
}
