import { Effect } from 'effect'
import type { NativeRecoveryStoreHandle } from './native-recovery-store'
import { NativeRecoveryError } from './native-recovery-types'
import type { NativeRecoveryActionsHandle } from './native-recovery-actions'
import { NativeRecoveryActionError } from './native-recovery-actions'

/** Keep recovery/export UI available while failed storage prohibits new native work. */
export function unavailableNativeRecoveryStore(
  directory: string,
  cause: unknown,
): NativeRecoveryStoreHandle {
  const error =
    cause instanceof NativeRecoveryError
      ? cause
      : new NativeRecoveryError({
          operation: 'initialize',
          path: directory,
          reason: 'io',
          message: 'Native recovery storage is unavailable. Existing agents were not restarted.',
          cause,
        })
  const unavailable = () => Effect.fail(error)
  return {
    createTransport: unavailable,
    readTransport: unavailable,
    listTransports: unavailable,
    updateTransport: unavailable,
    reserveInput: unavailable,
    acknowledgeInput: unavailable,
    cancelInput: unavailable,
    reconcileInputHighWater: unavailable,
    appendOutputs: unavailable,
    appendEvents: unavailable,
    checkpoint: unavailable,
    prepareHistory: unavailable,
    acknowledgeHistory: unavailable,
    flushEffect: unavailable,
    closeEffect: () => Effect.void,
  }
}

export function unavailableNativeRecoveryActions(
  directory: string,
  cause: unknown,
): NativeRecoveryActionsHandle {
  const error =
    cause instanceof NativeRecoveryActionError
      ? cause
      : new NativeRecoveryActionError({
          operation: 'initialize',
          path: directory,
          reason: 'io',
          message: 'Studio recovery storage is unavailable. No action was repeated.',
          cause,
        })
  const unavailable = () => Effect.fail(error)
  return {
    prepare: unavailable,
    read: unavailable,
    perform: unavailable,
    reconcile: unavailable,
    reconcileOnly: unavailable,
    closeEffect: () => Effect.void,
  }
}
