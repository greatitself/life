import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeUserContent } from '../src/main/agent-attachments'
import { AgentHistory } from '../src/main/agent-history'
import { localOwnedNodeCommand } from '../src/main/local-owned-runtime'
import { stageStudioContext } from '../src/main/studio-context'
import type { LifeStudioContext } from '../src/shared/life-studio'
import type { ConnectionState } from '../src/shared/types'
import type { SSHExecOptions } from '../src/main/ssh'

const roots: string[] = []
const processes = new Set<ChildProcessWithoutNullStreams>()
afterEach(async () => {
  for (const child of processes) child.kill('SIGKILL')
  processes.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'life-owned-local-'))
  roots.push(root)
  const config = join(root, "Claude home ' café 🧪")
  const project = join(config, 'projects', 'project')
  await mkdir(project, { recursive: true })
  const env = {
    ...process.env,
    PATH: join(root, 'no-external-runtimes'),
    CLAUDE_CONFIG_DIR: config,
  }
  const state: ConnectionState = {
    status: 'connected',
    home: root,
    profile: {
      transport: 'local',
      id: 'local-fixture',
      name: 'Local',
      host: 'localhost',
      port: 22,
      username: 'fixture',
      auth: 'agent',
      privateKeyPath: '',
      workspace: root,
    },
  }
  const exec = vi.fn((command: string, options: SSHExecOptions = {}) => run(command, options, env))
  const ssh = Object.assign(new EventEmitter(), {
    state,
    exec,
    channel: vi.fn(async () => {
      throw new Error('No provider process is authorized in owned-helper tests')
    }),
  })
  return { root, config, project, env, ssh }
}

function run(command: string, options: SSHExecOptions, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, signal: options.signal, stdio: 'pipe' })
    processes.add(child)
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.maxOutputBytes ?? 4_000_000)) {
        child.kill('SIGKILL')
        reject(new Error('Helper exceeded its output limit'))
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', (code) => {
      processes.delete(child)
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || `Helper exited ${code}`))
    })
    child.stdin.end(options.input)
  })
}

const context: LifeStudioContext = {
  instructions: 'Exact local Studio instructions.\r\n$HOME 🧪\n',
  files: [{ path: '.life/configuration.json', content: '{"theme":"dark"}\r\n' }],
  phase: 'request',
  revision: 1,
}
const user = (id: string, text: string) => ({
  type: 'user',
  uuid: id,
  sessionId: 'session',
  cwd: '/work/café',
  timestamp: '2026-10-09T12:00:00.000Z',
  message: { role: 'user', content: text },
})

