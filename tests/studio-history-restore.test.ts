import { describe, expect, it } from 'vitest'
import type { NativeRecoveryOwnerState } from '../src/shared/types'
import {
  createStudioSession,
  readStudioHistory,
  restoreNativeStudioSession,
} from '../src/renderer/studio-history'
import {
  STUDIO_PLANNER_RECOVERY_FORMAT,
  type StudioPlannerRecovery,
} from '../src/renderer/studio-planner-recovery'

const nativeRequest = '  Original native request\r\n\ud800 Ω  '
const localRequest = ' \tNewer offline settings request\r\n\udfff 😀  '
const nativeUser = {
  id: 'native-user-one',
  role: 'user' as const,
  text: nativeRequest,
  turn: 1,
  createdAt: 12,
}
const localUser = {
  id: 'local-user-two',
  role: 'user' as const,
  text: localRequest,
  input: localRequest,
  turn: 2,
  createdAt: 501,
  finishedAt: 502,
  finishStatus: 'completed',
}

function owner(userMessage: boolean = true): NativeRecoveryOwnerState {
  const planner: StudioPlannerRecovery = {
    format: STUDIO_PLANNER_RECOVERY_FORMAT,
    formatVersion: 1,
    sessionId: 'studio-one',
    profileId: 'machine-one',
    provider: 'codex',
    request: nativeRequest,
    input: {
      sessionId: 'studio-one',
      provider: 'codex',
      remoteId: 'native-session-one',
      prompt: nativeRequest,
      workspace: '/work/studio',
      localTurn: 1,
      mode: 'plan',
      scope: 'life-customization',
    },
    ...(userMessage ? { userMessage: nativeUser } : {}),
    nativeIteration: 1,
    reads: 0,
    repairs: 0,
    parts: [],
    finishing: false,
    autoApply: false,
    phase: 'finished',
  }
  return {
    sessionId: 'studio-one',
    transportId: 'older-native-transport',
    ownerGeneration: 2,
    status: 'idle',
    remoteId: 'native-session-one',
    snapshotToken: 'issued-owner-token',
    acceptedAppliedCursor: {
      appliedRevision: 7,
      ownerGeneration: 2,
      snapshotToken: 'accepted-cursor-token',
    },
    clientRecovery: planner,
  }
}

function history(nativeUserPresent: boolean = true, turn = 2) {
  const draft = createStudioSession('codex', 10, 'studio-one')
  const row = {
    ...draft,
    request: localRequest,
    stage: 'complete',
    updatedAt: 502,
    thread: {
      ...draft.thread,
      profileId: 'machine-one',
      remoteId: 'native-session-one',
      workspace: '/work/studio',
      turn,
      updatedAt: 502,
      turnStatus: 'completed',
      messages: [...(nativeUserPresent ? [nativeUser] : []), ...(turn > 1 ? [localUser] : [])],
    },
  }
  return readStudioHistory({ getItem: () => JSON.stringify([row]) })
}

describe('Studio restoration after a newer local turn', () => {
  it('preserves the exact newer local request, user row and timestamps when an older native turn is restored', () => {
    const store = history()
    const before = store.sessions[0]
    const restored = restoreNativeStudioSession(store.sessions, owner())[0]

    expect(restored.request).toBe(localRequest)
    expect(restored.thread.turn).toBe(2)
    expect(restored.thread.messages).toBe(before.thread.messages)
    expect(
      JSON.parse(
        JSON.stringify(restored.thread.messages.find((message) => message.id === localUser.id)),
      ),
    ).toEqual(localUser)
    expect(restored.createdAt).toBe(before.createdAt)
    expect(restored.updatedAt).toBe(502)
    expect(restored.thread.updatedAt).toBe(502)
    expect(
      JSON.parse(
        JSON.stringify(restored.thread.messages.find((message) => message.id === nativeUser.id)),
      ),
    ).toEqual(nativeUser)
    expect(restored.thread.nativeRecovery?.['older-native-transport']).toEqual({
      appliedRevision: 7,
      ownerGeneration: 2,
      snapshotToken: 'accepted-cursor-token',
    })
    expect(restored.thread.nativeRecoveryOwner).toEqual({
      transportId: 'older-native-transport',
      ownerGeneration: 2,
      snapshotToken: 'issued-owner-token',
    })
    expect(restored.thread).toMatchObject({
      profileId: 'machine-one',
      provider: 'codex',
      workspace: '/work/studio',
      remoteId: 'native-session-one',
    })
  })

  it('repairs the missing exact original native user row without replacing the newer local request or user row', () => {
    const store = history(false)
    const before = store.sessions[0]
    const originalLocalUser = before.thread.messages[0]
    const restored = restoreNativeStudioSession(store.sessions, owner())[0]

    expect(restored.request).toBe(localRequest)
    expect(restored.thread.turn).toBe(2)
    expect(restored.thread.messages[0]).toBe(originalLocalUser)
    expect(JSON.parse(JSON.stringify(restored.thread.messages[0]))).toEqual(localUser)
    expect(restored.thread.messages[1]).toEqual(nativeUser)
    expect(restored.updatedAt).toBe(502)
    expect(restored.thread.updatedAt).toBe(502)
    expect(restoreNativeStudioSession([restored], owner())[0].thread.messages).toHaveLength(2)
  })

  it('uses the recorded input local turn when older recovery has no original-user snapshot', () => {
    const store = history(false)
    const restored = restoreNativeStudioSession(store.sessions, owner(false))[0]

    expect(restored.request).toBe(localRequest)
    expect(restored.thread.messages).toBe(store.sessions[0].thread.messages)
    expect(restored.thread.turn).toBe(2)
  })

  it('still repairs the exact native request when the current session has not advanced beyond that turn', () => {
    const store = history(true, 1)
    const restored = restoreNativeStudioSession(store.sessions, owner())[0]

    expect(restored.request).toBe(nativeRequest)
    expect(restored.thread.turn).toBe(1)
  })
})
