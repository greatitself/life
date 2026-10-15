import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, Effect, Exit, Fiber, Scope } from 'effect'
import type { Scheduler, SchedulerDispatcher } from 'effect/Scheduler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativeRecoveryStore,
  type NativeRecoveryStoreHandle,
} from '../src/main/native-recovery-store'
import type { NativeRecoveryTransport } from '../src/main/native-recovery-types'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

class HeldScheduler implements Scheduler {
  readonly executionMode = 'sync'
  readonly tasks: { run: () => void; priority: number }[] = []
  private held = true

  shouldYield() {
    return false
  }

  makeDispatcher(): SchedulerDispatcher {
    return {
      scheduleTask: (run, priority) => {
        if (this.held) this.tasks.push({ run, priority })
        else setImmediate(run)
      },
      flush: () => this.flush(),
    }
  }

  step() {
    this.tasks.sort((a, b) => a.priority - b.priority)
    this.tasks.shift()?.run()
  }

  flush() {
    while (this.tasks.length) this.step()
  }

  release() {
    this.held = false
    this.flush()
  }
}

const directories: string[] = []
const scopes: Scope.Closeable[] = []
const schedulers: HeldScheduler[] = []
const releases: (() => void)[] = []
beforeEach(() => {
  vi.mocked(open).mockImplementation(actualFs.open)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const scheduler of schedulers.splice(0)) scheduler.release()
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

const transport: NativeRecoveryTransport = {
  id: 'ordered-native-output',
  brokerId: 'fixture-broker',
  brokerRoot: '/fixture/.life/agent-sessions/fixture-broker',
  launchCommand: 'codex app-server',
  provider: 'codex',
  providerVersion: '0.162.1',
  nativeProtocol: 'codex-app-server-stdio',
  brokerProtocolVersion: 2,
  machine: { profileId: 'fixture', host: 'fixture', port: 22, username: 'fixture' },
  controller: { id: 'fixture-controller', epoch: 1 },
  initialization: { status: 'pending', requestId: 1 },
  owners: [],
}

const stdout = (cursor: number, text: string) => ({
  type: 'stdout' as const,
  cursor,
  data: Buffer.from(text).toString('base64'),
})

async function start(): Promise<{
  store: NativeRecoveryStoreHandle
  path: string
  scheduler: HeldScheduler
}> {
  const directory = await mkdtemp(join(tmpdir(), 'life-output-admission-'))
  directories.push(directory)
  const scope = await Effect.runPromise(Scope.make())
  scopes.push(scope)
  const store = await Effect.runPromise(
    NativeRecoveryStore.make({ directory, outputBatchDelayMs: 10_000 }).pipe(Scope.provide(scope)),
  )
  await Effect.runPromise(store.createTransport(transport))
  const scheduler = new HeldScheduler()
  schedulers.push(scheduler)
  return {
    store,
    path: join(directory, createHash('sha256').update(transport.id).digest('hex') + '.jsonl'),
    scheduler,
  }
}

async function stepUntil(scheduler: HeldScheduler, predicate: () => boolean) {
  await vi.waitFor(
    () => {
      if (!predicate()) scheduler.step()
      expect(predicate()).toBe(true)
    },
    { timeout: 2_000, interval: 1 },
  )
}

async function holdMutation(
  store: NativeRecoveryStoreHandle,
  path: string,
  scheduler: HeldScheduler,
) {
  let atSync = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  releases.push(release)
  let syncs = 0
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args)
    if (args[0] === path && args[1] === 'r+') {
      const sync = file.sync.bind(file)
      file.sync = async () => {
        syncs++
        if (!atSync) {
          atSync = true
          await gate
        }
        await sync()
      }
    }
    return file
  })
  const mutation = Effect.runFork(
    store.updateTransport(transport.id, { controller: { id: 'fixture-controller', epoch: 2 } }),
    { scheduler },
  )
  await stepUntil(scheduler, () => atSync)
  return { mutation, release, syncs: () => syncs }
}

