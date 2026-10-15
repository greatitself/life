import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import { runEffect } from '../src/main/effect-runtime'

class DomainFailure extends Schema.TaggedError<DomainFailure>()('DomainFailure', {
  message: Schema.String,
}) {}

describe('Effect Promise integration', () => {
  it('returns values and preserves typed errors without FiberFailure wrappers', async () => {
    expect(await runEffect(Effect.succeed('exact result'))).toBe('exact result')
    const failure = new DomainFailure({ message: 'exact failure' })
    await expect(runEffect(Effect.fail(failure))).rejects.toBe(failure)
    const defect = new Error('unexpected defect')
    await expect(runEffect(Effect.die(defect))).rejects.toBe(defect)
  })

  it('waits for scoped resource cleanup on interruption', async () => {
    const controller = new AbortController()
    const actions: string[] = []
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => (acquired = resolve))
    const work = runEffect(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            actions.push('acquire')
            acquired()
          }),
          () =>
            Effect.promise(async () => {
              await Promise.resolve()
              actions.push('release')
            }),
        )
        yield* Effect.never
      }).pipe(Effect.scoped),
      { signal: controller.signal },
    )
    await ready
    controller.abort()
    await expect(work).rejects.toBeDefined()
    expect(actions).toEqual(['acquire', 'release'])
  })
})
