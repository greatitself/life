import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, rename } from 'node:fs/promises'
import { SSHConnection } from '../src/main/ssh'
import { Store } from '../src/main/store'
import { shellQuote } from '../src/shared/validation'
import type { ConnectionState, HostKeyRequest } from '../src/shared/types'
import { SSHFixture } from './helpers/ssh-fixture'

const fixtures: SSHFixture[] = []
const connections: SSHConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.disconnect()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function setup() {
  const fixture = await new SSHFixture().start()
  fixtures.push(fixture)
  const store = new Store(join(fixture.root, 'settings'))
  await store.init()
  const connection = new SSHConnection(store)
  connections.push(connection)
  connection.on('host-key', (request: HostKeyRequest) => connection.trust(request.id, true))
  await connection.connect(fixture.input())
  await connection.selectWorkspace(fixture.workspace)
  return { fixture, connection }
}

async function progressProvider(connection: SSHConnection, fixture: SSHFixture) {
  const log = join(fixture.root, 'durable-provider-log.jsonl')
  const code = `
    const fs = require('fs');
    const rl = require('readline').createInterface({input:process.stdin});
    const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
    const log = ${JSON.stringify(log)};
    rl.on('line', (line) => {
      const input = JSON.parse(line);
      fs.appendFileSync(log, JSON.stringify({received:input})+'\\n');
      send({remoteId:'stable-remote-thread',text:'before disconnect',input});
      setTimeout(() => {
        fs.appendFileSync(log, JSON.stringify({finished:input})+'\\n');
        send({remoteId:'stable-remote-thread',text:'completed while offline',input});
      }, 400);
    });
  `
  const channel = await connection.durableChannel(`exec node -e ${shellQuote(code)}`)
  const lines: Record<string, unknown>[] = []
  let buffer = ''
  channel.on('data', (bytes: Buffer) => {
    buffer += bytes.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  const logEntries = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { channel, lines, logEntries }
}

describe('remote agents survive real SSH socket cuts', () => {
  it('continues executing offline and restores its exact output and remote ID on manual reconnect', async () => {
    const { fixture, connection } = await setup()
    const { channel, lines, logEntries } = await progressProvider(connection, fixture)
    const closed = vi.fn()
    channel.on('close', closed)
    const input = { prompt: 'only these user words', threadId: 'stable-remote-thread' }
    channel.write(JSON.stringify(input) + '\n')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    fixture.dropConnections()
    await vi.waitFor(() => expect(connection.state.status).toBe('disconnected'))
    await vi.waitFor(async () => expect(await logEntries()).toHaveLength(2))
    expect(lines).toHaveLength(1)
    expect(closed).not.toHaveBeenCalled()
    await connection.connect(fixture.input())
    await connection.selectWorkspace(fixture.workspace)
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(lines.map((line) => line.remoteId)).toEqual([
      'stable-remote-thread',
      'stable-remote-thread',
    ])
    expect(lines[1]).toMatchObject({ text: 'completed while offline', input })
    expect((await logEntries()).filter((entry) => entry.received)).toEqual([{ received: input }])
    channel.close()
  })

  it('reconnects automatically with credentials kept only in memory and restores the active project', async () => {
    const { fixture, connection } = await setup()
    const { channel, lines, logEntries } = await progressProvider(connection, fixture)
    const connectionStates: ConnectionState[] = []
    const workspaceChanging = vi.fn()
    const rendererWouldOpenPicker = vi.fn()
    connection.on('state', (state: ConnectionState) => {
      connectionStates.push(state)
      if (state.status === 'connected' && !state.workspace) rendererWouldOpenPicker()
    })
    connection.on('workspace-changing', workspaceChanging)
    const input = { prompt: 'continue exactly once' }
    channel.write(JSON.stringify(input) + '\n')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    fixture.dropConnections()
    await vi.waitFor(() => expect(connection.state.status).toBe('disconnected'))
    expect(connection.state.workspace).toBe(fixture.workspace)
    await vi.waitFor(
      () =>
        expect(connection.state).toMatchObject({
          status: 'connected',
          workspace: fixture.workspace,
        }),
      { timeout: 6000 },
    )
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    const reconnected = connectionStates.filter((state) => state.status === 'connected')
    expect(reconnected).toHaveLength(1)
    expect(reconnected[0].workspace).toBe(fixture.workspace)
    expect(rendererWouldOpenPicker).not.toHaveBeenCalled()
    expect(workspaceChanging).not.toHaveBeenCalled()
    expect((await logEntries()).filter((entry) => entry.received)).toEqual([{ received: input }])
    expect(
      await readFile(join(fixture.root, 'settings', 'connections.json'), 'utf8'),
    ).not.toContain('fixture-password')
    channel.close()
  })

  it('keeps automatic machine recovery optional when the active project moved or disappeared', async () => {
    const { fixture, connection } = await setup()
    const connectionStates: ConnectionState[] = []
    const workspaceChanging = vi.fn()
    connection.on('state', (state: ConnectionState) => connectionStates.push(state))
    connection.on('workspace-changing', workspaceChanging)
    fixture.dropConnections()
    await vi.waitFor(() => expect(connection.state.status).toBe('disconnected'))
    const moved = join(fixture.root, 'moved-project')
    await rename(fixture.workspace, moved)
    // The fixture SSH shell needs a live cwd independently of the saved
    // project, just as a real sshd starts from the remote user's home.
    fixture.workspace = moved
    await vi.waitFor(() => expect(connection.state.status).toBe('connected'), { timeout: 6000 })
    expect(connection.state.home).toBe(fixture.root)
    expect(connection.state.workspace).toBeUndefined()
    expect(connectionStates.filter((state) => state.status === 'connected')).toHaveLength(1)
    expect(workspaceChanging).not.toHaveBeenCalled()
    expect(await connection.exec('printf MACHINE_RECONNECTED')).toBe('MACHINE_RECONNECTED')
  })

  it('explicitly disconnecting cancels automatic retries while preserving resumable remote work', async () => {
    const { fixture, connection } = await setup()
    const { channel, lines, logEntries } = await progressProvider(connection, fixture)
    channel.write(JSON.stringify({ prompt: 'saved remote work' }) + '\n')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    fixture.dropConnections()
    await vi.waitFor(() => expect(connection.state.status).toBe('disconnected'))
    connection.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 1250))
    expect(connection.state.status).toBe('disconnected')
    expect(await logEntries()).toHaveLength(2)
    await connection.connect(fixture.input())
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    channel.close()
  })
})
