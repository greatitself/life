import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Effect, Option, Schema } from 'effect'
import { formatAsyncQuestionReply } from '../shared/async-questions'
import type { AgentEvent, AgentQuestion, AgentQuestionReply } from '../shared/types'
import { stampRecoveryEvent } from './agent-native-recovery'
import type { NativeRecoverySnapshot, NativeRecoveryStoredInput } from './native-recovery-types'

const nonempty = Schema.NonEmptyString
const natural = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const asyncMessageSchema = Schema.Struct({
  type: Schema.Literal('agentMessage'),
  id: nonempty,
  delivery: Schema.Literal('async'),
  questions: Schema.Array(
    Schema.Struct({
      title: nonempty,
      options: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Array(Schema.String)])),
    }),
  ).check(Schema.isMinLength(1)),
})
export const decodeCodexAsyncMessage = Schema.decodeUnknownOption(asyncMessageSchema)

export const asyncQuestionOriginSchema = Schema.Struct({
  transportId: nonempty,
  eventId: nonempty,
  sessionId: nonempty,
  nativeThreadId: nonempty,
  rootNativeThreadId: nonempty,
  nativeTurnId: Schema.optionalKey(Schema.String),
  itemId: nonempty,
  ownerGeneration: natural,
  snapshotToken: nonempty,
  localTurn: Schema.optionalKey(natural),
  machine: nonempty,
  profileId: nonempty,
  workspace: nonempty,
})
export type AsyncQuestionOrigin = typeof asyncQuestionOriginSchema.Type
export const asyncQuestionReplySchema = Schema.Struct({
  requestId: nonempty,
  answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})
export const asyncQuestionBindingSchema = Schema.Struct({
  mode: Schema.Literal('async-question'),
  requestId: nonempty,
  source: asyncQuestionOriginSchema,
  prompt: Schema.String,
  answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  clientRecovery: Schema.optionalKey(Schema.Json),
})
export type AsyncQuestionBinding = typeof asyncQuestionBindingSchema.Type
const decodeBinding = Schema.decodeUnknownOption(asyncQuestionBindingSchema)
const decodeNativeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.Literals(['turn/start', 'turn/steer']),
      params: Schema.Struct({
        threadId: nonempty,
        input: Schema.Array(Schema.JsonObject),
      }),
    }),
  ),
)
const authoredMessage = Schema.Struct({
  id: nonempty,
  role: Schema.Literal('user'),
  text: Schema.String,
  turn: natural,
  createdAt: natural,
})
const decodeMainFollowup = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal('main'),
    userMessage: authoredMessage,
    threadSeed: Schema.Struct({
      id: nonempty,
      profileId: nonempty,
      provider: Schema.Literal('codex'),
      workspace: nonempty,
      turn: natural,
    }),
  }),
)
const decodeStudioFollowup = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal('studio-question-followup'),
    sessionId: nonempty,
    profileId: nonempty,
    provider: Schema.Literal('codex'),
    workspace: nonempty,
    remoteId: nonempty,
    userMessage: authoredMessage,
  }),
)
const decodeResolution = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: nonempty,
    type: Schema.Literal('request-resolved'),
    requestId: nonempty,
    status: Schema.Literals(['answered', 'dismissed']),
    details: Schema.Struct({
      asyncQuestionSource: asyncQuestionOriginSchema,
      asyncQuestionClaim: Schema.optionalKey(
        Schema.Struct({
          transportId: nonempty,
          sequence: natural.check(Schema.isGreaterThan(0)),
        }),
      ),
    }),
    nativeRecovery: Schema.Struct({
      transportId: nonempty,
      ownerGeneration: natural,
      snapshotToken: nonempty,
    }),
  }),
)
const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: nonempty,
    provider: Schema.Literal('codex'),
    type: Schema.Literal('question'),
    responseMode: Schema.Literal('message'),
    canDismiss: Schema.Literal(true),
    requestId: nonempty,
    itemId: nonempty,
    questions: Schema.Array(
      Schema.Struct({
        id: nonempty,
        question: nonempty,
        header: Schema.optionalKey(Schema.String),
        options: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) }),
          ),
        ),
        isOther: Schema.optionalKey(Schema.Boolean),
      }),
    ).check(Schema.isMinLength(1)),
    details: Schema.Struct({
      asyncQuestion: Schema.Struct({
        nativeThreadId: nonempty,
        rootNativeThreadId: nonempty,
        nativeTurnId: Schema.optionalKey(Schema.String),
      }),
    }),
    nativeRecovery: Schema.Struct({
      transportId: nonempty,
      eventId: nonempty,
      ownerGeneration: natural,
      snapshotToken: nonempty,
      localTurn: Schema.optionalKey(natural),
    }),
  }),
)

export class AsyncQuestionError extends Schema.TaggedError<AsyncQuestionError>()(
  'AsyncQuestionError',
  { message: Schema.String },
) {}

