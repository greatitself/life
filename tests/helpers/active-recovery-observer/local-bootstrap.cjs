// Fixture setup only. Native protocols and the frozen recovery assertions stay unchanged.
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const { appendFileSync, readFileSync } = require('node:fs')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { homedir } = require('node:os')
const { dirname, isAbsolute, join, resolve } = require('node:path')

const MODES = ['local', 'ssh']
const LOCAL_CASES = ['codex-stream-crash', 'claude-pending-approval-crash']
const NATIVE_PROVIDER_SHA256 = 'bec9cf3b2649c9a79c25e28564957623c027366b0a78e7caa8c0322d6cfdc983'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
const localIdPattern = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function privatePath(value) {
  assert.ok(typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/u.test(value))
  assert.ok(value.length <= 4096)
  return value
}

function seedConnections({ mode, fixture, localProfileId, configPath }) {
  assert.ok(MODES.includes(mode))
  assert.match(localProfileId, localIdPattern)
  privatePath(fixture.workspace)
  privatePath(configPath)
  const { password, passphrase, ...profile } = fixture.input()
  assert.equal(profile.host, '127.0.0.1')
  assert.equal(profile.username, 'fixture')
  assert.equal(profile.auth, 'password')
  assert.ok(Number.isSafeInteger(profile.port) && profile.port > 0 && profile.port <= 65535)
  assert.notEqual(profile.id, localProfileId)
  return {
    profiles: [
      {
        ...profile,
        transport: 'ssh',
        workspace: '~',
        sshConfig: { alias: 'life-recovery-fixture', path: configPath },
      },
    ],
    knownHosts: {},
    localProfileId,
    localWorkspace: fixture.workspace,
    selectedProfileId: mode === 'local' ? localProfileId : profile.id,
  }
}

function privateSSHConfig(fixture) {
  const input = fixture.input()
  return [
    'Host life-recovery-fixture',
    '  HostName 127.0.0.1',
    `  Port ${input.port}`,
    '  User fixture',
    '  IdentityFile none',
    '  IdentityAgent none',
    '  IdentitiesOnly yes',
    '  PubkeyAuthentication no',
    '  PasswordAuthentication yes',
    '  ProxyJump none',
    '  ProxyCommand none',
    '',
  ].join('\n')
}

function launchEnvironment(environment, bootstrap) {
  const output = {
    ...environment,
    SHELL: bootstrap.shell,
    PATH: `${bootstrap.guardBin}:${dirname(bootstrap.nodePath)}:/usr/bin:/bin`,
    RELAY_TEST_HOME: bootstrap.root,
    RELAY_TEST_LOG: join(bootstrap.root, 'provider-messages.jsonl'),
    LIFE_TEST_BOOTSTRAP_ROOT: bootstrap.root,
    LIFE_TEST_BOOTSTRAP_WORKSPACE: bootstrap.workspace,
    LIFE_TEST_BOOTSTRAP_GUARD_BIN: bootstrap.guardBin,
    LIFE_TEST_BOOTSTRAP_MODE: bootstrap.mode,
    LIFE_TEST_BOOTSTRAP_NODE: bootstrap.nodePath,
    LIFE_TEST_BOOTSTRAP_ADAPTER: __filename,
    LIFE_TEST_BOOTSTRAP_INHERITED_HOME: bootstrap.inheritedHome,
    LIFE_TEST_BOOTSTRAP_COMMAND_LOG: bootstrap.commandLog,
  }
  for (const name of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'BASH_ENV',
    'ENV',
  ])
    delete output[name]
  assert.equal(output.HOME, environment.HOME)
  assert.equal(output.CODEX_HOME, environment.CODEX_HOME)
  return output
}

