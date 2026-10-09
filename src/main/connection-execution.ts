import type { ConnectionExecutionInput } from '../shared/types'
import { posix } from 'node:path'
import { connectionExecutionSchema, shellQuote } from '../shared/validation'
import type { SSHConnection } from './ssh'

export async function executeConnectionCommand(
  connection: SSHConnection,
  input: ConnectionExecutionInput,
): Promise<string> {
  const options = connectionExecutionSchema.parse(input)
  if (connection.state.status !== 'connected') throw new Error('Connect to a machine first')
  const machine = options.scope === 'machine'
  const home = connection.state.home
  const profileId = connection.state.profile?.id
  const workspace = machine ? home : connection.state.workspace
  if (!workspace)
    throw new Error(
      machine ? 'The connected machine has no home directory' : 'Select a project first',
    )
  if (!machine && options.workspace && options.workspace !== workspace)
    throw new Error(
      'The selected project changed. Select the expected project to run this command.',
    )

  const controller = new AbortController()
  let cancellation: string | undefined
  const projectChanged = () => {
    cancellation = 'The selected project changed. The remote command was cancelled.'
    controller.abort()
  }
  const disconnected = () => {
    cancellation = 'SSH disconnected. The remote command was cancelled.'
    controller.abort()
  }
  if (!machine) connection.on('workspace-changing', projectChanged)
  connection.on('disconnected', disconnected)
  // Bound channel setup too: an SSH server may never acknowledge an exec
  // request, before SSHConnection.exec's running-command timer can begin.
  const timer = setTimeout(() => {
    cancellation = `Remote command timed out after ${options.timeoutMs / 1000} seconds`
    controller.abort()
  }, options.timeoutMs)
  try {
    const output = await connection.exec('exec "$SHELL" -s', {
      signal: controller.signal,
      maxOutputBytes: 1_000_000,
      timeoutMs: options.timeoutMs,
      // SSH exec requests have a packet-size limit. Stream the script through
      // stdin instead of embedding a potentially 100 KB script in that packet.
      input: machine
        ? machineCommandInput(workspace, options.workspace, options.command)
        : `cd ${shellQuote(workspace)} || exit\n${options.command}`,
    })
    if (cancellation) throw new Error(cancellation)
    if (connection.state.status !== 'connected')
      throw new Error('SSH disconnected. The remote command was cancelled.')
    if (connection.state.profile?.id !== profileId || connection.state.home !== home)
      throw new Error('The connected machine changed. The remote command was cancelled.')
    if (!machine && connection.state.workspace !== workspace)
      throw new Error('The selected project changed. The remote command was cancelled.')
    return output
  } catch (error) {
    if (cancellation) throw new Error(cancellation)
    throw error
  } finally {
    clearTimeout(timer)
    if (!machine) connection.off('workspace-changing', projectChanged)
    connection.off('disconnected', disconnected)
  }
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
