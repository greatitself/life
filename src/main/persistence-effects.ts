import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { Effect, Schema } from 'effect'

export class PersistenceError extends Schema.TaggedError<PersistenceError>()('PersistenceError', {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export function persistenceError(operation: string, path: string, cause: unknown) {
  return new PersistenceError({
    operation,
    path,
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })
}

export function persistenceIO<A>(operation: string, path: string, execute: () => Promise<A>) {
  return Effect.tryPromise({
    try: execute,
    catch: (cause) => persistenceError(operation, path, cause),
  })
}

/** Flush a private staged snapshot and release every resource before publishing it. */
export const atomicSnapshot = Effect.fnUntraced(function* (
  path: string,
  serialized: string,
  current?: () => boolean,
) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  yield* Effect.acquireRelease(Effect.succeed(temporary), (path) =>
    persistenceIO('cleanup', path, () => rm(path, { force: true })).pipe(Effect.orDie),
  )
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        persistenceIO('open', temporary, () => open(temporary, 'wx', 0o600)),
        (file) => persistenceIO('close', temporary, () => file.close()).pipe(Effect.orDie),
      )
      yield* persistenceIO('write', temporary, () => file.writeFile(serialized, 'utf8'))
      yield* persistenceIO('sync', temporary, () => file.sync())
    }),
  )
  if (current && !current()) return false
  yield* persistenceIO('rename', path, () => rename(temporary, path))
  return true
}, Effect.scoped)