describe('native output admission ordering', () => {
  it('keeps wire-order admissions ahead of a later fiber that starts before an older semaphore waiter wakes', async () => {
    const { store, path, scheduler } = await start()
    const held = await holdMutation(store, path, scheduler)
    const frames = [stdout(1, 'exact partial 🌍'), stdout(2, ' exact continuation')]
    const first = Effect.runFork(store.appendOutputs(transport.id, [frames[0]]), { scheduler })

    held.release()
    await stepUntil(scheduler, () => held.mutation.pollUnsafe() !== undefined)
    expect(Exit.isSuccess(held.mutation.pollUnsafe()!)).toBe(true)
    // The mutation freed its permit; its scheduled wakeup for the first frame
    // is still held. A separately started fiber can now acquire that permit.
    expect(scheduler.tasks.length).toBeGreaterThan(0)
    const second = Effect.runFork(store.appendOutputs(transport.id, [frames[1]]))
    expect(second.pollUnsafe()).toBeUndefined()

    const admissionBarrier = Effect.runFork(store.appendOutputs(transport.id, []))
    await stepUntil(scheduler, () => admissionBarrier.pollUnsafe() !== undefined)
    expect(await Effect.runPromise(Fiber.join(admissionBarrier))).toBe(2)
    expect(first.pollUnsafe()).toBeUndefined()
    expect(second.pollUnsafe()).toBeUndefined()
    expect(held.syncs()).toBe(1)

    await Effect.runPromise(store.flushEffect())
    scheduler.flush()
    expect(await Effect.runPromise(Fiber.join(first))).toBe(1)
    expect(await Effect.runPromise(Fiber.join(second))).toBe(2)
    expect(held.syncs()).toBe(2)
    const batches = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(batches).toHaveLength(3)
    expect(batches[2].records.map((record: { frame: unknown }) => record.frame)).toEqual(frames)
    expect((await Effect.runPromise(store.readTransport(transport.id))).outputs).toEqual(frames)
  })

  it('retains a queued raw frame when its subscriber cancels and lets the following frame join the same durable batch', async () => {
    const { store, path, scheduler } = await start()
    const held = await holdMutation(store, path, scheduler)
    const signal = new AbortController()
    const frames = [stdout(1, 'owned before cancellation'), stdout(2, 'owned after cancellation')]
    const first = Effect.runFork(store.appendOutputs(transport.id, [frames[0]]), {
      scheduler,
      signal: signal.signal,
    })
    signal.abort()
    const second = Effect.runFork(store.appendOutputs(transport.id, [frames[1]]))
    held.release()
    await stepUntil(scheduler, () => held.mutation.pollUnsafe() !== undefined)
    const admissionBarrier = Effect.runFork(store.appendOutputs(transport.id, []))
    await stepUntil(scheduler, () => admissionBarrier.pollUnsafe() !== undefined)
    expect(await Effect.runPromise(Fiber.join(admissionBarrier))).toBe(2)
    expect(second.pollUnsafe()).toBeUndefined()

    await Effect.runPromise(store.flushEffect())
    scheduler.flush()
    const cancelled = await Effect.runPromise(Fiber.await(first))
    expect(Exit.isFailure(cancelled)).toBe(true)
    if (Exit.isFailure(cancelled)) expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true)
    expect(await Effect.runPromise(Fiber.join(second))).toBe(2)
    expect(held.syncs()).toBe(2)
    expect((await Effect.runPromise(store.readTransport(transport.id))).outputs).toEqual(frames)
  })

  it('rejects a genuinely missing cursor without admitting, skipping, or reordering it', async () => {
    const { store } = await start()
    const rejected = await Effect.runPromiseExit(
      store.appendOutputs(transport.id, [stdout(2, 'gap')]),
    )
    expect(Exit.isFailure(rejected)).toBe(true)
    if (Exit.isFailure(rejected))
      expect(Cause.squash(rejected.cause)).toMatchObject({
        operation: 'output',
        reason: 'uncertain',
        message:
          'Recovery output frames must be contiguous; expected cursor 1, received 2; no frame was skipped.',
      })
    expect((await Effect.runPromise(store.readTransport(transport.id))).outputs).toEqual([])
    const first = Effect.runFork(store.appendOutputs(transport.id, [stdout(1, 'original first')]))
    const barrier = await Effect.runPromise(store.appendOutputs(transport.id, []))
    expect(barrier).toBe(1)
    await Effect.runPromise(store.flushEffect())
    expect(await Effect.runPromise(Fiber.join(first))).toBe(1)
    expect((await Effect.runPromise(store.readTransport(transport.id))).outputs).toEqual([
      stdout(1, 'original first'),
    ])
  })
})
