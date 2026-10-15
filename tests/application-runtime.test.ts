import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { ApplicationRuntime, NativeOperationError } from '../src/main/application-runtime'

describe('managed native application services', () => {
  it('runs native Effects and legacy boundary handlers with the same admission checks', async () => {
    const admit = vi.fn()
    const runtime = new ApplicationRuntime(admit)
    runtime.register('native:effect', (value) => Effect.succeed(value))
    runtime.register('legacy:promise', async (value) => value)
    runtime.register('legacy:sync', (value) => value)
    expect(await runtime.invoke('native:effect', ['exact input'])).toBe('exact input')
    expect(await runtime.invoke('legacy:promise', [42])).toBe(42)
    expect(await runtime.invoke('legacy:sync', [false])).toBe(false)
    expect(admit.mock.calls).toEqual([['native:effect'], ['legacy:promise'], ['legacy:sync']])
    expect(() => runtime.register('native:effect', () => undefined)).toThrow('already registered')
    await runtime.dispose()
  })

  it('rejects inadmissible work before dispatch and retains actionable typed errors', async () => {
    const operation = vi.fn()
    const runtime = new ApplicationRuntime(() => {
      throw new Error('Life is restarting its interface.')
    })
    runtime.register('native:work', operation)
    await expect(runtime.invoke('native:work', [])).rejects.toMatchObject({
      _tag: 'NativeOperationError',
      operation: 'native:work',
      message: 'Life is restarting its interface.',
    })
    expect(operation).not.toHaveBeenCalled()
    await runtime.dispose()
    const open = new ApplicationRuntime(() => {})
    const cause = new Error('The disk is full.')
    open.register('native:failure', () => Effect.fail(cause))
    await expect(open.invoke('native:failure', [])).rejects.toBeInstanceOf(NativeOperationError)
    await expect(open.invoke('native:failure', [])).rejects.toMatchObject({
      cause,
      message: 'The disk is full.',
    })
    await expect(open.invoke('native:missing', [])).rejects.toThrow('unavailable')
    await open.dispose()
  })

  it('checks the current renderer identity at the actual dispatch edge', async () => {
    const runtime = new ApplicationRuntime(() => {})
    const operation = vi.fn(() => Effect.succeed('result'))
    runtime.register('native:work', operation)
    await expect(
      runtime.invoke('native:work', [], {
        beforeDispatch: () => {
          throw new Error('Untrusted IPC sender')
        },
      }),
    ).rejects.toThrow('Untrusted IPC sender')
    expect(operation).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it.each(['request', 'application'] as const)(
    'interrupts owned work and awaits finalizers when the %s scope closes',
    async (scope) => {
      const runtime = new ApplicationRuntime(() => {})
      const controller = new AbortController()
      let acquired!: () => void
      const ready = new Promise<void>((resolve) => (acquired = resolve))
      const release = vi.fn(async () => {
        await Promise.resolve()
      })
      runtime.register('native:resource', () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.sync(acquired), () => Effect.promise(release))
          yield* Effect.never
        }).pipe(Effect.scoped),
      )
      const request = runtime.invoke('native:resource', [], { signal: controller.signal })
      // Attach the rejection observer before interrupting the owned fiber.
      const rejected = expect(request).rejects.toBeDefined()
      await ready
      if (scope === 'request') controller.abort()
      else await runtime.dispose()
      await rejected
      expect(release).toHaveBeenCalledTimes(1)
      await runtime.dispose()
      await expect(runtime.invoke('native:resource', [])).rejects.toThrow('shutting down')
    },
  )
})
