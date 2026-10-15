import type {
  NativeRecoveryOwner,
  NativeRecoverySnapshot,
  NativeRecoveryStoredInput,
} from './native-recovery-types'

/** These facts must come from replay of the owned native transport, never renderer history. */
export interface NativeStopRecoveryTarget {
  readonly state: 'starting' | 'active' | 'idle' | 'terminal' | 'unknown'
  readonly nativeThreadId?: string
  readonly nativeTurnId?: string
  readonly ownershipProven: boolean
  /** Native interrupt success avoids another send; completion still needs idle/terminal output. */
  readonly interruptAcknowledged?: boolean
}

export interface NativeStopRecoveryChild extends NativeStopRecoveryTarget {
  /** The private root-generation owner recorded when this child was discovered. */
  readonly owner: NativeRecoveryOwner
}

export interface NativeStopRecoveryApproval {
  readonly requestId: string
  readonly nativeRequestId: string | number
  readonly requestType: string
  readonly owner: NativeRecoveryOwner
  readonly nativeThreadId?: string
  /** False when the provider advertises no non-grant decision. Interrupt instead. */
  readonly canDeny: boolean
}

export interface NativeStopRecoveryInput {
  readonly snapshot: NativeRecoverySnapshot
  readonly owner: NativeRecoveryOwner
  /** Exact raw SDK replies matched privately and confirmed by the original native channel. */
  readonly processedInputSequences?: readonly number[]
  readonly root: NativeStopRecoveryTarget
  readonly children: readonly NativeStopRecoveryChild[]
  readonly approvals: readonly NativeStopRecoveryApproval[]
  /** The private native reducer has reconstructed all ownership and child relationships. */
  readonly graphComplete: boolean
  /** Live Main witness for the exact owner generation before its native prompt call begins. */
  readonly rootDispatchNotStarted?: boolean
}

export type NativeStopRecoveryAction =
  | { readonly type: 'retry-input'; readonly input: NativeRecoveryStoredInput }
  | {
      readonly type: 'deny-approval'
      readonly approval: NativeStopRecoveryApproval
      readonly stopKey: string
    }
  | {
      readonly type: 'interrupt-codex'
      readonly nativeThreadId: string
      readonly nativeTurnId: string
      readonly stopKey: string
    }
  | { readonly type: 'interrupt-claude'; readonly stopKey: string }
  | { readonly type: 'finish-unstarted' }
  | { readonly type: 'finish-stop' }

export interface NativeStopRecoveryPlan {
  readonly status: 'unrequested' | 'continuing' | 'waiting' | 'complete' | 'unknown'
  readonly actions: readonly NativeStopRecoveryAction[]
  /** Exact responses written to the native pipe; not proof of native application. */
  readonly resolvedApprovalIds: readonly string[]
  /** Original outbox responses own these controls; never allocate a second response. */
  readonly reservedApprovalIds: readonly string[]
  readonly reasons: readonly string[]
}

function sameOwner(left: NativeRecoveryOwner, right: NativeRecoveryOwner): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.sessionId === right.sessionId &&
    (left.generation ?? 0) === (right.generation ?? 0) &&
    left.snapshotToken === right.snapshotToken &&
    left.kind === right.kind &&
    left.parentSessionId === right.parentSessionId &&
    left.workspace === right.workspace &&
    left.writableRoot === right.writableRoot &&
    left.nativeThreadId === right.nativeThreadId &&
    left.nativeSessionId === right.nativeSessionId
  )
}

function inputOwnsGeneration(input: NativeRecoveryStoredInput, owner: NativeRecoveryOwner) {
  return (
    input.semantic.sessionId === (owner.parentSessionId ?? owner.sessionId) &&
    (input.semantic.ownerGeneration ?? 0) === (owner.generation ?? 0)
  )
}

function responseIsCurrentOccurrence(
  delivery: NativeRecoveryStoredInput,
  approval: NativeStopRecoveryApproval,
) {
  const binding = delivery.semantic.responseBinding
  const requestId =
    binding && typeof binding === 'object' && !Array.isArray(binding)
      ? (binding as Record<string, unknown>).requestId
      : undefined
  // Native request IDs can be reused within one generation. A privately bound
  // earlier local occurrence cannot resolve or corrupt the current occurrence.
  // Missing or invalid occurrence identity still requires the binding audit.
  return typeof requestId !== 'string' || !requestId || requestId === approval.requestId
}

