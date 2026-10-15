import { EventEmitter } from 'node:events'
import { Deferred, Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import { NativeRecoveryError } from '../src/main/native-recovery-types'
import type { NativeRecoveryPlatformPolicy } from '../src/main/native-recovery-platform'
import type { SSHConnection } from '../src/main/ssh'

// Service-unit policies only; the packaged Windows gate verifies real platform/FS admission.
vi.mock('../src/main/native-recovery-platform', async (original) => ({
  ...(await original<typeof import('../src/main/native-recovery-platform')>()),
  validateNativeRecoveryPlatformPolicyEffect: (policy: NativeRecoveryPlatformPolicy) =>
    Effect.succeed(policy),
}))

function fixture(guard: Effect.Effect<void, NativeRecoveryError>, mode = 'unsupported-clean') {
  const connection = Object.assign(new EventEmitter(), { state: { status: 'disconnected' } })
  const policy = {
    mode,
    assertOrdinaryHistoryWriteEffect: () => guard,
  } as NativeRecoveryPlatformPolicy
  const agents = new Agents(connection as unknown as SSHConnection, () => {}, undefined, policy)
  agents.pauseRendererRecovery()
  return agents
}

describe('ordinary renderer document admission', () => {
  it('keeps a pending support check out of native replay admission and resumes only after the guard', async () => {
    const ready = Deferred.makeUnsafe<void>()
    let checking = false
    const agents = fixture(
      Effect.sync(() => {
        checking = true
      }).pipe(Effect.andThen(Deferred.await(ready))),
    )
    const resuming = Effect.runPromise(agents.resumeOrdinaryRendererEffect(() => true))
    await vi.waitFor(() => expect(checking).toBe(true))
    expect(agents.hasUntrackedRunningSessions()).toBe(false)
    expect(Reflect.get(agents, 'rendererSuspended')).toBe(true)
    Deferred.doneUnsafe(ready, Effect.void)
    await resuming
    expect(Reflect.get(agents, 'rendererSuspended')).toBe(false)
    expect(agents.hasUntrackedRunningSessions()).toBe(false)
  })

  it('cannot let a late support reply resume a replacement document', async () => {
    const ready = Deferred.makeUnsafe<void>()
    let checking = false
    let current = true
    const agents = fixture(
      Effect.sync(() => {
        checking = true
      }).pipe(Effect.andThen(Deferred.await(ready))),
    )
    const resuming = Effect.runPromise(agents.resumeOrdinaryRendererEffect(() => current))
    await vi.waitFor(() => expect(checking).toBe(true))
    current = false
    Deferred.doneUnsafe(ready, Effect.void)
    await resuming
    expect(Reflect.get(agents, 'rendererSuspended')).toBe(true)
  })

  it('retains suspension when protected ordinary state cannot be admitted', async () => {
    const failure = new NativeRecoveryError({
      operation: 'platform-history',
      path: '/fixture',
      reason: 'ownership',
      message: 'Protected state appeared',
    })
    const agents = fixture(Effect.fail(failure))
    await expect(
      Effect.runPromise(agents.resumeOrdinaryRendererEffect(() => true)),
    ).rejects.toMatchObject({ operation: 'platform-history' })
    expect(Reflect.get(agents, 'rendererSuspended')).toBe(true)
  })

  it('does not resume durable native replay through ordinary admission', async () => {
    let checked = false
    const agents = fixture(
      Effect.sync(() => {
        checked = true
      }),
      'durable',
    )
    await Effect.runPromise(agents.resumeOrdinaryRendererEffect(() => true))
    expect(checked).toBe(false)
    expect(Reflect.get(agents, 'rendererSuspended')).toBe(true)
  })
})
