import { describe, expect, it } from 'vitest'
import type { AgentEvent, NativeRecoveryOwnerState } from '../src/shared/types'
import type { Thread } from '../src/renderer/state'
import {
  insertStudioQuestionFollowup,
  restoreStudioQuestionFollowups,
  type StudioQuestionFollowup,
} from '../src/renderer/studio-async-questions'
import { createStudioSession, normalizeStudioSessions } from '../src/renderer/studio-history'
import { resetStudioSessionRequests } from '../src/renderer/studio-source'
import type { StudioPlannerRecovery } from '../src/renderer/studio-planner-recovery'

const exact = 'Question:  Which direction?\r\n\nAnswer:  Keep these bytes\t界\ud800  '
const thread = (): Thread => ({
  ...createStudioSession('codex', 10, 'life-studio:one').thread,
  profileId: 'machine:one',
  workspace: '/private/studio workspace',
  remoteId: 'native:one',
  turn: 1,
  busy: true,
  pending: [],
  messages: [
    { id: 'initial-user', role: 'user', text: 'Original exact request', turn: 1, createdAt: 10 },
  ],
})
const followup = (): StudioQuestionFollowup => ({
  kind: 'studio-question-followup',
  sessionId: 'life-studio:one',
  profileId: 'machine:one',
  provider: 'codex',
  workspace: '/private/studio workspace',
  remoteId: 'native:one',
  userMessage: {
    id: 'reply-user',
    role: 'user',
    submission: 'steering',
    text: exact,
    turn: 1,
    createdAt: 20,
  },
})
const planner = (): StudioPlannerRecovery => ({
  format: 'life-studio-planner-recovery',
  formatVersion: 1,
  sessionId: 'life-studio:one',
  profileId: 'machine:one',
  provider: 'codex',
  request: 'Original exact request',
  input: {
    sessionId: 'life-studio:one',
    localTurn: 1,
    provider: 'codex',
    remoteId: 'native:one',
    workspace: '/private/studio workspace',
    prompt: 'Original exact request',
    mode: 'plan',
    scope: 'life-customization',
  },
  nativeIteration: 1,
  parts: [],
  reads: 0,
  repairs: 0,
  finishing: false,
  autoApply: false,
  phase: 'planning',
})
const owner = (values: unknown[] = [followup()]): NativeRecoveryOwnerState => ({
  sessionId: 'life-studio:one',
  transportId: 'transport:one',
  status: 'running',
  ownerGeneration: 1,
  localTurn: 1,
  remoteId: 'native:one',
  provider: 'codex',
  originalInput: planner().input,
  clientRecovery: planner(),
  admittedFollowups: values,
})

