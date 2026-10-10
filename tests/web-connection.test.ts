import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { WebConnection } from '../src/web/local-connection'
import { executeConnectionCommand } from '../src/main/connection-execution'

describe('web app local host', () => {
  let root: string
  let connection: WebConnection
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'life-web-connection-'))
    const store = new Store(join(root, 'state'))
    await store.init()
    connection = new WebConnection(store, root)
    await connection.connect(connection.localProfile)
  })
  afterEach(async () => {
    connection?.closeLocalProcesses()
    await rm(root, { recursive: true, force: true })
  })
  it('executes real commands and streams stdin through the shared connection API', async () => {
    expect(await connection.exec('cat', { input: 'Exact input: $() and `literal`\n' })).toBe(
      'Exact input: $() and `literal`\n',
    )
    expect(await executeConnectionCommand(connection, { command: 'pwd' })).toBe(root + '\n')
  })
  it('reports failures and cancels the running process', async () => {
    await expect(connection.exec('printf failure >&2; exit 7')).rejects.toThrow('failure')
    await expect(connection.exec('sleep 30', { timeoutMs: 50 })).rejects.toThrow('timed out')
    expect(await connection.exec('printf ready')).toBe('ready')
  })
  it('browses project files and rejects symlinks outside the project', async () => {
    await writeFile(join(root, 'notes.txt'), 'Real project file')
    await symlink('/etc/passwd', join(root, 'outside.txt'))
    expect((await connection.list()).some((entry) => entry.name === 'notes.txt')).toBe(true)
    expect(await connection.read('notes.txt')).toBe('Real project file')
    await expect(connection.read('outside.txt')).rejects.toThrow('inside the current project')
    await mkdir(join(root, 'second-project'))
    await connection.selectWorkspace(join(root, 'second-project'))
    expect(await executeConnectionCommand(connection, { command: 'pwd' })).toBe(
      join(root, 'second-project') + '\n',
    )
  })
  it('provides an interactive PTY with resize and real shell output', async () => {
    let output = ''
    connection.on('terminal', (data: string) => {
      output += data
    })
    await connection.openTerminal()
    connection.resizeTerminal(100, 25)
    connection.writeTerminal("printf 'LIFE_%s\\n' 'PTY_OK'\r")
    await expect.poll(() => output, { timeout: 5000 }).toContain('LIFE_PTY_OK')
    connection.closeTerminal()
  })
})