function responseThread(delivery: NativeRecoveryStoredInput, approval: NativeStopRecoveryApproval) {
  const binding = delivery.semantic.responseBinding
  const object =
    binding && typeof binding === 'object' && !Array.isArray(binding)
      ? (binding as Record<string, unknown>)
      : undefined
  const params = object?.params
  const boundThread =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).threadId
      : undefined
  if (object?.requestId !== approval.requestId) return false
  if (boundThread !== undefined && boundThread !== approval.nativeThreadId) return false
  if (delivery.semantic.nativeThreadId === approval.nativeThreadId) return true
  // Older Agents responses inherited the root thread in the semantic envelope.
  // Its privately recorded exact permission binding still identifies the child.
  // A missing semantic thread cannot act as a cross-child wildcard.
  return object?.requestId === approval.requestId && boundThread === approval.nativeThreadId
}

function stopKey(owner: NativeRecoveryOwner, kind: string, id?: string | number, turn?: string) {
  return JSON.stringify([
    owner.ownerId,
    owner.sessionId,
    owner.generation ?? 0,
    owner.snapshotToken ?? null,
    kind,
    typeof id,
    id ?? null,
    turn ?? null,
  ])
}

/**
 * Plan only after broker high-water reconciliation and complete native-output replay,
 * while pending outbox transmission is still paused. Allocate each new action through
 * the durable outbox before executing it, then refresh the snapshot before planning again.
 * Existing actions always retain their original sequence, frame and wire bytes.
 * Route retries through the transport's original outbox dispatcher, preserving
 * global input order, including deliveries owned by other roots on that transport.
 */
