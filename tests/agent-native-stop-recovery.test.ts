import { describe, expect, it } from 'vitest'
import {
  planNativeStopRecovery,
  type NativeStopRecoveryApproval,
  type NativeStopRecoveryChild,
  type NativeStopRecoveryInput,
} from '../src/main/agent-native-stop-recovery'
import type {
  NativeRecoveryOwner,
  NativeRecoverySnapshot,
  NativeRecoveryStoredInput,
  NativeRecoveryTransport,
} from '../src/main/native-recovery-types'

function owner(overrides: Partial<NativeRecoveryOwner> = {}): NativeRecoveryOwner {
  return {
    ownerId: 'private-root',
    sessionId: 'life-session',
    generation: 4,
    snapshotToken: 'private-token',
    kind: 'root',
    workspace: '/project',
    writableRoot: '/project/worktree',
    nativeThreadId: 'native-thread',
    nativeTurnId: 'native-turn',
    state: 'active',
    phase: 'running',
    stopRequested: true,
    input: { sessionId: 'life-session', provider: 'codex', prompt: ' Exact\r\n🌍\ud800 ' },
    ...overrides,
  }
}

function delivery(overrides: Partial<NativeRecoveryStoredInput> = {}): NativeRecoveryStoredInput {
  const sequence = overrides.sequence ?? 3
  const frame = {
    type: 'write' as const,
    sequence,
    data: Buffer.from(
      '{"id":17,"method":"turn/interrupt","params":{"threadId":"native-thread","turnId":"native-turn"}}\n',
    ).toString('base64'),
  }
  return {
    sequence,
    frame,
    wire: JSON.stringify(frame) + '\n',
    semantic: {
      kind: 'interrupt',
      sessionId: 'life-session',
      ownerGeneration: 4,
      method: 'turn/interrupt',
      requestId: 17,
      nativeThreadId: 'native-thread',
      nativeTurnId: 'native-turn',
    },
    acknowledged: false,
    written: overrides.written === true,
    consumed: overrides.written === true,
    ...(overrides.written === true
      ? { deliveryReceipt: { cursor: sequence + 1, status: 'written' as const } }
      : {}),
    ...overrides,
  }
}

function snapshot(overrides: Partial<NativeRecoverySnapshot> = {}): NativeRecoverySnapshot {
  return {
    transport: {
      id: 'private-transport',
      brokerId: 'original-broker',
      brokerRoot: '/registered/home/.life/agent-sessions/original-broker',
      launchCommand: 'exec codex app-server',
      provider: 'codex',
      providerVersion: '0.162.1',
      nativeProtocol: 'codex-app-server-stdio',
      brokerProtocolVersion: 2,
      inputReceipts: 1,
      machine: { profileId: 'profile', host: 'host', username: 'user', port: 22 },
      controller: { id: 'controller', epoch: 5 },
      initialization: { status: 'complete' },
      owners: [owner()],
    },
    allocatedInputSequence: 0,
    acknowledgedInputSequence: 0,
    outputCursor: 0,
    eventRevision: 0,
    inputs: [],
    outputs: [],
    events: [],
    historyAcks: [],
    historyPrepares: [],
    records: [],
    ...overrides,
  }
}

function withTransport(
  snapshot: NativeRecoverySnapshot,
  patch: Partial<NativeRecoveryTransport>,
): NativeRecoverySnapshot {
  return { ...snapshot, transport: { ...snapshot.transport, ...patch } }
}

function input(overrides: Partial<NativeStopRecoveryInput> = {}): NativeStopRecoveryInput {
  return {
    snapshot: snapshot(),
    owner: owner(),
    root: {
      state: 'active',
      nativeThreadId: 'native-thread',
      nativeTurnId: 'native-turn',
      ownershipProven: true,
    },
    children: [],
    approvals: [],
    graphComplete: true,
    ...overrides,
  }
}

function approval(overrides: Partial<NativeStopRecoveryApproval> = {}): NativeStopRecoveryApproval {
  return {
    requestId: 'local-permission',
    nativeRequestId: 'native-request',
    requestType: 'item/commandExecution/requestApproval',
    owner: owner(),
    nativeThreadId: 'native-thread',
    canDeny: true,
    ...overrides,
  }
}