export interface AsyncQuestionRecord {
  event: AgentEvent
  source: AsyncQuestionOrigin
  state: 'open' | 'responding' | 'answered' | 'dismissed'
  reply?: { transportId: string; input: NativeRecoveryStoredInput; binding: AsyncQuestionBinding }
}

function snapshotMachine(snapshot: NativeRecoverySnapshot): string {
  const machine = snapshot.transport.machine
  return machine.transport === 'local'
    ? JSON.stringify(['local', machine.profileId])
    : JSON.stringify([machine.host, machine.port, machine.username])
}

export function validAsyncQuestionFollowup(
  value: unknown,
  source: AsyncQuestionOrigin,
  prompt: string,
  localTurn: number,
): boolean {
  const main = decodeMainFollowup(value)
  if (Option.isSome(main)) {
    const { userMessage, threadSeed } = main.value
    return (
      userMessage.text === prompt &&
      userMessage.turn === localTurn &&
      threadSeed.id === source.sessionId &&
      threadSeed.profileId === source.profileId &&
      threadSeed.workspace === source.workspace &&
      threadSeed.turn === localTurn
    )
  }
  const studio = decodeStudioFollowup(value)
  return (
    Option.isSome(studio) &&
    studio.value.userMessage.text === prompt &&
    studio.value.userMessage.turn === localTurn &&
    studio.value.sessionId === source.sessionId &&
    studio.value.profileId === source.profileId &&
    studio.value.workspace === source.workspace &&
    studio.value.remoteId === source.nativeThreadId
  )
}

export function asyncQuestionRequestId(source: {
  transportId: string
  nativeThreadId: string
  nativeTurnId?: string
  itemId: string
  ownerGeneration: number
  snapshotToken: string
}): string {
  return (
    'codex-async:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          source.transportId,
          source.nativeThreadId,
          source.nativeTurnId ?? null,
          source.itemId,
          source.ownerGeneration,
          source.snapshotToken,
        ]),
      )
      .digest('hex')
  )
}

export function codexAsyncQuestions(message: typeof asyncMessageSchema.Type): AgentQuestion[] {
  return message.questions.map((question, index) => ({
    id: `question-${index + 1}`,
    header: `Question ${index + 1}`,
    question: question.title,
    isOther: true,
    ...(question.options?.length ? { options: question.options.map((label) => ({ label })) } : {}),
  }))
}

export const validateAsyncQuestionReplyEffect = Effect.fn('AsyncQuestions.validateReply')(
  function* (event: AgentEvent, input: unknown, prompt: string) {
    const reply = yield* Schema.decodeUnknownEffect(asyncQuestionReplySchema)(input).pipe(
      Effect.mapError(() => new AsyncQuestionError({ message: 'The question reply is invalid.' })),
    )
    const questions = event.questions || []
    if (
      reply.requestId !== event.requestId ||
      Object.keys(reply.answers).length !== questions.length ||
      questions.some(
        (question) =>
          !Object.hasOwn(reply.answers, question.id) ||
          reply.answers[question.id].length !== 1 ||
          reply.answers[question.id][0].length === 0,
      ) ||
      formatAsyncQuestionReply(questions, reply.answers) !== prompt
    )
      return yield* new AsyncQuestionError({
        message:
          'Answer every original question without changing its exact question or answer text.',
      })
    return reply as AgentQuestionReply
  },
)