export function planNativeStopRecovery(input: NativeStopRecoveryInput): NativeStopRecoveryPlan {
  const { snapshot, owner, root, children, approvals } = input
  const processedInputSequences = new Set(input.processedInputSequences ?? [])
  const nativeInputProcessed = (delivery: NativeRecoveryStoredInput) =>
    processedInputSequences.has(delivery.sequence) &&
    delivery.frame.type === 'write' &&
    delivery.semantic.requestId !== undefined &&
    ['user-prompt', 'settings', 'steer', 'interrupt'].includes(delivery.semantic.kind) &&
    delivery.cancellation === undefined &&
    delivery.deliveryReceipt === undefined
  const actions: NativeStopRecoveryAction[] = []
  const resolvedApprovalIds: string[] = []
  const reservedApprovalIds: string[] = []
  const reasons: string[] = []
  let waiting = false
  const result = (status: NativeStopRecoveryPlan['status']): NativeStopRecoveryPlan => ({
    status,
    actions:
      status === 'unknown' || status === 'unrequested'
        ? []
        : [
            ...actions
              .filter((action) => action.type === 'retry-input')
              .sort((left, right) => left.input.sequence - right.input.sequence),
            ...actions.filter((action) => action.type !== 'retry-input'),
          ],
    resolvedApprovalIds,
    reservedApprovalIds,
    reasons,
  })
  const registered = snapshot.transport.owners.find((candidate) => sameOwner(candidate, owner))
  if (!registered) {
    reasons.push('The Stop owner is not registered to this exact native transport generation.')
    return result('unknown')
  }
  const historicalOwners = snapshot.records.flatMap((record) =>
    record.kind === 'create'
      ? [...record.transport.owners]
      : record.kind === 'transport'
        ? [...(record.patch.owners ?? [])]
        : [],
  )
  const privatelyRegistered = (candidate: NativeRecoveryOwner) =>
    [...snapshot.transport.owners, ...historicalOwners].some((known) => sameOwner(known, candidate))
  const ownsChild = (child: NativeStopRecoveryChild) =>
    sameOwner(child.owner, owner) ||
    (privatelyRegistered(child.owner) &&
      (child.owner.kind === 'child'
        ? child.owner.parentSessionId === owner.sessionId
        : child.owner.ownerId === owner.ownerId &&
          child.owner.sessionId === owner.sessionId &&
          child.owner.workspace === owner.workspace &&
          child.owner.writableRoot === owner.writableRoot &&
          child.owner.nativeThreadId === owner.nativeThreadId &&
          child.owner.nativeSessionId === owner.nativeSessionId))
  const ownsApproval = (approval: NativeStopRecoveryApproval) =>
    sameOwner(approval.owner, owner) ||
    children.some(
      (child) =>
        ownsChild(child) &&
        sameOwner(child.owner, approval.owner) &&
        child.nativeThreadId === approval.nativeThreadId,
    )
  const responses = new Map<NativeStopRecoveryApproval, NativeRecoveryStoredInput[]>()
  for (const approval of approvals) {
    if (!ownsApproval(approval)) {
      reasons.push(`Approval ${approval.requestId} has no proven owner in the recovered graph.`)
      continue
    }
    const original = snapshot.inputs.filter(
      (delivery) =>
        delivery.semantic.kind === 'permission-response' &&
        inputOwnsGeneration(delivery, approval.owner) &&
        delivery.semantic.permissionRequestId === approval.nativeRequestId &&
        delivery.semantic.requestType === approval.requestType &&
        responseThread(delivery, approval),
    )
    if (
      snapshot.inputs.some(
        (delivery) =>
          delivery.semantic.kind === 'permission-response' &&
          inputOwnsGeneration(delivery, approval.owner) &&
          delivery.semantic.permissionRequestId === approval.nativeRequestId &&
          responseIsCurrentOccurrence(delivery, approval) &&
          !original.includes(delivery),
      )
    )
      reasons.push(`Permission response ${approval.requestId} has inconsistent native binding.`)
    responses.set(approval, original)
    if (original.some((delivery) => delivery.written)) resolvedApprovalIds.push(approval.requestId)
    else if (original.some((delivery) => !delivery.cancellation))
      reservedApprovalIds.push(approval.requestId)
  }
  // Archive/imported stopRequested flags never admit wire mutations: only this
  // matching owner in the private, validated snapshot can authorize continuation.
  if (registered.stopRequested !== true) return result('unrequested')
  if (!input.graphComplete || !root.ownershipProven || root.state === 'unknown')
    reasons.push('The complete native ownership graph has not been reconstructed.')
  if (
    children.some(
      (child) => !child.ownershipProven || !ownsChild(child) || child.state === 'unknown',
    )
  )
    reasons.push('A native child has uncertain ownership or activity.')
  if (snapshot.transport.provider === 'codex' && root.nativeThreadId !== registered.nativeThreadId)
    reasons.push('The native root thread differs from the registered Stop owner.')
  if (reasons.length) return result('unknown')
  if (
    snapshot.outputs.some((frame) => frame.type === 'exit' && frame.nativeExitConfirmed !== false)
  ) {
    actions.push({ type: 'finish-stop' })
    return result('complete')
  }
  if (
    snapshot.outputs.some((frame) => frame.type === 'exit' && frame.nativeExitConfirmed === false)
  ) {
    reasons.push('Broker cleanup did not confirm that the owned native process exited.')
    return result('unknown')
  }
  // An admitted close prohibits older retries, but it does not prove that the
  // provider exited or that its skipped inputs were delivered.
  if (snapshot.closeInputSequence !== undefined) {
    reasons.push('The transport was closed without recorded native exit evidence.')
    return result('unknown')
  }
  const retryOriginal = (deliveries: readonly NativeRecoveryStoredInput[], label: string) => {
    if (deliveries.length > 1) {
      reasons.push(`${label} has multiple original allocations.`)
      return
    }
    if (deliveries.some((delivery) => delivery.written || nativeInputProcessed(delivery))) {
      waiting = true
      return
    }
    if (
      deliveries.some(
        (delivery) =>
          delivery.cancellation !== undefined ||
          delivery.acknowledged ||
          delivery.deliveryReceipt?.status === 'cancelled' ||
          delivery.deliveryReceipt?.status === 'uncertain',
      )
    ) {
      reasons.push(`${label} was allocated but its original delivery is not proven retryable.`)
      return
    }
    actions.push({ type: 'retry-input', input: deliveries[0] })
  }
  const active = (target: NativeStopRecoveryTarget) =>
    target.state === 'active' || target.state === 'starting'
  const rootStopped = !active(root)
  const childrenStopped = children.every((child) => !active(child))
  const prompts = snapshot.inputs.filter(
    (delivery) => delivery.semantic.kind === 'user-prompt' && inputOwnsGeneration(delivery, owner),
  )
  if (
    prompts.some(
      (delivery) =>
        !delivery.written &&
        !nativeInputProcessed(delivery) &&
        (!delivery.cancellation ||
          delivery.acknowledged ||
          delivery.deliveryReceipt?.status === 'uncertain'),
    )
  ) {
    reasons.push('An original user prompt remains unresolved; Stop cannot activate or replace it.')
    return result('unknown')
  }
  const stopOwners = [owner, ...children.map((child) => child.owner)]
  if (
    snapshot.inputs.some(
      (delivery) =>
        ['settings', 'steer', 'permission-response'].includes(delivery.semantic.kind) &&
        stopOwners.some((candidate) => inputOwnsGeneration(delivery, candidate)) &&
        !delivery.written &&
        !nativeInputProcessed(delivery) &&
        (delivery.acknowledged || delivery.deliveryReceipt !== undefined),
    )
  ) {
    reasons.push(
      'An original native control was accepted without proven delivery; Stop awaits its exact receipt.',
    )
    return result('unknown')
  }
  if (rootStopped && childrenStopped) {
    actions.push({ type: 'finish-stop' })
    return result('complete')
  }
  for (const approval of approvals) {
    const original = responses.get(approval)!
    if (original.some((delivery) => delivery.written)) continue
    if (original.length) retryOriginal(original, `Permission response ${approval.requestId}`)
    else if (approval.canDeny)
      actions.push({
        type: 'deny-approval',
        approval,
        stopKey: stopKey(
          approval.owner,
          JSON.stringify([
            'permission-response',
            approval.requestType,
            approval.nativeThreadId ?? null,
            approval.requestId,
          ]),
          approval.nativeRequestId,
        ),
      })
  }
  const unstarted =
    root.state === 'starting' &&
    (registered.phase === 'initializing' || input.rootDispatchNotStarted === true) &&
    prompts.every(
      (delivery) =>
        !delivery.written &&
        delivery.cancellation !== undefined &&
        !delivery.acknowledged &&
        delivery.deliveryReceipt?.status !== 'uncertain',
    )
  const planCodexInterrupt = (
    target: NativeStopRecoveryTarget,
    targetOwner: NativeRecoveryOwner,
  ) => {
    if (!active(target)) return
    if (target.interruptAcknowledged) {
      waiting = true
      return
    }
    if (!target.nativeThreadId || !target.nativeTurnId) {
      reasons.push('An admitted native turn has not yet yielded its exact interruption identity.')
      return
    }
    const original = snapshot.inputs.filter(
      (delivery) =>
        delivery.semantic.kind === 'interrupt' &&
        inputOwnsGeneration(delivery, targetOwner) &&
        delivery.semantic.method === 'turn/interrupt' &&
        delivery.semantic.nativeThreadId === target.nativeThreadId &&
        delivery.semantic.nativeTurnId === target.nativeTurnId,
    )
    if (
      snapshot.inputs.some(
        (delivery) =>
          delivery.semantic.kind === 'interrupt' &&
          delivery.semantic.method === 'turn/interrupt' &&
          delivery.semantic.nativeThreadId === target.nativeThreadId &&
          (delivery.semantic.nativeTurnId === undefined ||
            delivery.semantic.nativeTurnId === target.nativeTurnId) &&
          !original.includes(delivery),
      )
    ) {
      reasons.push(`Interrupt for ${target.nativeThreadId} has uncertain original owner scope.`)
      return
    }
    if (original.length) retryOriginal(original, `Interrupt for ${target.nativeThreadId}`)
    else
      actions.push({
        type: 'interrupt-codex',
        nativeThreadId: target.nativeThreadId,
        nativeTurnId: target.nativeTurnId,
        stopKey: stopKey(targetOwner, 'interrupt', target.nativeThreadId, target.nativeTurnId),
      })
  }
  if (snapshot.transport.provider === 'codex') {
    if (!unstarted) planCodexInterrupt(root, owner)
    for (const child of children) planCodexInterrupt(child, child.owner)
  } else if (!unstarted || !childrenStopped) {
    // Claude's explicit native interrupt belongs to the entire owned stream-json
    // process. It must never be allocated against a process shared by another root.
    if (
      snapshot.transport.owners.some(
        (candidate) => candidate.kind === 'root' && !sameOwner(candidate, owner),
      )
    ) {
      reasons.push('The Claude process contains another native root owner.')
    } else if (root.interruptAcknowledged) {
      waiting = true
    } else {
      const original = snapshot.inputs.filter(
        (delivery) =>
          delivery.semantic.kind === 'interrupt' && inputOwnsGeneration(delivery, owner),
      )
      if (original.length) retryOriginal(original, 'Claude interrupt')
      else actions.push({ type: 'interrupt-claude', stopKey: stopKey(owner, 'interrupt') })
    }
  }
  if (reasons.length) return result('unknown')
  if (unstarted && childrenStopped && !actions.length) {
    actions.push({ type: 'finish-unstarted' })
    return result('complete')
  }
  return result(actions.length ? 'continuing' : waiting ? 'waiting' : 'unknown')
}
