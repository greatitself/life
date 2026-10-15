import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  appendFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Store } from '../src/main/store'
import { SSHConnection, type SSHExecOptions } from '../src/main/ssh'
import { stageStudioContext } from '../src/main/studio-context'
import { claudeUserContent } from '../src/main/agent-attachments'
import { AgentHistory } from '../src/main/agent-history'
import { localOwnedNodeCommand } from '../src/main/local-owned-runtime'
import { shellQuote } from '../src/shared/validation'
import type { LifeStudioContext } from '../src/shared/life-studio'

async function main() {
  assert.ok(process.versions.electron, 'This fixture must run inside genuine Electron')
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
  const proofPath = process.argv[2]
  assert.ok(proofPath)
  const root = await mkdtemp(join(tmpdir(), 'life-owned-helper-native-'))
  const workspace = join(root, "local workspace ' café 🧪  ")
  const emptyPath = join(root, 'empty-executable-path')
  const config = join(root, "Claude config ' café 🧪  ")
  const project = join(config, 'projects/project')
  const shell = join(root, 'fixture-shell')
  const inherited = {
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  }
  const proof: Record<string, unknown> = {
    fixture: 'genuine Electron bundled Node; real Local connection and temporary files',
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    executable: process.execPath,
    authenticatedProviderUse: false,
    inferenceRequests: 0,
    stagingHome: 'explicit fixture-owned home view; inherited HOME/CODEX_HOME unchanged',
    checks: [] as string[],
    timings: [] as { name: string; elapsedMs: number }[],
  }
  const checks = proof.checks as string[]
  const executions: { command: string; input?: string }[] = []
  let connection: SSHConnection | undefined
  let history: AgentHistory | undefined
  const measure = async <A>(name: string, action: () => Promise<A>): Promise<A> => {
    const started = performance.now()
    const result = await action()
    ;(proof.timings as { name: string; elapsedMs: number }[]).push({
      name,
      elapsedMs: performance.now() - started,
    })
    return result
  }
  try {
    await Promise.all([
      mkdir(workspace),
      mkdir(emptyPath),
      mkdir(project, { recursive: true }),
      writeFile(
        shell,
        '#!/bin/bash\nif [[ "$1" == "-lc" ]]; then\n  task_command="${2#*; }"\nelif [[ "$1" == "-c" ]]; then\n  task_command="$2"\nelse\n  exit 2\nfi\nexport PATH="$LIFE_HELPER_EMPTY_PATH"\nexec /bin/bash --noprofile --norc -c "$task_command"\n',
        { mode: 0o755 },
      ),
    ])
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHELL: shell,
      PATH: emptyPath,
      LIFE_HELPER_EMPTY_PATH: emptyPath,
      CLAUDE_CONFIG_DIR: config,
    }
    assert.equal(env.HOME, inherited.home)
    assert.equal(env.CODEX_HOME, inherited.codexHome)
    const store = new Store(join(root, 'settings'), { localWorkspace: workspace })
    await store.init()
    connection = new SSHConnection(store, {
      local: { shell, env, brokerDirectory: join(root, '.life/agent-sessions') },
    })
    let trustPrompts = 0
    connection.on('host-key', () => trustPrompts++)
    await measure('real-local-connect', () => connection!.connect(store.localProfile()))
    await connection.whenProviderVersionsReady()
    assert.equal(connection.state.status, 'connected')
    assert.equal(connection.state.profile?.transport, 'local')
    assert.equal(connection.state.workspace, workspace)
    assert.equal(connection.state.codex, 'missing')
    assert.equal(connection.state.claude, 'missing')
    assert.equal(trustPrompts, 0)
    const absent = await connection.exec(
      'for tool in node python3 codex claude; do if command -v "$tool" >/dev/null 2>&1; then exit 1; fi; done; printf NO_EXTERNAL_RUNTIME_OR_PROVIDER',
    )
    assert.equal(absent, 'NO_EXTERNAL_RUNTIME_OR_PROVIDER')
    checks.push('Real Local connection works with no Node, Python, Codex or Claude on PATH')

    const execute = connection.exec.bind(connection)
    const trackedExec = (command: string, options: SSHExecOptions = {}) => {
      executions.push({ command, input: options.input })
      return execute(command, options)
    }
    // The real connection retains the actual user's home. Only this helper's
    // supplied staging home points at the disposable filesystem fixture.
    const stageConnection = {
      get state() {
        return { ...connection!.state, home: root }
      },
      exec: trackedExec,
    }
    const instructions = 'Exact native Studio instructions.\r\n${literal} `quoted` café 🧪\n'
    const context: LifeStudioContext = {
      instructions,
      files: [{ path: '.life/configuration.json', content: '{"theme":"dark","text":"🧪"}\r\n' }],
      revision: 1,
      phase: 'request',
    }
    const staged = await measure('bundled-studio-stage', () =>
      stageStudioContext(stageConnection, 'native-studio', context),
    )
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      assert.equal(await readFile(join(staged, name), 'utf8'), instructions)
      assert.equal((await stat(join(staged, name))).mode & 0o777, 0o600)
    }
    assert.equal(
      await readFile(join(staged, context.files[0].path), 'utf8'),
      context.files[0].content,
    )
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'unchanged outside content')
    await rm(join(staged, 'CLAUDE.md'))
    await symlink(outside, join(staged, 'CLAUDE.md'))
    await assert.rejects(
      stageStudioContext(stageConnection, 'native-studio', context),
      /symbolic links/,
    )
    assert.equal(await readFile(outside, 'utf8'), 'unchanged outside content')
    checks.push('Bundled Electron stages exact private Studio files and preserves symlink defenses')

    const text = '\ufeff  Exact native attachment\r\n研究 🧪\n'
    const textPath = join(root, "attachment ' $(touch marker) 🧪.txt")
    const imagePath = join(root, 'selected.png')
    const image = Buffer.from([137, 80, 78, 71, 255, 0])
    await writeFile(textPath, text)
    await writeFile(imagePath, image)
    const attachmentConnection = {
      get state() {
        return connection!.state
      },
      exec: trackedExec,
    }
    const prompt = '  Exact original /life prompt\r\n${literal} café 🧪\t '
    const blocks = await measure('bundled-attachment-read', () =>
      claudeUserContent(attachmentConnection, prompt, [
        { remotePath: textPath, name: 'selected.txt', mimeType: 'text/plain' },
        { remotePath: imagePath, name: 'selected.png', mimeType: 'image/png' },
      ]),
    )
    assert.deepEqual(blocks, [
      { type: 'text', text: prompt },
      {
        type: 'document',
        title: 'selected.txt',
        source: { type: 'text', media_type: 'text/plain', data: text },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') },
      },
    ])
    await assert.rejects(stat(join(root, 'marker')), { code: 'ENOENT' })
    await assert.rejects(
      claudeUserContent(attachmentConnection, prompt, [
        { remotePath: root, name: 'directory', mimeType: '' },
      ]),
      /regular files/,
    )
    checks.push(
      'Bundled Electron reads native Claude image/text blocks with exact prompts and literal filenames',
    )

    const filename = join(project, 'session.jsonl')
    const user = (id: string, text: string) =>
      JSON.stringify({
        type: 'user',
        uuid: id,
        sessionId: 'session',
        cwd: workspace,
        message: { role: 'user', content: text },
      }) + '\n'
    const prompts = [prompt, '  Second original 研究\r\n']
    const padding = JSON.stringify({ type: 'irrelevant', value: 'x'.repeat(180_000) }) + '\n'
    const original =
      prompts.map((text, index) => user(`u${index}`, text)).join('') +
      padding +
      JSON.stringify({ type: 'ai-title', aiTitle: 'Original native middle title' }) +
      '\n' +
      padding
    await writeFile(filename, original)
    await symlink(outside, join(project, 'outside.jsonl'))
    const originalHash = createHash('sha256').update(original).digest('hex')
    const historyConnection = Object.assign(Object.create(connection), {
      exec: trackedExec,
      channel: async () => {
        throw new Error('Provider execution is not authorized in owned-helper fixtures')
      },
    }) as SSHConnection
    history = new AgentHistory(historyConnection)
    const listed = await measure('bundled-history-list', () =>
      history!.list({ provider: 'claude' }),
    )
    assert.deepEqual(listed.warnings, [])
    assert.equal(listed.sessions.length, 1)
    assert.equal(listed.sessions[0].id, 'claude:session')
    assert.equal(listed.sessions[0].remoteId, 'session')
    assert.equal(listed.sessions[0].title, 'Original native middle title')
    assert.equal(listed.sessions[0].workspace, workspace)
    const first = await history.read({ id: 'claude:session', limit: 1 })
    assert.deepEqual(
      first.messages.map((message) => message.text),
      prompts.slice(0, 1),
    )
    await appendFile(filename, user('later', 'Appended after the original snapshot'))
    const second = await history.read({ id: 'claude:session', limit: 10, cursor: first.nextCursor })
    assert.deepEqual(
      second.messages.map((message) => message.text),
      prompts.slice(1),
    )
    assert.equal(second.nextCursor, undefined)
    assert.equal(
      createHash('sha256')
        .update((await readFile(filename)).subarray(0, Buffer.byteLength(original)))
        .digest('hex'),
      originalHash,
    )
    checks.push(
      'Bundled Electron preserves custom-config history identity, middle titles, symlink exclusion and exact byte snapshots',
    )

    const bootstrap = JSON.parse(
      await trackedExec(
        localOwnedNodeCommand(
          `const expected=${JSON.stringify(inherited)};console.log(JSON.stringify({electron:process.versions.electron,executable:process.execPath,homeUnchanged:process.env.HOME===expected.home,codexHomeUnchanged:process.env.CODEX_HOME===expected.codexHome,ownedBootstrap:process.env.ELECTRON_RUN_AS_NODE==='1'}))`,
        ),
      ),
    )
    assert.equal(bootstrap.electron, process.versions.electron)
    assert.equal(bootstrap.executable, process.execPath)
    assert.equal(bootstrap.homeUnchanged, true)
    assert.equal(bootstrap.codexHomeUnchanged, true)
    assert.equal(bootstrap.ownedBootstrap, true)
    assert.equal(process.env.HOME, inherited.home)
    assert.equal(process.env.CODEX_HOME, inherited.codexHome)
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, inherited.runAsNode)
    const ownedCommands = executions.filter(
      ({ input, command }) => input || command.startsWith('ELECTRON_RUN_AS_NODE=1'),
    )
    assert.ok(ownedCommands.length >= 8)
    assert.ok(
      ownedCommands.every(({ command }) =>
        command.startsWith(`ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} -e `),
      ),
    )
    proof.ownedCommandCount = ownedCommands.length
    proof.bootstrap = bootstrap
    checks.push(
      'Every owned helper invokes genuine Electron; HOME/CODEX_HOME and parent bootstrap environment remain unchanged',
    )
    proof.passed = true
  } catch (error) {
    proof.passed = false
    proof.error = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    history?.cancelAll()
    await connection?.disconnectAndWait()
    await rm(root, { recursive: true, force: true })
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n')
  }
  console.log(
    `Owned-helper native proof passed ${checks.length} groups using genuine Electron ${process.versions.electron}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
