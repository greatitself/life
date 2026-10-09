import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageStudioContext } from '../src/main/studio-context'
import type { LifeStudioContext } from '../src/shared/life-studio'
import type { ConnectionState } from '../src/shared/types'

const context: LifeStudioContext = {
  instructions: 'Life Studio instructions.\nKeep the user prompt exact.\n',
  files: [
    { path: '.life/configuration.json', content: '{"theme":"dark"}\n' },
    { path: '.life/source-state.json', content: '{"revision":1}' },
  ],
  revision: 1,
  phase: 'request',
}
const connection: ConnectionState = {
  status: 'connected',
  profile: {
    id: 'machine',
    name: 'Research machine',
    host: 'example.test',
    port: 22,
    username: 'researcher',
    auth: 'agent',
    privateKeyPath: '',
    workspace: '~',
  },
}
const temporaryRoots: string[] = []
const pythonExecutable = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
}).stdout?.trim()
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function workspace(home: string, id = 'studio-session') {
  return join(home, '.life', 'customization', createHash('sha256').update(id).digest('hex'))
}
function fake(home?: string) {
  const suppliedHome = arguments.length ? home : '/home/researcher'
  const ssh = {
    state: { ...connection, home: suppliedHome },
    exec: vi.fn(async (_command: string, options?: { input?: string; signal?: AbortSignal }) => {
      if (!options?.input) return '/home/researcher'
      const input = JSON.parse(options.input)
      return JSON.stringify({
        workspace: join(input.home, '.life', 'customization', input.session),
      })
    }),
  }
  return ssh
}
async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), 'life-studio-context-'))
  temporaryRoots.push(home)
  return home
}
function runRemoteProgram(
  command: string,
  input: string,
  signal?: AbortSignal,
  runtimePath?: string,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'sh' : '/bin/sh', ['-c', command], {
      signal,
      env: {
        ...process.env,
        PATH: runtimePath ?? `${dirname(process.execPath)}:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '',
      error = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (error += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(error || `Exited ${code}`)),
    )
    child.stdin.on('error', () => {
      // An unavailable remote runtime can exit before consuming stdin. Its exit
      // status and stderr provide the actionable failure instead of EPIPE.
    })
    child.stdin.end(input)
  })
}
function actual(home: string, runtimePath?: string) {
  return {
    state: { ...connection, home },
    exec: vi.fn(async (command: string, options?: { input?: string; signal?: AbortSignal }) => {
      if (!options?.input) throw new Error('Unexpected home lookup')
      return runRemoteProgram(command, options.input, options.signal, runtimePath)
    }),
  }
}

describe('dedicated Life Studio instruction files', () => {
  it('uses a stable opaque session namespace independently of the selected project', async () => {
    const ssh = fake()
    const first = await stageStudioContext(ssh, '../../unsafe/session', context)
    ssh.state = { ...ssh.state, workspace: '/different/project' }
    const second = await stageStudioContext(ssh, '../../unsafe/session', {
      ...context,
      revision: 2,
    })
    expect(first).toBe(workspace('/home/researcher', '../../unsafe/session'))
    expect(second).toBe(first)
    expect(first).not.toContain('/unsafe/')
    const third = await stageStudioContext(ssh, 'other-session', context)
    expect(third).not.toBe(first)
    const [command, options] = ssh.exec.mock.calls[0]
    expect(command).toMatch(/^if command -v node /)
    expect(command).toContain('elif command -v python3 ')
    expect(command.length).toBeLessThan(16000)
    expect(command).not.toContain(context.instructions)
    expect(JSON.parse(options!.input!)).toMatchObject({ context, session: first.split('/').at(-1) })
  })

  it('reads the remote home without requiring a project when the connection did not supply it', async () => {
    const ssh = fake(undefined)
    const abort = new AbortController()
    expect(await stageStudioContext(ssh, 'studio-session', context, abort.signal)).toBe(
      workspace('/home/researcher'),
    )
    expect(ssh.exec.mock.calls[0][0]).toBe(`printf '%s' "$HOME"`)
    expect(ssh.exec.mock.calls[0][1]).toMatchObject({ signal: abort.signal, maxOutputBytes: 8192 })
    expect(ssh.exec.mock.calls[1][1]).toMatchObject({
      signal: abort.signal,
      timeoutMs: 30000,
      maxOutputBytes: 8192,
    })
  })

  it('rejects invalid or oversized schema values before remote work', async () => {
    const ssh = fake()
    for (const invalid of [
      { ...context, files: [{ path: '../outside.json', content: '{}' }] },
      { ...context, files: [context.files[0], context.files[0]] },
      { ...context, instructions: 'x'.repeat(100001) },
      { ...context, files: [{ path: '.life/large.json', content: '😀'.repeat(800000) }] },
    ])
      await expect(
        stageStudioContext(ssh, 'studio-session', invalid as LifeStudioContext),
      ).rejects.toThrow()
    expect(ssh.exec).not.toHaveBeenCalled()
    await expect(stageStudioContext(ssh, '', context)).rejects.toThrow('session')
    await expect(stageStudioContext(ssh, 'x'.repeat(101), context)).rejects.toThrow('session')
    expect(ssh.exec).not.toHaveBeenCalled()
  })

  it('rejects a missing connection, invalid home and cancellation without staging files', async () => {
    const offline = fake()
    offline.state = { ...offline.state, status: 'disconnected' }
    await expect(stageStudioContext(offline, 'studio-session', context)).rejects.toThrow('Connect')
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      stageStudioContext(fake(), 'studio-session', context, aborted.signal),
    ).rejects.toThrow('cancelled')
    for (const home of ['/home/../outside', 'relative', '/home/invalid\n']) {
      const ssh = fake(home)
      await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
        'home directory',
      )
      expect(ssh.exec).not.toHaveBeenCalled()
    }
  })

  it('fences a machine change during home discovery and after staging', async () => {
    const lookup = fake(undefined)
    lookup.exec.mockImplementationOnce(async () => {
      lookup.state = { ...lookup.state, profile: { ...connection.profile!, id: 'other' } }
      return '/home/researcher'
    })
    await expect(stageStudioContext(lookup, 'studio-session', context)).rejects.toThrow('Connect')
    expect(lookup.exec).toHaveBeenCalledTimes(1)
    const staging = fake()
    staging.exec.mockImplementationOnce(async () => {
      staging.state = { ...staging.state, status: 'disconnected' }
      return JSON.stringify({ workspace: workspace('/home/researcher') })
    })
    await expect(stageStudioContext(staging, 'studio-session', context)).rejects.toThrow('Connect')
  })

  it('requires the remote program to return the expected namespace', async () => {
    const ssh = fake()
    ssh.exec.mockResolvedValueOnce('not JSON')
    await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
      'invalid staging result',
    )
    ssh.exec.mockResolvedValueOnce(JSON.stringify({ workspace: '/another/project' }))
    await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
      'invalid workspace',
    )
  })

  it('actually writes exact private instruction and context files through Node and a shell', async () => {
    const home = await isolatedHome()
    const ssh = actual(home)
    const root = await stageStudioContext(ssh, 'studio-session', context)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(await readFile(join(root, name), 'utf8')).toBe(context.instructions)
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600)
    }
    for (const file of context.files) {
      expect(await readFile(join(root, file.path), 'utf8')).toBe(file.content)
      expect((await stat(join(root, file.path))).mode & 0o777).toBe(0o600)
    }
    for (const path of [
      join(home, '.life'),
      join(home, '.life', 'customization'),
      root,
      join(root, '.life'),
    ])
      expect((await stat(path)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(join(root, '.studio-context.json'), 'utf8'))).toMatchObject({
      revision: 1,
      phase: 'request',
      files: context.files.map((file) => file.path),
    })
    expect((await readdir(root)).some((name) => name.startsWith('.life-write-'))).toBe(false)
  })

  it('treats shell metacharacters, Unicode and control characters as literal file content', async () => {
    const home = await isolatedHome()
    const marker = join(home, 'must-not-exist')
    const instructions = `Literal '\\ quotes, \n\r\t\u0000, $HOME, \`touch ${marker}\`, $(touch ${marker}) and 🧪`
    const literal = {
      ...context,
      instructions,
      files: [{ path: '.life/literal.json', content: JSON.stringify({ text: instructions }) }],
    }
    const root = await stageStudioContext(actual(home), 'studio-session', literal)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(instructions)
    expect(await readFile(join(root, '.life/literal.json'), 'utf8')).toBe(literal.files[0].content)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes the same workspace atomically and retires only previously owned context files', async () => {
    const home = await isolatedHome(),
      ssh = actual(home)
    const root = await stageStudioContext(ssh, 'studio-session', context)
    const unrelated = join(root, '.life/notes.json')
    await writeFile(unrelated, 'user notes')
    await rm(join(root, '.life/source-state.json'))
    const next = {
      ...context,
      instructions: 'Updated source-reading instructions',
      files: [{ path: '.life/source-files.json', content: '{"files":[]}' }],
      revision: 2,
      phase: 'source-read' as const,
    }
    expect(await stageStudioContext(ssh, 'studio-session', next)).toBe(root)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(next.instructions)
    expect(await readFile(unrelated, 'utf8')).toBe('user notes')
    await expect(stat(join(root, '.life/configuration.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readdir(join(root, '.life'))).toEqual(['notes.json', 'source-files.json'])
  })

  it.each([
    '.life',
    '.life/customization',
    '.life/customization/session',
    '.life/customization/session/.life',
  ])('refuses a symbolic link at an existing app directory: %s', async (path) => {
    const home = await isolatedHome(),
      outside = await isolatedHome()
    const relative = path.replace(
      'session',
      createHash('sha256').update('studio-session').digest('hex'),
    )
    const target = join(home, relative)
    await mkdir(dirname(target), { recursive: true })
    await symlink(outside, target)
    await expect(stageStudioContext(actual(home), 'studio-session', context)).rejects.toThrow(
      'symbolic links',
    )
    expect(await readdir(outside)).toEqual([])
  })

  it.each(['AGENTS.md', 'CLAUDE.md', '.life/configuration.json', '.studio-context.json'])(
    'refuses a symbolic link at an existing context file before replacing instructions: %s',
    async (name) => {
      const home = await isolatedHome(),
        ssh = actual(home)
      const root = await stageStudioContext(ssh, 'studio-session', context)
      const outside = join(home, 'outside.txt')
      await writeFile(outside, 'unchanged')
      await rm(join(root, name))
      await symlink(outside, join(root, name))
      await expect(
        stageStudioContext(ssh, 'studio-session', { ...context, instructions: 'must not replace' }),
      ).rejects.toThrow('symbolic links')
      expect(await readFile(outside, 'utf8')).toBe('unchanged')
      if (name !== 'AGENTS.md')
        expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(context.instructions)
      expect((await readdir(root)).some((file) => file.startsWith('.life-write-'))).toBe(false)
    },
  )

  it('rejects traversal even if the input to the fixed remote program is tampered with', async () => {
    const home = await isolatedHome(),
      ssh = actual(home)
    const outside = join(home, 'outside.json')
    await writeFile(outside, 'unchanged')
    ssh.exec.mockImplementationOnce(async (command, options) => {
      const input = JSON.parse(options!.input!)
      input.context.files = [{ path: '../../../outside.json', content: 'overwrite' }]
      return runRemoteProgram(command, JSON.stringify(input))
    })
    await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
      'Invalid Life Studio context file',
    )
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
    await expect(stat(workspace(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(!pythonExecutable || process.platform === 'win32')(
  'Python-only remote Life Studio',
  () => {
    async function fixture() {
      const home = await isolatedHome()
      const runtimePath = await isolatedHome()
      await symlink(pythonExecutable, join(runtimePath, 'python3'))
      return { home, runtimePath, ssh: actual(home, runtimePath) }
    }

    it('stages exact private files with no Node available, preserving Unicode and literal shell content', async () => {
      const { home, ssh } = await fixture()
      const marker = join(home, 'must-not-exist')
      const instructions = `\nLiteral '\\ quotes, \r\n\t\u0000, $HOME, \`touch ${marker}\`, $(touch ${marker}), 🧪 and \ud800\udc00 / \ud800 end.\n`
      const literal: LifeStudioContext = {
        ...context,
        instructions,
        files: [{ path: '.life/context.json', content: JSON.stringify({ text: instructions }) }],
      }
      const root = await stageStudioContext(ssh, 'studio-session', literal)
      expect(root).toBe(workspace(home))
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        expect(await readFile(join(root, name))).toEqual(Buffer.from(instructions, 'utf8'))
        expect((await stat(join(root, name))).mode & 0o777).toBe(0o600)
      }
      expect(await readFile(join(root, literal.files[0].path), 'utf8')).toBe(
        literal.files[0].content,
      )
      expect((await stat(join(root, literal.files[0].path))).mode & 0o777).toBe(0o600)
      for (const directory of [
        join(home, '.life'),
        join(home, '.life', 'customization'),
        root,
        join(root, '.life'),
      ])
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(root)).some((name) => name.startsWith('.life-write-'))).toBe(false)
    })

    it('accepts schema-bounded content even when JSON escaping makes stdin larger than 3 MB', async () => {
      const { ssh } = await fixture()
      const escaped = {
        ...context,
        files: [{ path: '.life/escaped.json', content: '\u0000'.repeat(600000) }],
      }
      const root = await stageStudioContext(ssh, 'studio-session', escaped)
      expect(await readFile(join(root, '.life/escaped.json'))).toEqual(Buffer.alloc(600000))
      expect(Buffer.byteLength(ssh.exec.mock.calls[0][1]!.input!)).toBeGreaterThan(3500000)
    })

    it('keeps the same namespace for revisions and removes only obsolete app context', async () => {
      const { ssh } = await fixture()
      const root = await stageStudioContext(ssh, 'studio-session', context)
      await writeFile(join(root, '.life/notes.json'), 'user-owned notes')
      await rm(join(root, '.life/source-state.json'))
      const next = {
        ...context,
        revision: 2,
        phase: 'repair' as const,
        instructions: 'Repair instructions',
        files: [{ path: '.life/repair.json', content: '{"repair":true}' }],
      }
      expect(await stageStudioContext(ssh, 'studio-session', next)).toBe(root)
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(next.instructions)
      expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(next.instructions)
      expect(await readFile(join(root, '.life/notes.json'), 'utf8')).toBe('user-owned notes')
      expect(await readdir(join(root, '.life'))).toEqual(['notes.json', 'repair.json'])
    })

    it.each([
      '.life',
      '.life/customization',
      '.life/customization/session',
      '.life/customization/session/.life',
    ])('rejects an existing app directory symlink: %s', async (path) => {
      const { home, ssh } = await fixture(),
        outside = await isolatedHome()
      const target = join(
        home,
        path.replace('session', createHash('sha256').update('studio-session').digest('hex')),
      )
      await mkdir(dirname(target), { recursive: true })
      await symlink(outside, target)
      await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
        'symbolic links',
      )
      expect(await readdir(outside)).toEqual([])
    })

    it.each(['AGENTS.md', 'CLAUDE.md', '.life/configuration.json', '.studio-context.json'])(
      'rejects an existing context symlink before replacing any instructions: %s',
      async (name) => {
        const { home, ssh } = await fixture()
        const root = await stageStudioContext(ssh, 'studio-session', context)
        const outside = join(home, 'outside.txt')
        await writeFile(outside, 'unchanged')
        await rm(join(root, name))
        await symlink(outside, join(root, name))
        await expect(
          stageStudioContext(ssh, 'studio-session', {
            ...context,
            instructions: 'must not replace',
          }),
        ).rejects.toThrow('symbolic links')
        expect(await readFile(outside, 'utf8')).toBe('unchanged')
        if (name !== 'AGENTS.md')
          expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(context.instructions)
        expect((await readdir(root)).some((file) => file.startsWith('.life-write-'))).toBe(false)
      },
    )

    it.each([
      { ...context, files: [{ path: '../../../outside.json', content: 'overwrite' }] },
      { ...context, files: [{ ...context.files[0], unexpected: true }] },
      { ...context, revision: true },
      { ...context, instructions: '🧪'.repeat(50001) },
      { ...context, files: [{ path: '.life/large.json', content: '🧪'.repeat(800000) }] },
    ])(
      'enforces the schema again inside the Python process when stdin is tampered with',
      async (tampered) => {
        const { home, runtimePath, ssh } = await fixture()
        const outside = join(home, 'outside.json')
        await writeFile(outside, 'unchanged')
        ssh.exec.mockImplementationOnce(async (command, options) => {
          const input = JSON.parse(options!.input!)
          input.context = tampered
          return runRemoteProgram(command, JSON.stringify(input), undefined, runtimePath)
        })
        await expect(stageStudioContext(ssh, 'studio-session', context)).rejects.toThrow(
          /Invalid Life Studio|exceeds 3 MB/,
        )
        expect(await readFile(outside, 'utf8')).toBe('unchanged')
        await expect(stat(workspace(home))).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )

    it('returns a clear requirement when neither Node nor Python 3 is available', async () => {
      const home = await isolatedHome(),
        emptyPath = await isolatedHome()
      await expect(
        stageStudioContext(actual(home, emptyPath), 'studio-session', context),
      ).rejects.toThrow('Life Studio requires Node.js or Python 3 on the connected environment.')
      await expect(stat(workspace(home))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  },
)
