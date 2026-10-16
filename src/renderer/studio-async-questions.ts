import { Option, Schema } from 'effect'
import type { NativeRecoveryOwnerState } from '../shared/types'
import { carryNativeProjectionAuthoredTransition } from './native-projection-admissions'
import type { Message, Thread } from './state'
import { restoreStudioPlannerRecovery } from './studio-planner-recovery'

const identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(1000),
  Schema.isPattern(/^[^\x00-\x1f\x7f]+$/u),
)
const natural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const followupSchema = Schema.Struct({
  kind: Schema.Literal('studio-question-followup'),
  sessionId: identifier,
  profileId: identifier,
  provider: Schema.Literals(['codex', 'claude']),
  workspace: Schema.NonEmptyString.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(/^\/[^\x00-\x1f\x7f]*$/u),
  ),
  remoteId: identifier,
  userMessage: Schema.Struct({
    id: identifier,
    role: Schema.Literal('user'),
    submission: Schema.Literal('steering'),
    text: Schema.String.check(Schema.isMaxLength(1_000_000)),
    turn: natural,
    createdAt: natural,
  }),
})
const decodeFollowup = Schema.decodeUnknownOption(followupSchema, {
  onExcessProperty: 'error',
})

export type StudioQuestionFollowup = typeof followupSchema.Type

/** A delayed native acknowledgement retains the authored turn and its place in history. */
export function insertStudioQuestionFollowup(
  thread: Thread,
  followup: StudioQuestionFollowup,
): Thread {
  const user = followup.userMessage
  if (
    followup.sessionId !== thread.id ||
    followup.profileId !== thread.profileId ||
    followup.provider !== thread.provider ||
    followup.workspace !== thread.workspace ||
    followup.remoteId !== thread.remoteId ||
    thread.workspaceUnknown
  )
    return thread
  const previous = thread.messages.find((message) => message.id === user.id)
  if (previous || user.turn > thread.turn) return thread
  const finished =
    thread.turn > user.turn ||
    (!thread.busy && ['completed', 'interrupted', 'failed'].includes(thread.turnStatus || ''))
  const previousFinish = thread.messages.findLast(
    (message) => message.turn === user.turn && message.finishedAt !== undefined,
  )
  const message: Message = {
    ...user,
    ...(finished
      ? {
          finishedAt: Math.max(user.createdAt, previousFinish?.finishedAt || user.createdAt),
          finishStatus:
            previousFinish?.finishStatus ||
            (thread.turn === user.turn && thread.turnStatus ? thread.turnStatus : 'completed'),
        }
      : {}),
  }
  const following = thread.messages.findIndex(
    (candidate) =>
      candidate.turn > user.turn ||
      (candidate.turn === user.turn &&
        candidate.createdAt !== undefined &&
        candidate.createdAt > user.createdAt),
  )
  const index = following < 0 ? thread.messages.length : following
  return carryNativeProjectionAuthoredTransition(
    thread,
    {
      ...thread,
      messages: [...thread.messages.slice(0, index), message, ...thread.messages.slice(index)],
    },
    user.id,
  )
}

/** Native recovery supplies only followups whose exact outbox input was written. */
export function restoreStudioQuestionFollowups(
  thread: Thread,
  owner: NativeRecoveryOwnerState,
): Thread {
  const bound = restoreStudioPlannerRecovery(owner, {
    sessionId: thread.id,
    profileId: thread.profileId,
    provider: thread.provider,
  })
  if (!bound) return thread
  const nativeOwner = bound.owner
  if (
    nativeOwner.sessionId !== thread.id ||
    nativeOwner.originalInput?.sessionId !== thread.id ||
    nativeOwner.originalInput.scope !== 'life-customization' ||
    nativeOwner.originalInput.provider !== thread.provider ||
    !thread.profileId ||
    !thread.workspace ||
    thread.workspaceUnknown ||
    nativeOwner.originalInput.workspace !== thread.workspace ||
    !thread.remoteId ||
    nativeOwner.remoteId !== thread.remoteId
  )
    return thread
  let restored = thread
  for (const value of nativeOwner.admittedFollowups || []) {
    const followup = Option.getOrUndefined(decodeFollowup(value))
    if (
      !followup ||
      followup.sessionId !== thread.id ||
      followup.profileId !== thread.profileId ||
      followup.provider !== thread.provider ||
      followup.workspace !== thread.workspace ||
      followup.remoteId !== thread.remoteId ||
      followup.userMessage.turn > thread.turn
    )
      continue
    restored = insertStudioQuestionFollowup(restored, followup)
  }
  return restored
}
