import { describe, expect, it, vi } from 'vitest'
import type { ConversationProjectionAdmission } from '../src/shared/conversations'
import type { AgentEvent } from '../src/shared/types'
import { bindLegacyThreadWorkspace, readThreads, type Thread } from '../src/renderer/state'
import {
  carryNativeProjectionAdmissions,
  carryNativeProjectionMembership,
  nativeProjectionAdmissions,
  nativeProjectionMembershipAdmissions,
  registerNativeProjectionDelivery,
  registerNativeProjectionMembershipTransition,
} from '../src/renderer/native-projection-admissions'
import { createHistorySnapshotProjector } from '../src/renderer/conversation-checkpoint-client'
import {
  acknowledgeConversationSources,
  refreshConversationSources,
} from '../src/renderer/conversation-source'

function admission(id: string): ConversationProjectionAdmission {
  return {
    sessionId: id,
    transportId: `actual-transport-${id}`,
    appliedRevision: 4,
    snapshotToken: `actual-snapshot-${id}`,
    ownerGeneration: 2,
    deliveryToken: `actual-private-delivery-${id}`,
  }
}

function thread(id: string): Thread {
  const proof = admission(id)
  return {
    id,
    profileId: 'actual-machine',
    provider: 'codex',
    workspace: '/owned/project',
    remoteId: `actual-native-thread-${id}`,
    title: `Thread ${id}`,
    messages: [
      { id: `user-${id}`, role: 'user', text: '  Exact prompt\r\n\t🙂  ', turn: 1 },
      {
        id: `reply-${id}`,
        role: 'assistant',
        text: '  Exact native output\r\n🙂  ',
        turn: 1,
      },
    ],
    busy: false,
    pending: [],
    turn: 1,
    updatedAt: 10,
    model: '',
    mode: 'review',
    nativeRecovery: {
      [proof.transportId]: {
        appliedRevision: proof.appliedRevision,
        snapshotToken: proof.snapshotToken,
        ownerGeneration: proof.ownerGeneration,
      },
    },
  }
}

function live(id: string, value = thread(id)): Thread {
  const proof = admission(id)
  const event: AgentEvent = {
    sessionId: id,
    type: 'text',
    text: '  Exact native output\r\n🙂  ',
    nativeRecovery: {
      transportId: proof.transportId,
      revision: proof.appliedRevision,
      eventId: `actual-event-${id}`,
      snapshotToken: proof.snapshotToken,
      ownerGeneration: proof.ownerGeneration,
      deliveryToken: proof.deliveryToken,
    },
  }
  const result = registerNativeProjectionDelivery(value, event)
  expect(nativeProjectionAdmissions([result])).toEqual([proof])
  return result
}

function remove(before: Thread[], id: string): Thread[] {
  return registerNativeProjectionMembershipTransition(
    before,
    before.filter((row) => row.id !== id),
  )
}

function removedAdmission(history: Thread[], id: string): ConversationProjectionAdmission[] {
  return (nativeProjectionMembershipAdmissions(history) || []).filter(
    (proof) => proof.sessionId === id,
  )
}

function expectDenied(before: Thread[], after: Thread[]): void {
  expect(registerNativeProjectionMembershipTransition(before, after)).toBe(after)
  expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
}

