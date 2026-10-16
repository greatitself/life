import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import { coalesceAgentEvents } from '../src/renderer/agent-event-batch'
import {
  admitAgentEvents,
  applyEvent,
  applyNativeRecoveryOwner,
  nativeRecoveryBlocksMutation,
  readThreads,
  restoreNativeMainOwner,
  type Thread,
} from '../src/renderer/state'
import {
  normalizeStudioSessions,
  restoreNativeStudioSession,
  StudioHistoryStore,
} from '../src/renderer/studio-history'
import { reconcileStudioSessionLifecycle } from '../src/renderer/studio-source'
import { threadSection } from '../src/renderer/thread-management'
import {
  copyConversationSourceJson,
  projectConversationSource,
} from '../src/renderer/conversation-source'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    profileId: 'machine',
    workspace: '/srv/project',
    provider: 'codex',
    title: 'Original title',
    remoteId: 'native-session',
    messages: [
      { id: 'prompt', role: 'user', text: '  exact prompt\r\n\ud83d', turn: 31, createdAt: 10 },
    ],
    busy: true,
    turnStatus: 'running',
    model: '',
    mode: 'plan',
    updatedAt: 10,
    turn: 31,
    pending: [],
    ...overrides,
  }
}
function event(revision: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sessionId: 'thread',
    type: 'text',
    itemId: 'native-item',
    text: `${revision}`,
    nativeRecovery: {
      transportId: 'transport',
      revision,
      eventId: `event-${revision}`,
      ownerGeneration: 1,
      localTurn: 31,
      emittedAt: 100 + revision,
      snapshotToken: 'issued-native-token',
    },
    ...overrides,
  }
}

