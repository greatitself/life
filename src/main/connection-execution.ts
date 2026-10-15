import type { ConnectionExecutionInput } from '../shared/types'
import { posix } from 'node:path'
import { Deferred, Effect, Schema } from 'effect'
import { shellQuote } from '../shared/validation'
import type { SSHConnection } from './ssh'
import { runEffect } from './effect-runtime'

const commandInputSchema = Schema.Struct({
  scope: Schema.optional(Schema.Literals(['project', 'machine'])),
  command: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100_000),
    Schema.isPattern(/\S/u, { message: 'Enter a remote command' }),
    Schema.isPattern(/^[^\0]*$/u, { message: 'Enter a valid remote command' }),
    Schema.makeFilter((command) => Buffer.byteLength(command, 'utf8') <= 100_000, {
      message: 'Remote commands must not exceed 100 KB',
    }),
  ),
  workspace: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4096),
      Schema.isPattern(/^[^\x00-\x1f]*$/u, { message: 'Enter a valid remote path' }),
    ),
  ),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(30_000)),
  ),
})
const decodeCommandInput = Schema.decodeUnknownEffect(commandInputSchema, {
  onExcessProperty: 'error',
})

export class ConnectionCommandError extends Schema.TaggedError<ConnectionCommandError>()(
  'ConnectionCommandError',
  {
    reason: Schema.Literals(['validation', 'connection', 'workspace', 'cancelled', 'timeout']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const executeConnectionCommandEffect = Effect.fn('executeConnectionCommand')(function* (
  connection: SSHConnection,
  input: unknown,
) {
  const options = yield* decodeCommandInput(input).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectionCommandError({ reason: 'validation', message: cause.message, cause }),
    ),
  )
  if (connection.state.status !== 'connected')
    return yield* new ConnectionCommandError({
      reason: 'connection',
      message: 'Connect to a machine first',
      cause: undefined,
    })
  const machine = options.scope === 'machine'
  const home = connection.state.home
  const profileId = connection.state.profile?.id
  const workspace = machine ? home : connection.state.workspace
  if (!workspace)
    return yield* new ConnectionCommandError({
      reason: machine ? 'connection' : 'workspace',
      message: machine ? 'The connected machine has no home directory' : 'Select a project first',
      cause: undefined,
    })
  if (!machine && options.workspace && options.workspace !== workspace)
    return yield* new ConnectionCommandError({
      reason: 'workspace',
      message: 'The selected project changed. Select the expected project to run this command.',
      cause: undefined,
    })

  const cancelled = yield* Deferred.make<never, ConnectionCommandError>()
  const ownership = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const controller = new AbortController()
      let cancellation: ConnectionCommandError | undefined
      const cancel = (message: string) => {
        if (cancellation) return
        cancellation = new ConnectionCommandError({
          reason: 'cancelled',
          message,
          cause: undefined,
        })
        Deferred.doneUnsafe(cancelled, Effect.fail(cancellation))
        controller.abort()
      }
      const projectChanged = () =>
        cancel('The selected project changed. The remote command was cancelled.')
      const disconnected = () => cancel('SSH disconnected. The remote command was cancelled.')
      if (!machine) connection.on('workspace-changing', projectChanged)
      connection.on('disconnected', disconnected)
      return { controller, projectChanged, disconnected, cancellation: () => cancellation }
    }),
    (resource) =>
      Effect.sync(() => {
        if (!machine) connection.off('workspace-changing', resource.projectChanged)
        connection.off('disconnected', resource.disconnected)
        resource.controller.abort()
      }),
  )
  const execution = connection
    .execEffect('exec "$SHELL" -s', {
      signal: ownership.controller.signal,
      maxOutputBytes: 1_000_000,
      timeoutMs: options.timeoutMs,
      // SSH exec requests have a packet-size limit. Stream the script through
      // stdin instead of embedding a potentially 100 KB script in that packet.
      input: machine
        ? machineCommandInput(workspace, options.workspace, options.command)
        : `cd ${shellQuote(workspace)} || exit\n${options.command}`,
    })
    .pipe(
      Effect.catch((error) =>
        // ssh2 can fail a pending channel before SSHConnection publishes the
        // disconnect event in the same callback. Let that callback finish so
        // cancellation keeps its workspace/connection ownership explanation.
        Effect.yieldNow.pipe(
          Effect.andThen(Effect.failSync(() => ownership.cancellation() ?? error)),
        ),
      ),
      // This deadline owns the entire request, including the channel-opening
      // acknowledgement. Interruption closes an acquired channel and discards
      // any late channel returned by the SSH library.
      Effect.timeoutOrElse({
        duration: options.timeoutMs,
        orElse: () =>
          Effect.fail(
            new ConnectionCommandError({
              reason: 'timeout',
              message: `Remote command timed out after ${options.timeoutMs / 1000} seconds`,
              cause: undefined,
            }),
          ),
      }),
    )
  const output = yield* Effect.raceFirst(execution, Deferred.await(cancelled))
  const cancellation = ownership.cancellation()
  if (cancellation) return yield* cancellation
  if (connection.state.status !== 'connected')
    return yield* new ConnectionCommandError({
      reason: 'cancelled',
      message: 'SSH disconnected. The remote command was cancelled.',
      cause: undefined,
    })
  if (connection.state.profile?.id !== profileId || connection.state.home !== home)
    return yield* new ConnectionCommandError({
      reason: 'cancelled',
      message: 'The connected machine changed. The remote command was cancelled.',
      cause: undefined,
    })
  if (!machine && connection.state.workspace !== workspace)
    return yield* new ConnectionCommandError({
      reason: 'cancelled',
      message: 'The selected project changed. The remote command was cancelled.',
      cause: undefined,
    })
  return output
}, Effect.scoped)

export function executeConnectionCommand(
  connection: SSHConnection,
  input: ConnectionExecutionInput,
  options?: { signal?: AbortSignal },
): Promise<string> {
  return runEffect(executeConnectionCommandEffect(connection, input), options)
}

function machineCommandInput(home: string, workspace: string | undefined, command: string): string {
  if (workspace === undefined || workspace === '~')
    return `cd ${shellQuote(home)} || exit\n${command}`
  const requested = workspace.startsWith('~/')
    ? posix.join(home, workspace.slice(2))
    : posix.isAbsolute(workspace)
      ? workspace
      : posix.join(home, workspace)
  // Resolve symlinks on the connected machine in the same bounded request as
  // the command. This never selects or depends on the Agents project, and a
  // directory outside the machine's home cannot become a machine workspace.
  return `cd ${shellQuote(home)} || exit
life_machine_command_home=$(pwd -P) || exit
cd ${shellQuote(requested)} || exit
life_machine_command_workspace=$(pwd -P) || exit
if [ "$life_machine_command_home" != / ]; then
  case "$life_machine_command_workspace" in
    "$life_machine_command_home"|"$life_machine_command_home"/*) ;;
    *) printf '%s\\n' 'Machine commands must run within the connected home directory.' >&2; exit 1 ;;
  esac
fi
unset life_machine_command_home life_machine_command_workspace
${command}`
}
