import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeLaunchCommand } from '../src/main/claude-protocol'

const require = createRequire(import.meta.url)
const bootstrap = require('./helpers/active-recovery-observer/local-bootstrap.cjs')
const directories: string[] = []
const restorations: Array<() => void> = []
const localProfileId = 'local:9a265ca5-dea9-4c6b-98c0-888345783146'

function fixtureInput(root = '/private/fixture') {
  return {
    root,
    workspace: join(root, "workspace's café 🧪"),
    input: () => ({
      id: 'fixture-machine',
      name: 'Loopback fixture',
      host: '127.0.0.1',
      port: 43210,
      username: 'fixture',
      auth: 'password',
      password: 'fixture-password',
      privateKeyPath: '',
      workspace: join(root, "workspace's café 🧪"),
    }),
  }
}

async function privateHarness() {
  const root = await mkdtemp(join(tmpdir(), 'life-bootstrap-unit-'))
  directories.push(root)
  const fixture = fixtureInput(join(root, 'native-fixture'))
  const configurationRoot = join(root, 'configuration')
  await mkdir(join(configurationRoot, 'Life'), { recursive: true })
  await mkdir(join(fixture.root, '.local', 'bin'), { recursive: true })
  await mkdir(fixture.workspace, { recursive: true })
  const provider = await readFile(resolve('tests/helpers/active-session-recovery-provider.cjs'))
  for (const name of ['codex', 'claude'])
    await writeFile(join(fixture.root, '.local', 'bin', name), provider, { mode: 0o700 })
  return { fixture, configurationRoot }
}

