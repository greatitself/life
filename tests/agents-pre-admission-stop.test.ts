import { EventEmitter } from 'node:events'
import { Deferred, Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Agents } from '../src/main/agents'
import { NativeRecoveryError } from '../src/main/native-recovery-types'
import type { NativeRecoveryPlatformPolicy } from '../src/main/native-recovery-platform'
import type { SSHConnection } from '../src/main/ssh'

// Service-unit policies; actual Windows admission is checked by the packaged gate.
vi.mock('../src/main/native-recovery-platform', async (original) => ({
  ...(await original<typeof import('../src/main/native-recovery-platform')>()),
  validateNativeRecoveryPlatformPolicyEffect: (policy: NativeRecoveryPlatformPolicy) =>
    Effect.succeed(policy),
}))

describe('Stop before a provider start is admitted', () => {
  it.each(['none', 'completed', 'failed'] as const)(
    'cancels the pending new turn with previous completed Stop = %s',
    async (previousStop) => {
      const ready = Deferred.makeUnsafe<void>()
      let checking = false
      const guard = Effect.sync(() => {
        checking = true
      }).pipe(Effect.andThen(Deferred.await(ready)))
      const policy = {
        mode: 'unsupported-clean',
        assertFreshSshStartEffect: () => guard,
        assertOrdinaryHistoryWriteEffect: () => Effect.void,
      } as unknown as NativeRecoveryPlatformPolicy
      const channel = vi.fn(async () => {
        throw new Error('Unexpected provider launch')
      })
      const connection = Object.assign(new EventEmitter(), {
        state: {
          status: 'connected',
          home: '/fixture',
          workspace: '/fixture/project',
          codex: 'codex-cli fixture',
          profile: {
            id: 'fixture',
            transport: 'ssh',
            host: 'fixture',
            port: 22,
            username: 'fixture',
          },
        },
        channel,
        durableChannel: channel,
      })
      const agents = new Agents(connection as unknown as SSHConnection, () => {}, undefined, policy)
      if (previousStop !== 'none') {
        const completed = Deferred.makeUnsafe<void, NativeRecoveryError>()
        Deferred.doneUnsafe(
          completed,
          previousStop === 'failed'
            ? Effect.fail(
                new NativeRecoveryError({
                  operation: 'stop',
                  path: 'original-owner',
                  reason: 'uncertain',
                  message: 'The previous process had not confirmed exit at its Stop deadline.',
                  cause: undefined,
                }),
              )
            : Effect.void,
        )
        Reflect.get(agents, 'stopCompletions').set('thread', completed)
      }
      const starting = agents.start({
        sessionId: 'thread',
        provider: 'codex',
        prompt: '  Exact new request Ω\r\n  ',
        mode: 'ask-for-approval',
      })
      const cancelled = expect(starting).resolves.toBeUndefined()
      await vi.waitFor(() => expect(checking).toBe(true))
      let stopped = false
      const stopping = agents.stop('thread').then(() => {
        stopped = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stopped).toBe(false)
      expect(channel).not.toHaveBeenCalled()
      Deferred.doneUnsafe(ready, Effect.void)
      await Promise.all([cancelled, stopping])
      expect(channel).not.toHaveBeenCalled()
      expect(agents.hasRunningSessions()).toBe(false)
      expect(agents.hasPendingRendererWork()).toBe(false)
    },
  )
})