/** Rebuild claims from every journal, including inputs allocated before an interrupted ACK. */
export function collectAsyncQuestions(
  snapshots: readonly NativeRecoverySnapshot[],
): Map<string, AsyncQuestionRecord> {
  const questions = new Map<string, AsyncQuestionRecord>()
  for (const snapshot of snapshots) {
    const owners = snapshot.records.flatMap((record) =>
      record.kind === 'create'
        ? [...record.transport.owners]
        : record.kind === 'transport'
          ? [...(record.patch.owners || [])]
          : [],
    )
    for (const stored of snapshot.events) {
      const decoded = decodeQuestion(stored.event)
      if (Option.isNone(decoded)) continue
      const question = decoded.value
      const native = question.nativeRecovery
      const owner = owners.find(
        (candidate) =>
          candidate.snapshotToken === native.snapshotToken &&
          (candidate.generation ?? 0) === native.ownerGeneration &&
          (candidate.sessionId === question.sessionId ||
            candidate.parentSessionId === question.sessionId) &&
          (candidate.nativeThreadId === question.details.asyncQuestion.nativeThreadId ||
            candidate.nativeThreadId === question.details.asyncQuestion.rootNativeThreadId),
      )
      if (
        !owner ||
        native.transportId !== snapshot.transport.id ||
        native.eventId !== stored.eventId
      )
        continue
      const source: AsyncQuestionOrigin = {
        transportId: snapshot.transport.id,
        eventId: stored.eventId,
        sessionId: question.sessionId,
        nativeThreadId: question.details.asyncQuestion.nativeThreadId,
        rootNativeThreadId: question.details.asyncQuestion.rootNativeThreadId,
        ...(question.details.asyncQuestion.nativeTurnId !== undefined
          ? { nativeTurnId: question.details.asyncQuestion.nativeTurnId }
          : {}),
        itemId: question.itemId,
        ownerGeneration: native.ownerGeneration,
        snapshotToken: native.snapshotToken,
        ...(native.localTurn !== undefined ? { localTurn: native.localTurn } : {}),
        machine: snapshotMachine(snapshot),
        profileId: snapshot.transport.machine.profileId,
        workspace: owner.workspace,
      }
      if (question.requestId !== asyncQuestionRequestId(source)) continue
      if (questions.has(question.requestId)) continue
      questions.set(question.requestId, {
        event: stampRecoveryEvent(stored, snapshot.transport.id),
        source,
        state: 'open',
      })
    }
  }
  for (const snapshot of snapshots) {
    for (const input of snapshot.inputs) {
      if (!['user-prompt', 'steer'].includes(input.semantic.kind)) continue
      const decoded = decodeBinding(input.semantic.responseBinding)
      if (Option.isNone(decoded)) continue
      const binding = decoded.value
      const question = questions.get(binding.requestId)
      if (!question) continue
      if (!isDeepStrictEqual(question.source, binding.source))
        throw new AsyncQuestionError({
          message: 'The asynchronous reply claim changed its private question origin.',
        })
      const native =
        input.frame.type === 'write'
          ? decodeNativeReply(Buffer.from(input.frame.data, 'base64').toString('utf8'))
          : Option.none()
      const destinationOwner = snapshot.records
        .flatMap((record) =>
          record.kind === 'create'
            ? [...record.transport.owners]
            : record.kind === 'transport'
              ? [...(record.patch.owners || [])]
              : [],
        )
        .find(
          (owner) =>
            owner.sessionId === question.source.sessionId &&
            owner.generation === input.semantic.ownerGeneration &&
            owner.nativeThreadId === question.source.nativeThreadId &&
            owner.workspace === question.source.workspace,
        )
      if (
        question.reply ||
        input.semantic.sessionId !== question.source.sessionId ||
        input.semantic.nativeThreadId !== question.source.nativeThreadId ||
        snapshotMachine(snapshot) !== question.source.machine ||
        snapshot.transport.machine.profileId !== question.source.profileId ||
        formatAsyncQuestionReply(question.event.questions || [], binding.answers) !==
          binding.prompt ||
        Option.isNone(native) ||
        native.value.params.threadId !== question.source.nativeThreadId ||
        native.value.params.input.filter((item) => item.type === 'text').length !== 1 ||
        native.value.params.input.find((item) => item.type === 'text')?.text !== binding.prompt ||
        !destinationOwner ||
        (binding.clientRecovery !== undefined &&
          !validAsyncQuestionFollowup(
            binding.clientRecovery,
            question.source,
            binding.prompt,
            destinationOwner.localTurn ?? 0,
          ))
      )
        throw new AsyncQuestionError({
          message: 'The asynchronous question has an ambiguous native reply claim.',
        })
      question.reply = { transportId: snapshot.transport.id, input, binding }
      question.state = 'responding'
    }
  }
  for (const snapshot of snapshots) {
    for (const stored of snapshot.events) {
      const decoded = decodeResolution(stored.event)
      if (Option.isNone(decoded)) continue
      const resolution = decoded.value
      const question = questions.get(resolution.requestId)
      if (
        question &&
        snapshot.transport.id === question.source.transportId &&
        resolution.sessionId === question.source.sessionId &&
        resolution.nativeRecovery.transportId === question.source.transportId &&
        resolution.nativeRecovery.ownerGeneration === question.source.ownerGeneration &&
        resolution.nativeRecovery.snapshotToken === question.source.snapshotToken &&
        isDeepStrictEqual(question.source, resolution.details.asyncQuestionSource)
      ) {
        if (resolution.status === 'dismissed') {
          const claim = resolution.details.asyncQuestionClaim
          const matchingClaim =
            question.reply &&
            claim &&
            claim.transportId === question.reply.transportId &&
            claim.sequence === question.reply.input.sequence
          if (question.reply ? !matchingClaim : claim !== undefined)
            throw new AsyncQuestionError({
              message:
                'A native question reply and dismissal do not identify the same exact claimed input.',
            })
        }
        if (resolution.status === 'answered' && !question.reply?.input.written)
          throw new AsyncQuestionError({
            message: 'An asynchronous question resolution has no written native reply.',
          })
        question.state = resolution.status
      }
    }
  }
  return questions
}