afterEach(async () => {
  for (const restore of restorations.splice(0)) restore()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('private active recovery bootstrap', () => {
  it.each(['local', 'ssh'])(
    'selects a genuine %s profile without persisted credentials',
    (mode) => {
      const fixture = fixtureInput()
      const seed = bootstrap.seedConnections({
        mode,
        fixture,
        localProfileId,
        configPath: '/private/ssh-config',
      })
      expect(seed.selectedProfileId).toBe(mode === 'local' ? localProfileId : 'fixture-machine')
      expect(seed.localWorkspace).toBe(fixture.workspace)
      expect(seed.profiles[0]).toMatchObject({
        transport: 'ssh',
        auth: 'password',
        workspace: '~',
        sshConfig: { alias: 'life-recovery-fixture', path: '/private/ssh-config' },
      })
      expect(seed.profiles[0]).not.toHaveProperty('password')
      expect(seed.profiles[0]).not.toHaveProperty('passphrase')
      expect(seed.knownHosts).toEqual({})
      expect(bootstrap.privateSSHConfig(fixture)).toContain('IdentityFile none\n')
      expect(bootstrap.privateSSHConfig(fixture)).toContain('IdentityAgent none\n')
      expect(bootstrap.privateSSHConfig(fixture)).not.toMatch(/Include|~\//)
    },
  )

  it('rejects mismatched machine identities and nonprivate path shapes', () => {
    const fixture = fixtureInput()
    const valid = { mode: 'local', fixture, localProfileId, configPath: '/private/ssh-config' }
    expect(() => bootstrap.seedConnections({ ...valid, localProfileId: 'life-local' })).toThrow()
    expect(() => bootstrap.seedConnections({ ...valid, configPath: '~/.ssh/config' })).toThrow()
    expect(() =>
      bootstrap.seedConnections({
        ...valid,
        fixture: { ...fixture, workspace: '/private/\nwrong' },
      }),
    ).toThrow()
    expect(() =>
      bootstrap.seedConnections({
        ...valid,
        fixture: { ...fixture, input: () => ({ ...fixture.input(), host: 'public.example.com' }) },
      }),
    ).toThrow()
    expect(() =>
      bootstrap.seedConnections({ ...valid, localProfileId: fixture.input().id }),
    ).toThrow()
  })

  it('preserves inherited auth-home values and input options while controlling execution', () => {
    const environment = {
      HOME: '/inherited/home',
      CODEX_HOME: '/inherited/codex',
      CLAUDE_CONFIG_DIR: '/inherited/claude',
      PATH: '/installed/providers',
      SHELL: '/installed/shell',
      NODE_OPTIONS: '--require /installed/injection',
      ELECTRON_RUN_AS_NODE: '1',
      BASH_ENV: '/installed/startup',
      ENV: '/installed/startup',
      XDG_CONFIG_HOME: '/private/configuration',
      opaque: '漢字',
    }
    const before = { ...environment }
    const output = bootstrap.launchEnvironment(environment, {
      mode: 'local',
      root: '/private/fixture',
      shell: '/private/fixture/bin/shell',
      guardBin: '/private/fixture/bin',
      nodePath: '/private/node/bin/node',
      inheritedHome: environment.HOME,
      commandLog: '/private/fixture/commands.jsonl',
    })
    expect(environment).toEqual(before)
    expect(output).toMatchObject({
      HOME: before.HOME,
      CODEX_HOME: before.CODEX_HOME,
      CLAUDE_CONFIG_DIR: before.CLAUDE_CONFIG_DIR,
      opaque: before.opaque,
      XDG_CONFIG_HOME: before.XDG_CONFIG_HOME,
      RELAY_TEST_HOME: '/private/fixture',
      RELAY_TEST_LOG: '/private/fixture/provider-messages.jsonl',
      SHELL: '/private/fixture/bin/shell',
    })
    expect(output.PATH).toBe('/private/fixture/bin:/private/node/bin:/usr/bin:/bin')
    for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV', 'ENV'])
      expect(output).not.toHaveProperty(name)
  })

  it('admits only native fixture provider protocols and harmless discovery', () => {
    expect(bootstrap.providerInvocationAllowed('codex', ['--version'])).toBe(true)
    expect(bootstrap.providerInvocationAllowed('claude', ['--help'])).toBe(true)
    expect(
      bootstrap.providerInvocationAllowed('codex', ['app-server', '--listen', 'stdio://']),
    ).toBe(true)
    expect(
      bootstrap.providerInvocationAllowed('claude', [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
        '--permission-mode',
        'plan',
      ]),
    ).toBe(true)
    for (const provider of ['codex', 'claude']) {
      expect(bootstrap.providerInvocationAllowed(provider, ['login', 'status'])).toBe(false)
      expect(bootstrap.providerInvocationAllowed(provider, ['--version', 'login'])).toBe(false)
      expect(bootstrap.providerInvocationAllowed(provider, ['exec', 'arbitrary prompt'])).toBe(
        false,
      )
    }
    expect(
      bootstrap.providerInvocationAllowed('claude', [
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
      ]),
    ).toBe(false)
    expect(bootstrap.providerInvocationAllowed('unknown', ['--version'])).toBe(false)
    expect(
      bootstrap.providerInvocationAllowed('codex', [
        'app-server',
        '--listen',
        'stdio://',
        '--unknown',
      ]),
    ).toBe(false)
  })

  it('redirects only fixture paths and broker root, preserving native command/runtime bytes', () => {
    const configuration = {
      mode: 'local',
      root: '/private/fixture',
      guardBin: '/private/fixture/bin',
      inheritedHome: '/inherited/home',
      workspace: '/private/fixture/workspace',
    }
    const native = {
      id: 'original-native-id',
      root: '/inherited/home/.life/agent-sessions/original-native-id',
      command: "cd '/private/fixture/workspace' && exec codex app-server --listen stdio://",
      launch: true,
      observer: false,
      localRuntime: { inheritedRunAsNode: 'original' },
      future: { exact: ['漢字', null] },
    }
    const encoded = Buffer.from(JSON.stringify(native)).toString('base64')
    const command = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; export ELECTRON_RUN_AS_NODE=1; exec '/private/electron' -e 'unchanged broker program' '${encoded}'`
    const result = bootstrap.rewriteLocalCommand(command, '-lc', configuration)
    const rewritten = JSON.parse(
      Buffer.from(result.command.match(/'([a-zA-Z0-9+/=]+)'\s*$/)[1], 'base64').toString('utf8'),
    )
    expect(rewritten).toEqual({
      ...native,
      root: '/private/fixture/.life/agent-sessions/original-native-id',
    })
    expect(result.broker).toMatchObject({
      originalRoot: native.root,
      root: rewritten.root,
      runtimeUnchanged: true,
    })
    expect(result.command).toContain(
      '$LIFE_TEST_BOOTSTRAP_GUARD_BIN:$RELAY_TEST_HOME/.npm-global/bin',
    )
    expect(result.command).toContain("-e 'unchanged broker program'")
    expect(native.root).toBe('/inherited/home/.life/agent-sessions/original-native-id')
    const wrong = Buffer.from(JSON.stringify({ ...native, root: '/other-owner/native' })).toString(
      'base64',
    )
    expect(() =>
      bootstrap.rewriteLocalCommand(command.replace(encoded, wrong), '-lc', configuration),
    ).toThrow()
    for (const inner of [
      'exec /installed/bin/codex app-server --listen stdio://',
      'exec codex app-server --listen stdio:// --unknown',
      'exec codex app-server --listen "$(/installed/bin/codex login)"',
      'exec codex app-server --listen `installed-codex login`',
      'exec claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode plan --model=x|/installed/bin/codex',
      'exec claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode plan --model=x>/unowned/file',
    ]) {
      const unsafe = Buffer.from(JSON.stringify({ ...native, command: inner })).toString('base64')
      expect(() =>
        bootstrap.rewriteLocalCommand(command.replace(encoded, unsafe), '-lc', configuration),
      ).toThrow()
    }
    expect(
      bootstrap.validateNativeCommand(
        "exec 'claude' '-p' '--input-format' 'stream-json' '--output-format' 'stream-json' '--verbose' '--permission-prompt-tool' 'stdio' '--permission-mode' 'plan' '--model=literal|model'",
        configuration.workspace,
      ),
    ).toBe('claude')
    expect(() =>
      bootstrap.rewriteLocalCommand(command, '-lc', { ...configuration, mode: 'ssh' }),
    ).toThrow()
    expect(() =>
      bootstrap.rewriteLocalCommand('exec /installed/bin/codex app-server', '-c', configuration),
    ).toThrow()
    expect(() =>
      bootstrap.rewriteLocalCommand('exec codex app-server', '-i', configuration),
    ).toThrow()
  })

  it('executes bounded native stdin scripts through the private shell and retains exact byte proof', async () => {
    const paths = await privateHarness()
    const prepared = await bootstrap.prepare(paths, 'local', {
      inheritedHome: '/inherited/home',
      nodePath: process.execPath,
    })
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const script = `cd ${quote(paths.fixture.workspace)} || exit\nprintf '%s\\n' "$HOME" 'café 漢字 🧪'\n\n`
    const result = spawnSync(prepared.shell, ['-s'], {
      input: Buffer.from(script),
      env: bootstrap.launchEnvironment(process.env, prepared),
      timeout: 5000,
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(paths.fixture.root + '\ncafé 漢字 🧪\n')
    const [record] = (await readFile(prepared.commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(record).toMatchObject({ kind: 'local-command-admitted', option: '-s' })
    expect(Buffer.from(record.scriptBase64, 'base64')).toEqual(Buffer.from(script))
    expect(record.commandSha256).toBe(createHash('sha256').update(script).digest('hex'))
    const rewritten = Buffer.from(record.rewrittenBase64, 'base64')
    expect(record.rewrittenSha256).toBe(createHash('sha256').update(rewritten).digest('hex'))
    expect(rewritten.toString()).toBe(script.replaceAll('$HOME', '$RELAY_TEST_HOME'))
  })

  it('preserves and executes the native machine workspace guard for stdin scripts', async () => {
    const paths = await privateHarness()
    const prepared = await bootstrap.prepare(paths, 'local', {
      inheritedHome: '/inherited/home',
      nodePath: process.execPath,
    })
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    for (const [requested, allowed] of [
      [paths.fixture.workspace, true],
      [paths.configurationRoot, false],
    ] as const) {
      const nativeGuard = `life_machine_command_home=$(pwd -P) || exit\ncd ${quote(requested)} || exit\nlife_machine_command_workspace=$(pwd -P) || exit\nif [ "$life_machine_command_home" != / ]; then\n  case "$life_machine_command_workspace" in\n    "$life_machine_command_home"|"$life_machine_command_home"/*) ;;\n    *) printf '%s\\n' 'Machine commands must run within the connected home directory.' >&2; exit 1 ;;\n  esac\nfi\nunset life_machine_command_home life_machine_command_workspace\nprintf '%s\\n' 'workspace command executed'\n`
      const script = "cd '/inherited/home' || exit\n" + nativeGuard
      const result = spawnSync(prepared.shell, ['-s'], {
        input: script,
        env: bootstrap.launchEnvironment(process.env, prepared),
        timeout: 5000,
        encoding: 'utf8',
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(allowed ? 0 : 1)
      expect(result.stdout).toBe(allowed ? 'workspace command executed\n' : '')
      if (!allowed) expect(result.stderr).toContain('Machine commands must run within')
      const records = (await readFile(prepared.commandLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const rewritten = Buffer.from(records.at(-1).rewrittenBase64, 'base64').toString()
      expect(rewritten).toBe(`cd ${quote(paths.fixture.root)} || exit\n` + nativeGuard)
    }
  })

  it('rejects unowned, invalid and oversized stdin scripts without executing partial bytes', async () => {
    const paths = await privateHarness()
    const prepared = await bootstrap.prepare(paths, 'local', {
      inheritedHome: '/inherited/home',
      nodePath: process.execPath,
    })
    const configuration = { ...prepared, inheritedHome: '/inherited/home' }
    for (const bytes of [
      Buffer.from("cd '/unowned' || exit\nprintf unexpected"),
      Buffer.from("cd '/inherited/home' || exit\nprintf '\0'"),
      Buffer.from([0xff]),
      Buffer.from("cd '/inherited/home' || exit\nexec /installed/bin/codex app-server"),
      Buffer.alloc(bootstrap.maximumLocalScriptBytes + 1, 97),
    ])
      expect(() => bootstrap.rewriteLocalScript(bytes, configuration)).toThrow()
    expect(() =>
      bootstrap.rewriteLocalScript(Buffer.from("cd '/inherited/home' || exit\npwd"), {
        ...configuration,
        mode: 'ssh',
      }),
    ).toThrow()
    const result = spawnSync(prepared.shell, ['-s'], {
      input: Buffer.alloc(bootstrap.maximumLocalScriptBytes + 1, 97),
      env: bootstrap.launchEnvironment(process.env, prepared),
      timeout: 5000,
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(125)
    expect(result.stdout).toBe('')
    const [record] = (await readFile(prepared.commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(record).toMatchObject({
      kind: 'unexpected-local-command',
      option: '-s',
      truncated: true,
    })
    expect(Buffer.from(record.scriptBase64, 'base64')).toHaveLength(
      bootstrap.maximumLocalScriptBytes + 1,
    )
  })

  it('logs and rejects unexpected Local provider use before reading a provider source', async () => {
    const { fixture } = await privateHarness()
    const commandLog = join(fixture.root, 'unexpected.jsonl')
    await writeFile(commandLog, '')
    expect(() =>
      bootstrap.runProviderGuard(
        'codex',
        join(fixture.root, '.local/bin/codex'),
        'unused',
        { LIFE_TEST_BOOTSTRAP_ROOT: fixture.root, LIFE_TEST_BOOTSTRAP_COMMAND_LOG: commandLog },
        ['login', 'status'],
      ),
    ).toThrow()
    const record = JSON.parse((await readFile(commandLog, 'utf8')).trim())
    expect(record).toMatchObject({ kind: 'unexpected-local-provider', provider: 'codex' })
    expect(record).not.toHaveProperty('argv')
  })

  it('prepares private files once and preserves native launcher Promise identity and cold settings', async () => {
    const paths = await privateHarness()
    const application = { genuine: true }
    const promise = Promise.resolve(application)
    const received: Array<Record<string, any>> = []
    const electron = {
      launch(options: Record<string, any>) {
        received.push(options)
        return promise
      },
    }
    class Harness {
      fixture = paths.fixture
      configurationRoot = paths.configurationRoot
      activeRecoveryBootstrap: any
      launch() {
        return electron.launch({
          args: ['/private/unchanged-app'],
          cwd: '/private/unchanged-app',
          env: {
            XDG_CONFIG_HOME: this.configurationRoot,
            HOME: process.env.HOME,
            CODEX_HOME: process.env.CODEX_HOME,
          },
          timeout: 30000,
        })
      }
      connect() {
        throw new Error('Original SSH setup is not a Local connection')
      }
      assertOwnership() {
        return 'original ownership oracle'
      }
    }
    const ownership = Harness.prototype.assertOwnership
    const installed = bootstrap.install({
      electron,
      RecoveryHarness: Harness,
      mode: 'local',
      selectedCase: 'codex-stream-crash',
    })
    restorations.push(installed.restore)
    const harness = new Harness()
    expect(await harness.launch()).toBe(application)
    expect(Harness.prototype.assertOwnership).toBe(ownership)
    expect(received[0].args).toEqual(['/private/unchanged-app'])
    const information = harness.activeRecoveryBootstrap
    expect((await stat(information.shell)).mode & 0o777).toBe(0o700)
    expect(information.nativeHash.codex).toBe(bootstrap.NATIVE_PROVIDER_SHA256)
    const saved = JSON.parse(await readFile(information.settingsPath, 'utf8'))
    saved.futureSettings = { unchanged: ['漢字', null] }
    const savedBytes = JSON.stringify(saved) + '\n'
    await writeFile(information.settingsPath, savedBytes)
    expect(await harness.launch()).toBe(application)
    expect(await readFile(information.settingsPath, 'utf8')).toBe(savedBytes)
    const options = {
      args: ['/private/unchanged-app'],
      env: {
        XDG_CONFIG_HOME: paths.configurationRoot,
        HOME: process.env.HOME,
        CODEX_HOME: process.env.CODEX_HOME,
      },
      cwd: '/private/unchanged-app',
    }
    const before = structuredClone(options)
    expect(electron.launch(options)).toBe(promise)
    expect(options).toEqual(before)
    expect(received).toHaveLength(3)
    expect(() => electron.launch({ env: { XDG_CONFIG_HOME: '/unowned/profile' } })).toThrow()
  })

  it('rejects Local cases that depend on SSH wire gates', () => {
    class Harness {
      launch() {}
      connect() {}
    }
    const electron = { launch() {} }
    expect(() =>
      bootstrap.install({
        electron,
        RecoveryHarness: Harness,
        mode: 'local',
        selectedCase: 'codex-approval-before-ack-crash',
      }),
    ).toThrow()
    expect(() =>
      bootstrap.install({
        electron,
        RecoveryHarness: Harness,
        mode: 'local',
        selectedCase: undefined,
      }),
    ).toThrow()
  })

  it('requires actual Local state with the original private machine and workspace', async () => {
    const fixture = fixtureInput()
    const identity = { localProfileId, workspace: fixture.workspace }
    let state = {
      status: 'connected',
      profile: { id: localProfileId, transport: 'local' },
      workspace: fixture.workspace,
    }
    let polls = 0
    const harness = {
      fixture,
      page: {
        evaluate() {
          polls++
          return Promise.resolve(state)
        },
        getByRole() {
          return { isVisible: async () => false }
        },
      },
    }
    await bootstrap.connectLocal(harness, identity)
    expect(polls).toBe(1)
    state = { ...state, profile: { id: localProfileId, transport: 'ssh' } }
    await expect(bootstrap.connectLocal(harness, identity)).rejects.toThrow()
    state = { ...state, profile: { id: 'another-local-machine', transport: 'local' } }
    await expect(bootstrap.connectLocal(harness, identity)).rejects.toThrow()
    state = {
      ...state,
      profile: { id: localProfileId, transport: 'local' },
      workspace: '/another-workspace',
    }
    await expect(bootstrap.connectLocal(harness, identity)).rejects.toThrow()
  })

  it('admits the exact production Claude UID conditional while rejecting neighboring executable changes', () => {
    const workspace = "/private/fixture/workspace's café 🧪"
    const args = [
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      'plan',
      '--model=literal $model; café',
      '--resume=native-original-id',
    ]
    const command = claudeLaunchCommand(workspace, args)
    expect(bootstrap.providerInvocationAllowed('claude', args.slice(1))).toBe(true)
    expect(
      bootstrap.providerInvocationAllowed('claude', [
        ...args.slice(1),
        '--allow-dangerously-skip-permissions',
      ]),
    ).toBe(true)
    expect(
      bootstrap.providerInvocationAllowed('claude', [
        ...args.slice(1),
        '--allow-dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
      ]),
    ).toBe(false)
    expect(bootstrap.validateNativeCommand(command, workspace)).toBe('claude')
    for (const changed of [
      command.replace('$(id -u)', '$(/installed/bin/codex login)'),
      command.replace('= 0', '= 1'),
      command.replace(
        'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1',
        'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=2',
      ),
      command.replace("'claude'", "'/installed/bin/claude'"),
      command.replace('; fi', '; exec /installed/bin/codex; fi'),
      command.replace(
        "'--allow-dangerously-skip-permissions'",
        "'--allow-dangerously-skip-permissions' '--unknown'",
      ),
    ])
      expect(() => bootstrap.validateNativeCommand(changed, workspace)).toThrow()
    expect(command).toBe(claudeLaunchCommand(workspace, args))
  })
})