describe('native Studio async question replies', () => {
  it('restores a written followup exactly once without replacing the planner request', () => {
    const original = thread()
    const native = owner()
    const restored = restoreStudioQuestionFollowups(original, native)
    expect(restored.messages.map((message) => message.id)).toEqual(['initial-user', 'reply-user'])
    expect(restored.messages[1]).toEqual(followup().userMessage)
    expect(restored.messages[1].text).toBe(exact)
    expect(restoreStudioQuestionFollowups(restored, native)).toBe(restored)
    expect(native.clientRecovery).toEqual(planner())
    expect(original.messages).toHaveLength(1)
  })

  it('places a late acknowledgement before newer output and later turns', () => {
    const current = thread()
    current.turn = 2
    current.messages.push(
      {
        id: 'after-answer',
        role: 'assistant',
        text: 'Native response',
        turn: 1,
        createdAt: 30,
        finishedAt: 40,
        finishStatus: 'completed',
      },
      { id: 'later-turn', role: 'user', text: 'Later request', turn: 2, createdAt: 50 },
    )
    const restored = insertStudioQuestionFollowup(current, followup())
    expect(restored.messages.map((message) => message.id)).toEqual([
      'initial-user',
      'reply-user',
      'after-answer',
      'later-turn',
    ])
    expect(restored.messages[1]).toMatchObject({
      ...followup().userMessage,
      finishedAt: 40,
      finishStatus: 'completed',
    })
  })

  it('retains native completion when the answer acknowledgement arrives after the run ends', () => {
    const current = { ...thread(), busy: false, turnStatus: 'interrupted' as const }
    const restored = insertStudioQuestionFollowup(current, followup())
    expect(restored.busy).toBe(false)
    expect(restored.turnStatus).toBe('interrupted')
    expect(restored.messages[1]).toMatchObject({ finishStatus: 'interrupted', finishedAt: 20 })
    expect(
      insertStudioQuestionFollowup({ ...thread(), busy: false }, followup()).messages[1].finishedAt,
    ).toBeUndefined()
  })

  it('does not replace a conflicting existing message with the same native-admitted ID', () => {
    const current = thread()
    current.messages.push({ ...followup().userMessage, text: 'Conflicting preserved bytes' })
    expect(restoreStudioQuestionFollowups(current, owner())).toBe(current)
    expect(current.messages[1].text).toBe('Conflicting preserved bytes')
  })

  it('requires the original Studio owner and exact machine, workspace, thread and provider', () => {
    const current = thread()
    for (const patch of [
      { sessionId: 'other-session' },
      { originalInput: undefined },
      { originalInput: { ...planner().input, scope: 'research' as const } },
      { originalInput: { ...planner().input, workspace: '/another/private/workspace' } },
      { remoteId: 'other-native-thread' },
      { clientRecovery: { ...planner(), profileId: 'another-machine' } },
    ])
      expect(restoreStudioQuestionFollowups(current, { ...owner(), ...patch })).toBe(current)
    for (const patch of [
      { sessionId: 'other-session' },
      { profileId: 'other-machine' },
      { provider: 'claude' },
      { workspace: '/another/private/workspace' },
      { remoteId: 'other-native-thread' },
    ])
      expect(restoreStudioQuestionFollowups(current, owner([{ ...followup(), ...patch }]))).toBe(
        current,
      )
    expect(
      restoreStudioQuestionFollowups({ ...current, workspaceUnknown: true }, owner()).messages,
    ).toBe(current.messages)
  })

  it('rejects malformed followups and cannot hydrate an unwritten archival answer', () => {
    const current = thread()
    const valid = followup()
    const invalid = [
      null,
      { ...valid, kind: 'main' },
      { ...valid, unexpected: true },
      { ...valid, userMessage: { ...valid.userMessage, role: 'assistant' } },
      { ...valid, userMessage: { ...valid.userMessage, turn: 2 } },
      { ...valid, userMessage: { ...valid.userMessage, createdAt: -1 } },
      { ...valid, userMessage: { ...valid.userMessage, submission: 'queued' } },
    ]
    expect(restoreStudioQuestionFollowups(current, owner(invalid))).toBe(current)
    expect(
      restoreStudioQuestionFollowups(current, { ...owner(), admittedFollowups: undefined }),
    ).toBe(current)
    expect(restoreStudioQuestionFollowups(current, { ...owner(), clientRecovery: valid })).toBe(
      current,
    )
  })

  it('keeps live message questions during a deliberate new turn and drops callback requests', () => {
    const session = createStudioSession('codex', 10, 'life-studio:one')
    const question: AgentEvent = {
      sessionId: session.id,
      type: 'question',
      requestId: 'async:one',
      responseMode: 'message',
      canDismiss: true,
      questions: [{ id: '0', question: 'Which direction?' }],
    }
    const callback: AgentEvent = { ...question, requestId: 'callback:one', responseMode: 'native' }
    session.thread.pending = [question, callback]
    expect(resetStudioSessionRequests(session).thread.pending).toEqual([question])
    expect(session.thread.pending).toEqual([question, callback])
    const archived = normalizeStudioSessions([{ ...session, thread: { ...session.thread } }])
    expect(archived[0].thread.pending).toEqual([])
  })
})
