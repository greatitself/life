import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect, Exit, Scope } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NativeRecoveryActions,
  NativeRecoveryActionError,
  nativeRecoveryActionIntentHash,
  type NativeRecoveryActionDriver,
  type NativeRecoveryActionRequest,
  type NativeRecoveryActionsHandle,
} from '../src/main/native-recovery-actions'

const directories: string[] = []
const scopes: Scope.Closeable[] = []
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
afterEach(async () => {
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const request = (
  change: Partial<NativeRecoveryActionRequest> = {},
): NativeRecoveryActionRequest => ({
  actionId: 'source-action',
  transportId: 'native-transport',
  sessionId: 'studio-session',
  ownerGeneration: 3,
  kind: 'source-apply',
  intent: {
    patch: {
      summary: 'Exact\r\nproposal 🌍\ud800',
      baseRevision: 0,
      files: [{ path: 'src/renderer/control.ts', content: 'exact\r\n🌍\ud800' }],
    },
  },
  ...change,
})
const actionPath = (directory: string, id = 'source-action') =>
  join(directory, createHash('sha256').update(id).digest('hex') + '.json')
async function start(
  driver: NativeRecoveryActionDriver,
  directory?: string,
  exclusiveRuntime = false,
): Promise<{ store: NativeRecoveryActionsHandle; directory: string }> {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), 'life-native-actions-'))
    directories.push(directory)
  }
  const scope = await run(Scope.make())
  scopes.push(scope)
  const store = await run(
    NativeRecoveryActions.make({
      directory,
      exclusiveRuntime,
      drivers: {
        'source-read': driver,
        'source-apply': driver,
        'settings-apply': driver,
        'extension-apply': driver,
        reload: driver,
      },
    }).pipe(Scope.provide(scope)),
  )
  return { store, directory }
}
const unknownDriver: NativeRecoveryActionDriver = {
  execute: () => Effect.succeed(undefined),
  reconcile: () => Effect.succeed({ status: 'unknown' }),
}
async function interruptStarted(
  store: NativeRecoveryActionsHandle,
  action: NativeRecoveryActionRequest,
  started: Deferred.Deferred<void>,
) {
  const controller = new AbortController()
  const ongoing = Effect.runPromiseExit(store.perform(action), { signal: controller.signal })
  await run(Deferred.await(started))
  controller.abort()
  expect(Exit.isFailure(await ongoing)).toBe(true)
}

