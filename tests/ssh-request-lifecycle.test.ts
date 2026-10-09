import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, type ClientChannel, type ClientSFTPCallback, type SFTPWrapper } from 'ssh2'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'

type Reply<T> = (error: Error | null, value: T) => void
const connections: SSHConnection[] = []

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function remote() {
  const store = new Store(join(tmpdir(), 'life-ssh-request-tests'))
  const save = vi
    .spyOn(store, 'saveIfCurrent')
    .mockImplementation(async (_profile, current, onCommit) => {
      if (!current()) return false
      onCommit()
      return true
    })
  const connection = new SSHConnection(store)
  connections.push(connection)
  const client = { exec: vi.fn(), end: vi.fn() }
  const directory = { isDirectory: () => true, size: 12 }
  const sftp = {
    realpath: vi.fn((path: string, done: Reply<string>) => done(null, path)),
    stat: vi.fn((_path: string, done: Reply<typeof directory>) => done(null, directory)),
    readdir: vi.fn((_path: string, done: Reply<unknown[]>) => done(null, [])),
    createReadStream: vi.fn(() => new PassThrough()),
  }
  Object.assign(connection, { client, sftp })
  connection.state = {
    status: 'connected',
    home: '/home/test',
    workspace: '/project',
    profile: {
      id: 'request-test',
      name: 'Request test',
      host: 'test',
      port: 22,
      username: 'test',
      auth: 'agent',
      privateKeyPath: '',
      workspace: '/project',
    },
  }
  return { connection, client, sftp, save }
}

function commandChannel() {
  const channel = Object.assign(new PassThrough({ autoDestroy: false }), {
    stderr: new PassThrough({ autoDestroy: false }),
    close: vi.fn(),
  })
  channel.close.mockImplementation(() => channel.emit('close'))
  return channel as typeof channel & ClientChannel
}

