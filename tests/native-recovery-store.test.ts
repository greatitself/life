import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import {
  isConfirmedNativeExit,
  type NativeRecoveryStartPlan,
  type NativeRecoveryTransport,
} from '../src/main/native-recovery-types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
beforeEach(() => {
  vi.mocked(open).mockImplementation(actualFs.open)
  vi.mocked(rename).mockImplementation(actualFs.rename)
})

const directories: string[] = []
const scopes: Scope.Closeable[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'life-native-recovery-'))
  directories.push(directory)
  return directory
}

async function start(
  directory: string,
  delay = 10,
  exclusiveRuntime = false,
): Promise<NativeRecoveryStoreHandle> {
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  return Effect.runPromise(
    NativeRecoveryStore.make({ directory, outputBatchDelayMs: delay, exclusiveRuntime }).pipe(
      Scope.provide(scope),
    ),
  )
}

function descriptor(id = 'shared-codex-transport'): NativeRecoveryTransport {
  return {
    id,
    brokerId: 'broker-uuid',
    brokerRoot: '/home/fixture/.life/agent-sessions/broker-uuid',
    launchCommand: 'codex app-server',
    provider: 'codex',
    providerVersion: '0.162.1',
    nativeProtocol: 'codex-app-server-stdio',
    brokerProtocolVersion: 2,
    machine: { profileId: 'fixture-profile', host: 'fixture', port: 22, username: 'fixture' },
    controller: { id: 'controller-uuid', epoch: 1 },
    initialization: { status: 'pending', requestId: 1 },
    owners: [
      {
        ownerId: 'root-owner',
        sessionId: 'life-session',
        generation: 1,
        kind: 'root',
        workspace: '/project',
        writableRoot: '/project',
        state: 'starting',
        input: {
          sessionId: 'life-session',
          provider: 'codex',
          prompt: 'Exact\r\nprompt 🌍\ud800',
          mode: 'read-only',
          workspace: '/project',
          providerOptions: { turn: { futureNativeOption: { opaque: [null, false, 'value'] } } },
        },
      },
    ],
  }
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
const journalPath = (directory: string, id: string) =>
  join(directory, createHash('sha256').update(id).digest('hex') + '.jsonl')
const frame = (cursor: number, value: string | Buffer) => ({
  type: 'stdout' as const,
  cursor,
  data: Buffer.from(value).toString('base64'),
})
const inputOwner = {
  kind: 'user-prompt' as const,
  sessionId: 'life-session',
  method: 'turn/start',
  requestId: 7,
  ownerGeneration: 1,
}

describe('durable native recovery journal', () => {
  it('reloads exact shared ownership, native identity, prompts and numbered original wire after closing', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    const initial = await run(store.createTransport(transport))
    expect(initial.transport).toEqual(transport)
    const first = await run(
      store.reserveInput(
        transport.id,
        { type: 'write', data: Buffer.from('exact\r\n🌍').toString('base64') },
        inputOwner,
      ),
    )
    const second = await run(
      store.reserveInput(
        transport.id,
        { type: 'signal', signal: 'SIGINT' },
        {
          kind: 'interrupt',
          sessionId: 'life-session',
          method: 'turn/interrupt',
          requestId: 'native-string-id',
        },
      ),
    )
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(
      (await readFile(journalPath(directory, transport.id), 'utf8')).includes(
        JSON.stringify(first),
      ),
    ).toBe(true)
    await run(store.acknowledgeInput(transport.id, 1))
    await run(
      store.updateTransport(transport.id, {
        initialization: { status: 'complete', requestId: 1 },
        owners: [
          {
            ...transport.owners[0],
            state: 'active',
            nativeThreadId: 'native-thread',
            nativeTurnId: 'native-turn',
          },
        ],
      }),
    )
    await run(store.closeEffect())
    const recovered = await start(directory)
    const snapshot = await run(recovered.readTransport(transport.id))
    expect(snapshot.inputs[0]).toEqual({
      ...first,
      acknowledged: true,
      written: false,
      consumed: false,
    })
    expect(snapshot.transport.owners[0].input).toEqual(transport.owners[0].input)
    expect(snapshot.transport.owners[0].nativeTurnId).toBe('native-turn')
    expect(await run(recovered.reconcileInputHighWater(transport.id, 1))).toEqual([second])
    expect(snapshot.records.map((record) => record.revision)).toEqual(
      snapshot.records.map((_, index) => index + 1),
    )
  })

  it('coalesces concurrent output into durable ordered batches and retains split bytes for parser replay', async () => {
    const directory = await temporary()
    const store = await start(directory, 30)
    const transport = descriptor()
    await run(store.createTransport(transport))
    const bytes = Buffer.from('{"delta":"🌍"}\n')
    const split = bytes.indexOf(0xf0) + 2
    const chunks = [
      bytes.subarray(0, split),
      bytes.subarray(split),
      Buffer.from('{"next":'),
      Buffer.from('true}\n'),
    ]
    const cursors = await run(
      Effect.all(
        chunks.map((chunk, index) => store.appendOutputs(transport.id, [frame(index + 1, chunk)])),
        { concurrency: 'unbounded' },
      ),
    )
    expect(cursors).toEqual([1, 2, 3, 4])
    const journal = await readFile(journalPath(directory, transport.id), 'utf8')
    expect(journal.trimEnd().split('\n')).toHaveLength(2)
    await run(store.closeEffect())
    const recovered = await start(directory)
    const snapshot = await run(recovered.readTransport(transport.id))
    expect(snapshot.outputs.map((value) => value.cursor)).toEqual([1, 2, 3, 4])
    expect(
      Buffer.concat(
        snapshot.outputs.map((value) =>
          Buffer.from(
            value.type === 'stdout' || value.type === 'stderr' ? value.data : '',
            'base64',
          ),
        ),
      ),
    ).toEqual(Buffer.concat(chunks))
    expect(
      snapshot.records.filter((value) => value.kind === 'output').map((value) => value.revision),
    ).toEqual([2, 3, 4, 5])
  })

  it('preserves forced native exit notices without converting them into observed native death', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    const frames = [
      {
        type: 'exit' as const,
        cursor: 1,
        code: null,
        signal: 'SIGTERM',
        nativeExitConfirmed: false,
      },
      { type: 'exit' as const, cursor: 2, code: 0, signal: null, nativeExitConfirmed: true },
      { type: 'exit' as const, cursor: 3, code: 0, signal: null },
    ]
    await run(store.appendOutputs(transport.id, frames))
    await run(store.closeEffect())
    const recovered = await start(directory)
    const state = await run(recovered.readTransport(transport.id))
    expect(state.outputs).toEqual(frames)
    expect(
      state.records.filter((record) => record.kind === 'output').map((record) => record.frame),
    ).toEqual(frames)
    expect(state.outputs.map(isConfirmedNativeExit)).toEqual([false, true, true])
    expect(state.events).toEqual([])
    expect(state.historyAcks).toEqual([])
  })

  it('rejects a malformed native-exit confirmation marker without advancing output ownership', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    const original = await readFile(journalPath(directory, transport.id))
    await expect(
      run(
        store.appendOutputs(transport.id, [
          { type: 'exit', cursor: 1, code: null, nativeExitConfirmed: 'false' },
        ] as never),
      ),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    expect((await run(store.readTransport(transport.id))).outputCursor).toBe(0)
  })

  it('flushes earlier queued output before mutation admission and owner-generation replacement', async () => {
    const directory = await temporary()
    const store = await start(directory, 10000)
    const transport = descriptor()
    await run(store.createTransport(transport))
    const queued = run(store.appendOutputs(transport.id, [frame(1, 'first turn reply')]))
    await new Promise((resolve) => setImmediate(resolve))
    await run(
      store.updateTransport(transport.id, {
        owners: [{ ...transport.owners[0], generation: 2, state: 'starting' }],
      }),
    )
    await run(
      store.reserveInput(
        transport.id,
        { type: 'write', data: 'bmV4dA==' },
        { ...inputOwner, ownerGeneration: 2 },
      ),
    )
    expect(await queued).toBe(1)
    const snapshot = await run(store.readTransport(transport.id))
    expect(snapshot.records.map((record) => record.kind)).toEqual([
      'create',
      'output',
      'transport',
      'input',
    ])
  })

  it('commits streaming native events and raw output together without a sync for every event', async () => {
    const directory = await temporary()
    const store = await start(directory, 30)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    const event = (cursor: number) => ({
      eventId: 'native-output-' + cursor,
      outputCursor: cursor,
      event: { sessionId: 'life-session', type: 'text', text: String(cursor) },
    })
    await run(
      Effect.all(
        [
          store.appendOutputs(id, [frame(1, 'one')]),
          store.appendEvents(id, [event(1)]),
          store.appendOutputs(id, [frame(2, 'two')]),
          store.appendEvents(id, [event(2)]),
          store.appendEvents(id, [event(2)]),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    expect((await readFile(journalPath(directory, id), 'utf8')).trimEnd().split('\n')).toHaveLength(
      2,
    )
    const snapshot = await run(store.readTransport(id))
    expect(snapshot.records.map((record) => record.kind)).toEqual([
      'create',
      'output',
      'event',
      'output',
      'event',
    ])
    expect(snapshot.events.map((event) => event.revision)).toEqual([1, 2])
  })

  it('persists high-water reconciliation without renumbering and rejects unknown or regressed acknowledgments', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    const first = await run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner))
    const second = await run(
      store.reserveInput(id, { type: 'write', data: 'Mg==' }, { ...inputOwner, requestId: 8 }),
    )
    expect(await run(store.reconcileInputHighWater(id, 1))).toEqual([second])
    const committed = await readFile(journalPath(directory, id))
    await expect(run(store.reconcileInputHighWater(id, 3))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await expect(run(store.reconcileInputHighWater(id, 0))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await expect(run(store.acknowledgeInput(id, 3))).rejects.toMatchObject({ reason: 'uncertain' })
    expect(await readFile(journalPath(directory, id))).toEqual(committed)
    expect((await run(store.readTransport(id))).inputs[0].wire).toBe(first.wire)
    expect((await run(store.readTransport(id))).inputs[0]).toMatchObject({
      acknowledged: true,
      written: false,
      consumed: false,
    })
  })

  it('atomically persists terminal close and suppresses every older unresolved delivery during recovery', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    await run(store.reserveInput(id, { type: 'write', data: 'cHJvbXB0' }, inputOwner))
    await run(store.reserveInput(id, { type: 'signal', signal: 'SIGINT' }, { kind: 'interrupt' }))
    const close = await run(store.reserveInput(id, { type: 'close' }, { kind: 'close' }))
    const batches = (await readFile(journalPath(directory, id), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(batches.at(-1).records.map((record: { kind: string }) => record.kind)).toEqual([
      'input-cancel',
      'input-cancel',
      'input',
    ])
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect(await run(recovered.reconcileInputHighWater(id, 0))).toEqual([close])
    await expect(
      run(recovered.reserveInput(id, { type: 'write', data: 'bm8=' }, inputOwner)),
    ).rejects.toMatchObject({ reason: 'closed' })
    expect(await run(recovered.reconcileInputHighWater(id, close.sequence))).toEqual([])
  })

  it('distinguishes exact transport write receipts from acceptance and terminal close coverage', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport({ ...descriptor(), inputReceipts: 1 }))
    await run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner))
    await run(store.acknowledgeInput(id, 1))
    await run(
      store.appendOutputs(id, [
        { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
      ]),
    )
    await run(
      store.reserveInput(
        id,
        { type: 'write', data: 'Mg==' },
        { kind: 'permission-response', sessionId: 'life-session', permissionRequestId: 19 },
      ),
    )
    const close = await run(store.reserveInput(id, { type: 'close' }, { kind: 'close' }))
    await run(store.reconcileInputHighWater(id, close.sequence))
    const snapshot = await run(store.readTransport(id))
    expect(
      snapshot.inputs.map((input) => ({
        sequence: input.sequence,
        acknowledged: input.acknowledged,
        written: input.written,
        consumed: input.consumed,
      })),
    ).toEqual([
      { sequence: 1, acknowledged: true, written: true, consumed: true },
      { sequence: 2, acknowledged: true, written: false, consumed: false },
      { sequence: 3, acknowledged: true, written: false, consumed: false },
    ])
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(id))).inputs).toEqual(snapshot.inputs)
  })

  it.each(['written', 'cancelled', 'uncertain'] as const)(
    'retains an exact %s receipt before ACK and never resends its original sequence',
    async (status) => {
      const directory = await temporary()
      const store = await start(directory)
      const transport = { ...descriptor(), inputReceipts: 1 as const }
      await run(store.createTransport(transport))
      const first = await run(
        store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner),
      )
      const second = await run(
        store.reserveInput(transport.id, { type: 'write', data: 'Mg==' }, inputOwner),
      )
      const receipt = { type: 'inputReceipt' as const, cursor: 1, sequence: 1, status }
      await run(store.appendOutputs(transport.id, [receipt]))
      const beforeACK = await run(store.readTransport(transport.id))
      expect(beforeACK.inputs[0]).toEqual({
        ...first,
        acknowledged: false,
        written: status === 'written',
        consumed: status === 'written',
        deliveryReceipt: { cursor: 1, status },
      })
      expect(beforeACK.inputs[1].written).toBe(false)
      expect(beforeACK.events).toEqual([])
      expect(beforeACK.historyAcks).toEqual([])
      await run(store.closeEffect())
      const recovered = await start(directory)
      const committed = await readFile(journalPath(directory, transport.id))
      await expect(run(recovered.reconcileInputHighWater(transport.id, 0))).rejects.toMatchObject({
        reason: 'uncertain',
      })
      for (const contradiction of ['written', 'cancelled', 'uncertain'] as const)
        await expect(
          run(
            recovered.appendOutputs(transport.id, [
              { ...receipt, cursor: 2, status: contradiction },
            ]),
          ),
        ).rejects.toMatchObject({ reason: 'uncertain' })
      expect(await readFile(journalPath(directory, transport.id))).toEqual(committed)
      expect(await run(recovered.reconcileInputHighWater(transport.id, 1))).toEqual([second])
      const state = await run(recovered.readTransport(transport.id))
      expect(state.outputs).toEqual([receipt])
      expect(state.inputs[0].acknowledged).toBe(true)
      expect(state.inputs[0].written).toBe(status === 'written')
      expect(state.allocatedInputSequence).toBe(2)
    },
  )

  it('records a late write receipt after local cancellation and close without changing the original wire', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    const original = await run(
      store.reserveInput(transport.id, { type: 'write', data: 'ZXhhY3Q=' }, inputOwner),
    )
    await run(store.cancelInput(transport.id, original.sequence, 'Do not replay the original.'))
    const close = await run(store.reserveInput(transport.id, { type: 'close' }, { kind: 'close' }))
    await run(store.reconcileInputHighWater(transport.id, close.sequence))
    await run(
      store.appendOutputs(transport.id, [
        { type: 'inputReceipt', cursor: 1, sequence: original.sequence, status: 'written' },
      ]),
    )
    const state = await run(store.readTransport(transport.id))
    expect(state.inputs[0]).toEqual({
      ...original,
      acknowledged: true,
      written: true,
      consumed: true,
      cancellation: 'Do not replay the original.',
      deliveryReceipt: { cursor: 1, status: 'written' },
    })
    expect(state.inputs[1]).toEqual({
      ...close,
      acknowledged: true,
      written: false,
      consumed: false,
    })
    expect(await run(store.reconcileInputHighWater(transport.id, close.sequence))).toEqual([])
  })

  it('persists actual queued cancellation separately from ACKed acceptance and local close intent', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'cHJvbXB0' }, inputOwner))
    await run(store.acknowledgeInput(transport.id, 1))
    const close = await run(store.reserveInput(transport.id, { type: 'close' }, { kind: 'close' }))
    await run(store.reconcileInputHighWater(transport.id, close.sequence))
    expect((await run(store.readTransport(transport.id))).inputs[0].cancellation).toBeUndefined()
    await run(
      store.appendOutputs(transport.id, [
        { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'cancelled' },
      ]),
    )
    const state = await run(store.readTransport(transport.id))
    expect(state.inputs[0]).toMatchObject({
      acknowledged: true,
      written: false,
      consumed: false,
      deliveryReceipt: { cursor: 1, status: 'cancelled' },
    })
    expect(state.inputs[1].written).toBe(false)
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).inputs).toEqual(state.inputs)
  })

  it('coalesces distinct exact receipts without replacing a final receipt identity', async () => {
    const directory = await temporary()
    const store = await start(directory, 30)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'Mg==' }, inputOwner))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'Mw==' }, inputOwner))
    await run(
      Effect.all(
        [
          store.appendOutputs(transport.id, [
            { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
          ]),
          store.appendOutputs(transport.id, [
            { type: 'inputReceipt', cursor: 2, sequence: 2, status: 'written' },
          ]),
          store.appendOutputs(transport.id, [
            { type: 'inputReceipt', cursor: 3, sequence: 3, status: 'cancelled' },
          ]),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    const path = journalPath(directory, transport.id)
    expect((await readFile(path, 'utf8')).trimEnd().split('\n')).toHaveLength(5)
    const committed = await readFile(path)
    for (const [sequence, status] of [
      [1, 'cancelled'],
      [1, 'uncertain'],
      [2, 'written'],
      [3, 'written'],
    ] as const)
      await expect(
        run(
          store.appendOutputs(transport.id, [
            { type: 'inputReceipt', cursor: 4, sequence, status },
          ]),
        ),
      ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(await readFile(path)).toEqual(committed)
    await run(store.appendOutputs(transport.id, [frame(4, 'provider output after the receipts')]))
    const state = await run(store.readTransport(transport.id))
    expect(state.inputs.map((input) => input.written)).toEqual([true, true, false])
    expect(state.inputs.map((input) => input.deliveryReceipt)).toEqual([
      { cursor: 1, status: 'written' },
      { cursor: 2, status: 'written' },
      { cursor: 3, status: 'cancelled' },
    ])
  })

  it('rejects contradictory receipts within one batch before admitting any cursor or receipt state', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const original = await readFile(journalPath(directory, transport.id))
    await expect(
      run(
        store.appendOutputs(transport.id, [
          { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
          { type: 'inputReceipt', cursor: 2, sequence: 1, status: 'written' },
        ]),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    const unchanged = await run(store.readTransport(transport.id))
    expect(unchanged.outputCursor).toBe(0)
    expect(unchanged.inputs[0].written).toBe(false)
    expect(unchanged.inputs[0].deliveryReceipt).toBeUndefined()
    await run(
      store.appendOutputs(transport.id, [
        { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'cancelled' },
      ]),
    )
    expect((await run(store.readTransport(transport.id))).inputs[0].deliveryReceipt).toEqual({
      cursor: 1,
      status: 'cancelled',
    })
  })

  it('rejects a conflicting receipt while the original receipt remains queued for the same batch', async () => {
    const directory = await temporary()
    const store = await start(directory, 60_000)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const path = journalPath(directory, transport.id)
    const original = await readFile(path)
    let completed = false
    const queued = run(
      store.appendOutputs(transport.id, [
        { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
      ]),
    ).then((cursor) => {
      completed = true
      return cursor
    })
    await expect(
      run(
        store.appendOutputs(transport.id, [
          { type: 'inputReceipt', cursor: 2, sequence: 1, status: 'written' },
        ]),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain', operation: 'input-receipt' })
    expect(completed).toBe(false)
    expect(await readFile(path)).toEqual(original)
    await run(store.flushEffect())
    expect(await queued).toBe(1)
    const state = await run(store.readTransport(transport.id))
    expect(state.outputs).toEqual([
      { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
    ])
    expect(state.inputs[0].deliveryReceipt).toEqual({ cursor: 1, status: 'written' })
  })

  it('requires negotiated receipt capability and ignores receipt-shaped provider stdout', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const receipt = {
      type: 'inputReceipt' as const,
      cursor: 1,
      sequence: 1,
      status: 'written' as const,
    }
    const original = await readFile(journalPath(directory, transport.id))
    await expect(run(store.appendOutputs(transport.id, [receipt]))).rejects.toMatchObject({
      reason: 'unsupported',
    })
    await expect(
      run(store.updateTransport(transport.id, { inputReceipts: 2 } as never)),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    await run(store.appendOutputs(transport.id, [frame(1, JSON.stringify(receipt) + '\n')]))
    expect((await run(store.readTransport(transport.id))).inputs[0].written).toBe(false)
    await run(store.updateTransport(transport.id, { inputReceipts: 1 }))
    await run(store.appendOutputs(transport.id, [{ ...receipt, cursor: 2 }]))
    const state = await run(store.readTransport(transport.id))
    expect(state.inputs[0].deliveryReceipt).toEqual({ cursor: 2, status: 'written' })
    expect(state.records.map((record) => record.kind)).toEqual([
      'create',
      'input',
      'output',
      'transport',
      'output',
    ])
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).transport.inputReceipts).toBe(1)
  })

  it('rejects receipts without original sequence or strict outer proof before changing the archive', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const original = await readFile(journalPath(directory, transport.id))
    await expect(
      run(
        store.appendOutputs(transport.id, [
          { type: 'inputReceipt', cursor: 1, sequence: 2, status: 'written' },
        ]),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    for (const invalid of [
      { type: 'inputReceipt', cursor: 1, sequence: 0, status: 'written' },
      { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'applied' },
      { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written', written: true },
    ])
      await expect(
        run(store.appendOutputs(transport.id, [invalid] as never)),
      ).rejects.toMatchObject({
        reason: 'invalid',
      })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    expect((await run(store.readTransport(transport.id))).outputCursor).toBe(0)
  })

  it.each([{ type: 'signal', signal: 'SIGINT' }, { type: 'end' }, { type: 'close' }] as const)(
    'retains a completed $type side effect without claiming native application or exit',
    async (input) => {
      const directory = await temporary()
      const store = await start(directory)
      const transport = { ...descriptor(), inputReceipts: 1 as const }
      await run(store.createTransport(transport))
      const original = await run(store.reserveInput(transport.id, input, { kind: 'transport' }))
      const receipt = {
        type: 'inputReceipt' as const,
        cursor: 1,
        sequence: original.sequence,
        status: 'written' as const,
      }
      await run(store.appendOutputs(transport.id, [receipt]))
      const state = await run(store.readTransport(transport.id))
      expect(state.inputs[0].frame).toEqual({ ...input, sequence: original.sequence })
      expect(state.inputs[0].written).toBe(true)
      expect(state.inputs[0].deliveryReceipt).toEqual({ cursor: 1, status: 'written' })
      expect(state.outputs.map(isConfirmedNativeExit)).toEqual([false])
      expect(state.events).toEqual([])
      expect(state.historyAcks).toEqual([])
      expect(state.transport.owners).toEqual(transport.owners)
    },
  )

  it('never upgrades an old archive from an unqualified receipt, even when its checksum is valid', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    await run(store.closeEffect())
    const path = journalPath(directory, transport.id)
    const text = await readFile(path, 'utf8')
    const previous = JSON.parse(text.trimEnd().split('\n').at(-1)!)
    const payload = {
      format: 'life-native-recovery',
      version: 1,
      index: previous.index + 1,
      previousHash: previous.hash,
      records: [
        {
          kind: 'output',
          frame: { type: 'inputReceipt', cursor: 1, sequence: 1, status: 'written' },
          revision: 3,
        },
      ],
    }
    const damaged =
      text +
      JSON.stringify({
        ...payload,
        hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      }) +
      '\n'
    await writeFile(path, damaged)
    const recovered = await start(directory)
    await expect(run(recovered.readTransport(transport.id))).rejects.toMatchObject({
      reason: 'corrupt',
    })
    await expect(
      run(recovered.updateTransport(transport.id, { inputReceipts: 1 })),
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })

  it('preserves the original receipt cursor on cold replay and refuses a checksummed second final receipt', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = { ...descriptor(), inputReceipts: 1 as const }
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const original = {
      type: 'inputReceipt' as const,
      cursor: 1,
      sequence: 1,
      status: 'written' as const,
    }
    await run(store.appendOutputs(transport.id, [original]))
    await run(store.closeEffect())
    const firstRecovery = await start(directory)
    const originalState = await run(firstRecovery.readTransport(transport.id))
    expect(originalState.inputs[0].deliveryReceipt).toEqual({ cursor: 1, status: 'written' })
    expect(originalState.outputs).toEqual([original])
    await run(firstRecovery.closeEffect())
    const path = journalPath(directory, transport.id)
    const text = await readFile(path, 'utf8')
    const previous = JSON.parse(text.trimEnd().split('\n').at(-1)!)
    const payload = {
      format: 'life-native-recovery',
      version: 1,
      index: previous.index + 1,
      previousHash: previous.hash,
      records: [{ kind: 'output', frame: { ...original, cursor: 2 }, revision: 4 }],
    }
    const damaged =
      text +
      JSON.stringify({
        ...payload,
        hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      }) +
      '\n'
    await writeFile(path, damaged)
    const secondRecovery = await start(directory)
    await expect(run(secondRecovery.readTransport(transport.id))).rejects.toMatchObject({
      reason: 'corrupt',
    })
    await expect(
      run(secondRecovery.appendOutputs(transport.id, [frame(3, 'cannot overwrite evidence')])),
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })

  it('preserves startup Stop intent and ignored native turns without inventing a terminal delivery', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(
      store.createTransport({
        ...transport,
        owners: [
          { ...transport.owners[0], phase: 'initializing', stopRequested: false, ignoredTurns: [] },
        ],
      }),
    )
    const stopped = {
      ...transport.owners[0],
      phase: 'startingTurn' as const,
      stopRequested: true,
      ignoredTurns: ['native-turn-before-stop', 'exact\r\n🌍'],
      claudeRestartForSettings: true,
      linkedTransportId: 'actual-native-transport',
      nativeStartIntentId: 'private-start-intent',
      nativeStartClaimed: false,
    }
    await run(store.updateTransport(transport.id, { owners: [stopped] }))
    const committed = await readFile(journalPath(directory, transport.id))
    await expect(
      run(
        store.updateTransport(transport.id, {
          owners: [{ ...stopped, stopRequested: 'true' }],
        } as never),
      ),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(committed)
    await run(store.closeEffect())
    const recovered = await start(directory)
    const snapshot = await run(recovered.readTransport(transport.id))
    expect(snapshot.transport.owners).toEqual([stopped])
    expect(snapshot.inputs).toEqual([])
    expect(snapshot.closeInputSequence).toBeUndefined()
    expect(snapshot.records.map((record) => record.kind)).toEqual(['create', 'transport'])
  })

  it.each(['codex', 'claude'] as const)(
    'retains the exact captured %s startup plan through cold reopen',
    async (provider) => {
      const directory = await temporary()
      const store = await start(directory)
      const base = descriptor()
      const plan =
        provider === 'codex'
          ? {
              provider,
              thread: {
                method: 'thread/start' as const,
                params: {
                  cwd: '/project',
                  developerInstructions: 'Exact private Studio context\r\n🌍',
                  futureThreadParameter: { opaque: [null, false] },
                },
              },
              turn: {
                params: {
                  input: [{ type: 'text', text: base.owners[0].input.prompt }],
                  cwd: '/project',
                  effort: 'captured-default',
                  serviceTier: 'captured-tier',
                  futureTurnParameter: { untouched: true },
                },
              },
            }
          : {
              provider,
              initialize: {
                subtype: 'initialize',
                hooks: null,
                forwardSubagentText: true,
                futureInitializationParameter: { opaque: [null, false] },
              },
              user: {
                type: 'user',
                session_id: '',
                message: { role: 'user', content: 'Exact user content\r\n🌍\ud800' },
                parent_tool_use_id: null,
                futureUserParameter: { untouched: true },
              },
            }
      const transport = {
        ...base,
        provider,
        owners: [
          {
            ...base.owners[0],
            input: { ...base.owners[0].input, provider },
            nativeStartPlan: plan,
          },
        ],
      }
      await run(store.createTransport(transport))
      await run(store.closeEffect())
      const recovered = await start(directory)
      const snapshot = await run(recovered.readTransport(transport.id))
      expect(snapshot.transport.owners[0].nativeStartPlan).toEqual(plan)
      expect(snapshot.inputs).toEqual([])
      expect(snapshot.outputs).toEqual([])
    },
  )

  it('retains exact ordered Claude controls before any reused-generation command is allocated', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      provider: 'claude' as const,
      owners: [
        {
          ...base.owners[0],
          input: { ...base.owners[0].input, provider: 'claude' },
          generation: 1,
        },
      ],
    }
    await run(store.createTransport(transport))
    const plan: Extract<NativeRecoveryStartPlan, { provider: 'claude' }> = {
      provider: 'claude' as const,
      initialize: { subtype: 'initialize', futureInitialize: { opaque: [null, false] } },
      user: {
        type: 'user',
        session_id: 'existing-native-session',
        message: { role: 'user', content: 'Exact next-generation content\r\n🌍\ud800' },
      },
      controls: [
        { request: { subtype: 'set_permission_mode', mode: 'plan' } },
        {
          request: { subtype: 'set_model', model: 'captured-model\r\n🌍' },
          details: { requestedSettings: { model: 'captured-model\r\n🌍' } },
        },
        {
          request: {
            subtype: 'apply_settings',
            settings: { thinking: { type: 'enabled', budget_tokens: 123 }, future: [null, false] },
          },
          details: {
            requestedSettings: { reasoningEffort: 'captured-effort' },
            future: { exact: true },
          },
        },
      ],
    }
    await run(
      store.updateTransport(transport.id, {
        owners: [{ ...transport.owners[0], generation: 2, nativeStartPlan: plan }],
      }),
    )
    await run(store.closeEffect())
    const recovered = await start(directory)
    const state = await run(recovered.readTransport(transport.id))
    expect(state.transport.owners[0].nativeStartPlan).toEqual(plan)
    expect(state.transport.owners[0].generation).toBe(2)
    expect(state.inputs).toEqual([])
    expect(state.records.map((record) => record.kind)).toEqual(['create', 'transport'])
  })

  it.each(
    [
      null,
      [{ request: [] }],
      [{ request: 'set_model' }],
      [{ request: { subtype: 'set_model' }, details: [] }],
      [{ request: { subtype: 'set_model' }, unauthorized: true }],
    ].map((controls) => ({ controls })),
  )(
    'rejects malformed captured Claude controls $controls before replacing its owner',
    async ({ controls }) => {
      const directory = await temporary()
      const store = await start(directory)
      const base = descriptor()
      const transport = {
        ...base,
        provider: 'claude' as const,
        owners: [{ ...base.owners[0], input: { ...base.owners[0].input, provider: 'claude' } }],
      }
      await run(store.createTransport(transport))
      const before = await readFile(journalPath(directory, transport.id))
      await expect(
        run(
          store.updateTransport(transport.id, {
            owners: [
              {
                ...transport.owners[0],
                nativeStartPlan: {
                  provider: 'claude',
                  initialize: { subtype: 'initialize' },
                  user: {
                    type: 'user',
                    session_id: '',
                    message: { role: 'user', content: 'prompt' },
                  },
                  controls,
                },
              },
            ],
          } as never),
        ),
      ).rejects.toMatchObject({ reason: 'invalid' })
      expect(await readFile(journalPath(directory, transport.id))).toEqual(before)
      expect((await run(store.readTransport(transport.id))).transport.owners).toEqual(
        transport.owners,
      )
    },
  )

  it.each([
    { provider: 'codex', thread: { method: 'turn/start', params: {} }, turn: { params: {} } },
    { provider: 'codex', thread: { method: 'thread/start', params: [] }, turn: { params: {} } },
    {
      provider: 'codex',
      thread: { method: 'thread/start', params: {} },
      turn: { params: {} },
      inferenceApi: 'replacement',
    },
    {
      provider: 'codex',
      thread: { method: 'thread/start', params: {} },
      turn: { params: {} },
      controls: [{ request: { subtype: 'set_permission_mode', mode: 'plan' } }],
    },
    {
      provider: 'claude',
      initialize: { subtype: 'interrupt' },
      user: { type: 'user', session_id: '', message: { role: 'user', content: 'prompt' } },
    },
    {
      provider: 'claude',
      initialize: { subtype: 'initialize' },
      user: { type: 'user', session_id: '', message: { role: 'assistant', content: 'prompt' } },
    },
  ])(
    'rejects malformed captured startup commands before touching the native journal',
    async (plan) => {
      const directory = await temporary()
      const store = await start(directory)
      const base = descriptor()
      const provider = plan.provider as 'codex' | 'claude'
      const transport = {
        ...base,
        provider,
        owners: [
          {
            ...base.owners[0],
            input: { ...base.owners[0].input, provider },
            nativeStartPlan: plan,
          },
        ],
      }
      await expect(run(store.createTransport(transport as never))).rejects.toMatchObject({
        reason: 'invalid',
      })
      expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
    },
  )

  it('refuses a captured plan for another provider without replacing the existing native owner', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    const before = await readFile(journalPath(directory, transport.id))
    await expect(
      run(
        store.updateTransport(transport.id, {
          owners: [
            {
              ...transport.owners[0],
              nativeStartPlan: {
                provider: 'claude',
                initialize: { subtype: 'initialize' },
                user: {
                  type: 'user',
                  session_id: '',
                  message: { role: 'user', content: 'prompt' },
                },
                controls: [{ request: { subtype: 'set_permission_mode', mode: 'plan' } }],
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'ownership' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(before)
  })

  it('preserves cancellation uncertainty rather than silently skipping a numbered command', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    await run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner))
    await run(store.cancelInput(id, 1, 'User cancelled before certainty.'))
    await expect(run(store.reconcileInputHighWater(id, 0))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    expect(await run(store.reconcileInputHighWater(id, 1))).toEqual([])
  })

  it('retains stable native event IDs, original permission IDs, reducer tails and exact history acknowledgments', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    await run(store.appendOutputs(id, [frame(1, '{"approval":true}\n')]))
    const approval = {
      eventId: 'transport:cursor1:event0',
      outputCursor: 1,
      nativeRequestId: 17,
      emittedAtMs: 1234,
      event: {
        sessionId: 'life-session',
        type: 'approval',
        requestId: 'stable-ui-request',
        details: { nativeRequestId: 17, future: [null, 'opaque'] },
      },
    }
    const first = await run(store.appendEvents(id, [approval]))
    expect(first[0].revision).toBe(1)
    expect(await run(store.appendEvents(id, [approval]))).toEqual(first)
    await expect(
      run(store.appendEvents(id, [{ ...approval, nativeRequestId: 18 }])),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await run(
      store.checkpoint(id, {
        throughOutputCursor: 1,
        throughEventRevision: 1,
        reducerState: { pending: [17], turn: 'native-turn' },
        parserTail: {
          stdoutBase64: '8J8=',
          stderrBase64: '',
          decoderState: { utf8IncompleteBytes: 2 },
        },
      }),
    )
    const ack = {
      consumerId: 'main-renderer',
      sessionId: 'life-session',
      snapshotId: 'exact-native-write-42',
      durability: 'admitted-cache' as const,
      throughEventRevision: 1,
    }
    await run(store.acknowledgeHistory(id, ack))
    await run(store.closeEffect())
    const recovered = await start(directory)
    const snapshot = await run(recovered.readTransport(id))
    expect(snapshot.events).toEqual(first)
    expect(snapshot.checkpoint?.parserTail?.stdoutBase64).toBe('8J8=')
    expect(snapshot.historyAcks).toEqual([ack])
    expect(snapshot.outputs).toHaveLength(1)
    expect(snapshot.inputs).toHaveLength(0)
    expect(snapshot.records).toHaveLength(5)
  })

  it.each(['truncated', 'unsupported', 'bad-checksum', 'missing-record'])(
    'never overwrites an existing %s archive',
    async (damage) => {
      const directory = await temporary()
      const store = await start(directory)
      const { id } = descriptor()
      await run(store.createTransport(descriptor()))
      await run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner))
      await run(store.closeEffect())
      const path = journalPath(directory, id)
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
      let damaged: string
      if (damage === 'truncated') damaged = lines.join('\n') + '\n{"unfinished":'
      else if (damage === 'unsupported') {
        const first = JSON.parse(lines[0])
        first.version = 99
        damaged = JSON.stringify(first) + '\n' + lines[1] + '\n'
      } else if (damage === 'bad-checksum')
        damaged = lines.join('\n').replace('codex app-server', 'wrong app-server') + '\n'
      else damaged = lines[1] + '\n'
      await writeFile(path, damaged)
      const recovered = await start(directory)
      await expect(run(recovered.readTransport(id))).rejects.toMatchObject({
        reason: damage === 'unsupported' ? 'unsupported' : 'corrupt',
      })
      await expect(run(recovered.createTransport(descriptor()))).rejects.toMatchObject({
        reason: 'io',
      })
      expect(await readFile(path, 'utf8')).toBe(damaged)
    },
  )

  it('poisons a failed disk writer and does not allocate more mutation sequence numbers', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    const path = journalPath(directory, id)
    await rm(path)
    await expect(
      run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner)),
    ).rejects.toMatchObject({ reason: 'io' })
    await writeFile(path, 'Original unreadable evidence.\n')
    await expect(
      run(store.reserveInput(id, { type: 'write', data: 'Mg==' }, inputOwner)),
    ).rejects.toMatchObject({ reason: 'io' })
    expect(await readFile(path, 'utf8')).toBe('Original unreadable evidence.\n')
  })

  it('fails every batched waiter and poisons admission when a file finalizer fails after sync', async () => {
    const directory = await temporary()
    const store = await start(directory, 30)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    const path = journalPath(directory, id)
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args)
      if (args[0] === path && args[1] === 'r+') {
        const close = file.close.bind(file)
        file.close = async () => {
          await close()
          throw new Error('Injected close failure after sync')
        }
      }
      return file
    })
    const pending = [
      run(store.appendOutputs(id, [frame(1, 'raw bytes')])),
      run(
        store.appendEvents(id, [
          {
            eventId: 'stable-event',
            outputCursor: 1,
            event: { sessionId: 'life-session', type: 'text', text: 'raw bytes' },
          },
        ]),
      ),
    ]
    const results = await Promise.allSettled(pending)
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ reason: 'io' })
    await expect(
      run(store.reserveInput(id, { type: 'write', data: 'MQ==' }, inputOwner)),
    ).rejects.toMatchObject({ reason: 'io' })
    await expect(run(store.closeEffect())).rejects.toMatchObject({ reason: 'io' })
    vi.mocked(open).mockImplementation(actualFs.open)
    const recovered = await start(directory)
    const snapshot = await run(recovered.readTransport(id))
    expect(snapshot.outputs).toEqual([frame(1, 'raw bytes')])
    expect(snapshot.events[0].eventId).toBe('stable-event')
  })

  it('cleans an acquired lease when directory sync fails before constructor completion', async () => {
    const directory = await temporary()
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args)
      if (args[0] === directory)
        file.sync = async () => {
          throw new Error('Injected directory sync failure')
        }
      return file
    })
    await expect(start(directory)).rejects.toMatchObject({ reason: 'io' })
    expect(await readdir(directory)).not.toContain('.writer.lock')
    vi.mocked(open).mockImplementation(actualFs.open)
    const store = await start(directory)
    await run(store.createTransport(descriptor()))
  })

  it('rejects getters, forged symbols, callable hooks and mismatched workspace ownership without executing them', async () => {
    const directory = await temporary()
    const store = await start(directory)
    let calls = 0
    const getter = descriptor()
    Object.defineProperty(getter, 'providerVersion', {
      get() {
        calls++
        return 'untrusted'
      },
      enumerable: true,
    })
    await expect(run(store.createTransport(getter))).rejects.toMatchObject({ reason: 'invalid' })
    const symbol = descriptor()
    Object.defineProperty(symbol, Symbol('ownership'), { value: true })
    await expect(run(store.createTransport(symbol))).rejects.toMatchObject({ reason: 'invalid' })
    const callable = descriptor()
    Object.defineProperty(callable.owners[0].input, 'toJSON', {
      value: () => {
        calls++
        return {}
      },
      enumerable: true,
    })
    await expect(run(store.createTransport(callable))).rejects.toMatchObject({ reason: 'invalid' })
    const wrong = descriptor()
    Object.defineProperty(wrong.owners[0].input, 'workspace', {
      value: '/foreign',
      enumerable: true,
    })
    await expect(run(store.createTransport(wrong))).rejects.toMatchObject({ reason: 'ownership' })
    expect(calls).toBe(0)
    expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
  })

  it('keeps returned snapshots detached from internal ownership and refuses identity-changing patches', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const { id } = descriptor()
    const snapshot = await run(store.createTransport(descriptor()))
    Object.defineProperty(snapshot.transport, 'launchCommand', {
      value: 'foreign',
      enumerable: true,
    })
    expect((await run(store.readTransport(id))).transport.launchCommand).toBe('codex app-server')
    await expect(run(store.updateTransport(id, { id: 'foreign' } as never))).rejects.toMatchObject({
      reason: 'invalid',
    })
    expect((await run(store.readTransport(id))).transport.id).toBe(id)
  })

  it('shares immutable committed entries while detaching snapshot prefixes and current owners', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    const first = await run(store.createTransport(transport))
    const second = await run(store.readTransport(transport.id))
    expect(second.records).not.toBe(first.records)
    expect(second.records[0]).toBe(first.records[0])
    const creation = first.records[0]
    expect(creation.kind).toBe('create')
    if (creation.kind !== 'create') throw new Error('Missing original creation record')
    expect(() =>
      Object.defineProperty(creation.transport.owners[0].input, 'prompt', { value: 'foreign' }),
    ).toThrow(TypeError)
    expect(() =>
      Object.defineProperty(first.records, '0', { value: { kind: 'foreign' } }),
    ).not.toThrow()
    Object.defineProperty(second.transport.owners[0].input, 'prompt', { value: 'detached edit' })
    await run(
      store.updateTransport(transport.id, { controller: { id: 'next-controller', epoch: 2 } }),
    )
    const next = await run(store.readTransport(transport.id))
    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(1)
    expect(next.records).toHaveLength(2)
    expect(next.records[0]).toBe(second.records[0])
    expect(next.transport.owners[0].input.prompt).toBe(transport.owners[0].input.prompt)
    expect(creation.transport.owners[0].input.prompt).toBe(transport.owners[0].input.prompt)
    expect(second.transport.controller.epoch).toBe(1)
    expect(next.transport.controller.epoch).toBe(2)
    await run(store.closeEffect())
    const restored = await start(directory)
    const replayed = await run(restored.readTransport(transport.id))
    expect(replayed.records).toEqual(next.records)
    expect(replayed.transport).toEqual(next.transport)
    expect(() => Object.defineProperty(replayed.records[1], 'revision', { value: 999 })).toThrow(
      TypeError,
    )
  })

  it('rejects a second live local writer and releases ownership on explicit close', async () => {
    const directory = await temporary()
    const first = await start(directory)
    await expect(start(directory)).rejects.toMatchObject({ reason: 'ownership' })
    await run(first.closeEffect())
    const second = await start(directory)
    await run(second.createTransport(descriptor()))
    expect(await run(second.listTransports())).toHaveLength(1)
  })

  it.each(['replaced', 'missing', 'malformed'])(
    'blocks mutation before opening a journal after its directory lease is %s',
    async (damage) => {
      const directory = await temporary()
      const store = await start(directory)
      const transport = descriptor()
      await run(store.createTransport(transport))
      const path = journalPath(directory, transport.id)
      const original = await readFile(path)
      const ownerPath = join(directory, '.writer.lock', 'owner.json')
      const originalLease = await readFile(ownerPath)
      if (damage === 'missing') await rm(ownerPath)
      else
        await writeFile(
          ownerPath,
          damage === 'malformed'
            ? 'not-json'
            : JSON.stringify({ pid: process.pid, token: 'different-live-owner' }),
        )
      await expect(
        run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner)),
      ).rejects.toMatchObject({ reason: 'ownership' })
      expect(
        vi.mocked(open).mock.calls.filter(([file, flags]) => file === path && flags === 'r+'),
      ).toEqual([])
      expect(await readFile(path)).toEqual(original)
      await expect(run(store.closeEffect())).rejects.toMatchObject({ reason: 'ownership' })
      if (damage !== 'missing')
        expect(await readFile(ownerPath, 'utf8')).toBe(
          damage === 'malformed'
            ? 'not-json'
            : JSON.stringify({ pid: process.pid, token: 'different-live-owner' }),
        )
      await writeFile(ownerPath, originalLease)
    },
  )

  it('requires current directory ownership before returning unresolved original inputs for resend', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    await run(store.reserveInput(transport.id, { type: 'write', data: 'MQ==' }, inputOwner))
    const path = journalPath(directory, transport.id)
    const original = await readFile(path)
    const ownerPath = join(directory, '.writer.lock', 'owner.json')
    const originalLease = await readFile(ownerPath)
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: 'different-live-owner' }))
    await expect(run(store.reconcileInputHighWater(transport.id, 0))).rejects.toMatchObject({
      reason: 'ownership',
    })
    expect(await readFile(path)).toEqual(original)
    await writeFile(ownerPath, originalLease)
  })

  it('keeps an unverifiable lease intact and reclaims only an authoritatively dead owner', async () => {
    const directory = await temporary()
    const lock = join(directory, '.writer.lock')
    await mkdir(lock)
    await writeFile(join(lock, 'owner.json'), 'not-json')
    await expect(start(directory)).rejects.toMatchObject({ reason: 'ownership' })
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe('not-json')
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2147483647, token: 'dead-owner' }),
    )
    await expect(start(directory)).rejects.toMatchObject({ reason: 'ownership' })
    const recovered = await start(directory, 10, true)
    await run(recovered.createTransport(descriptor()))
  })

  it('preserves a foreign lease that replaces a dead owner between observation and rename', async () => {
    const directory = await temporary()
    const lock = join(directory, '.writer.lock')
    await mkdir(lock)
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2147483647, token: 'dead-owner' }),
    )
    const foreign = JSON.stringify({ pid: process.pid, token: 'new-live-foreign-owner' })
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (from === lock) await writeFile(join(lock, 'owner.json'), foreign)
      return actualFs.rename(from, to)
    })
    await expect(start(directory, 10, true)).rejects.toMatchObject({ reason: 'ownership' })
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(foreign)
    expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
  })

  it.each(['missing', 'malformed', 'unsupported'])(
    'preserves the admission barrier when renamed lease metadata becomes %s',
    async (damage) => {
      const directory = await temporary()
      const lock = join(directory, '.writer.lock')
      await mkdir(lock)
      await writeFile(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: 2147483647, token: 'dead-owner' }),
      )
      await writeFile(join(lock, 'opaque.txt'), 'Original unknown ownership data.')
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (from === lock) {
          if (damage === 'missing') await rm(join(lock, 'owner.json'))
          else
            await writeFile(
              join(lock, 'owner.json'),
              damage === 'malformed'
                ? '{broken'
                : JSON.stringify({
                    pid: process.pid,
                    token: 'future-live-owner',
                    futureVersion: 99,
                  }),
            )
        }
        return actualFs.rename(from, to)
      })
      await expect(start(directory, 10, true)).rejects.toMatchObject({ reason: 'ownership' })
      expect(await readFile(join(lock, 'opaque.txt'), 'utf8')).toBe(
        'Original unknown ownership data.',
      )
      vi.mocked(rename).mockImplementation(actualFs.rename)
      await expect(start(directory, 10, true)).rejects.toMatchObject({
        reason: damage === 'unsupported' ? 'invalid' : 'ownership',
      })
      expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
    },
  )

  it('keeps delayed history acknowledgments separate for each private owner generation', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(
      store.createTransport({
        ...transport,
        owners: [{ ...transport.owners[0], snapshotToken: 'old-token', generation: 1 }],
      }),
    )
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'first',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'status', status: 'running' },
        },
      ]),
    )
    await run(
      store.updateTransport(transport.id, {
        owners: [{ ...transport.owners[0], snapshotToken: 'new-token', generation: 2 }],
      }),
    )
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'second',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'complete' },
        },
      ]),
    )
    const base = {
      consumerId: 'studio:life-session',
      sessionId: 'life-session',
      durability: 'admitted-cache' as const,
    }
    const newer = {
      ...base,
      snapshotId: 'newer-cache-write',
      snapshotToken: 'new-token',
      ownerGeneration: 2,
      throughEventRevision: 2,
    }
    const older = {
      ...base,
      snapshotId: 'delayed-older-cache-write',
      snapshotToken: 'old-token',
      ownerGeneration: 1,
      throughEventRevision: 1,
    }
    await run(store.acknowledgeHistory(transport.id, newer))
    await run(store.acknowledgeHistory(transport.id, older))
    expect((await run(store.readTransport(transport.id))).historyAcks).toEqual([newer, older])
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).historyAcks).toEqual([newer, older])
  })

  it('durably prepares exact history bytes before acknowledgment and accepts only the matching private tuple', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(
      store.createTransport({
        ...transport,
        owners: [{ ...transport.owners[0], snapshotToken: 'private-owner-token', generation: 1 }],
      }),
    )
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'native-event',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'text', text: 'exact response' },
        },
      ]),
    )
    const owner = {
      consumerId: 'main:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-owner-token',
      ownerGeneration: 1,
      throughEventRevision: 1,
      authority: 'native-delivery' as const,
    }
    const prepare = {
      snapshotId: 'worker-write-42',
      fileHash: createHash('sha256').update('{"savedAt":42,"threads":[]}').digest('hex'),
      owners: [owner],
    }
    await run(store.prepareHistory(transport.id, prepare))
    const preparedBytes = await readFile(journalPath(directory, transport.id))
    expect((await run(store.readTransport(transport.id))).historyAcks).toEqual([])
    await run(store.prepareHistory(transport.id, prepare))
    expect(await readFile(journalPath(directory, transport.id))).toEqual(preparedBytes)
    await expect(
      run(store.prepareHistory(transport.id, { ...prepare, fileHash: 'a'.repeat(64) })),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).historyPrepares).toEqual([prepare])
    const { authority: _authority, ...privateOwner } = owner
    const ack = {
      ...privateOwner,
      snapshotId: prepare.snapshotId,
      fileHash: prepare.fileHash,
      durability: 'native' as const,
    }
    for (const invalid of [
      { ...ack, fileHash: 'b'.repeat(64) },
      { ...ack, snapshotId: 'different-write' },
      { ...ack, snapshotToken: 'forged-owner-token' },
      { ...ack, ownerGeneration: 2 },
      { ...ack, throughEventRevision: 0 },
    ])
      await expect(run(recovered.acknowledgeHistory(transport.id, invalid))).rejects.toMatchObject({
        reason: 'uncertain',
      })
    await expect(
      run(recovered.acknowledgeHistory(transport.id, { ...ack, fileHash: undefined } as never)),
    ).rejects.toMatchObject({ reason: 'invalid' })
    expect((await run(recovered.readTransport(transport.id))).historyAcks).toEqual([])
    await run(recovered.acknowledgeHistory(transport.id, ack))
    const acknowledgedBytes = await readFile(journalPath(directory, transport.id))
    await run(recovered.acknowledgeHistory(transport.id, ack))
    expect(await readFile(journalPath(directory, transport.id))).toEqual(acknowledgedBytes)
    const state = await run(recovered.readTransport(transport.id))
    expect(state.historyAcks).toEqual([ack])
    expect(state.records.map((record) => record.kind)).toEqual([
      'create',
      'event',
      'history-prepare',
      'history-ack',
    ])
  })

  it('rejects history preparation from raw claims and requires actual earlier private ACK authority', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(
      store.createTransport({
        ...transport,
        owners: [{ ...transport.owners[0], snapshotToken: 'private-owner-token', generation: 1 }],
      }),
    )
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'native-event',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'text', text: 'exact response' },
        },
      ]),
    )
    const owner = {
      consumerId: 'studio:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-owner-token',
      ownerGeneration: 1,
      throughEventRevision: 1,
      authority: 'private-ack' as const,
    }
    const prepare = {
      snapshotId: 'prepared-cache-derived-write',
      fileHash: 'a'.repeat(64),
      location: 'studio-cache' as const,
      owners: [owner],
    }
    await expect(run(store.prepareHistory(transport.id, prepare))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await expect(
      run(
        store.prepareHistory(transport.id, {
          ...prepare,
          owners: [{ ...owner, authority: 'native-delivery', snapshotToken: 'raw-archive-claim' }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await expect(
      run(
        store.prepareHistory(transport.id, {
          ...prepare,
          owners: [{ ...owner, authority: 'native-delivery', throughEventRevision: 2 }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    const priorPrepare = {
      snapshotId: 'actual-cache-write',
      fileHash: 'b'.repeat(64),
      location: 'studio-cache' as const,
      owners: [{ ...owner, authority: 'native-delivery' as const }],
    }
    await run(store.prepareHistory(transport.id, priorPrepare))
    await run(
      store.acknowledgeHistory(transport.id, {
        consumerId: owner.consumerId,
        sessionId: owner.sessionId,
        snapshotToken: owner.snapshotToken,
        ownerGeneration: owner.ownerGeneration,
        throughEventRevision: 1,
        snapshotId: 'actual-cache-write',
        fileHash: priorPrepare.fileHash,
        durability: 'admitted-cache',
      }),
    )
    await run(store.prepareHistory(transport.id, prepare))
    expect((await run(store.readTransport(transport.id))).historyPrepares).toEqual([
      priorPrepare,
      prepare,
    ])
  })

  it('keeps browser cache hashes separate from native file receipts even for otherwise exact main owner tuples', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
    }
    await run(store.createTransport(transport))
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'event',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'text', text: 'response' },
        },
      ]),
    )
    const owner = {
      consumerId: 'main:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-token',
      ownerGeneration: 1,
      throughEventRevision: 1,
      authority: 'native-delivery' as const,
    }
    const { authority: _authority, ...tuple } = owner
    for (const location of ['studio-cache', 'main-cache'] as const) {
      const prepare = {
        snapshotId: `cache-${location}`,
        fileHash: 'a'.repeat(64),
        location,
        owners: [owner],
      }
      await run(store.prepareHistory(transport.id, prepare))
      await expect(
        run(
          store.acknowledgeHistory(transport.id, {
            ...tuple,
            snapshotId: prepare.snapshotId,
            fileHash: prepare.fileHash,
            durability: 'native',
          }),
        ),
      ).rejects.toMatchObject({ reason: 'uncertain' })
    }
    const nativePrepare = {
      snapshotId: 'actual-native-file',
      fileHash: 'a'.repeat(64),
      location: 'native-file' as const,
      owners: [owner],
    }
    await run(store.prepareHistory(transport.id, nativePrepare))
    await run(
      store.acknowledgeHistory(transport.id, {
        ...tuple,
        snapshotId: nativePrepare.snapshotId,
        fileHash: nativePrepare.fileHash,
        durability: 'native',
      }),
    )
    expect((await run(store.readTransport(transport.id))).historyAcks).toHaveLength(1)
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect(
      (await run(recovered.readTransport(transport.id))).historyPrepares.map(
        (prepare) => prepare.location,
      ),
    ).toEqual(['studio-cache', 'main-cache', 'native-file'])
  })

  it('retains the original main-cache savedAt only on the exact durable preparation without inferring a legacy clock', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
    }
    await run(store.createTransport(transport))
    const owner = {
      consumerId: 'main-cache:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-token',
      ownerGeneration: 1,
      throughEventRevision: 0,
      authority: 'native-delivery' as const,
    }
    const prepare = {
      snapshotId: 'cache-with-private-clock',
      fileHash: 'a'.repeat(64),
      location: 'main-cache' as const,
      savedAt: 73,
      owners: [owner],
    }
    await run(store.prepareHistory(transport.id, prepare))
    const committed = await readFile(journalPath(directory, transport.id))
    await expect(
      run(store.prepareHistory(transport.id, { ...prepare, savedAt: 74 })),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(committed)
    const { savedAt: _savedAt, ...legacy } = prepare
    await run(
      store.prepareHistory(transport.id, {
        ...legacy,
        snapshotId: 'legacy-no-private-clock',
        fileHash: 'b'.repeat(64),
      }),
    )
    await run(store.closeEffect())
    const recovered = await start(directory)
    const preparations = (await run(recovered.readTransport(transport.id))).historyPrepares
    expect(preparations[0]).toEqual(prepare)
    expect(preparations[1].savedAt).toBeUndefined()
    expect((await run(recovered.readTransport(transport.id))).historyAcks).toEqual([])
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '73'])(
    'rejects noncanonical main-cache clock %s without writing a preparation',
    async (savedAt) => {
      const directory = await temporary()
      const store = await start(directory)
      const base = descriptor()
      const transport = {
        ...base,
        owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
      }
      await run(store.createTransport(transport))
      const original = await readFile(journalPath(directory, transport.id))
      await expect(
        run(
          store.prepareHistory(transport.id, {
            snapshotId: 'invalid-clock',
            fileHash: 'a'.repeat(64),
            location: 'main-cache',
            savedAt,
            owners: [
              {
                consumerId: 'main-cache:life-session',
                sessionId: 'life-session',
                snapshotToken: 'private-token',
                ownerGeneration: 1,
                throughEventRevision: 0,
                authority: 'native-delivery',
              },
            ],
          } as never),
        ),
      ).rejects.toMatchObject({ reason: 'invalid' })
      expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    },
  )

  it('retains private main-cache deletion membership without creating a history cursor or acknowledgment', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
    }
    await run(store.createTransport(transport))
    const owner = {
      consumerId: 'main-cache:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-token',
      ownerGeneration: 1,
      throughEventRevision: 0,
      authority: 'native-delivery' as const,
      absent: true as const,
    }
    const prepare = {
      snapshotId: 'all-owned-threads-deleted',
      fileHash: createHash('sha256').update('[]').digest('hex'),
      location: 'main-cache' as const,
      savedAt: 73,
      owners: [owner],
    }
    for (const unproven of [
      { ...owner, snapshotToken: 'raw-cache-claim' },
      { ...owner, throughEventRevision: 1 },
    ])
      await expect(
        run(store.prepareHistory(transport.id, { ...prepare, owners: [unproven] })),
      ).rejects.toMatchObject({ reason: 'uncertain' })
    await run(store.prepareHistory(transport.id, prepare))
    const committed = await readFile(journalPath(directory, transport.id))
    await run(store.prepareHistory(transport.id, prepare))
    expect(await readFile(journalPath(directory, transport.id))).toEqual(committed)
    const { absent: _absent, authority: _authority, ...tuple } = owner
    await expect(
      run(
        store.prepareHistory(transport.id, {
          ...prepare,
          owners: [{ ...tuple, authority: 'native-delivery' }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'uncertain' })
    await run(store.closeEffect())
    const recovered = await start(directory)
    for (const ack of [
      { ...tuple, durability: 'admitted-cache' as const },
      { ...tuple, consumerId: 'main:life-session', durability: 'native' as const },
      { ...tuple, consumerId: 'studio:life-session', durability: 'admitted-cache' as const },
    ])
      await expect(
        run(
          recovered.acknowledgeHistory(transport.id, {
            ...ack,
            snapshotId: prepare.snapshotId,
            fileHash: prepare.fileHash,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'uncertain' })
    const state = await run(recovered.readTransport(transport.id))
    expect(state.historyPrepares).toEqual([prepare])
    expect(state.historyAcks).toEqual([])
    expect(state.eventRevision).toBe(0)
    expect(state.records.map((record) => record.kind)).toEqual(['create', 'history-prepare'])
    expect(await readFile(journalPath(directory, transport.id))).toEqual(committed)
  })

  it('rejects deletion membership outside its private main-cache location and consumer', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
    }
    await run(store.createTransport(transport))
    const original = await readFile(journalPath(directory, transport.id))
    const owner = {
      consumerId: 'main-cache:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-token',
      ownerGeneration: 1,
      throughEventRevision: 0,
      authority: 'native-delivery' as const,
      absent: true as const,
    }
    const prepare = {
      snapshotId: 'forged-deletion-membership',
      fileHash: 'a'.repeat(64),
      savedAt: 73,
      owners: [owner],
    }
    for (const invalid of [
      prepare,
      { ...prepare, location: 'native-file' as const },
      { ...prepare, location: 'studio-cache' as const },
      {
        ...prepare,
        location: 'main-cache' as const,
        owners: [{ ...owner, consumerId: 'main:life-session' }],
      },
      {
        ...prepare,
        location: 'main-cache' as const,
        owners: [{ ...owner, consumerId: 'main-cache:different-session' }],
      },
    ])
      await expect(run(store.prepareHistory(transport.id, invalid))).rejects.toMatchObject({
        reason: 'uncertain',
      })
    for (const absent of [false, 'true'])
      await expect(
        run(
          store.prepareHistory(transport.id, {
            ...prepare,
            location: 'main-cache',
            owners: [{ ...owner, absent }],
          } as never),
        ),
      ).rejects.toMatchObject({ reason: 'invalid' })
    expect(await readFile(journalPath(directory, transport.id))).toEqual(original)
    expect((await run(store.readTransport(transport.id))).historyPrepares).toEqual([])
  })

  it('excludes legacy cache claims from private authority and from the monotonic barrier of a lower proven receipt', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const base = descriptor()
    const transport = {
      ...base,
      owners: [{ ...base.owners[0], snapshotToken: 'private-token', generation: 1 }],
    }
    await run(store.createTransport(transport))
    await run(
      store.appendEvents(
        transport.id,
        [1, 2].map((revision) => ({
          eventId: 'event-' + revision,
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'text', text: String(revision) },
        })),
      ),
    )
    const tuple = {
      consumerId: 'studio:life-session',
      sessionId: 'life-session',
      snapshotToken: 'private-token',
      ownerGeneration: 1,
    }
    await run(
      store.acknowledgeHistory(transport.id, {
        ...tuple,
        snapshotId: 'legacy-cache-claim',
        throughEventRevision: 2,
        durability: 'admitted-cache',
      }),
    )
    const forged = {
      snapshotId: 'legacy-derived',
      fileHash: 'a'.repeat(64),
      location: 'studio-cache' as const,
      owners: [{ ...tuple, throughEventRevision: 2, authority: 'private-ack' as const }],
    }
    await expect(run(store.prepareHistory(transport.id, forged))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    const proven = {
      snapshotId: 'actual-cache-write',
      fileHash: 'b'.repeat(64),
      location: 'studio-cache' as const,
      owners: [{ ...tuple, throughEventRevision: 1, authority: 'native-delivery' as const }],
    }
    await run(store.prepareHistory(transport.id, proven))
    await run(
      store.acknowledgeHistory(transport.id, {
        ...tuple,
        snapshotId: proven.snapshotId,
        fileHash: proven.fileHash,
        throughEventRevision: 1,
        durability: 'admitted-cache',
      }),
    )
    const state = await run(store.readTransport(transport.id))
    expect(state.historyAcks.map((ack) => ack.throughEventRevision)).toEqual([2, 1])
    await expect(run(store.prepareHistory(transport.id, forged))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await run(
      store.prepareHistory(transport.id, {
        ...forged,
        snapshotId: 'actual-private-ack-derived',
        owners: [{ ...tuple, throughEventRevision: 1, authority: 'private-ack' }],
      }),
    )
    await run(store.closeEffect())
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).historyAcks).toEqual(
      state.historyAcks,
    )
  })

  it('reads legacy native ACK archives without admitting a new unprepared native ACK', async () => {
    const directory = await temporary()
    const store = await start(directory)
    const transport = descriptor()
    await run(store.createTransport(transport))
    await run(
      store.appendEvents(transport.id, [
        {
          eventId: 'legacy-event',
          outputCursor: 0,
          event: { sessionId: 'life-session', type: 'text', text: 'legacy text' },
        },
      ]),
    )
    const ack = {
      consumerId: 'main:life-session',
      sessionId: 'life-session',
      snapshotId: 'legacy-write',
      durability: 'native' as const,
      throughEventRevision: 1,
    }
    await expect(run(store.acknowledgeHistory(transport.id, ack))).rejects.toMatchObject({
      reason: 'uncertain',
    })
    await run(store.closeEffect())
    const path = journalPath(directory, transport.id)
    const text = await readFile(path, 'utf8')
    const batches = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const prior = batches.at(-1)
    const payload = {
      format: 'life-native-recovery',
      version: 1,
      index: prior.index + 1,
      previousHash: prior.hash,
      records: [{ kind: 'history-ack', ack, revision: 3 }],
    }
    await writeFile(
      path,
      text +
        JSON.stringify({
          ...payload,
          hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        }) +
        '\n',
    )
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(transport.id))).historyAcks).toEqual([ack])
    expect((await run(recovered.readTransport(transport.id))).historyPrepares).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(
      text +
        JSON.stringify({
          ...payload,
          hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        }) +
        '\n',
    )
  })

  it('admits only one same-process contender when recovering an exclusively owned stale lease', async () => {
    const directory = await temporary()
    const lock = join(directory, '.writer.lock')
    await mkdir(lock)
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2147483647, token: 'dead-owner' }),
    )
    const results = await Promise.allSettled([
      start(directory, 10, true),
      start(directory, 10, true),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ reason: 'ownership' })
    const admitted = results.find(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<NativeRecoveryStoreHandle>
    await run(admitted.value.createTransport(descriptor()))
  })

  it('flushes queued raw output on scope closure and rejects access after closure', async () => {
    const directory = await temporary()
    const store = await start(directory, 10000)
    const { id } = descriptor()
    await run(store.createTransport(descriptor()))
    const queued = run(store.appendOutputs(id, [frame(1, 'last pending bytes')]))
    await new Promise((resolve) => setImmediate(resolve))
    await run(store.closeEffect())
    expect(await queued).toBe(1)
    await expect(run(store.readTransport(id))).rejects.toMatchObject({ reason: 'closed' })
    const recovered = await start(directory)
    expect((await run(recovered.readTransport(id))).outputs).toEqual([
      frame(1, 'last pending bytes'),
    ])
  })
})
