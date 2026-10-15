import { Cause, Effect, Exit } from 'effect'

/** Preserve domain Error instances at Promise-only integration boundaries. */
export function unwrapExit<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

export async function runEffect<A, E>(
  program: Effect.Effect<A, E>,
  options?: { signal?: AbortSignal },
): Promise<A> {
  return unwrapExit(await Effect.runPromiseExit(program, options))
}