describe('bounded SSH and SFTP requests', () => {
  it('settles connection setup immediately when cancelled before SSH readiness', async () => {
    const { connection } = remote()
    vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      return this
    })
    const rejected = expect(
      connection.connect({
        ...connection.state.profile!,
        auth: 'password',
        password: 'test',
      }),
    ).rejects.toThrow(/SSH connection cancelled/)
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.status).toBe('connecting')
    connection.disconnect()
    await rejected
    expect(connection.state.status).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles stalled SFTP initialization on disconnect and ends a late SFTP session', async () => {
    const { connection } = remote()
    vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      this.emit('ready')
      return this
    })
    vi.spyOn(connection, 'exec').mockImplementation(async (command) =>
      command.includes('CODEX=') ? 'CODEX=test\nCLAUDE=test\n' : '/home/test\n',
    )
    let answer: ClientSFTPCallback | undefined
    vi.spyOn(Client.prototype, 'sftp').mockImplementation(function (this: Client, done) {
      answer = done
      return this
    })
    const rejected = expect(
      connection.connect({
        ...connection.state.profile!,
        auth: 'password',
        password: 'test',
      }),
    ).rejects.toThrow(/SSH connection cancelled/)
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toBeDefined()
    connection.disconnect()
    await rejected
    const late = { end: vi.fn() }
    answer!(undefined, late as unknown as SFTPWrapper)
    expect(late.end).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['realpath', 'stat', 'readdir'] as const)(
    'releases a project selection stalled in %s and allows retry without losing the current project',
    async (stage) => {
      const { connection, sftp, save } = remote()
      sftp[stage].mockImplementationOnce(() => {})
      const pending = connection.selectWorkspace('/next-project')
      const rejected = expect(pending).rejects.toThrow(/timed out after 30 seconds/)
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(connection.state.workspace).toBe('/project')
      expect(save).not.toHaveBeenCalled()
      await expect(connection.selectWorkspace('/next-project')).resolves.toMatchObject({
        workspace: '/next-project',
      })
      expect(save).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['realpath', 'stat', 'readdir'] as const)(
    'settles a project selection stalled in %s immediately on disconnect and ignores its late result',
    async (stage) => {
      const { connection, sftp, save } = remote()
      let answer: (() => void) | undefined
      const original = sftp[stage].getMockImplementation()!
      sftp[stage].mockImplementationOnce((...args: unknown[]) => {
        answer = () => Reflect.apply(original, undefined, args)
      })
      const pending = connection.selectWorkspace('/next-project')
      const rejected = expect(pending).rejects.toThrow(/SSH connection cancelled/)
      await vi.advanceTimersByTimeAsync(0)
      connection.disconnect()
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      answer!()
      await vi.advanceTimersByTimeAsync(0)
      expect(connection.state.status).toBe('disconnected')
      expect(save).not.toHaveBeenCalled()
      await expect(connection.selectWorkspace('/next-project')).rejects.toThrow(
        /Connect to a machine first/,
      )
    },
  )

  it('bounds remote directory browsing even when no SFTP reply arrives', async () => {
    const { connection, sftp } = remote()
    sftp.readdir.mockImplementationOnce(() => {})
    const rejected = expect(connection.listDirectories('/home/test')).rejects.toThrow(
      /Listing remote directories timed out/,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    await expect(connection.listDirectories('/home/test')).resolves.toEqual({
      path: '/home/test',
      parent: '/home',
      entries: [],
    })
  })

  it('rejects a pending file request when its project changes and ignores a late callback', async () => {
    const { connection, sftp } = remote()
    let lateStat: Reply<{ isDirectory: () => boolean; size: number }> | undefined
    sftp.stat.mockImplementationOnce((_path, done) => {
      lateStat = done
    })
    const read = connection.read('README.md')
    const rejected = expect(read).rejects.toThrow(/selected project changed/)
    await vi.advanceTimersByTimeAsync(0)
    await connection.selectWorkspace('/next-project')
    await rejected
    lateStat!(null, { isDirectory: () => false, size: 5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sftp.createReadStream).not.toHaveBeenCalled()
    expect(connection.state.workspace).toBe('/next-project')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces the file byte limit while streaming even if the remote file grows after stat', async () => {
    const { connection, sftp } = remote()
    const stream = new PassThrough()
    sftp.createReadStream.mockReturnValue(stream)
    const rejected = expect(connection.read('growing-file.txt')).rejects.toThrow(/1 MB/)
    await vi.advanceTimersByTimeAsync(0)
    stream.write(Buffer.alloc(600_000))
    stream.write(Buffer.alloc(400_001))
    await rejected
    expect(stream.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('destroys a stalled remote file stream on disconnect and releases its deadline', async () => {
    const { connection, sftp } = remote()
    const stream = new PassThrough()
    sftp.createReadStream.mockReturnValue(stream)
    const rejected = expect(connection.read('stalled-file.txt')).rejects.toThrow(
      /SSH connection cancelled/,
    )
    await vi.advanceTimersByTimeAsync(0)
    connection.disconnect()
    await rejected
    expect(stream.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts the exec deadline before acquiring its channel and closes a late channel', async () => {
    const { connection, client } = remote()
    let answer: Reply<ClientChannel> | undefined
    client.exec.mockImplementation((_command, _options, done) => {
      answer = done
    })
    const rejected = expect(connection.exec('stalled exec', { timeoutMs: 250 })).rejects.toThrow(
      /Opening the remote command timed out after 0.25 seconds/,
    )
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    const late = commandChannel()
    answer!(null, late)
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies one total exec deadline across channel acquisition and command execution', async () => {
    const { connection, client } = remote()
    const channel = commandChannel()
    client.exec.mockImplementation((_command, _options, done) => {
      setTimeout(() => done(null, channel), 75)
    })
    const rejected = expect(
      connection.exec('slow open then stalled command', { timeoutMs: 100 }),
    ).rejects.toThrow(/Remote command timed out after 0.1 seconds/)
    await vi.advanceTimersByTimeAsync(75)
    expect(channel.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
  })

  it('immediately settles an acquired but stalled command on disconnect', async () => {
    const { connection, client } = remote()
    const channel = commandChannel()
    client.exec.mockImplementation((_command, _options, done) => done(null, channel))
    const rejected = expect(connection.exec('stalled command')).rejects.toThrow(
      /SSH connection cancelled/,
    )
    await vi.advanceTimersByTimeAsync(0)
    connection.disconnect()
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels acquisition on abort, removes the abort listener, and discards a late channel', async () => {
    const { connection, client } = remote()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let answer: Reply<ClientChannel> | undefined
    client.exec.mockImplementation((_command, _options, done) => {
      answer = done
    })
    const rejected = expect(
      connection.channel('stalled exec', undefined, controller.signal),
    ).rejects.toThrow(/Remote command cancelled/)
    controller.abort()
    await rejected
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    const late = commandChannel()
    answer!(null, late)
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles every pending channel on disconnect without adding per-request event listeners', async () => {
    const { connection, client } = remote()
    const requests = Array.from({ length: 20 }, () => connection.channel('stalled exec'))
    const rejected = Promise.all(
      requests.map((request) => expect(request).rejects.toThrow(/SSH connection cancelled/)),
    )
    expect(connection.listenerCount('disconnected')).toBe(0)
    expect(client.exec).toHaveBeenCalledTimes(20)
    connection.disconnect()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a previous renderer’s delayed selection while keeping the replacement thread’s project', async () => {
    const { connection, sftp, save, client } = remote()
    let late: Reply<unknown[]> | undefined
    sftp.readdir.mockImplementationOnce((_path, done) => {
      late = done
    })
    const changes = vi.fn()
    connection.on('workspace-changing', changes)
    const rejected = expect(connection.selectWorkspace('/obsolete-project')).rejects.toThrow(
      /Life interface changed/,
    )
    await vi.advanceTimersByTimeAsync(0)
    await connection.cancelRendererRequests()
    await rejected
    expect(connection.state).toMatchObject({ status: 'connected', workspace: '/project' })
    expect(client.end).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    await expect(connection.selectWorkspace('/project')).resolves.toMatchObject({
      workspace: '/project',
    })
    late!(null, [])
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.workspace).toBe('/project')
    expect(save).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    await expect(connection.selectWorkspace('/valid-next-project')).resolves.toMatchObject({
      workspace: '/valid-next-project',
    })
  })

  it('invalidates a selection awaiting profile persistence and never publishes its late commit', async () => {
    const { connection, save } = remote()
    let commitLate: (() => void) | undefined
    save.mockImplementationOnce(async (_profile, current, onCommit) => {
      return await new Promise<boolean>((resolve) => {
        commitLate = () => {
          const owned = current()
          if (owned) onCommit()
          resolve(owned)
        }
      })
    })
    const rejected = expect(connection.selectWorkspace('/obsolete-project')).rejects.toThrow(
      /Life interface changed/,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(commitLate).toBeDefined()
    await connection.cancelRendererRequests()
    await rejected
    await connection.selectWorkspace('/valid-next-project')
    commitLate!()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.workspace).toBe('/valid-next-project')
  })

  it('cancels renderer commands during replacement while preserving machine-owned polling', async () => {
    const { connection, client } = remote()
    const renderer = commandChannel()
    const polling = commandChannel()
    client.exec.mockImplementationOnce((_command, _options, done) => done(null, renderer))
    client.exec.mockImplementationOnce((_command, _options, done) => done(null, polling))
    const rejected = expect(connection.exec('renderer command')).rejects.toThrow(
      /Life interface changed/,
    )
    const background = connection.exec('machine port polling', { rendererOwned: false })
    await vi.advanceTimersByTimeAsync(0)
    await connection.cancelRendererRequests()
    await rejected
    expect(renderer.close).toHaveBeenCalledTimes(1)
    expect(polling.close).not.toHaveBeenCalled()
    polling.emit('exit', 0)
    polling.emit('close', 0)
    await expect(background).resolves.toBe('')
    expect(connection.state.status).toBe('connected')
  })

  it('closes an already acknowledged channel before streaming input after renderer replacement', async () => {
    const { connection, client } = remote()
    const channel = commandChannel()
    const streamed = vi.spyOn(channel, 'end')
    client.exec.mockImplementation((_command, _options, done) => done(null, channel))
    const rejected = expect(
      connection.exec('short shell', { input: 'SHOULD_NOT_EXECUTE' }),
    ).rejects.toThrow(/Life interface changed/)
    await connection.cancelRendererRequests()
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(streamed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not begin an old renderer’s file read after a synchronously resolved path lookup', async () => {
    const { connection, sftp } = remote()
    const rejected = expect(connection.read('README.md')).rejects.toThrow(/Life interface changed/)
    await connection.cancelRendererRequests()
    await rejected
    expect(sftp.stat).not.toHaveBeenCalled()
    expect(sftp.createReadStream).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not adopt an acknowledged terminal after its renderer has been replaced', async () => {
    const { connection, client } = remote()
    const channel = commandChannel()
    client.exec.mockImplementation((_command, _options, done) => done(null, channel))
    const opening = connection.openTerminal()
    await connection.cancelRendererRequests()
    await opening
    expect(channel.close).toHaveBeenCalledTimes(1)
    const write = vi.spyOn(channel, 'write')
    connection.writeTerminal('SHOULD_NOT_EXECUTE')
    expect(write).not.toHaveBeenCalled()
  })
})