function response(overrides: Partial<NativeRecoveryStoredInput> = {}): NativeRecoveryStoredInput {
  return delivery({
    semantic: {
      kind: 'permission-response',
      sessionId: 'life-session',
      ownerGeneration: 4,
      permissionRequestId: 'native-request',
      requestType: 'item/commandExecution/requestApproval',
      nativeThreadId: 'native-thread',
      responseBinding: { requestId: 'local-permission', status: 'approved' },
    },
    ...overrides,
  })
}

describe('native Stop recovery plan', () => {
  it('allocates a missing interrupt only for a private persisted Stop intent', () => {
    const actual = planNativeStopRecovery(input())
    expect(actual.status).toBe('continuing')
    expect(actual.actions).toEqual([
      {
        type: 'interrupt-codex',
        nativeThreadId: 'native-thread',
        nativeTurnId: 'native-turn',
        stopKey: expect.any(String),
      },
    ])
    const withoutIntent = withTransport(snapshot(), { owners: [owner({ stopRequested: false })] })
    expect(planNativeStopRecovery(input({ snapshot: withoutIntent })).actions).toEqual([])
    expect(planNativeStopRecovery(input({ snapshot: withoutIntent })).status).toBe('unrequested')
  })

  it('refuses archived intent, another generation, and changed workspace ownership', () => {
    for (const foreign of [
      owner({ generation: 5 }),
      owner({ snapshotToken: 'forged-token' }),
      owner({ workspace: '/another-project' }),
      owner({ writableRoot: '/another-root' }),
      owner({ nativeThreadId: 'foreign-thread' }),
    ]) {
      const actual = planNativeStopRecovery(input({ owner: foreign }))
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('retries the exact original allocated interrupt without generating a new request', () => {
    const original = delivery()
    const source = input({ snapshot: snapshot({ inputs: [original] }) })
    const before = JSON.stringify(source)
    const actual = planNativeStopRecovery(source)
    expect(actual.actions).toEqual([{ type: 'retry-input', input: original }])
    expect(actual.actions[0].type === 'retry-input' && actual.actions[0].input).toBe(original)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('does not treat broker input acceptance as native interruption acknowledgment', () => {
    const actual = planNativeStopRecovery(
      input({ snapshot: snapshot({ inputs: [delivery({ acknowledged: true, written: true })] }) }),
    )
    expect(actual.status).toBe('waiting')
    expect(actual.actions).toEqual([])
  })

  it('acceptance without a native write receipt cannot resolve or replace a permission answer', () => {
    const original = response({ acknowledged: true, written: false, consumed: true })
    const actual = planNativeStopRecovery(
      input({ approvals: [approval()], snapshot: snapshot({ inputs: [original] }) }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
    expect(actual.resolvedApprovalIds).toEqual([])
    expect(actual.reservedApprovalIds).toEqual(['local-permission'])
  })

  it('an accepted unwritten user prompt cannot finish an apparently idle Stop', () => {
    const original = delivery({
      acknowledged: true,
      written: false,
      semantic: {
        kind: 'user-prompt',
        sessionId: 'life-session',
        ownerGeneration: 4,
        method: 'turn/start',
        requestId: 20,
      },
    })
    const actual = planNativeStopRecovery(
      input({
        root: { ...input().root, state: 'idle' },
        snapshot: snapshot({ inputs: [original] }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('accepted native settings or steering cannot be followed by new Stop frames before delivery', () => {
    for (const kind of ['settings', 'steer'] as const) {
      const original = delivery({
        acknowledged: true,
        written: false,
        semantic: {
          kind,
          sessionId: 'life-session',
          ownerGeneration: 4,
          requestId: 20,
        },
      })
      const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) }))
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('uses exact private SDK processing proof without altering receipts or resolving permission responses', () => {
    for (const kind of ['user-prompt', 'settings', 'steer', 'interrupt'] as const) {
      const original = delivery({
        acknowledged: true,
        semantic: { ...delivery().semantic, kind },
      })
      const saved = snapshot({ inputs: [original] })
      expect(planNativeStopRecovery(input({ snapshot: saved })).status).toBe('unknown')
      const actual = planNativeStopRecovery(
        input({ snapshot: saved, processedInputSequences: [original.sequence] }),
      )
      expect(actual.status).toBe(kind === 'interrupt' ? 'waiting' : 'continuing')
      expect(actual.actions.map((action) => action.type)).toEqual(
        kind === 'interrupt' ? [] : ['interrupt-codex'],
      )
      expect(saved.inputs[0]).toBe(original)
      expect(original).toMatchObject({ acknowledged: true, written: false, consumed: false })
      expect(original.deliveryReceipt).toBeUndefined()
      for (const uncertain of [
        { ...original, cancellation: 'cancelled before proof' },
        { ...original, deliveryReceipt: { cursor: 7, status: 'uncertain' as const } },
        { ...original, deliveryReceipt: { cursor: 7, status: 'cancelled' as const } },
      ]) {
        const fenced = planNativeStopRecovery(
          input({ snapshot: snapshot({ inputs: [uncertain] }), processedInputSequences: [3] }),
        )
        expect(fenced.status).toBe('unknown')
        expect(fenced.actions).toEqual([])
      }
      const closed = planNativeStopRecovery(
        input({
          snapshot: snapshot({ inputs: [original], closeInputSequence: 4 }),
          processedInputSequences: [3],
        }),
      )
      expect(closed.status).toBe('unknown')
      expect(closed.actions).toEqual([])
    }
    const permission = response({ acknowledged: true })
    const permissionPlan = planNativeStopRecovery(
      input({
        snapshot: snapshot({ inputs: [permission] }),
        approvals: [approval()],
        processedInputSequences: [permission.sequence],
      }),
    )
    expect(permissionPlan.status).toBe('unknown')
    expect(permissionPlan.actions).toEqual([])
    expect(permissionPlan.resolvedApprovalIds).toEqual([])
  })

  it('an uncertain or cancelled original write cannot be retried from an acceptance number', () => {
    for (const status of ['uncertain', 'cancelled'] as const) {
      const original = delivery({ deliveryReceipt: { cursor: 7, status }, written: false })
      const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) }))
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('a completed native write with a lost acceptance ACK waits for the native interrupt response', () => {
    const original = delivery({
      acknowledged: false,
      written: true,
      deliveryReceipt: { cursor: 7, status: 'written' },
    })
    const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) }))
    expect(actual.status).toBe('waiting')
    expect(actual.actions).toEqual([])
  })

  it('a later exact write receipt releases a pending settings Stop without declaring native completion', () => {
    const original = delivery({
      acknowledged: true,
      semantic: {
        kind: 'settings',
        sessionId: 'life-session',
        ownerGeneration: 4,
        requestId: 20,
      },
    })
    expect(
      planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) })).status,
    ).toBe('unknown')
    const written = delivery({
      ...original,
      written: true,
      consumed: true,
      deliveryReceipt: { cursor: 8, status: 'written' },
    })
    const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [written] }) }))
    expect(actual.status).toBe('continuing')
    expect(actual.actions).toEqual([
      {
        type: 'interrupt-codex',
        nativeThreadId: 'native-thread',
        nativeTurnId: 'native-turn',
        stopKey: expect.any(String),
      },
    ])
  })

  it('waits after native interrupt success until terminal activity is proven', () => {
    const actual = planNativeStopRecovery(
      input({ root: { ...input().root, interruptAcknowledged: true } }),
    )
    expect(actual.status).toBe('waiting')
    expect(actual.actions).toEqual([])
    expect(planNativeStopRecovery(input({ root: { ...input().root, state: 'idle' } })).status).toBe(
      'complete',
    )
  })

  it('never renumbers canceled or terminal-barrier-covered interrupts', () => {
    for (const original of [
      delivery({ cancellation: 'discarded by the original owner' }),
      delivery({ acknowledged: true, written: false }),
    ]) {
      const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) }))
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
    const closed = planNativeStopRecovery(input({ snapshot: snapshot({ closeInputSequence: 7 }) }))
    expect(closed.status).toBe('unknown')
    expect(closed.actions).toEqual([])
  })

  it('uses actual recorded process exit, not close admission, as terminal proof', () => {
    const actual = planNativeStopRecovery(
      input({
        snapshot: snapshot({ closeInputSequence: 7, outputs: [{ type: 'exit', cursor: 8 }] }),
      }),
    )
    expect(actual.status).toBe('complete')
    expect(actual.actions).toEqual([{ type: 'finish-stop' }])
  })

  it('forced broker cleanup cannot finish Stop or retry any native mutation', () => {
    for (const closeInputSequence of [undefined, 7]) {
      const actual = planNativeStopRecovery(
        input({
          snapshot: snapshot({
            closeInputSequence,
            inputs: [delivery()],
            outputs: [
              { type: 'exit', cursor: 8, nativeExitConfirmed: false, code: null, signal: 'TERM' },
            ],
          }),
        }),
      )
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
      expect(actual.reasons).toContain(
        'Broker cleanup did not confirm that the owned native process exited.',
      )
    }
  })

  it('an idle turn and successful interrupt cannot certify forced broker cleanup', () => {
    const actual = planNativeStopRecovery(
      input({
        root: { ...input().root, state: 'idle', interruptAcknowledged: true },
        snapshot: snapshot({ outputs: [{ type: 'exit', cursor: 8, nativeExitConfirmed: false }] }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('a later confirmed native exit can settle Stop after an unconfirmed cleanup and close', () => {
    const before = input({
      snapshot: snapshot({
        closeInputSequence: 7,
        outputs: [{ type: 'exit', cursor: 8, nativeExitConfirmed: false }],
      }),
    })
    expect(planNativeStopRecovery(before).status).toBe('unknown')
    const actual = planNativeStopRecovery({
      ...before,
      snapshot: {
        ...before.snapshot,
        outputs: [
          ...before.snapshot.outputs,
          { type: 'exit', cursor: 9, nativeExitConfirmed: true, code: 0 },
        ],
      },
    })
    expect(actual.status).toBe('complete')
    expect(actual.actions).toEqual([{ type: 'finish-stop' }])
  })

  it('legacy observed exit remains terminal while pipe-written permission answers stay resolved', () => {
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval()],
        snapshot: snapshot({
          inputs: [response({ acknowledged: true, written: true })],
          outputs: [{ type: 'exit', cursor: 8 }],
        }),
      }),
    )
    expect(actual.status).toBe('complete')
    expect(actual.resolvedApprovalIds).toEqual(['local-permission'])
    expect(actual.actions).toEqual([{ type: 'finish-stop' }])
  })

  it('unconfirmed cleanup preserves pipe-written approval resolution without allocating a replacement', () => {
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval()],
        snapshot: snapshot({
          inputs: [response({ acknowledged: true, written: true })],
          outputs: [{ type: 'exit', cursor: 8, nativeExitConfirmed: false }],
        }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.resolvedApprovalIds).toEqual(['local-permission'])
    expect(actual.actions).toEqual([])
  })

  it('unconfirmed cleanup cannot finish unstarted native work as locally canceled', () => {
    const pendingOwner = owner({
      phase: 'initializing',
      state: 'starting',
      nativeThreadId: undefined,
      nativeTurnId: undefined,
    })
    const actual = planNativeStopRecovery(
      input({
        owner: pendingOwner,
        root: { state: 'starting', ownershipProven: true },
        snapshot: {
          ...snapshot(),
          transport: { ...snapshot().transport, owners: [pendingOwner] },
          outputs: [{ type: 'exit', cursor: 8, nativeExitConfirmed: false }],
        },
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('later cleanup uncertainty cannot revoke an already observed native death on the same transport', () => {
    const actual = planNativeStopRecovery(
      input({
        snapshot: snapshot({
          outputs: [
            { type: 'exit', cursor: 8, nativeExitConfirmed: true },
            { type: 'exit', cursor: 9, nativeExitConfirmed: false },
          ],
        }),
      }),
    )
    expect(actual.status).toBe('complete')
    expect(actual.actions).toEqual([{ type: 'finish-stop' }])
  })

  it('does not borrow an interruption for another native thread or turn', () => {
    for (const changed of [{ nativeThreadId: 'other-thread' }, { nativeTurnId: 'other-turn' }]) {
      const original = delivery()
      const actual = planNativeStopRecovery(
        input({
          snapshot: snapshot({
            inputs: [{ ...original, semantic: { ...original.semantic, ...changed } }],
          }),
        }),
      )
      expect(actual.actions[0].type).toBe('interrupt-codex')
    }
  })

  it('cannot replace an allocated interruption with missing or contradictory ownership', () => {
    for (const changed of [
      { ownerGeneration: 3 },
      { sessionId: 'other-local-session' },
      { sessionId: undefined, ownerGeneration: undefined },
      { nativeTurnId: undefined },
    ]) {
      const original = delivery()
      const actual = planNativeStopRecovery(
        input({
          snapshot: snapshot({
            inputs: [{ ...original, semantic: { ...original.semantic, ...changed } }],
          }),
        }),
      )
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('denies an unallocated approval once and records a stable admission key', () => {
    const first = planNativeStopRecovery(input({ approvals: [approval()] }))
    const second = planNativeStopRecovery(input({ approvals: [approval()] }))
    expect(first.actions.map((action) => action.type)).toEqual(['deny-approval', 'interrupt-codex'])
    expect(first.actions).toEqual(second.actions)
    const allocated = planNativeStopRecovery(
      input({ approvals: [approval()], snapshot: snapshot({ inputs: [response()] }) }),
    )
    expect(allocated.actions.map((action) => action.type)).toEqual([
      'retry-input',
      'interrupt-codex',
    ])
    expect(allocated.reservedApprovalIds).toEqual(['local-permission'])
    expect(allocated.resolvedApprovalIds).toEqual([])
  })

  it('preserves an already allocated allow response and cannot replace it with a denial', () => {
    const original = response()
    const actual = planNativeStopRecovery(
      input({ approvals: [approval()], snapshot: snapshot({ inputs: [original] }) }),
    )
    expect(actual.actions[0]).toEqual({ type: 'retry-input', input: original })
    expect(actual.actions.some((action) => action.type === 'deny-approval')).toBe(false)
  })

  it('denies the newer same-generation occurrence without reusing its earlier native-ID response', () => {
    const original = response({ acknowledged: true, written: true })
    const pending = approval({ requestId: 'local-permission-next-occurrence' })
    const saved = snapshot({ inputs: [original] })
    const actual = planNativeStopRecovery(input({ approvals: [pending], snapshot: saved }))
    expect(actual.status).toBe('continuing')
    expect(actual.actions).toEqual([
      { type: 'deny-approval', approval: pending, stopKey: expect.any(String) },
      {
        type: 'interrupt-codex',
        nativeThreadId: 'native-thread',
        nativeTurnId: 'native-turn',
        stopKey: expect.any(String),
      },
    ])
    expect(actual.resolvedApprovalIds).toEqual([])
    expect(actual.reservedApprovalIds).toEqual([])
    expect(
      planNativeStopRecovery(input({ approvals: [approval()], snapshot: saved }))
        .resolvedApprovalIds,
    ).toEqual(['local-permission'])
    expect(saved.inputs).toEqual([original])
  })

  it('still rejects a corrupt current binding when an older occurrence used the same native ID', () => {
    const original = response({ acknowledged: true, written: true })
    const invalidBindings: readonly NativeRecoveryStoredInput['semantic']['responseBinding'][] = [
      undefined,
      { requestId: '' },
      { requestId: 17 },
      {
        requestId: 'local-permission-next-occurrence',
        params: { threadId: 'foreign-native-thread' },
      },
    ]
    for (const responseBinding of invalidBindings) {
      const current = response({
        sequence: 4,
        semantic: { ...original.semantic, responseBinding },
      })
      const actual = planNativeStopRecovery(
        input({
          approvals: [approval({ requestId: 'local-permission-next-occurrence' })],
          snapshot: snapshot({ inputs: [original, current] }),
        }),
      )
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
      expect(actual.reasons).toContain(
        'Permission response local-permission-next-occurrence has inconsistent native binding.',
      )
    }
  })

  it('orders original numbered retries before new Stop allocations', () => {
    const originalInterrupt = delivery({ sequence: 3 })
    const originalResponse = response({ sequence: 5 })
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval()],
        snapshot: snapshot({ inputs: [originalInterrupt, originalResponse] }),
      }),
    )
    expect(actual.actions).toEqual([
      { type: 'retry-input', input: originalInterrupt },
      { type: 'retry-input', input: originalResponse },
    ])
  })

  it('suppresses a pipe-written permission response even if Stop was never requested', () => {
    let saved = snapshot({ inputs: [response({ acknowledged: true, written: true })] })
    saved = withTransport(saved, { owners: [owner({ stopRequested: false })] })
    const actual = planNativeStopRecovery(input({ snapshot: saved, approvals: [approval()] }))
    expect(actual.status).toBe('unrequested')
    expect(actual.resolvedApprovalIds).toEqual(['local-permission'])
    expect(actual.reservedApprovalIds).toEqual([])
    expect(actual.actions).toEqual([])
  })

  it('a canceled unwritten permission response is unresolved and cannot be reallocated', () => {
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval()],
        snapshot: snapshot({ inputs: [response({ cancellation: 'cancelled' })] }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
    expect(actual.resolvedApprovalIds).toEqual([])
    expect(actual.reservedApprovalIds).toEqual([])
  })

  it('a pipe-written response remains resolved when its earlier cancellation also survives', () => {
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval()],
        snapshot: snapshot({
          inputs: [
            response({ cancellation: 'old cancellation', acknowledged: true, written: true }),
          ],
        }),
      }),
    )
    expect(actual.resolvedApprovalIds).toEqual(['local-permission'])
    expect(actual.actions.some((action) => action.type === 'deny-approval')).toBe(false)
  })

  it('preserves native request ID types and distinguishes approval methods', () => {
    const old = response()
    for (const other of [approval({ nativeRequestId: 7 })]) {
      const actual = planNativeStopRecovery(
        input({ approvals: [other], snapshot: snapshot({ inputs: [old] }) }),
      )
      expect(actual.resolvedApprovalIds).toEqual([])
      expect(actual.reservedApprovalIds).toEqual([])
      expect(actual.actions[0].type).toBe('deny-approval')
    }
    const textId = response({
      semantic: { ...old.semantic, permissionRequestId: '7' },
      written: true,
      acknowledged: true,
    })
    expect(
      planNativeStopRecovery(
        input({
          approvals: [approval({ nativeRequestId: 7 })],
          snapshot: snapshot({ inputs: [textId] }),
        }),
      ).resolvedApprovalIds,
    ).toEqual([])
  })

  it('does not invent a denial when no native non-grant choice is advertised', () => {
    const actual = planNativeStopRecovery(input({ approvals: [approval({ canDeny: false })] }))
    expect(actual.actions.map((action) => action.type)).toEqual(['interrupt-codex'])
  })

  it('refuses an allocated permission response with inconsistent native method binding', () => {
    const actual = planNativeStopRecovery(
      input({
        approvals: [approval({ requestType: 'item/tool/requestUserInput' })],
        snapshot: snapshot({ inputs: [response()] }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('refuses an approval from an unproven foreign owner', () => {
    const actual = planNativeStopRecovery(
      input({ approvals: [approval({ owner: owner({ generation: 2 }) })] }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('only a live pre-dispatch witness can finish a prepared start with no allocated prompt', () => {
    const pendingOwner = owner({
      phase: 'startingTurn',
      state: 'starting',
      nativeTurnId: undefined,
    })
    const saved = withTransport(snapshot(), { owners: [pendingOwner] })
    for (const rootDispatchNotStarted of [false, true]) {
      const actual = planNativeStopRecovery(
        input({
          owner: pendingOwner,
          snapshot: saved,
          root: { state: 'starting', ownershipProven: true, nativeThreadId: 'native-thread' },
          rootDispatchNotStarted,
        }),
      )
      expect(actual.status).toBe(rootDispatchNotStarted ? 'complete' : 'unknown')
      expect(actual.actions).toEqual(rootDispatchNotStarted ? [{ type: 'finish-unstarted' }] : [])
    }
  })

  it('a pre-dispatch witness cannot finish any unresolved allocated user prompt', () => {
    const pendingOwner = owner({
      phase: 'startingTurn',
      state: 'starting',
      nativeTurnId: undefined,
    })
    for (const acknowledged of [false, true]) {
      const original = delivery({
        acknowledged,
        written: false,
        semantic: {
          kind: 'user-prompt',
          sessionId: 'life-session',
          ownerGeneration: 4,
          method: 'turn/start',
          requestId: 20,
        },
      })
      const saved = withTransport(snapshot({ inputs: [original] }), { owners: [pendingOwner] })
      const actual = planNativeStopRecovery(
        input({
          owner: pendingOwner,
          snapshot: saved,
          root: { state: 'starting', ownershipProven: true, nativeThreadId: 'native-thread' },
          rootDispatchNotStarted: true,
        }),
      )
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('finishes startup before any prompt allocation without native work or title inference', () => {
    const pendingOwner = owner({
      phase: 'initializing',
      state: 'starting',
      nativeThreadId: undefined,
      nativeTurnId: undefined,
    })
    let saved = snapshot()
    saved = withTransport(saved, { owners: [pendingOwner] })
    const actual = planNativeStopRecovery(
      input({
        owner: pendingOwner,
        snapshot: saved,
        root: { state: 'starting', ownershipProven: true },
      }),
    )
    expect(actual.status).toBe('complete')
    expect(actual.actions).toEqual([{ type: 'finish-unstarted' }])
  })

  it('does not activate or regenerate a prompt whose original delivery is unresolved', () => {
    const original = delivery({
      semantic: {
        kind: 'user-prompt',
        sessionId: 'life-session',
        ownerGeneration: 4,
        method: 'turn/start',
        requestId: 20,
      },
    })
    const actual = planNativeStopRecovery(input({ snapshot: snapshot({ inputs: [original] }) }))
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
    expect(actual.reasons[0]).toContain('user prompt')
    const idle = planNativeStopRecovery(
      input({
        root: { ...input().root, state: 'idle' },
        snapshot: snapshot({ inputs: [original] }),
      }),
    )
    expect(idle.status).toBe('unknown')
    expect(idle.actions).toEqual([])
  })

  it('waits for a pipe-written starting turn to reveal its native turn identity', () => {
    const pendingOwner = owner({
      phase: 'startingTurn',
      state: 'starting',
      nativeTurnId: undefined,
    })
    let saved = snapshot({
      inputs: [
        delivery({
          semantic: {
            kind: 'user-prompt',
            sessionId: 'life-session',
            ownerGeneration: 4,
            method: 'turn/start',
            requestId: 20,
          },
          written: true,
          acknowledged: true,
        }),
      ],
    })
    saved = withTransport(saved, { owners: [pendingOwner] })
    const actual = planNativeStopRecovery(
      input({
        owner: pendingOwner,
        snapshot: saved,
        root: { state: 'starting', ownershipProven: true, nativeThreadId: 'native-thread' },
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
    expect(actual.reasons[0]).toContain('interruption identity')
  })

  it('interrupts owned active children while an idle root shares Codex with another root', () => {
    const child: NativeStopRecoveryChild = {
      owner: owner(),
      state: 'active',
      nativeThreadId: 'native-child',
      nativeTurnId: 'child-turn',
      ownershipProven: true,
    }
    let saved = snapshot()
    saved = withTransport(saved, {
      owners: [
        ...saved.transport.owners,
        owner({
          ownerId: 'other-root',
          sessionId: 'other-local',
          nativeThreadId: 'other-thread',
          snapshotToken: 'other-token',
        }),
      ],
    })
    const actual = planNativeStopRecovery(
      input({ snapshot: saved, root: { ...input().root, state: 'idle' }, children: [child] }),
    )
    expect(actual.actions).toEqual([
      {
        type: 'interrupt-codex',
        nativeThreadId: 'native-child',
        nativeTurnId: 'child-turn',
        stopKey: expect.any(String),
      },
    ])
    expect(actual.actions.some((action) => action.type === 'interrupt-claude')).toBe(false)
  })

  it('a root interruption acknowledgment cannot complete active children', () => {
    const actual = planNativeStopRecovery(
      input({
        root: { ...input().root, interruptAcknowledged: true },
        children: [
          {
            owner: owner(),
            state: 'active',
            nativeThreadId: 'child',
            nativeTurnId: 'child-turn',
            ownershipProven: true,
          },
        ],
      }),
    )
    expect(actual.status).toBe('continuing')
    expect(actual.actions[0].type).toBe('interrupt-codex')
  })

  it('cannot interrupt an active native child before its exact turn ID is known', () => {
    const actual = planNativeStopRecovery(
      input({
        root: { ...input().root, state: 'idle' },
        children: [
          { owner: owner(), state: 'active', nativeThreadId: 'child', ownershipProven: true },
        ],
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('preserves an existing child response whose old envelope inherited the root thread', () => {
    const child: NativeStopRecoveryChild = {
      owner: owner(),
      state: 'active',
      nativeThreadId: 'child',
      nativeTurnId: 'child-turn',
      ownershipProven: true,
    }
    const original = response({
      semantic: {
        ...response().semantic,
        nativeThreadId: 'native-thread',
        responseBinding: {
          requestId: 'local-permission',
          status: 'approved',
          params: { threadId: 'child' },
        },
      },
    })
    const actual = planNativeStopRecovery(
      input({
        children: [child],
        approvals: [approval({ nativeThreadId: 'child' })],
        snapshot: snapshot({ inputs: [original] }),
      }),
    )
    expect(actual.actions[0]).toEqual({ type: 'retry-input', input: original })
    expect(actual.actions.some((action) => action.type === 'deny-approval')).toBe(false)
  })

  it('does not treat a missing semantic thread as wildcard child response ownership', () => {
    const child: NativeStopRecoveryChild = {
      owner: owner(),
      state: 'active',
      nativeThreadId: 'child',
      nativeTurnId: 'child-turn',
      ownershipProven: true,
    }
    const original = response({
      semantic: {
        ...response().semantic,
        nativeThreadId: undefined,
        responseBinding: { requestId: 'local-permission', params: { threadId: 'another-child' } },
      },
    })
    const actual = planNativeStopRecovery(
      input({
        children: [child],
        approvals: [approval({ nativeThreadId: 'child' })],
        snapshot: snapshot({ inputs: [original] }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
    expect(actual.resolvedApprovalIds).toEqual([])
    expect(actual.reservedApprovalIds).toEqual([])
  })

  it('does not silently retry multiple original allocations for one native interruption', () => {
    const actual = planNativeStopRecovery(
      input({
        snapshot: snapshot({
          inputs: [
            delivery({ sequence: 3, acknowledged: true, written: true }),
            delivery({ sequence: 4 }),
          ],
        }),
      }),
    )
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })

  it('continues a privately registered old-generation child without borrowing another owner', () => {
    const earlier = owner({ generation: 3, snapshotToken: 'earlier-private-token' })
    const oldTransport = { ...snapshot().transport, owners: [earlier] }
    const child: NativeStopRecoveryChild = {
      owner: earlier,
      state: 'active',
      nativeThreadId: 'child',
      nativeTurnId: 'child-turn',
      ownershipProven: true,
    }
    const actual = planNativeStopRecovery(
      input({
        root: { ...input().root, state: 'idle' },
        children: [child],
        snapshot: snapshot({ records: [{ kind: 'create', revision: 1, transport: oldTransport }] }),
      }),
    )
    expect(actual.status).toBe('continuing')
    expect(actual.actions).toEqual([
      {
        type: 'interrupt-codex',
        nativeThreadId: 'child',
        nativeTurnId: 'child-turn',
        stopKey: expect.any(String),
      },
    ])
  })

  it('refuses incomplete child graphs and foreign child generations', () => {
    const child: NativeStopRecoveryChild = {
      owner: owner({ generation: 1 }),
      state: 'active',
      nativeThreadId: 'child',
      ownershipProven: true,
    }
    for (const source of [
      input({ graphComplete: false }),
      input({ children: [child] }),
      input({ root: { ...input().root, ownershipProven: false } }),
    ]) {
      const actual = planNativeStopRecovery(source)
      expect(actual.status).toBe('unknown')
      expect(actual.actions).toEqual([])
    }
  })

  it('uses one explicit Claude control for its owned root and children', () => {
    let saved = snapshot()
    saved = withTransport(saved, { provider: 'claude' })
    const actual = planNativeStopRecovery(
      input({
        snapshot: saved,
        children: [{ owner: owner(), state: 'active', ownershipProven: true }],
      }),
    )
    expect(actual.actions).toEqual([{ type: 'interrupt-claude', stopKey: expect.any(String) }])
  })

  it('does not allocate an additional Claude control after an original allocation', () => {
    let saved = snapshot({
      inputs: [
        delivery({
          semantic: {
            kind: 'interrupt',
            sessionId: 'life-session',
            ownerGeneration: 4,
            requestId: 'original-control',
          },
        }),
      ],
    })
    saved = withTransport(saved, { provider: 'claude' })
    const actual = planNativeStopRecovery(input({ snapshot: saved }))
    expect(actual.actions).toEqual([{ type: 'retry-input', input: saved.inputs[0] }])
  })

  it('refuses process-wide Claude interruption if another root owns that process', () => {
    let saved = snapshot()
    saved = withTransport(saved, { provider: 'claude' })
    saved = withTransport(saved, {
      owners: [
        ...saved.transport.owners,
        owner({ ownerId: 'other-root', sessionId: 'other-local', snapshotToken: 'other-token' }),
      ],
    })
    const actual = planNativeStopRecovery(input({ snapshot: saved }))
    expect(actual.status).toBe('unknown')
    expect(actual.actions).toEqual([])
  })
})