function providerInvocationAllowed(provider, argv) {
  if (
    !['codex', 'claude'].includes(provider) ||
    !Array.isArray(argv) ||
    argv.some((value) => typeof value !== 'string' || value.includes('\0'))
  )
    return false
  if (argv.length === 1 && ['--version', '--help'].includes(argv[0])) return true
  if (provider === 'codex')
    return (
      JSON.stringify(argv) === JSON.stringify(['app-server', '--listen', 'stdio://']) ||
      JSON.stringify(argv) ===
        JSON.stringify([
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'features.step_model_switching=true',
        ])
    )
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const name = argument.split('=')[0]
    if (seen.has(name)) return false
    seen.add(name)
    if (
      [
        '-p',
        '--verbose',
        '--include-partial-messages',
        '--allow-dangerously-skip-permissions',
      ].includes(argument)
    )
      continue
    if (['--input-format', '--output-format'].includes(argument)) {
      if (argv[++index] !== 'stream-json') return false
    } else if (argument === '--permission-prompt-tool') {
      if (argv[++index] !== 'stdio') return false
    } else if (argument === '--permission-mode') {
      if (!['plan', 'default', 'acceptEdits', 'bypassPermissions'].includes(argv[++index]))
        return false
    } else if (/^--(?:model|effort|resume)=[^\x00-\x1f=]+$/u.test(argument)) continue
    else if (argument === '--settings') {
      try {
        const settings = JSON.parse(argv[++index])
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
      } catch {
        return false
      }
    } else if (argument === '--add-dir') {
      if (!argv[++index] || !isAbsolute(argv[index])) return false
    } else return false
  }
  return [
    '-p',
    '--input-format',
    '--output-format',
    '--verbose',
    '--permission-prompt-tool',
    '--permission-mode',
  ].every((name) => seen.has(name))
}

function shellWords(command) {
  const words = []
  let word = '',
    quoted,
    started = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (quoted) {
      if (character === quoted) quoted = undefined
      else if (quoted === '"' && character === '\\') {
        assert.ok(index + 1 < command.length)
        word += command[++index]
      } else {
        assert.ok(
          quoted === "'" || !['$', '`'].includes(character),
          'Native shell arguments cannot execute substitutions',
        )
        word += character
      }
    } else if (character === "'" || character === '"') {
      quoted = character
      started = true
    } else if (character === '\\') {
      assert.ok(index + 1 < command.length)
      word += command[++index]
      started = true
    } else if (/\s/u.test(character)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else if (character === '&') {
      assert.equal(started, false)
      assert.equal(command[++index], '&', 'Only the exact private cwd separator is admitted')
      assert.ok(index + 1 === command.length || /\s/u.test(command[index + 1]))
      words.push('&&')
    } else {
      assert.ok(
        !['$', '`', '|', ';', '<', '>', '(', ')'].includes(character),
        'Native shell arguments cannot execute substitutions or extra operations',
      )
      word += character
      started = true
    }
  }
  assert.equal(quoted, undefined, 'The native launch has complete literal shell arguments')
  if (started) words.push(word)
  return words
}

function validateNativeCommand(command, workspace) {
  // Match the exact production root/non-root conditional. Its only executable
  // substitution is the fixed id probe; both literal native branches must agree.
  const prefix = `cd ${quote(workspace)} && if [ "$(id -u)" = 0 ]; then exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 `
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const conditional = new RegExp(
    `^${escapePattern(prefix)}(.+); else exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 \\1 ${escapePattern(quote('--allow-dangerously-skip-permissions'))}; fi$`,
    'su',
  ).exec(command)
  if (conditional) {
    const words = shellWords(conditional[1])
    assert.equal(words[0], 'claude')
    assert.ok(providerInvocationAllowed('claude', words.slice(1)))
    assert.equal(
      conditional[1],
      words.map(quote).join(' '),
      'Both Claude branches retain exact canonical literal arguments',
    )
    return 'claude'
  }
  const words = shellWords(command)
  let offset = 0
  if (words[0] === 'cd') {
    assert.equal(words[1], workspace)
    assert.equal(words[2], '&&')
    offset = 3
  }
  assert.equal(words[offset], 'exec')
  const provider = words[offset + 1]
  assert.ok(
    providerInvocationAllowed(provider, words.slice(offset + 2)),
    'The native broker may launch only the finite fixture provider protocols',
  )
  return provider
}

function commandConfiguration(environment) {
  return {
    mode: environment.LIFE_TEST_BOOTSTRAP_MODE,
    root: privatePath(environment.LIFE_TEST_BOOTSTRAP_ROOT),
    guardBin: privatePath(environment.LIFE_TEST_BOOTSTRAP_GUARD_BIN),
    workspace: privatePath(environment.LIFE_TEST_BOOTSTRAP_WORKSPACE),
    inheritedHome: privatePath(environment.LIFE_TEST_BOOTSTRAP_INHERITED_HOME),
  }
}