describe('Life-owned Local helpers without PATH Node or Python', () => {
  it('stages exact Studio files while the same SSH environment reports its runtime requirement', async () => {
    const { root, ssh } = await fixture()
    const workspace = await stageStudioContext(ssh, 'studio', context)
    expect(workspace).toBe(
      join(root, '.life/customization', createHash('sha256').update('studio').digest('hex')),
    )
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe(context.instructions)
    expect(await readFile(join(workspace, 'CLAUDE.md'), 'utf8')).toBe(context.instructions)
    expect(await readFile(join(workspace, context.files[0].path), 'utf8')).toBe(
      context.files[0].content,
    )
    expect((await stat(join(workspace, 'AGENTS.md'))).mode & 0o777).toBe(0o600)
    expect(ssh.exec.mock.calls[0][0]).toMatch(/^ELECTRON_RUN_AS_NODE=1 exec /)
    ssh.state.profile = { ...ssh.state.profile!, transport: 'ssh' }
    await expect(stageStudioContext(ssh, 'remote', context)).rejects.toThrow(
      'requires Node.js or Python 3',
    )
  })

  it('retains Studio symlink defenses and only retires its own obsolete context files', async () => {
    const { root, ssh } = await fixture()
    const workspace = await stageStudioContext(ssh, 'studio', context)
    await writeFile(join(workspace, '.life/notes.json'), 'User-owned notes')
    await stageStudioContext(ssh, 'studio', { ...context, revision: 2, files: [] })
    expect(await readdir(join(workspace, '.life'))).toEqual(['notes.json'])
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'unchanged')
    await rm(join(workspace, 'CLAUDE.md'))
    await symlink(outside, join(workspace, 'CLAUDE.md'))
    await expect(stageStudioContext(ssh, 'studio', context)).rejects.toThrow('symbolic links')
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
  })

  it('rejects switching transport during staging before adopting a foreign workspace', async () => {
    const { ssh } = await fixture()
    const exec = ssh.exec.getMockImplementation()!
    ssh.exec.mockImplementationOnce(async (command, options) => {
      const output = await exec(command, options)
      ssh.state.profile = { ...ssh.state.profile!, transport: 'ssh' }
      return output
    })
    await expect(stageStudioContext(ssh, 'studio', context)).rejects.toThrow('Connect')
  })

  it('preserves prompts, selected filenames, image bytes and text when attachments use bundled Node', async () => {
    const { root, ssh } = await fixture()
    const prompt = '  /life exact\r\n${literal} `quoted` café 🧪\t '
    const remotePath = join(root, "'$(touch marker)' 🧪.txt")
    const text = '\ufeff  # Exact document\r\n研究 🧪\n'
    const image = join(root, 'image.png')
    const bytes = Buffer.from([137, 80, 78, 71, 255])
    await writeFile(remotePath, text)
    await writeFile(image, bytes)
    expect(
      await claudeUserContent(ssh, prompt, [
        { remotePath, name: 'selected.txt', mimeType: 'text/plain' },
        { remotePath: image, name: 'image.png', mimeType: 'image/png' },
      ]),
    ).toEqual([
      { type: 'text', text: prompt },
      {
        type: 'document',
        title: 'selected.txt',
        source: { type: 'text', media_type: 'text/plain', data: text },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
      },
    ])
    expect(ssh.exec.mock.calls[0][0]).not.toContain(remotePath)
    ssh.state.profile = { ...ssh.state.profile!, transport: 'ssh' }
    await expect(
      claudeUserContent(ssh, prompt, [
        { remotePath, name: 'selected.txt', mimeType: 'text/plain' },
      ]),
    ).rejects.toThrow('require Node.js or Python 3')
  })

  it('keeps selected attachment symlinks valid while enforcing regular-file and transfer limits', async () => {
    const { root, ssh } = await fixture()
    const target = join(root, 'target.txt'),
      link = join(root, 'selected.txt')
    await writeFile(target, 'Exact target content')
    await symlink(target, link)
    expect(
      (
        await claudeUserContent(ssh, '', [
          { remotePath: link, name: 'selected.txt', mimeType: 'text/plain' },
        ])
      )[1],
    ).toMatchObject({ source: { data: 'Exact target content' } })
    await expect(
      claudeUserContent(ssh, '', [{ remotePath: root, name: 'directory', mimeType: '' }]),
    ).rejects.toThrow('regular files')
    await truncate(target, 10 * 1024 * 1024 + 1)
    await expect(
      claudeUserContent(ssh, '', [{ remotePath: target, name: 'target.txt', mimeType: '' }]),
    ).rejects.toThrow('10 MB')
  })

  it('uses exact quoted executable paths and confines Electron bootstrap flags to the owned child', async () => {
    const { root, env } = await fixture()
    const inherited = {
      home: process.env.HOME,
      codexHome: process.env.CODEX_HOME,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE,
    }
    const executable = join(root, "Life ' bundled runtime 🧪")
    await symlink(process.execPath, executable)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
    let command: string
    try {
      Object.defineProperty(process, 'execPath', { ...descriptor, value: executable })
      command = localOwnedNodeCommand(
        `const expected=${JSON.stringify(inherited)}; console.log(JSON.stringify({home:process.env.HOME===expected.home,codexHome:process.env.CODEX_HOME===expected.codexHome,owned:process.env.ELECTRON_RUN_AS_NODE==='1'}))`,
      )
    } finally {
      Object.defineProperty(process, 'execPath', descriptor)
    }
    expect(JSON.parse(await run(command!, {}, env))).toEqual({
      home: true,
      codexHome: true,
      owned: true,
    })
    expect({
      home: process.env.HOME,
      codexHome: process.env.CODEX_HOME,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE,
    }).toEqual(inherited)
  })

  it('reads native Claude history with custom config, provider identity and exact Unicode through no external utilities', async () => {
    const { project, ssh } = await fixture()
    const filename = join(project, 'session.jsonl')
    const prompt = '  Exact original\r\n研究 🧪\t '
    const original =
      [
        JSON.stringify(user('u1', prompt)),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Native title' }),
      ].join('\n') + '\n'
    await writeFile(filename, original)
    const history = new AgentHistory(ssh)
    const listed = await history.list({ provider: 'claude' })
    expect(listed.warnings).toEqual([])
    expect(listed.sessions[0]).toMatchObject({
      id: 'claude:session',
      remoteId: 'session',
      title: 'Native title',
      workspace: '/work/café',
    })
    const page = await history.read({ id: 'claude:session' })
    expect(page.messages[0].text).toBe(prompt)
    expect(await readFile(filename, 'utf8')).toBe(original)
    expect(ssh.channel).not.toHaveBeenCalled()
    expect(
      ssh.exec.mock.calls
        .slice(1)
        .every(([command]) => command.startsWith('ELECTRON_RUN_AS_NODE=1 exec ')),
    ).toBe(true)
    history.cancelAll()
  })

  it('skips transcript symlinks and symlink directories when indexing Local history', async () => {
    const { root, config, project, ssh } = await fixture()
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, JSON.stringify(user('outside', 'Private outside record')) + '\n')
    await symlink(outside, join(project, 'linked.jsonl'))
    const outsideDirectory = join(root, 'outside-directory')
    await mkdir(outsideDirectory)
    await writeFile(
      join(outsideDirectory, 'hidden.jsonl'),
      JSON.stringify(user('hidden', 'Private record')) + '\n',
    )
    await symlink(outsideDirectory, join(config, 'projects', 'linked-directory'))
    const history = new AgentHistory(ssh)
    expect((await history.list({ provider: 'claude' })).sessions).toEqual([])
    history.cancelAll()
  })

  it('preserves a Local Claude config directory with trailing spaces', async () => {
    const { root, env, ssh } = await fixture()
    const config = join(root, 'config with trailing spaces  ')
    const project = join(config, 'projects', 'project')
    await mkdir(project, { recursive: true })
    env.CLAUDE_CONFIG_DIR = config
    await writeFile(
      join(project, 'session.jsonl'),
      JSON.stringify(user('u1', 'Exact config path')) + '\n',
    )
    const history = new AgentHistory(ssh)
    expect((await history.list({ provider: 'claude' })).sessions[0].remoteId).toBe('session')
    expect((await history.read({ id: 'claude:session' })).messages[0].text).toBe(
      'Exact config path',
    )
    history.cancelAll()
  })

  it('finds titles between large records, across chunks, with huge ASCII whitespace and bounded title tails', async () => {
    const { project, ssh } = await fixture()
    const filename = join(project, 'session.jsonl')
    const tool = JSON.stringify({ type: 'tool', content: 'x'.repeat(300_000) }) + '\n'
    const title =
      '{"type"' + ' '.repeat(6_000_000) + ': "ai-title", "aiTitle":"Middle native title"}\n'
    const ordinaryTitles =
      Array.from({ length: 3000 }, (_, i) =>
        JSON.stringify({ type: 'ai-title', aiTitle: `Earlier native title ${i}` }),
      ).join('\n') + '\n'
    await writeFile(
      filename,
      JSON.stringify(user('u1', 'User text stays separate')) +
        '\n' +
        tool +
        ordinaryTitles +
        title +
        tool,
    )
    const original = await readFile(filename)
    const history = new AgentHistory(ssh)
    const listed = await history.list({ provider: 'claude' })
    expect(listed.warnings).toEqual([])
    expect(listed.sessions[0].title).toBe('Untitled Claude Code session')
    // Like grep|tail, the gigantic matching line's last 128 KB lacks its opening
    // JSON bytes. A later complete title remains recoverable beyond head/tail.
    await appendFile(
      filename,
      JSON.stringify({ type: 'ai-title', aiTitle: 'Last complete native title' }) + '\n' + tool,
    )
    history.cancelAll()
    const fresh = new AgentHistory(ssh)
    expect((await fresh.list({ provider: 'claude' })).sessions[0].title).toBe(
      'Last complete native title',
    )
    expect((await readFile(filename)).subarray(0, original.length).equals(original)).toBe(true)
    fresh.cancelAll()
  }, 20_000)

  it('retains the original byte snapshot when a provider transcript grows during pagination', async () => {
    const { project, ssh } = await fixture()
    const filename = join(project, 'session.jsonl')
    const prompts = ['First 🧪\r\n', 'Second café', 'Third 研究']
    await writeFile(
      filename,
      prompts.map((text, i) => JSON.stringify(user(`u${i}`, text))).join('\n') + '\n',
    )
    const history = new AgentHistory(ssh)
    await history.list({ provider: 'claude' })
    const first = await history.read({ id: 'claude:session', limit: 1 })
    expect(first.messages.map((message) => message.text)).toEqual([prompts[0]])
    await appendFile(filename, JSON.stringify(user('later', 'Appended after snapshot')) + '\n')
    const second = await history.read({ id: 'claude:session', limit: 10, cursor: first.nextCursor })
    expect(second.messages.map((message) => message.text)).toEqual(prompts.slice(1))
    expect(second.nextCursor).toBeUndefined()
    history.cancelAll()
  })
})
