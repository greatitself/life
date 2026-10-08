import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.restoreAllMocks()
})

function remoteCommand(
  options: {
    earlyExit?: number | null
    stdout?: Buffer[]
    stderr?: string
  } = {},
) {
  const channel = Object.assign(new PassThrough({ autoDestroy: false }), {
    stderr: new PassThrough({ autoDestroy: false }),
    close: vi.fn(),
  })
  channel.close.mockImplementation(() => {
    channel.emit('close')
  })
  const connection = new SSHConnection(new Store(join(tmpdir(), 'life-ssh-command-tests')))
  let exitHadListener = false
  vi.spyOn(connection, 'channel').mockImplementation(async () => {
    // ssh2 can receive exec-success and exit-status in one packet batch. The
    // exit event then precedes the awaiting exec() continuation and its listeners.
    exitHadListener = channel.listenerCount('exit') !== 0
    if ('earlyExit' in options) channel.emit('exit', options.earlyExit, 'TERM')
    for (const buffer of options.stdout || []) channel.write(buffer)
    if (options.stderr) channel.stderr.write(options.stderr)
    return channel as unknown as ClientChannel
  })
  const result = connection.exec('fixture command')
  cleanup.push(() => {
    connection.disconnect()
    channel.destroy()
    channel.stderr.destroy()
  })
  return {
    channel,
    result,
    exitHadListener: () => exitHadListener,
    async drain() {
      const stdoutFinished = once(channel, 'end')
      const stderrFinished = once(channel.stderr, 'end')
      channel.end()
      channel.stderr.end()
      await Promise.all([stdoutFinished, stderrFinished])
    },
  }
}

describe('SSH command exit status ordering', () => {
  it('uses the close status when exit arrived before channel readiness and preserves buffered output', async () => {
    const output = Buffer.from('Already finished 👋\n')
    const command = remoteCommand({
      earlyExit: 0,
      stdout: [output.subarray(0, output.length - 3), output.subarray(output.length - 3)],
    })
    expect(command.exitHadListener()).toBe(false)
    await command.drain()
    command.channel.emit('close', 0)
    await expect(command.result).resolves.toBe('Already finished 👋\n')
  })

  it('rejects a nonzero close status when the earlier exit event was missed', async () => {
    const command = remoteCommand({ earlyExit: 7 })
    await command.drain()
    command.channel.emit('close', 7)
    await expect(command.result).rejects.toThrow('Remote command exited with code 7')
  })

  it('preserves buffered stderr for a failed command whose exit event was missed', async () => {
    const command = remoteCommand({ earlyExit: 7, stderr: 'fixture process failed\n' })
    await command.drain()
    command.channel.emit('close', 7)
    await expect(command.result).rejects.toThrow('fixture process failed')
  })

  it('rejects a closed channel without any exit status', async () => {
    const command = remoteCommand()
    await command.drain()
    command.channel.emit('close')
    await expect(command.result).rejects.toThrow('Remote command closed without an exit status')
  })

  it('rejects signal termination with a null status instead of treating it as success', async () => {
    const command = remoteCommand({ earlyExit: null })
    await command.drain()
    command.channel.emit('close', null, 'TERM', false, 'terminated')
    await expect(command.result).rejects.toThrow('Remote command closed without an exit status')
  })

  it.each([0, 7])(
    'preserves an observed exit status of %i when close has no status',
    async (code) => {
      const command = remoteCommand({ stdout: [Buffer.from('ordinary output')] })
      await command.drain()
      command.channel.emit('exit', code)
      command.channel.emit('close')
      if (code === 0) await expect(command.result).resolves.toBe('ordinary output')
      else await expect(command.result).rejects.toThrow('Remote command exited with code 7')
    },
  )
})