function rewriteLocalCommand(command, option, configuration) {
  assert.equal(configuration.mode, 'local', 'Unexpected Local execution in an SSH-only fixture')
  assert.ok(['-c', '-lc'].includes(option), 'The fixture admits only noninteractive Local commands')
  assert.equal(typeof command, 'string')
  assert.equal(command.includes('\0'), false)
  // Absolute provider paths cannot bypass the dedicated fixture executable guards.
  assert.equal(/(?:^|[\s'"])(?:\/[\w. -]+)+\/(?:codex|claude)(?=[\s'"]|$)/u.test(command), false)
  let rewritten = command
    .replaceAll('$HOME/.local/bin', '$LIFE_TEST_BOOTSTRAP_GUARD_BIN')
    .replaceAll('${HOME}/.local/bin', '$LIFE_TEST_BOOTSTRAP_GUARD_BIN')
    .replaceAll('$HOME', '$RELAY_TEST_HOME')
    .replaceAll('${HOME}', '$RELAY_TEST_HOME')
  let broker
  if (option === '-lc' && command.includes('export ELECTRON_RUN_AS_NODE=1; exec ')) {
    const encoded = rewritten.match(/'([a-zA-Z0-9+/=]+)'\s*$/u)
    assert.ok(encoded, 'The actual Local broker must retain its encoded configuration')
    const original = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'))
    assert.match(original.id, /^[a-zA-Z0-9_-]{1,80}$/u)
    assert.equal(typeof original.command, 'string')
    validateNativeCommand(original.command, configuration.workspace)
    const root = join(configuration.root, '.life', 'agent-sessions', original.id)
    assert.ok(
      original.root === root ||
        original.root === join(configuration.inheritedHome, '.life', 'agent-sessions', original.id),
    )
    const redirected = { ...original, root }
    assert.equal(redirected.command, original.command)
    assert.deepEqual(redirected.localRuntime, original.localRuntime)
    const replacement = Buffer.from(JSON.stringify(redirected)).toString('base64')
    rewritten = rewritten.slice(0, encoded.index) + quote(replacement)
    broker = {
      id: original.id,
      originalRoot: original.root,
      root,
      commandSha256: hash(original.command),
      runtimeUnchanged: true,
    }
  }
  return { command: rewritten, broker }
}

function guardRecord(environment, value) {
  appendFileSync(
    privatePath(environment.LIFE_TEST_BOOTSTRAP_COMMAND_LOG),
    JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n',
    { mode: 0o600 },
  )
}

function runCommandGuard(environment = process.env, argv = process.argv.slice(3)) {
  try {
    const result = rewriteLocalCommand(argv[0], argv[1], commandConfiguration(environment))
    guardRecord(environment, {
      kind: 'local-command-admitted',
      commandSha256: hash(argv[0]),
      option: argv[1],
      ...(result.broker ? { broker: result.broker } : {}),
    })
    process.stdout.write(result.command)
  } catch (error) {
    guardRecord(environment, {
      kind: 'unexpected-local-command',
      commandSha256: hash(String(argv[0])),
      option: argv[1],
    })
    throw error
  }
}

function runProviderGuard(
  provider,
  source,
  expectedHash,
  environment = process.env,
  argv = process.argv.slice(2),
) {
  const root = privatePath(environment.LIFE_TEST_BOOTSTRAP_ROOT)
  assert.equal(source, join(root, '.local', 'bin', provider))
  const admitted = providerInvocationAllowed(provider, argv)
  guardRecord(environment, {
    kind: admitted ? 'private-provider-admitted' : 'unexpected-local-provider',
    provider,
    argvSha256: hash(JSON.stringify(argv)),
  })
  assert.ok(admitted, 'The private fixture rejects provider commands outside its native protocols')
  assert.equal(
    hash(readFileSync(source)),
    expectedHash,
    'Only the captured private provider bytes may execute',
  )
  require(source)
}

async function prepare(
  harness,
  mode,
  { inheritedHome = homedir(), nodePath = process.execPath } = {},
) {
  assert.ok(MODES.includes(mode))
  const root = privatePath(harness.fixture.root)
  privatePath(harness.configurationRoot)
  privatePath(harness.fixture.workspace)
  privatePath(inheritedHome)
  privatePath(nodePath)
  const directory = join(root, 'active-recovery-bootstrap')
  const guardBin = join(directory, 'bin')
  const configPath = join(directory, 'ssh-config')
  const commandLog = join(directory, 'commands.jsonl')
  const shell = join(guardBin, 'fixture-shell')
  const nativeHash = {}
  await mkdir(guardBin, { recursive: true, mode: 0o700 })
  for (const provider of ['codex', 'claude']) {
    const source = join(root, '.local', 'bin', provider)
    nativeHash[provider] = hash(await readFile(source))
    if (mode === 'local') assert.equal(nativeHash[provider], NATIVE_PROVIDER_SHA256)
    const body = `#!${nodePath}\nprocess.env.LIFE_TEST_BOOTSTRAP_CHILD = '1'\nrequire(${JSON.stringify(__filename)}).runProviderGuard(${JSON.stringify(provider)}, ${JSON.stringify(source)}, ${JSON.stringify(nativeHash[provider])})\n`
    await writeFile(join(guardBin, provider), body, { mode: 0o700, flag: 'wx' })
  }
  await writeFile(commandLog, '', { mode: 0o600, flag: 'wx' })
  await writeFile(configPath, privateSSHConfig(harness.fixture), { mode: 0o600, flag: 'wx' })
  const shellBody =
    '#!/bin/bash\nif [[ "$1" != "-c" && "$1" != "-lc" ]]; then\n  "$LIFE_TEST_BOOTSTRAP_NODE" "$LIFE_TEST_BOOTSTRAP_ADAPTER" --guard-command "${2-}" "${1-}"\n  exit 125\nfi\ntask_command="$("$LIFE_TEST_BOOTSTRAP_NODE" "$LIFE_TEST_BOOTSTRAP_ADAPTER" --guard-command "$2" "$1")" || exit $?\nexec /bin/bash --noprofile --norc -c "$task_command"\n'
  await writeFile(shell, shellBody, { mode: 0o700, flag: 'wx' })
  const localProfileId = 'local:' + randomUUID()
  const seed = seedConnections({ mode, fixture: harness.fixture, localProfileId, configPath })
  const settingsPath = join(harness.configurationRoot, 'Life', 'connections.json')
  await writeFile(settingsPath, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return {
    version: 1,
    mode,
    root,
    workspace: harness.fixture.workspace,
    directory,
    guardBin,
    configPath,
    commandLog,
    shell,
    nodePath,
    inheritedHome,
    nativeHash,
    localProfileId,
    sshProfileId: seed.profiles[0].id,
    settingsPath,
    initialSettingsSha256: hash(await readFile(settingsPath)),
  }
}

async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((done) => setTimeout(done, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function connectLocal(harness, bootstrap) {
  await waitUntil(async () => {
    const state = await harness.page.evaluate(() => window.relay.connection.state())
    if (state.status !== 'connected') return false
    assert.equal(state.profile?.transport, 'local')
    assert.equal(state.profile?.id, bootstrap.localProfileId)
    assert.equal(state.workspace, harness.fixture.workspace)
    return true
  }, 'the genuine built-in Local connection owns the exact private fixture workspace')
  const chooser = harness.page.getByRole('dialog', { name: 'Choose an environment', exact: true })
  if (await chooser.isVisible())
    await chooser.getByRole('button', { name: 'Use Local', exact: true }).click()
  const picker = harness.page.getByRole('dialog', { name: 'Select a project', exact: true })
  if (await picker.isVisible()) {
    await picker
      .getByRole('textbox', { name: 'Project directory', exact: true })
      .fill(harness.fixture.workspace)
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
  }
}

async function connectSSH(harness, bootstrap) {
  const input = harness.fixture.input()
  const dialog = harness.page.getByRole('dialog', { name: 'Choose an environment', exact: true })
  if (!(await dialog.isVisible()))
    await harness.page.getByRole('button', { name: 'Connections', exact: true }).click()
  await dialog.waitFor()
  const profiles = await harness.page.evaluate(() => window.relay.profiles.list())
  const profile = profiles.find((entry) => entry.id === bootstrap.sshProfileId)
  assert.ok(profile && profile.transport === 'ssh')
  assert.equal(profile.host, '127.0.0.1')
  assert.equal(profile.port, input.port)
  assert.equal(profile.sshConfig?.path, bootstrap.configPath)
  await dialog
    .locator('.saved-profile')
    .filter({ hasText: profile.name })
    .getByRole('button')
    .first()
    .click()
  await dialog.getByPlaceholder('Your SSH password').fill(input.password)
  await dialog.getByRole('button', { name: 'Connect machine', exact: true }).click()
  const trust = harness.page.getByRole('dialog', { name: 'Trust this machine?', exact: true })
  await waitUntil(
    async () =>
      (await trust.isVisible()) ||
      (await harness.page.evaluate(() => window.relay.connection.state())).status === 'connected',
    'the real fixture SSH trust prompt or connection',
  )
  if (await trust.isVisible())
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const picker = harness.page.getByRole('dialog', { name: 'Select a project', exact: true })
  await waitUntil(
    async () =>
      (await picker.isVisible()) ||
      (await harness.page.evaluate(() => window.relay.connection.state())).workspace ===
        harness.fixture.workspace,
    'the saved fixture workspace or real project picker',
  )
  if (
    (await harness.page.evaluate(() => window.relay.connection.state())).workspace !==
    harness.fixture.workspace
  ) {
    await picker
      .getByRole('textbox', { name: 'Project directory', exact: true })
      .fill(harness.fixture.workspace)
    await picker.getByRole('button', { name: 'Open project', exact: true }).click()
  }
  if (await picker.isVisible()) await picker.waitFor({ state: 'hidden' })
  const connected = await harness.page.evaluate(() => window.relay.connection.state())
  assert.equal(connected.status, 'connected')
  assert.equal(connected.profile?.id, bootstrap.sshProfileId)
  assert.equal(connected.profile?.transport, 'ssh')
  assert.equal(connected.workspace, harness.fixture.workspace)
}

function install({
  electron,
  RecoveryHarness,
  mode,
  selectedCase = process.env.LIFE_TEST_RECOVERY_CASE,
}) {
  assert.ok(MODES.includes(mode))
  if (mode === 'local')
    assert.ok(
      LOCAL_CASES.includes(selectedCase),
      'Local acceptance is limited to the two transport-neutral frozen scenarios',
    )
  const preparations = new Map()
  const originalLaunch = RecoveryHarness.prototype.launch
  const originalConnect = RecoveryHarness.prototype.connect
  const originalElectronLaunch = electron.launch
  RecoveryHarness.prototype.launch = async function (...args) {
    let bootstrap = this.activeRecoveryBootstrap
    if (!bootstrap) {
      bootstrap = await prepare(this, mode)
      this.activeRecoveryBootstrap = bootstrap
      preparations.set(this.configurationRoot, bootstrap)
    }
    assert.equal(bootstrap.mode, mode)
    const saved = JSON.parse(await readFile(bootstrap.settingsPath, 'utf8'))
    assert.equal(saved.localProfileId, bootstrap.localProfileId)
    assert.equal(saved.localWorkspace, this.fixture.workspace)
    assert.equal(
      saved.selectedProfileId,
      mode === 'local' ? bootstrap.localProfileId : bootstrap.sshProfileId,
    )
    return Reflect.apply(originalLaunch, this, args)
  }
  electron.launch = function (options) {
    const bootstrap = preparations.get(options.env?.XDG_CONFIG_HOME)
    assert.ok(bootstrap, 'Only a prepared disposable fixture may launch through this adapter')
    const augmented = { ...options, env: launchEnvironment(options.env, bootstrap) }
    return Reflect.apply(originalElectronLaunch, this, [augmented])
  }
  RecoveryHarness.prototype.connect = function () {
    assert.ok(this.activeRecoveryBootstrap)
    return mode === 'local'
      ? connectLocal(this, this.activeRecoveryBootstrap)
      : connectSSH(this, this.activeRecoveryBootstrap)
  }
  return {
    preparations,
    restore() {
      RecoveryHarness.prototype.launch = originalLaunch
      RecoveryHarness.prototype.connect = originalConnect
      electron.launch = originalElectronLaunch
    },
  }
}

module.exports = {
  LOCAL_CASES,
  NATIVE_PROVIDER_SHA256,
  seedConnections,
  privateSSHConfig,
  launchEnvironment,
  providerInvocationAllowed,
  validateNativeCommand,
  rewriteLocalCommand,
  runCommandGuard,
  runProviderGuard,
  prepare,
  connectLocal,
  connectSSH,
  install,
}
if (require.main === module && process.argv[2] === '--guard-command') {
  try {
    runCommandGuard()
  } catch (error) {
    console.error(String(error))
    process.exitCode = 125
  }
} else if (
  process.env.LIFE_TEST_ACTIVE_RECOVERY_MODE &&
  process.env.LIFE_TEST_BOOTSTRAP_CHILD !== '1'
) {
  assert.equal(process.type, undefined, 'Bootstrap belongs only to the fixture driver')
  const repository = resolve(__dirname, '../../..')
  install({
    electron: require('playwright')._electron,
    RecoveryHarness: require(join(repository, 'tests/helpers/active-session-recovery-steps.cjs'))
      .RecoveryHarness,
    mode: process.env.LIFE_TEST_ACTIVE_RECOVERY_MODE,
  })
}