describe('renderer admission of durable native events', () => {
  it('persists native completion immediately after cold busy recovery without an intermediate running save', () => {
    const raw = {
      ...thread(),
      futureLifecycle: { exact: '  opaque\r\n\ud800' },
      pending: [{ sessionId: 'thread', type: 'approval', requestId: 'archived-request' }],
    }
    const restored = readThreads([raw])[0]
    expect(restored.busy).toBe(false)
    expect(projectConversationSource(restored).busy).toBe(true)
    const running = applyNativeRecoveryOwner(restored, {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 1,
      snapshotToken: 'issued-native-token',
      status: 'running',
      acceptedAppliedRevision: 0,
      pending: [],
    })
    const streamed = applyEvent(running, event(1, { text: '  exact native answer\r\n🧪' }))
    const completed = applyEvent(streamed, event(2, { type: 'complete' }))
    const saved = copyConversationSourceJson(completed)
    expect(saved).toMatchObject({
      busy: false,
      turnStatus: 'completed',
      agentStatus: 'completed',
      futureLifecycle: raw.futureLifecycle,
      pending: raw.pending,
    })
    expect(saved.messages[0]).toMatchObject(raw.messages[0])
    expect(saved.messages[1]).toMatchObject({
      id: '31:native-item',
      text: '  exact native answer\r\n🧪',
      createdAt: 101,
    })
    expect(completed.pending).toEqual([])
    expect(Object.getOwnPropertySymbols(saved)).toEqual([])
    expect(readThreads([saved])[0]).toMatchObject({ busy: false, turnStatus: 'completed' })
  })

  it('projects a verified idle owner while retaining passive archived lifecycle and permission data', () => {
    const raw = thread()
    const restored = readThreads([raw])[0]
    expect(projectConversationSource(restored).busy).toBe(true)
    const unknown = applyNativeRecoveryOwner(restored, {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 1,
      status: 'unknown',
    })
    expect(projectConversationSource(unknown).busy).toBe(true)
    const idle = applyNativeRecoveryOwner(restored, {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 1,
      status: 'idle',
      pending: [],
    })
    expect(copyConversationSourceJson(idle)).toMatchObject({ busy: false, turnStatus: 'running' })
    expect(projectConversationSource(restored).busy).toBe(true)
  })

  it.each(['running', 'idle'] as const)(
    'preserves opaque archived statuses outside the fields verified by a %s native owner',
    (status) => {
      const raw = {
        ...thread(),
        turnStatus: { futureNativeState: ['  exact\r\n\ud800', 7, null] },
        agentStatus: { futureAgentStatus: '  opaque\r\n🧪' },
        pending: [{ type: 'approval', sessionId: 'thread', requestId: 'opaque-archive' }],
      }
      const restored = readThreads([raw])[0]
      expect(restored.turnStatus).toBe('unknown')
      expect(restored.agentStatus).toBeUndefined()
      const verified = applyNativeRecoveryOwner(restored, {
        sessionId: 'thread',
        transportId: 'transport',
        ownerGeneration: 1,
        snapshotToken: 'issued-native-token',
        status,
        pending: [],
      })
      const saved = copyConversationSourceJson(verified)
      expect(saved).toMatchObject({
        busy: status === 'running',
        turnStatus: status === 'running' ? 'running' : raw.turnStatus,
        agentStatus: raw.agentStatus,
        pending: raw.pending,
      })
      expect(saved.messages[0]).toEqual(raw.messages[0])
      expect(verified.pending).toEqual([])
      expect(Object.getOwnPropertySymbols(saved)).toEqual([])
      expect(projectConversationSource(restored)).toMatchObject({
        busy: true,
        turnStatus: raw.turnStatus,
        agentStatus: raw.agentStatus,
      })
      const completed = applyEvent(verified, event(1, { type: 'complete' }))
      expect(copyConversationSourceJson(completed)).toMatchObject({
        busy: false,
        turnStatus: 'completed',
        agentStatus: 'completed',
        pending: raw.pending,
      })
    },
  )

  it('retains an actual terminal event authority when idle reconciliation happens before its save', () => {
    const restored = readThreads([thread()])[0]
    const terminal = applyEvent(
      restored,
      event(1, {
        type: 'complete',
        status: 'future-native-terminal-status',
      }),
    )
    expect(copyConversationSourceJson(terminal)).toMatchObject({
      busy: false,
      turnStatus: 'unknown',
      agentStatus: 'unknown',
    })
    const idle = applyNativeRecoveryOwner(terminal, {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 1,
      status: 'idle',
      pending: [],
    })
    expect(copyConversationSourceJson(idle)).toMatchObject({
      busy: false,
      turnStatus: 'unknown',
      agentStatus: 'unknown',
    })
  })

  it('does not author current lifecycle from an older native generation at the same local turn', () => {
    const raw = {
      ...thread(),
      turnStatus: 'future-native-terminal-status',
      agentStatus: 'running',
    }
    const restored = readThreads([raw])[0]
    const uncertain = applyNativeRecoveryOwner(restored, {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 2,
      status: 'unknown',
    })
    const historical = applyEvent(
      uncertain,
      event(1, {
        type: 'complete',
        status: 'future-native-terminal-status',
      }),
    )
    expect(historical).toMatchObject({ busy: false, turnStatus: 'unknown' })
    expect(projectConversationSource(historical)).toMatchObject({
      busy: true,
      turnStatus: 'future-native-terminal-status',
      agentStatus: 'running',
    })
  })

  it('drops old and repeated tails before combining new fragments, preserving exact UTF-16 and IDs', () => {
    const first = applyEvent(thread(), event(1, { text: 'A\r\n\ud83d' }))
    const raw = [
      event(1, { text: 'A\r\n\ud83d' }),
      event(2, { text: '\ude42\n' }),
      event(2, { text: 'duplicate' }),
      event(3, { text: '\ud800\r' }),
    ]
    const admitted = admitAgentEvents(first, raw)
    expect(admitted).toEqual([raw[1], raw[3]])
    expect(coalesceAgentEvents(admitted)).toBe(admitted)
    const final = admitted.reduce(applyEvent, first)
    expect(final.messages[0]).toEqual(thread().messages[0])
    expect(final.messages[1]).toMatchObject({
      id: '31:native-item',
      text: 'A\r\n🙂\n\ud800\r',
      createdAt: 101,
    })
    expect(final.nativeRecovery).toEqual({
      transport: {
        appliedRevision: 3,
        ownerGeneration: 1,
        snapshotToken: 'issued-native-token',
      },
    })
    expect(applyEvent(final, raw[3])).toBe(final)
  })

  it('retains permissions and their original resolution across replay without resurrecting a request', () => {
    const approval = event(1, {
      type: 'approval',
      requestId: 'exact-native-request',
      approvalChoices: [
        {
          id: 'native-choice',
          label: 'Approve',
          description: 'Exact native choice',
          outcome: 'approved',
        },
      ],
      details: { exact: { native: 'payload' } },
      text: 'Allow this command?',
    })
    const requested = applyEvent(thread(), approval)
    const resolved = applyEvent(
      requested,
      event(2, {
        type: 'request-resolved',
        text: undefined,
        requestId: 'exact-native-request',
        status: 'approved',
      }),
    )
    expect(resolved.pending).toEqual([])
    expect(resolved.messages.find((message) => message.kind === 'event')).toMatchObject({
      createdAt: 101,
      finishedAt: 102,
      status: 'approved',
      details: { exact: { native: 'payload' } },
    })
    expect(applyEvent(resolved, approval)).toBe(resolved)
  })

  it('maps older native generations to their actual UI turn without settling a newer root turn', () => {
    const active = thread({
      nativeRecovery: { transport: { appliedRevision: 1, ownerGeneration: 1 } },
    })
    const historical = event(2, {
      text: 'older reply',
      nativeRecovery: {
        ...event(2).nativeRecovery!,
        localTurn: 30,
      },
    })
    const appended = applyEvent(active, historical)
    expect(appended.turn).toBe(31)
    expect(appended.messages.at(-1)).toMatchObject({
      id: '30:native-item',
      turn: 30,
      text: 'older reply',
    })
    const complete = applyEvent(
      appended,
      event(3, {
        type: 'complete',
        status: 'completed',
        text: undefined,
        nativeRecovery: { ...event(3).nativeRecovery!, localTurn: 30 },
      }),
    )
    expect(complete).toMatchObject({
      busy: true,
      turnStatus: 'running',
      remoteId: 'native-session',
      turn: 31,
    })
    expect(complete.messages.at(-1)).toMatchObject({ finishedAt: 103, finishStatus: 'completed' })
    const successor = applyEvent(
      complete,
      event(4, {
        nativeRecovery: {
          ...event(4).nativeRecovery!,
          ownerGeneration: 2,
        },
      }),
    )
    const laterHistorical = applyEvent(successor, event(5))
    expect(
      laterHistorical.messages.find((message) => message.nativeRecovery?.ownerGeneration === 2)
        ?.text,
    ).toBe('4')
    expect(laterHistorical.messages.at(-1)?.text).toBe('5')
  })

  it('uses original native timestamps and deterministic error identity on independent cold projections', () => {
    vi.useFakeTimers()
    try {
      const failure = event(1, {
        type: 'error',
        text: 'exact failure',
        details: { recoverable: true },
      })
      vi.setSystemTime(100_000)
      const first = applyEvent(thread(), failure)
      vi.setSystemTime(900_000)
      const replay = applyEvent(thread(), failure)
      expect(replay).toEqual(first)
      expect(first.messages.at(-1)).toMatchObject({ createdAt: 101, text: 'exact failure' })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    null,
    {},
    { transportId: 'x', eventId: 'e', revision: -1 },
    { transportId: 'x', eventId: 'e', revision: 1.5 },
    { transportId: 'x', eventId: 'e', revision: 1, ownerGeneration: -1 },
    { transportId: 'x', eventId: 'e', revision: 1, emittedAt: Infinity },
  ])('preserves the thread when recovery metadata is malformed: %j', (metadata) => {
    const original = thread()
    expect(applyEvent(original, { ...event(1), nativeRecovery: metadata } as AgentEvent)).toBe(
      original,
    )
  })

  it('hydrates progress with uncertain authority until a native owner confirms it', () => {
    const restored = readThreads([applyEvent(thread(), event(1))])[0]
    expect(restored).toMatchObject({
      busy: false,
      turnStatus: 'unknown',
      nativeRecoveryStatus: 'unknown',
      nativeRecovery: { transport: { appliedRevision: 1, snapshotToken: 'issued-native-token' } },
    })
    expect(nativeRecoveryBlocksMutation(restored)).toBe(true)
    const running = applyNativeRecoveryOwner(restored, {
      sessionId: 'thread',
      transportId: 'transport',
      status: 'running',
      snapshotToken: 'new-issued-token',
      ownerGeneration: 1,
      acceptedAppliedRevision: 1,
      acceptedAppliedCursor: restored.nativeRecovery!.transport,
      throughEventRevision: 100,
    })
    expect(running).toMatchObject({
      busy: true,
      turnStatus: 'running',
      nativeRecovery: {
        transport: { appliedRevision: 1, snapshotToken: 'issued-native-token' },
      },
    })
    expect(nativeRecoveryBlocksMutation(running)).toBe(false)
    expect(applyEvent(running, event(1))).toBe(running)
  })

  it('admits missing historical output after a newer owner generation is restored', () => {
    const restored = applyNativeRecoveryOwner(
      thread({
        nativeRecovery: {
          transport: { appliedRevision: 1, ownerGeneration: 1 },
        },
      }),
      {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'running',
        ownerGeneration: 2,
        acceptedAppliedRevision: 1,
        snapshotToken: 'current-token',
      },
    )
    const old = applyEvent(
      restored,
      event(2, {
        text: 'older missing tail',
        nativeRecovery: {
          ...event(2).nativeRecovery!,
          localTurn: 30,
        },
      }),
    )
    expect(old.messages.at(-1)).toMatchObject({ text: 'older missing tail', turn: 30 })
    expect(old.nativeRecovery?.transport).toMatchObject({
      appliedRevision: 2,
      snapshotToken: 'issued-native-token',
    })
    expect(old.nativeRecoveryOwner?.ownerGeneration).toBe(2)
  })

  it.each(['complete', 'error', 'approval'] as const)(
    'retains the current parked arrangement when admitting an older native %s',
    (type) => {
      for (const arrangement of [
        { settled: true, settledAt: 500 },
        { snoozedAt: 500, snoozedUntil: 900 },
        { archivedAt: 500 },
      ]) {
        const current = applyNativeRecoveryOwner(
          thread({
            ...arrangement,
            busy: false,
            turnStatus: 'failed',
            attentionAt: 400,
            completedAt: 400,
            lastReadAt: 500,
            nativeRecovery: { transport: { appliedRevision: 1, ownerGeneration: 1 } },
          }),
          {
            sessionId: 'thread',
            transportId: 'transport',
            status: 'idle',
            ownerGeneration: 2,
            acceptedAppliedRevision: 1,
            snapshotToken: 'current-token',
            remoteId: 'native-session',
            pending: [],
          },
        )
        const historical = applyEvent(
          current,
          event(2, {
            type,
            ...(type === 'complete' ? { status: 'completed' } : {}),
            ...(type === 'approval' ? { requestId: 'old-native-approval' } : {}),
            text: 'Exact older native record\r\n🧪',
            nativeRecovery: { ...event(2).nativeRecovery!, localTurn: 30 },
          }),
        )
        expect(historical).not.toBe(current)
        expect(historical).toMatchObject({
          ...arrangement,
          busy: current.busy,
          turn: current.turn,
          turnStatus: current.turnStatus,
          remoteId: current.remoteId,
          attentionAt: 400,
          completedAt: 400,
          lastReadAt: 500,
        })
        expect(historical.nativeRecoveryOwner).toEqual(current.nativeRecoveryOwner)
        expect(historical.pending).toBe(current.pending)
        expect(historical.messages.slice(0, current.messages.length)).toEqual(current.messages)
        expect(historical.nativeRecovery?.transport.appliedRevision).toBe(2)
        if (type !== 'complete')
          expect(historical.messages.at(-1)).toMatchObject({
            text: 'Exact older native record\r\n🧪',
            turn: 30,
          })
      }
    },
  )

  it('restores current native approval controls separately from already applied historical events', () => {
    const approval = event(1, { type: 'approval', requestId: 'pending-native-request' })
    const saved = readThreads([applyEvent(thread(), approval)])[0]
    expect(saved.pending).toEqual([])
    expect(applyEvent(saved, approval)).toBe(saved)
    const restored = applyNativeRecoveryOwner(saved, {
      sessionId: 'thread',
      transportId: 'transport',
      status: 'running',
      acceptedAppliedRevision: 1,
      pending: [approval],
    })
    expect(restored.pending).toEqual([approval])
    expect(restored.nativeRecovery?.transport.appliedRevision).toBe(1)
  })

  it('permanently wakes parked history for its exact current native permission, including after answering', () => {
    const approval = event(1, { type: 'approval', requestId: 'pending-native-request' })
    for (const arrangement of [
      { settled: true, settledAt: 200 },
      { snoozedAt: 200, snoozedUntil: 900 },
      { archivedAt: 200 },
    ]) {
      const raw = {
        ...applyEvent(thread(), approval),
        ...arrangement,
        futureThreadField: { exact: '  Archived café 漢字 🧪\r\n' },
      }
      const saved = readThreads([raw])[0]
      const recovered = applyNativeRecoveryOwner(saved, {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'running',
        ownerGeneration: 1,
        snapshotToken: 'issued-native-token',
        acceptedAppliedRevision: 1,
        pending: [approval],
      })
      expect(recovered.pending).toEqual([approval])
      expect(threadSection(recovered, 300)).toBe('active')
      expect(recovered.settled).toBe(false)
      expect(recovered.snoozedUntil).toBeUndefined()
      expect(recovered.archivedAt).toBeUndefined()
      const answered = applyEvent(
        recovered,
        event(2, {
          type: 'request-resolved',
          requestId: approval.requestId,
          status: 'approved',
        }),
      )
      expect(answered.pending).toEqual([])
      expect(threadSection(answered, 400)).toBe('active')
      expect(answered.nativeRecoveryOwner).toEqual(recovered.nativeRecoveryOwner)
      expect(answered.messages[0]).toEqual(saved.messages[0])
      const persisted = copyConversationSourceJson(answered)
      expect(persisted).toMatchObject({ futureThreadField: raw.futureThreadField })
      expect(persisted.settled).toBe(false)
      expect(persisted.snoozedUntil).toBeUndefined()
      expect(persisted.archivedAt).toBeUndefined()
      expect(persisted.messages[0]).toEqual(raw.messages[0])
    }
  })

  it('permanently wakes parked history when a newer native owner restores its current permission', () => {
    for (const arrangement of [
      { settled: true, settledAt: 200 },
      { snoozedAt: 200, snoozedUntil: 900 },
      { archivedAt: 200 },
    ]) {
      const raw = {
        ...applyEvent(thread(), event(1)),
        ...arrangement,
        futureThreadField: { exact: '  New owner café 漢字 🧪\r\n' },
      }
      const current = applyNativeRecoveryOwner(readThreads([raw])[0], {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'idle',
        ownerGeneration: 1,
        snapshotToken: 'issued-native-token',
        acceptedAppliedRevision: 1,
        pending: [],
      })
      const approval = event(2, {
        type: 'approval',
        requestId: 'new-owner-permission',
        nativeRecovery: {
          ...event(2).nativeRecovery!,
          ownerGeneration: 2,
          snapshotToken: 'new-issued-token',
        },
      })
      const recovered = applyNativeRecoveryOwner(current, {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'idle',
        ownerGeneration: 2,
        snapshotToken: 'new-issued-token',
        acceptedAppliedRevision: 1,
        pending: [approval],
      })
      expect(recovered.pending).toEqual([approval])
      expect(recovered.messages).toBe(current.messages)
      expect(recovered.nativeRecoveryOwner).toEqual({
        transportId: 'transport',
        ownerGeneration: 2,
        snapshotToken: 'new-issued-token',
      })
      expect(recovered.settled).toBe(false)
      expect(recovered.snoozedUntil).toBeUndefined()
      expect(recovered.archivedAt).toBeUndefined()
      const answered = applyEvent(
        recovered,
        event(3, {
          type: 'request-resolved',
          requestId: approval.requestId,
          status: 'approved',
          nativeRecovery: {
            ...event(3).nativeRecovery!,
            ownerGeneration: 2,
            snapshotToken: 'new-issued-token',
          },
        }),
      )
      expect(answered.pending).toEqual([])
      expect(threadSection(answered, 400)).toBe('active')
      const persisted = copyConversationSourceJson(answered)
      expect(persisted).toMatchObject({ futureThreadField: raw.futureThreadField })
      expect(persisted.messages).toEqual(raw.messages)
      expect(persisted.settled).toBe(false)
      expect(persisted.snoozedUntil).toBeUndefined()
      expect(persisted.archivedAt).toBeUndefined()
    }
  })

  it.each([1, 2])(
    'keeps parked history when a mismatched generation-%i owner restores a permission',
    (ownerGeneration) => {
      const raw = {
        ...applyEvent(thread(), event(1)),
        snoozedAt: 200,
        snoozedUntil: 900,
      }
      const current = applyNativeRecoveryOwner(readThreads([raw])[0], {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'idle',
        ownerGeneration: 2,
        snapshotToken: 'current-token',
        acceptedAppliedRevision: 1,
        pending: [],
      })
      const approval = event(2, {
        type: 'approval',
        requestId: 'mismatched-owner-permission',
        nativeRecovery: {
          ...event(2).nativeRecovery!,
          ownerGeneration,
          snapshotToken: 'mismatched-token',
        },
      })
      const recovered = applyNativeRecoveryOwner(current, {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'idle',
        ownerGeneration,
        snapshotToken: 'mismatched-token',
        acceptedAppliedRevision: 1,
        pending: [approval],
      })
      expect(recovered).toMatchObject({ snoozedAt: 200, snoozedUntil: 900 })
      const answered = applyEvent(
        recovered,
        event(3, {
          type: 'request-resolved',
          requestId: approval.requestId,
          status: 'approved',
          nativeRecovery: {
            ...event(3).nativeRecovery!,
            ownerGeneration,
            snapshotToken: 'mismatched-token',
          },
        }),
      )
      expect(answered.pending).toEqual([])
      expect(threadSection(answered, 400)).toBe('snoozed')
      expect(copyConversationSourceJson(answered)).toMatchObject({
        snoozedAt: 200,
        snoozedUntil: 900,
        messages: JSON.parse(JSON.stringify(raw.messages)),
      })
    },
  )

  it.each(['transport', 'generation', 'token', 'session', 'unknown-owner'] as const)(
    'does not author a permanent wake from a %s mismatch in recovered native permissions',
    (mismatch) => {
      const approval = event(1, {
        type: 'approval',
        requestId: 'pending-native-request',
      })
      const saved = readThreads([
        { ...applyEvent(thread(), approval), snoozedAt: 200, snoozedUntil: 900 },
      ])[0]
      const pending = {
        ...approval,
        ...(mismatch === 'session' ? { sessionId: 'other-thread' } : {}),
        nativeRecovery: {
          ...approval.nativeRecovery!,
          ...(mismatch === 'transport' ? { transportId: 'another-transport' } : {}),
          ...(mismatch === 'generation' ? { ownerGeneration: 0 } : {}),
          ...(mismatch === 'token' ? { snapshotToken: 'another-token' } : {}),
        },
      }
      const recovered = applyNativeRecoveryOwner(saved, {
        sessionId: 'thread',
        transportId: 'transport',
        status: mismatch === 'unknown-owner' ? 'unknown' : 'running',
        ownerGeneration: 1,
        snapshotToken: 'issued-native-token',
        acceptedAppliedRevision: 1,
        pending: [pending],
      })
      expect(recovered).toMatchObject({ snoozedAt: 200, snoozedUntil: 900 })
      expect(recovered.messages).toEqual(saved.messages)
      expect(copyConversationSourceJson(recovered)).toMatchObject({
        snoozedAt: 200,
        snoozedUntil: 900,
      })
    },
  )

  it('restores an uncached surviving child on its original UI turn without advancing history', () => {
    const original = thread({ turn: 31, busy: true, turnStatus: 'running' })
    const child = event(9, {
      type: 'subagent',
      agentId: 'old-child',
      itemId: 'old-child-item',
      text: 'child still running',
      status: 'running',
      nativeRecovery: {
        ...event(9).nativeRecovery!,
        localTurn: 30,
        deliveryToken: 'ephemeral-child',
        ownerStatus: 'running',
      },
    })
    const restored = applyNativeRecoveryOwner(original, {
      sessionId: original.id,
      transportId: 'transport',
      status: 'running',
      ownerGeneration: 2,
      snapshotToken: 'new-owner',
      currentChildren: [child],
      acceptedAppliedRevision: 0,
    })
    expect(restored).toMatchObject({
      turn: 31,
      busy: true,
      turnStatus: 'running',
      nativeRecovery: { transport: { appliedRevision: 0 } },
      agentTurns: { 'old-child': 30 },
    })
    expect(restored.messages.find((message) => message.agentId === 'old-child')).toMatchObject({
      turn: 30,
    })
    expect(JSON.stringify(restored)).not.toContain('ephemeral-child')
    expect(JSON.stringify(restored)).not.toContain('ownerStatus')
  })

  it('repairs an accepted main prompt when its history checkpoint never reached disk', () => {
    const original = thread()
    const userMessage = original.messages[0]
    const owner = {
      sessionId: original.id,
      transportId: 'transport',
      status: 'running' as const,
      localTurn: 31,
      remoteId: 'native-session',
      originalInput: {
        sessionId: original.id,
        provider: 'codex' as const,
        localTurn: 31,
        prompt: userMessage.text,
        workspace: original.workspace,
        mode: 'plan' as const,
        clientRecovery: {
          kind: 'main',
          userMessage,
          threadSeed: { ...original, messages: [], pending: [], busy: false },
        },
      },
    }
    const first = restoreNativeMainOwner([], owner)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      busy: true,
      turn: 31,
      remoteId: 'native-session',
      messages: [userMessage],
    })
    expect(restoreNativeMainOwner(first, owner)[0].messages).toEqual([userMessage])
    const archive = thread({ messages: [], profileId: 'different-machine' })
    expect(restoreNativeMainOwner([archive], owner)).toEqual([archive])
  })
})

