import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { runEffect } from './effect-runtime'

export class NativeDocumentReadinessError extends Schema.TaggedError<NativeDocumentReadinessError>()(
  'NativeDocumentReadinessError',
  { message: Schema.String },
) {}

interface DocumentState {
  readonly owner: object
  readonly id: string
  readyRevision?: number
}

/** Native document identity is issued at navigation, never restored from renderer JSON. */
export class NativeDocumentReadiness {
  private current?: DocumentState
  private closed = false
  private readonly waiters = new Set<() => void>()

  commit(owner: object): void {
    if (this.closed) return
    this.current = { owner, id: randomUUID() }
    this.notify()
  }

  capture(): { documentId: string } {
    if (this.closed || !this.current)
      throw new NativeDocumentReadinessError({ message: 'The Life document is unavailable.' })
    return { documentId: this.current.id }
  }

  ready(owner: object, revision: number): void {
    if (
      this.closed ||
      this.current?.owner !== owner ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return
    this.current.readyRevision = revision
    this.notify()
  }

  invalidate(owner: object): void {
    if (this.current?.owner !== owner) return
    this.current = undefined
    this.notify()
  }

  matches(originalDocumentId: string, revision: number): boolean {
    return (
      !this.closed &&
      this.current !== undefined &&
      this.current.id !== originalDocumentId &&
      this.current.readyRevision === revision
    )
  }

  readonly waitEffect = Effect.fn('NativeDocumentReadiness.wait')(
    (originalDocumentId: string, revision: number, deadlineMs = 30_000) =>
      Effect.callback<void, NativeDocumentReadinessError>((resume) => {
        let done = false
        let deadline: ReturnType<typeof setTimeout> | undefined
        const check = () => {
          if (done) return
          if (this.closed || !this.current) {
            done = true
            resume(
              Effect.fail(
                new NativeDocumentReadinessError({
                  message: 'Life closed before the new source document was ready.',
                }),
              ),
            )
          } else if (this.matches(originalDocumentId, revision)) {
            done = true
            resume(Effect.void)
          }
        }
        this.waiters.add(check)
        check()
        if (!done) {
          deadline = setTimeout(() => {
            done = true
            resume(
              Effect.fail(
                new NativeDocumentReadinessError({
                  message:
                    'The applied source document has not finished starting. Its commit remains recoverable.',
                }),
              ),
            )
          }, deadlineMs)
          deadline.unref()
        }
        return Effect.sync(() => {
          done = true
          if (deadline) clearTimeout(deadline)
          this.waiters.delete(check)
        })
      }),
  )

  wait(originalDocumentId: string, revision: number, signal?: AbortSignal): Promise<void> {
    return runEffect(this.waitEffect(originalDocumentId, revision), { signal })
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  private notify(): void {
    for (const check of this.waiters) check()
  }
}