describe('native Studio action durability', () => {
  it('commits exact intent before the driver and retains an original receipt across reopen', async () => {
    let executions = 0
    let directory = ''
    const action = request()
    const setup = await start({
      prepare: () => Effect.succeed({ baseRevision: 0 }),
      execute: Effect.fnUntraced(function* (actual, prepared, intentHash) {
        executions++
        const saved = JSON.parse(
          yield* Effect.promise(() => readFile(actionPath(directory), 'utf8')),
        )
        expect(saved.record.status).toBe('started')
        expect(saved.record.request).toEqual(action)
        expect(saved.record.prepared).toEqual(prepared)
        expect(saved.record.intentHash).toBe(intentHash)
        return { snapshot: { revision: 1, exact: actual.intent.patch } }
      }),
      reconcile: unknownDriver.reconcile,
    })
    directory = setup.directory
    const original = await run(setup.store.perform(action))
    expect(original.status).toBe('succeeded')
    expect(original.receipt?.native).toEqual(original.native)
    await run(setup.store.closeEffect())
    const recovered = await start(
      {
        execute: () => {
          throw new Error('Must not repeat a completed source build.')
        },
        reconcile: unknownDriver.reconcile,
      },
      directory,
    )
    expect(await run(recovered.store.perform(action))).toEqual(original)
    expect(await run(recovered.store.read(action))).toEqual(original)
    expect(executions).toBe(1)
  })

  it('coalesces simultaneous identical requests and rejects intent or owner collisions before execution', async () => {
    let executions = 0
    const { store } = await start({
      execute: () =>
        Effect.sleep(5).pipe(
          Effect.andThen(
            Effect.sync(() => {
              executions++
              return { snapshot: { revision: 1 } }
            }),
          ),
        ),
      reconcile: unknownDriver.reconcile,
    })
    const action = request()
    const results = await run(
      Effect.all([store.perform(action), store.perform(action), store.perform(action)], {
        concurrency: 'unbounded',
      }),
    )
    expect(results.every((value) => JSON.stringify(value) === JSON.stringify(results[0]))).toBe(
      true,
    )
    expect(executions).toBe(1)
    for (const changed of [
      request({ intent: { patch: { text: 'another proposal' } } }),
      request({ ownerGeneration: 4 }),
      request({ transportId: 'foreign' }),
      request({ sessionId: 'foreign' }),
      request({ kind: 'settings-apply' }),
    ])
      await expect(run(store.perform(changed))).rejects.toMatchObject({ reason: 'collision' })
    expect(executions).toBe(1)
  })

  it('runs a proven intended action after reopening and never starts it during reconciliation', async () => {
    let executions = 0
    const driver: NativeRecoveryActionDriver = {
      execute: () =>
        Effect.sync(() => {
          executions++
          return undefined
        }),
      reconcile: unknownDriver.reconcile,
    }
    const { store, directory } = await start(driver)
    expect((await run(store.prepare(request()))).status).toBe('intended')
    expect((await run(store.reconcile(request()))).status).toBe('intended')
    expect(executions).toBe(0)
    await run(store.closeEffect())
    const recovered = await start(driver, directory)
    expect((await run(recovered.store.perform(request()))).status).toBe('succeeded')
    expect(executions).toBe(1)
  })

  it('retains started work when its caller disappears, and unknown recovery never repeats it', async () => {
    let executions = 0
    const started = await run(Deferred.make<void>())
    const { store, directory } = await start({
      execute: () =>
        Effect.sync(() => {
          executions++
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      reconcile: unknownDriver.reconcile,
    })
    await interruptStarted(store, request(), started)
    expect((await run(store.read(request())))?.status).toBe('started')
    await run(store.closeEffect())
    const recovered = await start(
      {
        execute: () => {
          executions++
          return Effect.succeed(undefined)
        },
        reconcile: unknownDriver.reconcile,
      },
      directory,
    )
    expect((await run(recovered.store.perform(request()))).status).toBe('unknown')
    expect((await run(recovered.store.perform(request()))).status).toBe('unknown')
    expect(executions).toBe(1)
  })

  it('reconciles a native commit whose caller vanished without reapplying or replacing its original result', async () => {
    const started = await run(Deferred.make<void>())
    let executions = 0
    let committed = false
    const original = { snapshot: { revision: 7, enabled: true } }
    const { store, directory } = await start({
      execute: () =>
        Effect.sync(() => {
          executions++
          committed = true
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      reconcile: () =>
        Effect.succeed(
          committed ? { status: 'succeeded', result: original } : { status: 'unknown' },
        ),
    })
    await interruptStarted(store, request(), started)
    await run(store.closeEffect())
    const recovered = await start(
      {
        execute: () => {
          executions++
          return Effect.succeed({ snapshot: { revision: 99 } })
        },
        reconcile: () => Effect.succeed({ status: 'succeeded', result: original }),
      },
      directory,
    )
    const receipt = await run(recovered.store.perform(request()))
    expect(receipt.receipt?.snapshot).toEqual(original.snapshot)
    expect(executions).toBe(1)
    expect(await run(recovered.store.perform(request()))).toEqual(receipt)
  })

  it('persists known rejection and never retries failed actions', async () => {
    let executions = 0
    const { store } = await start({
      execute: () => {
        executions++
        return Effect.fail(
          new NativeRecoveryActionError({
            operation: 'compile',
            path: '',
            reason: 'rejected',
            message: 'Exact compiler diagnostic\r\n🌍',
          }),
        )
      },
      reconcile: unknownDriver.reconcile,
    })
    const first = await run(store.perform(request()))
    expect(first).toMatchObject({ status: 'failed', error: 'Exact compiler diagnostic\r\n🌍' })
    expect(await run(store.perform(request()))).toEqual(first)
    expect(executions).toBe(1)
  })

  it('keeps ambiguous rejection unknown until authoritative outcome evidence becomes available', async () => {
    let evidence = false
    let executions = 0
    const { store } = await start({
      execute: () => {
        executions++
        return Effect.fail(
          new NativeRecoveryActionError({
            operation: 'apply',
            path: '',
            reason: 'io',
            message: 'Observer disappeared after commit',
          }),
        )
      },
      reconcile: () =>
        Effect.succeed(
          evidence
            ? { status: 'succeeded', result: { snapshot: { revision: 8 } } }
            : { status: 'unknown' },
        ),
    })
    expect((await run(store.perform(request()))).status).toBe('unknown')
    evidence = true
    expect((await run(store.perform(request()))).status).toBe('succeeded')
    expect(executions).toBe(1)
  })

  it('refuses executable, cyclic, sparse and forged receipt data without calling drivers', async () => {
    let executions = 0
    let getterCalls = 0
    const { store } = await start({
      execute: () => {
        executions++
        return Effect.succeed(undefined)
      },
      reconcile: unknownDriver.reconcile,
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'patch', {
      enumerable: true,
      get() {
        getterCalls++
        return {}
      },
    })
    for (const intent of [
      accessor,
      cyclic,
      { patch: () => 1 },
      { patch: [, 'hole'] },
      {
        patch: {
          toJSON() {
            getterCalls++
            return {}
          },
        },
      },
    ])
      await expect(
        run(store.perform(request({ intent: intent as NativeRecoveryActionRequest['intent'] }))),
      ).rejects.toMatchObject({ reason: 'invalid' })
    expect(getterCalls).toBe(0)
    expect(executions).toBe(0)
  })

  it('preserves corrupt and unsupported record bytes and refuses a second writer', async () => {
    const { store, directory } = await start(unknownDriver)
    await expect(start(unknownDriver, directory)).rejects.toMatchObject({ reason: 'ownership' })
    const path = actionPath(directory)
    for (const text of ['{"record":', JSON.stringify({ record: { version: 99 } })]) {
      await writeFile(path, text)
      await expect(run(store.perform(request()))).rejects.toMatchObject({
        reason: text.includes('99') ? 'unsupported' : 'corrupt',
      })
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  })

  it('refuses non-file action paths before external mutation', async () => {
    let executions = 0
    const { store, directory } = await start({
      execute: () => {
        executions++
        return Effect.succeed(undefined)
      },
      reconcile: unknownDriver.reconcile,
    })
    await mkdir(actionPath(directory))
    await expect(run(store.perform(request()))).rejects.toMatchObject({ reason: 'ownership' })
    expect(executions).toBe(0)
  })

  it('requires exclusive native runtime authority before reclaiming a dead writer lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-native-action-lease-'))
    directories.push(directory)
    const lock = join(directory, '.writer.lock')
    await mkdir(lock)
    const path = join(lock, 'owner.json')
    const original = JSON.stringify({ pid: 2147483647, token: 'dead-controller' })
    await writeFile(path, original)
    await expect(start(unknownDriver, directory)).rejects.toMatchObject({ reason: 'ownership' })
    expect(await readFile(path, 'utf8')).toBe(original)
    const { store } = await start(unknownDriver, directory, true)
    expect((await run(store.perform(request()))).status).toBe('succeeded')
  })

  it('queries terminal missing and intended actions without preparation, execution or record writes', async () => {
    let preparations = 0
    let executions = 0
    let reconciliations = 0
    const { store, directory } = await start({
      prepare: () =>
        Effect.sync(() => {
          preparations++
          return {}
        }),
      execute: () =>
        Effect.sync(() => {
          executions++
          return undefined
        }),
      reconcile: () =>
        Effect.sync(() => {
          reconciliations++
          return { status: 'unknown' as const }
        }),
    })
    expect((await run(store.reconcileOnly(request()))).status).toBe('unknown')
    expect(await run(store.read(request()))).toBeUndefined()
    expect(preparations).toBe(0)
    await run(store.prepare(request()))
    const bytes = await readFile(actionPath(directory), 'utf8')
    expect((await run(store.reconcileOnly(request()))).status).toBe('intended')
    expect(await readFile(actionPath(directory), 'utf8')).toBe(bytes)
    expect(preparations).toBe(1)
    expect(executions).toBe(0)
    expect(reconciliations).toBe(0)
  })

  it('returns observed committed facts for terminal actions without changing their stored started state', async () => {
    const started = await run(Deferred.make<void>())
    let reconciliations = 0
    let executions = 0
    const { store, directory } = await start({
      execute: () =>
        Effect.sync(() => {
          executions++
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      reconcile: () =>
        Effect.sync(() => {
          reconciliations++
          return { status: 'unknown' as const }
        }),
      observe: () => Effect.succeed({ status: 'succeeded', result: { snapshot: { revision: 1 } } }),
    })
    await interruptStarted(store, request(), started)
    const bytes = await readFile(actionPath(directory), 'utf8')
    expect((await run(store.reconcileOnly(request()))).status).toBe('succeeded')
    expect(await readFile(actionPath(directory), 'utf8')).toBe(bytes)
    expect((await run(store.read(request())))?.status).toBe('started')
    expect(reconciliations).toBe(0)
    expect(executions).toBe(1)
  })

  it('refuses new effects after its writer token changes', async () => {
    let executions = 0
    const { store, directory } = await start({
      execute: () => {
        executions++
        return Effect.succeed(undefined)
      },
      reconcile: unknownDriver.reconcile,
    })
    const path = join(directory, '.writer.lock/owner.json')
    const original = await readFile(path, 'utf8')
    await writeFile(path, JSON.stringify({ pid: process.pid, token: 'foreign-writer-token' }))
    try {
      await expect(run(store.perform(request()))).rejects.toMatchObject({ reason: 'ownership' })
      expect(executions).toBe(0)
    } finally {
      await writeFile(path, original)
    }
  })

  it('hashes object-key ordering consistently while preserving arrays and exact UTF-16 values', () => {
    const a = request({ intent: { first: 'exact\r\n🌍\ud800', second: ['a', 'b'] } })
    const b = request({ intent: { second: ['a', 'b'], first: 'exact\r\n🌍\ud800' } })
    expect(nativeRecoveryActionIntentHash(a)).toBe(nativeRecoveryActionIntentHash(b))
    expect(nativeRecoveryActionIntentHash(a)).not.toBe(
      nativeRecoveryActionIntentHash(
        request({ intent: { first: 'exact\n🌍\ud800', second: ['a', 'b'] } }),
      ),
    )
    expect(nativeRecoveryActionIntentHash(a)).not.toBe(
      nativeRecoveryActionIntentHash(
        request({ intent: { first: 'exact\r\n🌍\ud800', second: ['b', 'a'] } }),
      ),
    )
  })
})
