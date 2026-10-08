import type { ConnectionExecutionInput } from '../shared/types'
import { connectionExecutionSchema, shellQuote } from '../shared/validation'
import type { SSHConnection } from './ssh'

export async function executeConnectionCommand(
  connection: SSHConnection,
  input: ConnectionExecutionInput,
): Promise<string> {
  const options = connectionExecutionSchema.parse(input)
  if (connection.state.status !== 'connected') throw new Error('Connect to a machine first')
  const workspace = connection.state.workspace
  if (!workspace) throw new Error('Select a project first')
  if (options.workspace && options.workspace !== workspace)
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
  connection.on('workspace-changing', projectChanged)
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
      input: `cd ${shellQuote(workspace)} || exit\n${options.command}`,
    })
    if (cancellation) throw new Error(cancellation)
    if (connection.state.status !== 'connected')
      throw new Error('SSH disconnected. The remote command was cancelled.')
    if (connection.state.workspace !== workspace)
      throw new Error('The selected project changed. The remote command was cancelled.')
    return output
  } catch (error) {
    if (cancellation) throw new Error(cancellation)
    throw error
  } finally {
    clearTimeout(timer)
    connection.off('workspace-changing', projectChanged)
    connection.off('disconnected', disconnected)
  }
}