describe('private native membership transitions', () => {
  it('records actual deletion of the final native-owned thread on the exact empty array', () => {
    const before = [live('deleted')]
    const after: Thread[] = []
    expect(registerNativeProjectionMembershipTransition(before, after)).toBe(after)
    expect(after).toEqual([])
    expect(nativeProjectionAdmissions(after)).toBeUndefined()
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(JSON.stringify(after)).toBe('[]')
    expect(Reflect.ownKeys(after)).toEqual(['length'])
  })

  it('preserves deletion authority when only unowned histories remain', () => {
    const kept = thread('unowned-survivor')
    const after = remove([live('deleted'), kept], 'deleted')
    expect(after).toEqual([kept])
    expect(after[0]).toBe(kept)
    expect(nativeProjectionAdmissions(after)).toBeUndefined()
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
  })

  it('retains the exact surviving native row without importing its identity into the deleted row', () => {
    const kept = live('kept')
    const after = remove([live('deleted'), kept], 'deleted')
    expect(after[0]).toBe(kept)
    expect(nativeProjectionAdmissions(after)).toEqual([admission('kept')])
    expect(removedAdmission(after, 'deleted')).toEqual([admission('deleted')])
    expect(removedAdmission(after, 'deleted')[0].deliveryToken).not.toBe(
      admission('kept').deliveryToken,
    )
  })

  it('returns copies of canonical admissions so callers cannot mutate private deletion authority', () => {
    const history = remove([live('deleted')], 'deleted')
    const exposed = nativeProjectionMembershipAdmissions(history)!
    Reflect.set(exposed[0], 'deliveryToken', 'forged caller value')
    Reflect.set(exposed[0], 'appliedRevision', 99)
    Reflect.set(exposed, String(exposed.length), admission('forged-owner'))
    expect(nativeProjectionMembershipAdmissions(history)).toEqual([admission('deleted')])
  })

  it('carries existing tombstones through explicit sequential native thread deletion', () => {
    const first = remove([live('first'), live('second')], 'first')
    const second = remove(first, 'second')
    expect(second).toEqual([])
    expect(nativeProjectionMembershipAdmissions(second)).toEqual([
      admission('first'),
      admission('second'),
    ])
  })

  it('carries an existing tombstone while subsequently deleting an unowned survivor', () => {
    const first = remove([live('deleted'), thread('unowned-survivor')], 'deleted')
    const second = remove(first, 'unowned-survivor')
    expect(second).toEqual([])
    expect(nativeProjectionMembershipAdmissions(second)).toEqual([admission('deleted')])
  })

  it('records all privately admitted owners removed in a single ordered subset deletion', () => {
    const kept = thread('unowned-survivor')
    const before = [live('first-deleted'), kept, live('second-deleted')]
    const after = registerNativeProjectionMembershipTransition(before, [kept])
    expect(nativeProjectionMembershipAdmissions(after)).toHaveLength(2)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual(
      expect.arrayContaining([admission('first-deleted'), admission('second-deleted')]),
    )
  })

  it('records each actual transport proof of a removed native owner', () => {
    const current = live('deleted')
    const second = {
      ...admission('deleted'),
      transportId: 'second-actual-transport',
      appliedRevision: 6,
      snapshotToken: 'second-actual-snapshot',
      ownerGeneration: 3,
      deliveryToken: 'second-actual-private-delivery',
    }
    const next = {
      ...current,
      nativeRecovery: {
        ...current.nativeRecovery,
        [second.transportId]: {
          appliedRevision: second.appliedRevision,
          snapshotToken: second.snapshotToken,
          ownerGeneration: second.ownerGeneration,
        },
      },
    }
    registerNativeProjectionDelivery(next, {
      sessionId: next.id,
      type: 'text',
      text: '  Exact native output\r\n🙂  ',
      nativeRecovery: {
        transportId: second.transportId,
        revision: second.appliedRevision,
        eventId: 'second-actual-event',
        snapshotToken: second.snapshotToken,
        ownerGeneration: second.ownerGeneration,
        deliveryToken: second.deliveryToken,
      },
    })
    expect(nativeProjectionAdmissions([next])).toHaveLength(2)
    const deleted = remove([next], next.id)
    expect(nativeProjectionMembershipAdmissions(deleted)).toHaveLength(2)
    expect(nativeProjectionMembershipAdmissions(deleted)).toEqual(
      expect.arrayContaining([admission('deleted'), second]),
    )
  })

  it('does not recover a previous tombstone from an arbitrary copied array during another deletion', () => {
    const first = remove([live('deleted'), thread('unowned-survivor')], 'deleted')
    const copied = [...first]
    expect(nativeProjectionMembershipAdmissions(copied)).toBeUndefined()
    expectDenied(copied, [])
  })

  it('admits only the newly deleted native owner when the preceding array provenance was copied', () => {
    const first = remove([live('first'), live('second')], 'first')
    const copied = [...first]
    const second = remove(copied, 'second')
    expect(nativeProjectionMembershipAdmissions(second)).toEqual([admission('second')])
  })

  it('does not mint authority from an arbitrary empty history', () => {
    expect(nativeProjectionMembershipAdmissions([])).toBeUndefined()
    expectDenied([], [])
  })

  it('does not mint authority from an unowned removed row whose visible cursor matches native data', () => {
    expectDenied([thread('unowned')], [])
  })

  it('does not mint authority from a JSON copy of an admitted row', () => {
    const copied = JSON.parse(JSON.stringify(live('deleted'))) as Thread
    expectDenied([copied], [])
  })

  it('does not mint authority by deleting a freshly re-read exported row', () => {
    const exported = createHistorySnapshotProjector()([live('deleted')])
    expect(nativeProjectionAdmissions(exported)).toEqual([admission('deleted')])
    const imported = readThreads(exported)
    expect(nativeProjectionAdmissions(imported)).toBeUndefined()
    expectDenied(imported, [])
  })

  it('does not copy private tombstones into JSON, exported rows, or a new empty array', () => {
    const history = remove([live('deleted')], 'deleted')
    const copied = JSON.parse(JSON.stringify(history)) as Thread[]
    expect(nativeProjectionMembershipAdmissions(copied)).toBeUndefined()
    expect(nativeProjectionMembershipAdmissions([...history])).toBeUndefined()
    expect(nativeProjectionMembershipAdmissions(history.slice())).toBeUndefined()
    expect(JSON.stringify(history)).not.toContain(admission('deleted').deliveryToken)
  })

  it('does not treat unchanged membership as a native deletion', () => {
    const before = [live('kept')]
    expectDenied(before, [before[0]])
    expectDenied(before, before)
  })

  it('rejects an apparent deletion when the same owner is still present as another object', () => {
    const deleted = live('deleted')
    expectDenied([deleted], [{ ...deleted }])
  })

  it('rejects a replacement survivor even when it borrows an actual native cursor and messages', () => {
    const kept = live('kept')
    expectDenied([live('deleted'), kept], [{ ...kept }])
  })

  it('rejects replacing an unowned survivor with a JSON-equal object during deletion', () => {
    const kept = thread('unowned-survivor')
    expectDenied([live('deleted'), kept], [JSON.parse(JSON.stringify(kept)) as Thread])
  })

  it('rejects survivor reorder during the deletion transition', () => {
    const first = live('first-kept')
    const second = live('second-kept')
    expectDenied([first, live('deleted'), second], [second, first])
  })

  it('rejects inserting a new thread while deleting an admitted native row', () => {
    const kept = live('kept')
    expectDenied([live('deleted'), kept], [kept, thread('inserted')])
  })

  it.each(['before', 'after'] as const)('rejects duplicate thread IDs in the %s array', (side) => {
    const deleted = live('deleted')
    const kept = thread('kept')
    const before = side === 'before' ? [deleted, { ...deleted }, kept] : [deleted, kept]
    const after = side === 'after' ? [kept, { ...kept }] : [kept]
    expectDenied(before, after)
  })

  it.each(['before', 'after'] as const)(
    'rejects an unsafe thread ID accessor in the %s array without invoking it',
    (side) => {
      const deleted = live('deleted')
      const kept = thread('unsafe-survivor')
      const getter = vi.fn(() => {
        throw new Error('An unsafe membership ID getter was invoked')
      })
      Object.defineProperty(kept, 'id', { enumerable: true, get: getter })
      const before = side === 'before' ? [deleted, kept] : [deleted]
      const after = side === 'after' ? [kept] : []
      expectDenied(before, after)
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it.each(['before', 'after'] as const)(
    'rejects an unsafe array entry accessor in the %s array without invoking it',
    (side) => {
      const deleted = live('deleted')
      const kept = thread('kept')
      const before = [deleted, kept]
      const after = [kept]
      const getter = vi.fn(() => {
        throw new Error('An unsafe membership array getter was invoked')
      })
      Object.defineProperty(side === 'before' ? before : after, '0', {
        enumerable: true,
        get: getter,
      })
      expectDenied(before, after)
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it('revokes a membership proof after the registered survivor array is mutated', () => {
    const kept = thread('kept')
    const history = remove([live('deleted'), kept], 'deleted')
    expect(nativeProjectionMembershipAdmissions(history)).toEqual([admission('deleted')])
    history.push(thread('inserted'))
    expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
  })

  it('revokes a membership proof after a deleted thread ID is reintroduced', () => {
    const history = remove([live('deleted')], 'deleted')
    history.push(thread('deleted'))
    expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
  })

  it.each([
    ['profile', { profileId: 'foreign-machine' }],
    ['workspace', { workspace: '/foreign/project' }],
    ['native identity', { remoteId: 'foreign-native-thread' }],
    ['covered messages', { messages: [] }],
  ] as const)(
    'revokes a membership proof after a surviving native row changes %s',
    (_name, fields) => {
      const kept = live('kept')
      const history = remove([live('deleted'), kept], 'deleted')
      expect(removedAdmission(history, 'deleted')).toEqual([admission('deleted')])
      Object.assign(kept, fields)
      expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
    },
  )

  it('revokes membership authority after covered native output is rewritten in place', () => {
    const kept = live('kept')
    const history = remove([live('deleted'), kept], 'deleted')
    expect(removedAdmission(history, 'deleted')).toEqual([admission('deleted')])
    kept.messages[1].text = 'rewritten native output'
    expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
  })

  it('revokes membership authority after a surviving message collection is cleared in place', () => {
    const kept = live('kept')
    const history = remove([live('deleted'), kept], 'deleted')
    expect(removedAdmission(history, 'deleted')).toEqual([admission('deleted')])
    kept.messages.length = 0
    expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
  })

  it('revokes membership authority when an unowned survivor body is rewritten', () => {
    const kept = thread('unowned-survivor')
    const history = remove([live('deleted'), kept], 'deleted')
    expect(nativeProjectionMembershipAdmissions(history)).toEqual([admission('deleted')])
    kept.messages[1].text = 'rewritten unowned archive'
    expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
  })

  it.each([
    ['revision', { appliedRevision: 5 }],
    ['snapshot token', { snapshotToken: 'changed-snapshot' }],
    ['generation', { ownerGeneration: 3 }],
  ] as const)(
    'revokes membership authority after a surviving native cursor changes %s',
    (_name, fields) => {
      const kept = live('kept')
      const history = remove([live('deleted'), kept], 'deleted')
      expect(removedAdmission(history, 'deleted')).toEqual([admission('deleted')])
      Object.assign(kept.nativeRecovery![admission('kept').transportId], fields)
      expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
    },
  )

  it.each(['workspace', 'messages', 'text'] as const)(
    'rejects a %s accessor introduced on a survivor after registration without invoking it',
    (key) => {
      const kept = live('kept')
      const history = remove([live('deleted'), kept], 'deleted')
      expect(removedAdmission(history, 'deleted')).toEqual([admission('deleted')])
      const getter = vi.fn(() => {
        throw new Error('An unsafe survivor getter was invoked')
      })
      Object.defineProperty(key === 'text' ? kept.messages[1] : kept, key, {
        enumerable: true,
        get: getter,
      })
      expect(nativeProjectionMembershipAdmissions(history)).toBeUndefined()
      expect(getter).not.toHaveBeenCalled()
    },
  )

  it('carries the deletion proof through the actual empty history snapshot projector and source refresh', () => {
    const deleted = remove([live('deleted')], 'deleted')
    const snapshot = createHistorySnapshotProjector()(deleted)
    expect(snapshot).not.toBe(deleted)
    expect(snapshot).toEqual([])
    expect(nativeProjectionMembershipAdmissions(snapshot)).toEqual([admission('deleted')])
    acknowledgeConversationSources(snapshot, 20)
    const refreshed = carryNativeProjectionAdmissions(
      snapshot,
      refreshConversationSources(snapshot),
    )
    expect(nativeProjectionMembershipAdmissions(refreshed)).toEqual([admission('deleted')])
    expect(nativeProjectionMembershipAdmissions([...refreshed])).toBeUndefined()
    expect(JSON.stringify(refreshed)).toBe('[]')
  })

  it('carries deletion proof while source projection and ACK refresh preserve unowned opaque survivors', () => {
    const raw = {
      ...thread('opaque-kept'),
      futureField: { exact: '  unknown archive\r\n🙂  ' },
      messages: [
        ...thread('opaque-kept').messages,
        { id: 'future-row', role: 'future-role', payload: { exact: '\tkeep\r\n' } },
        null,
      ],
    }
    const kept = readThreads([raw])[0]
    const deleted = remove([live('deleted'), kept], 'deleted')
    const snapshot = createHistorySnapshotProjector()(deleted)
    expect(snapshot).toEqual([raw])
    expect(nativeProjectionMembershipAdmissions(snapshot)).toEqual([admission('deleted')])
    acknowledgeConversationSources(snapshot, 20)
    const refreshed = carryNativeProjectionAdmissions(
      snapshot,
      refreshConversationSources(snapshot),
    )
    expect(refreshed).toEqual([raw])
    expect(nativeProjectionMembershipAdmissions(refreshed)).toEqual([admission('deleted')])
    expect(JSON.stringify(refreshed)).not.toContain(admission('deleted').deliveryToken)
  })

  it('retains both live survivor admission and tombstone authority through actual source ACK refresh', () => {
    const raw = { ...thread('kept'), futureField: { exact: '  retained archive\r\n🙂  ' } }
    const kept = live('kept', readThreads([raw])[0])
    const deleted = remove([live('deleted'), kept], 'deleted')
    const snapshot = createHistorySnapshotProjector()(deleted)
    expect(snapshot).toEqual([raw])
    expect(nativeProjectionAdmissions(snapshot)).toEqual([admission('kept')])
    expect(nativeProjectionMembershipAdmissions(snapshot)).toEqual([admission('deleted')])
    acknowledgeConversationSources(snapshot, 20)
    const refreshed = carryNativeProjectionAdmissions(
      snapshot,
      refreshConversationSources(snapshot),
    )
    expect(refreshed).toEqual([raw])
    expect(nativeProjectionAdmissions(refreshed)).toEqual([admission('kept')])
    expect(nativeProjectionMembershipAdmissions(refreshed)).toEqual([admission('deleted')])
    expect(JSON.stringify(refreshed)).not.toContain(admission('kept').deliveryToken)
    expect(JSON.stringify(refreshed)).not.toContain(admission('deleted').deliveryToken)
  })

  it('permits the genuine source projector to restore archival ordering after an ordered UI deletion', () => {
    const first = { ...thread('first-archive'), updatedAt: 10, futureField: { exact: ' first ' } }
    const second = {
      ...thread('second-archive'),
      updatedAt: 20,
      futureField: { exact: ' second ' },
    }
    const survivors = readThreads([first, second])
    expect(survivors.map((row) => row.id)).toEqual(['second-archive', 'first-archive'])
    const deleted = remove([live('deleted'), ...survivors], 'deleted')
    expect(deleted.map((row) => row.id)).toEqual(['second-archive', 'first-archive'])
    const snapshot = createHistorySnapshotProjector()(deleted)
    expect(snapshot).toEqual([first, second])
    expect(nativeProjectionMembershipAdmissions(snapshot)).toEqual([admission('deleted')])
    acknowledgeConversationSources(snapshot, 20)
    const refreshed = carryNativeProjectionAdmissions(
      snapshot,
      refreshConversationSources(snapshot),
    )
    expect(refreshed).toEqual([first, second])
    expect(nativeProjectionMembershipAdmissions(refreshed)).toEqual([admission('deleted')])
  })
})

describe('authored native membership carry', () => {
  it('preserves an independently registered first delete when the previous array has no tombstone', () => {
    const before = [live('deleted')]
    const after = remove(before, 'deleted')
    expect(carryNativeProjectionMembership(before, after)).toBe(after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
  })

  it('preserves the newer combined proof of an independently registered later deletion', () => {
    const before = remove([live('first'), live('second')], 'first')
    const after = remove(before, 'second')
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([
      admission('first'),
      admission('second'),
    ])
  })

  it('carries an actual empty-array tombstone into the next authored empty array', () => {
    const before = remove([live('deleted')], 'deleted')
    const after: Thread[] = []
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(nativeProjectionMembershipAdmissions([])).toBeUndefined()
  })

  it('retains deletion authority when the authored update adds a new unowned row', () => {
    const before = remove([live('deleted')], 'deleted')
    const added = thread('new-unowned-row')
    const after = [added]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(nativeProjectionAdmissions(after)).toBeUndefined()
    expect(after[0]).toBe(added)
  })

  it('allows authored sorting of the same actual surviving rows', () => {
    const first = thread('first-kept')
    const second = thread('second-kept')
    const before = remove([live('deleted'), first, second], 'deleted')
    const after = [second, first]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(after[0]).toBe(second)
    expect(after[1]).toBe(first)
  })

  it('retains a lifecycle-only immutable clone without changing normalized row admission bindings', () => {
    const kept = live('kept')
    const before = remove([live('deleted'), kept], 'deleted')
    const cloned = {
      ...kept,
      busy: false,
      messages: kept.messages.map((message) => ({
        ...message,
        finishedAt: 30,
        finishStatus: 'completed',
      })),
    }
    const after = [cloned]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(nativeProjectionAdmissions(before)).toEqual([admission('kept')])
    expect(nativeProjectionAdmissions(after)).toBeUndefined()
  })

  it('retains an immutable owner-control snapshot while its historical cursor and body are intact', () => {
    const kept = live('kept')
    const before = remove([live('deleted'), kept], 'deleted')
    const after = [
      {
        ...kept,
        nativeRecovery: { ...kept.nativeRecovery },
        nativeRecoveryOwner: {
          transportId: admission('kept').transportId,
          ownerGeneration: 3,
          snapshotToken: 'current-controls-only',
        },
        nativeRecoveryStatus: 'idle' as const,
      },
    ]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(nativeProjectionAdmissions(before)).toEqual([admission('kept')])
    expect(nativeProjectionAdmissions(after)).toEqual([admission('kept')])
  })

  it('retains actual source-owned legacy workspace binding while the survivor remains unowned', () => {
    const { workspace: _workspace, nativeRecovery: _recovery, ...raw } = thread('legacy-kept')
    const kept = readThreads([raw])[0]
    const before = remove([live('deleted'), kept], 'deleted')
    const bound = bindLegacyThreadWorkspace(kept, {
      status: 'connected',
      lastWorkspace: '/legacy/project',
      profile: {
        id: kept.profileId,
        name: 'Actual machine',
        host: 'fixture.invalid',
        port: 22,
        username: 'fixture',
        auth: 'agent',
        privateKeyPath: '',
        workspace: '/legacy/project',
      },
    })
    expect(bound).not.toBe(kept)
    expect(bound.workspace).toBe('/legacy/project')
    const after = [bound]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toEqual([admission('deleted')])
    expect(nativeProjectionAdmissions(after)).toBeUndefined()
  })

  it.each([null, '', 'relative/project'] as const)(
    'rejects inventing workspace over the normalized persisted raw value %s',
    (workspace) => {
      const kept = readThreads([{ ...thread('malformed-legacy'), workspace }])[0]
      expect(kept.workspace).toBeUndefined()
      const before = remove([live('deleted'), kept], 'deleted')
      const after = [{ ...kept, workspace: '/invented/project' }]
      carryNativeProjectionMembership(before, after)
      expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
    },
  )

  it('revokes deletion authority when a tombstoned session ID is restored', () => {
    const before = remove([live('deleted')], 'deleted')
    const after = [thread('deleted')]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
  })

  it('does not mint deletion authority from an imported plain array', () => {
    const before = [thread('unowned')]
    const after = [...before]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
  })

  it('does not inherit a tombstone from a shape-equal copied previous array', () => {
    const actual = remove([live('deleted'), thread('unowned')], 'deleted')
    const before = [...actual]
    const after = [...before]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
  })

  it('does not preserve deletion authority through a JSON replacement of a surviving row', () => {
    const before = remove([live('deleted'), thread('unowned')], 'deleted')
    const after = JSON.parse(JSON.stringify(before)) as Thread[]
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
  })

  it('does not admit an ordinary whole-array clear instead of an explicit native deletion', () => {
    const before = remove([live('deleted'), thread('kept')], 'deleted')
    const after: Thread[] = []
    carryNativeProjectionMembership(before, after)
    expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
  })

  it.each([
    ['clear', (kept: Thread) => ({ ...kept, messages: [] })],
    [
      'text',
      (kept: Thread) => ({
        ...kept,
        messages: kept.messages.map((message) => ({ ...message, text: 'rewritten' })),
      }),
    ],
    [
      'attachment',
      (kept: Thread) => ({
        ...kept,
        messages: kept.messages.map((message) => ({ ...message, attachments: [] })),
      }),
    ],
    [
      'native cursor',
      (kept: Thread) => ({
        ...kept,
        nativeRecovery: {
          [admission('kept').transportId]: {
            ...kept.nativeRecovery![admission('kept').transportId],
          },
        },
      }),
    ],
    ['scope', (kept: Thread) => ({ ...kept, workspace: '/foreign/project' })],
  ] as const)(
    'revokes membership authority after a covered survivor changes %s',
    (_name, change) => {
      const kept = live('kept')
      const before = remove([live('deleted'), kept], 'deleted')
      const after = [change(kept)]
      carryNativeProjectionMembership(before, after)
      expect(nativeProjectionMembershipAdmissions(after)).toBeUndefined()
      expect(nativeProjectionAdmissions(before)).toEqual([admission('kept')])
    },
  )
})