describe('Studio native history acknowledgments', () => {
  it('recreates the native-owned Studio session/user turn from its first-start seed', () => {
    const request = '  Exact Studio request.\r\n\ud800'
    const owner = {
      sessionId: 'thread',
      transportId: 'transport',
      ownerGeneration: 1,
      status: 'running' as const,
      snapshotToken: 'token',
      clientRecovery: {
        format: 'life-studio-planner-recovery',
        formatVersion: 1,
        sessionId: 'thread',
        profileId: 'machine',
        provider: 'codex',
        request,
        input: {
          sessionId: 'thread',
          provider: 'codex',
          prompt: request,
          localTurn: 1,
          mode: 'plan',
          scope: 'life-customization',
        },
        userMessage: {
          id: 'exact-original-user-id',
          role: 'user',
          text: request,
          turn: 1,
          createdAt: 12,
        },
        sessionSeed: {
          id: 'thread',
          createdAt: 10,
          updatedAt: 12,
          thread: {
            id: 'thread',
            profileId: 'machine',
            provider: 'codex',
            title: 'New customization',
            model: '',
            mode: 'plan',
            purpose: 'customization',
            updatedAt: 12,
            turn: 1,
            messages: [],
            pending: [],
            busy: false,
          },
        },
        nativeIteration: 1,
        reads: 0,
        repairs: 0,
        parts: [],
        finishing: false,
        autoApply: true,
        phase: 'planning',
      },
    }
    const first = restoreNativeStudioSession([], owner)
    expect(first).toHaveLength(1)
    expect(first[0].thread).toMatchObject({
      busy: true,
      turn: 1,
      messages: [
        {
          id: 'exact-original-user-id',
          text: request,
          createdAt: 12,
        },
      ],
    })
    expect(restoreNativeStudioSession(first, owner)[0].thread.messages).toHaveLength(1)
  })

  it('persists proven native completion even when it equals the inert baseline, preserving opaque pending', () => {
    const pending = [null, { futureNativePermission: ['retain'] }]
    const raw = {
      id: 'thread',
      thread: thread({
        busy: true,
        turnStatus: 'running',
        pending: pending as unknown as AgentEvent[],
      }),
      stage: 'planning',
      createdAt: 1,
      updatedAt: 1,
    }
    const history = new StudioHistoryStore([raw])
    const restored = history.sessions[0]
    const running = reconcileStudioSessionLifecycle({
      ...restored,
      thread: applyNativeRecoveryOwner(restored.thread, {
        sessionId: 'thread',
        transportId: 'transport',
        status: 'running',
      }),
    })
    const completed = reconcileStudioSessionLifecycle({
      ...running,
      stage: 'complete' as const,
      thread: applyEvent(
        running.thread,
        event(1, { type: 'complete', status: 'completed', text: undefined }),
      ),
    })
    const written = history.write([completed], { setItem: () => {} })[0].row
    expect(written).toMatchObject({
      stage: 'complete',
      thread: { busy: false, turnStatus: 'completed', pending },
    })
    const passive = new StudioHistoryStore([raw])
    expect(JSON.parse(passive.encode(passive.sessions))).toEqual([raw])
  })
  it('returns the exact committed source occurrence among duplicate IDs and opaque rows', () => {
    const first = {
      id: 'thread',
      thread: thread({ busy: false }),
      stage: 'complete',
      createdAt: 1,
      updatedAt: 1,
      opaque: { retained: 'first' },
    }
    const duplicate = {
      ...first,
      opaque: { retained: 'duplicate' },
      thread: {
        ...first.thread,
        nativeRecovery: { transport: { appliedRevision: 999, snapshotToken: 'archival-forgery' } },
      },
    }
    const history = new StudioHistoryStore([first, null, duplicate, { future: ['archive'] }])
    const admitted = history.sessions[0]
    const updated = { ...admitted, thread: applyEvent(admitted.thread, event(1)) }
    let stored = ''
    const receipts = history.write([updated], {
      setItem: (_key, value) => {
        stored = value
      },
    })
    expect(receipts).toHaveLength(1)
    expect(receipts[0].session).toBe(updated)
    expect(receipts[0].row).toMatchObject({
      id: 'thread',
      opaque: { retained: 'first' },
      thread: {
        nativeRecovery: { transport: { appliedRevision: 1, snapshotToken: 'issued-native-token' } },
      },
    })
    const rows = JSON.parse(stored)
    expect(rows[1]).toBeNull()
    expect(rows[2]).toEqual(duplicate)
    expect(rows[3]).toEqual({ future: ['archive'] })
    expect(normalizeStudioSessions(rows)[0].thread.nativeRecovery?.transport.appliedRevision).toBe(
      1,
    )
  })

  it('produces no checkpoint receipt when a storage write fails', () => {
    const seed = {
      id: 'thread',
      thread: thread({ busy: false }),
      stage: 'complete',
      createdAt: 1,
      updatedAt: 1,
    }
    const history = new StudioHistoryStore([seed])
    const admitted = history.sessions[0]
    const updated = { ...admitted, thread: applyEvent(admitted.thread, event(1)) }
    expect(() =>
      history.write([updated], {
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).toThrow('quota')
    expect(history.projectSession(admitted).thread).toEqual(seed.thread)
    const receipts = history.write([updated], { setItem: () => {} })
    expect(receipts[0].row).toMatchObject({
      thread: {
        nativeRecovery: {
          transport: { appliedRevision: 1 },
        },
      },
    })
  })
})
