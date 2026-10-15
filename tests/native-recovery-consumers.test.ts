import { describe, expect, it } from 'vitest'
import {
  hasNativeRecoveryConsumerIdentity,
  mainNativeRecoveryRequest,
} from '../src/renderer/native-recovery-consumers'
import { applyEvent, readThreads, type Thread } from '../src/renderer/state'
import { projectConversationSourceHistory } from '../src/renderer/conversation-source'
import { registerNativeProjectionMembershipTransition } from '../src/renderer/native-projection-admissions'
import { createStudioSession } from '../src/renderer/studio-history'

function archive(profileId = '') {
  return {
    id: 'opaque-archive',
    profileId,
    provider: 'codex',
    title: 'Opaque archive',
    model: '',
    mode: 'future-native-mode',
    turn: 0,
    busy: true,
    agentStatus: { future: '  exact\r\n\ud800' },
    pending: [{ type: 'approval', requestId: 'archived-native-permission' }],
    futureArchive: { exact: '  Unicode 🧪\r\n', values: [null, 7, true] },
    messages: [
      { id: 'exact-user', role: 'user', text: '  original\r\n\ud800', turn: 0, createdAt: 123 },
      { id: 'future-event', role: 'future-native-role', text: 'exact opaque event' },
      null,
    ],
  }
}

function owned(): Thread {
  const thread = readThreads([
    {
      ...archive('known-machine'),
      id: 'owned-session',
      workspace: '/srv/exact project',
      remoteId: 'native-session',
    },
  ])[0]
  return applyEvent(thread, {
    sessionId: thread.id,
    type: 'text',
    itemId: 'native-item',
    text: '  exact native response\r\n🧪',
    nativeRecovery: {
      transportId: 'transport',
      revision: 1,
      eventId: 'native-event-1',
      ownerGeneration: 1,
      localTurn: 0,
      snapshotToken: 'issued-snapshot',
      deliveryToken: 'actual-document-delivery',
      emittedAt: 124,
    },
  })
}

describe('native recovery consumer eligibility', () => {
  it('keeps an opaque unassigned archive exact while emitting an empty authoritative Main request', () => {
    const raw = archive()
    const threads = readThreads([raw])
    expect(mainNativeRecoveryRequest(threads)).toEqual({ consumers: [], membershipAdmissions: [] })
    expect(projectConversationSourceHistory(threads)).toEqual([raw])
    expect(threads[0].profileId).toBe('')
  })

  it('registers the owned row in mixed history with its exact scope and private admission', () => {
    const raw = archive()
    const unassigned = readThreads([raw])[0]
    const active = owned()
    const request = mainNativeRecoveryRequest([unassigned, active])
    expect(request.consumers).toEqual([
      {
        kind: 'main',
        sessionId: 'owned-session',
        profileId: 'known-machine',
        workspace: '/srv/exact project',
        remoteId: 'native-session',
        applied: active.nativeRecovery,
        projectionAdmissions: [
          {
            sessionId: 'owned-session',
            transportId: 'transport',
            appliedRevision: 1,
            snapshotToken: 'issued-snapshot',
            ownerGeneration: 1,
            deliveryToken: 'actual-document-delivery',
          },
        ],
      },
    ])
    expect(request.consumers[0].applied).toBe(active.nativeRecovery)
    expect(projectConversationSourceHistory([unassigned])[0]).toEqual(raw)
    expect(JSON.stringify(projectConversationSourceHistory([unassigned, active]))).not.toContain(
      'actual-document-delivery',
    )
  })

  it('keeps private deletion membership when no remaining row is eligible for registration', () => {
    const unassigned = readThreads([archive()])[0]
    const active = owned()
    const remaining = registerNativeProjectionMembershipTransition(
      [unassigned, active],
      [unassigned],
    )
    const request = mainNativeRecoveryRequest(remaining)
    expect(request.consumers).toEqual([])
    expect(request.membershipAdmissions).toEqual([
      {
        sessionId: 'owned-session',
        transportId: 'transport',
        appliedRevision: 1,
        snapshotToken: 'issued-snapshot',
        ownerGeneration: 1,
        deliveryToken: 'actual-document-delivery',
      },
    ])
  })

  it('keeps assigned prebind consumers without requiring a remote ID, workspace, or running status', () => {
    const prebind = readThreads([{ ...archive('known-machine'), id: 'prebind', busy: false }])[0]
    expect(mainNativeRecoveryRequest([prebind]).consumers).toEqual([
      {
        kind: 'main',
        sessionId: 'prebind',
        profileId: 'known-machine',
      },
    ])
  })

  it('skips fresh and archived unassigned Studio rows while keeping an assigned preparation', () => {
    const fresh = createStudioSession('codex', 123, 'fresh-studio')
    const archived = { ...fresh, id: 'archived-studio', thread: readThreads([archive()])[0] }
    const preparing = {
      ...fresh,
      id: 'preparing-studio',
      thread: { ...fresh.thread, profileId: 'known-machine', busy: true },
    }
    expect(
      [fresh, archived, preparing].filter((session) =>
        hasNativeRecoveryConsumerIdentity(session.id, session.thread.profileId),
      ),
    ).toEqual([preparing])
    expect(fresh.thread.profileId).toBe('')
  })

  it('rejects only invalid required identities and preserves nonempty spelling without coercion', () => {
    for (const [sessionId, profileId] of [
      ['', 'machine'],
      ['session', ''],
      [7, 'machine'],
      ['session', null],
    ])
      expect(hasNativeRecoveryConsumerIdentity(sessionId, profileId)).toBe(false)
    expect(hasNativeRecoveryConsumerIdentity('  exact session\t', '  exact profile  ')).toBe(true)
    const emptyId = readThreads([{ ...archive('machine'), id: '' }])[0]
    expect(mainNativeRecoveryRequest([emptyId]).consumers).toEqual([])
    expect(projectConversationSourceHistory([emptyId])[0].id).toBe('')
  })
})
