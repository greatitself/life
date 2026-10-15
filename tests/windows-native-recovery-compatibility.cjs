#!/usr/bin/env node
/*
 * Required hosted-Windows release gate. Run against release/win-unpacked/Life.exe.
 * This is an executable test, not a recorded pass or a process.platform mock.
 * No provider login, installed provider CLI or authenticated inference is used.
 */
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join, relative, resolve, sep } = require('node:path')
const { build } = require('esbuild')
const { _electron: electron } = require('playwright')

assert.equal(process.platform, 'win32', 'This gate must execute on an actual Windows host')
const repository = resolve(__dirname, '..')
const executable = resolve(
  process.env.LIFE_WINDOWS_EXECUTABLE || join(repository, 'release/win-unpacked/Life.exe'),
)
const output = resolve(
  process.env.LIFE_WINDOWS_PROOF_DIR ||
    join(repository, 'output/windows-native-recovery-compatibility'),
)
const resources = join(dirname(executable), 'resources')
const packagedSource = join(resources, 'life-source')
const policyModule = join(packagedSource, 'src/main/native-recovery-platform.ts')
const provenancePath = process.env.LIFE_RECOVERY_BUILD_PROVENANCE
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceState = {
  format: 1,
  revision: 0,
  current: null,
  history: [],
  enabled: false,
  failed: [],
}
const protectedAction = {
  actionId: 'windows-protected-action',
  intentHash: 'a'.repeat(64),
  payloadHash: 'b'.repeat(64),
  revision: 1,
  snapshotHash: 'c'.repeat(64),
}
const protectedRoots = ['native-recovery', 'native-recovery-actions']
let phase = 'validate package'

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function waitUntil(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function within(check, description, timeout = 30000) {
  let deadline
  try {
    return await Promise.race([
      check(),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeout,
        )
      }),
    ])
  } finally {
    clearTimeout(deadline)
  }
}

async function inventory(root) {
  const entries = []
  async function visit(path) {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const name = relative(root, path).split(sep).join('/') || '.'
    if (info.isSymbolicLink())
      entries.push({ path: name, type: 'link', target: await readlink(path) })
    else if (info.isDirectory()) {
      entries.push({ path: name, type: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else {
      assert(info.isFile(), `Unexpected filesystem object at ${path}`)
      const bytes = await readFile(path)
      entries.push({ path: name, type: 'file', size: bytes.length, sha256: hash(bytes) })
    }
  }
  await visit(root)
  return entries
}

async function sourceHashes(root) {
  const entries = await inventory(join(root, 'src'))
  assert(
    !entries.some((entry) => entry.type === 'link'),
    `Source symlinks or junctions cannot be omitted from exact source evidence: ${root}`,
  )
  return entries.filter((entry) => entry.type === 'file')
}

async function preserved(caseInfo) {
  const result = {}
  for (const path of caseInfo.protectedPaths)
    result[path] = await inventory(join(caseInfo.userData, path))
  return result
}

async function protectedInventory(userData) {
  const names = new Set([...protectedRoots, 'source-code', 'conversations.json'])
  for (const name of await readdir(userData))
    if (
      name.toLowerCase().startsWith('native-recovery.') ||
      name.toLowerCase().startsWith('native-recovery-actions.') ||
      name.toLowerCase().startsWith('conversations.recovery-receipts.json') ||
      (name.toLowerCase().startsWith('conversations.json.') && name.toLowerCase().endsWith('.tmp'))
    )
      names.add(name)
  const result = {}
  for (const name of [...names].sort()) result[name] = await inventory(join(userData, name))
  return result
}

function validAction() {
  const canonical = (value) =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : value && typeof value === 'object'
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`
        : JSON.stringify(value)
  const request = {
    actionId: 'windows-valid-private-action',
    transportId: 'windows-preserved-valid-transport',
    sessionId: 'windows-protected-session',
    ownerGeneration: 1,
    kind: 'settings-apply',
    intent: { theme: 'light' },
  }
  const record = {
    format: 'life-native-recovery-action',
    version: 1,
    request,
    intentHash: hash(canonical(request.intent)),
    status: 'intended',
  }
  return {
    name: `${hash(request.actionId)}.json`,
    bytes: `${JSON.stringify({ record, checksum: hash(canonical(record)) })}\n`,
  }
}

async function requireNoRecoveryArtifacts(userData) {
  for (const name of protectedRoots) {
    const entries = await inventory(join(userData, name))
    assert(
      entries.every((entry) => entry.type === 'directory' && entry.path === '.'),
      `Unexpected durable recovery artifact in ${name}`,
    )
  }
  const names = await readdir(userData)
  assert(
    !names.some(
      (name) =>
        name.toLowerCase().startsWith('conversations.recovery-receipts.json') ||
        name.toLowerCase().startsWith('native-recovery.') ||
        name.toLowerCase().startsWith('native-recovery-actions.'),
    ),
    'Unsupported Windows mode wrote a native receipt or recovery temporary',
  )
  const source = join(userData, 'source-code')
  if (existsSync(source)) {
    for (const entry of await inventory(source))
      assert(
        !/(?:^|\/)(?:recovery-action\.json|incorporation-recovery\.json)(?:\.|$)/i.test(entry.path),
        `Ordinary source wrote native recovery evidence: ${entry.path}`,
      )
    const state = join(source, 'state.json')
    if (existsSync(state))
      assert.equal(JSON.parse(await readFile(state, 'utf8')).recoveryActions?.length || 0, 0)
  }
}

function validJournal() {
  const id = 'windows-preserved-valid-transport'
  const transport = {
    id,
    brokerId: 'windows-private-broker',
    brokerRoot: '/home/fixture/.life/agent-sessions/windows-private-broker',
    launchCommand: 'exec codex app-server --listen stdio://',
    provider: 'codex',
    providerVersion: '0.127.0',
    nativeProtocol: 'codex-app-server',
    brokerProtocolVersion: 1,
    machine: {
      transport: 'ssh',
      profileId: 'windows-fixture-machine',
      host: '127.0.0.1',
      port: 22,
      username: 'fixture',
    },
    controller: { id: 'private-controller', epoch: 1 },
    initialization: { status: 'not-started' },
    owners: [],
  }
  const payload = {
    format: 'life-native-recovery',
    version: 1,
    index: 1,
    previousHash: null,
    records: [{ kind: 'create', transport, revision: 1 }],
  }
  return {
    name: `${hash(id)}.jsonl`,
    bytes: `${JSON.stringify({ ...payload, hash: hash(JSON.stringify(payload)) })}\n`,
  }
}

async function makeCase(root, name, seed, expected = 'blocked') {
  const userData = join(root, name, 'user data')
  await mkdir(userData, { recursive: true })
  const protectedPaths = await seed(userData)
  const result = { name, userData, expected, protectedPaths }
  result.before = await preserved(result)
  return result
}

async function filesystemCases(root) {
  const cases = []
  cases.push(await makeCase(root, 'clean-missing', async () => [], 'unsupported-clean'))
  cases.push(
    await makeCase(
      root,
      'clean-empty-directories',
      async (userData) => {
        for (const name of protectedRoots) await mkdir(join(userData, name))
        return protectedRoots
      },
      'unsupported-clean',
    ),
  )
  for (const rootName of protectedRoots) {
    for (const kind of [
      'foreign-lease',
      'unknown',
      'temporary',
      'corrupt',
      'valid-journal',
      'file-instead-of-directory',
      'junction',
    ]) {
      cases.push(
        await makeCase(root, `${rootName}-${kind}`, async (userData) => {
          const path = join(userData, rootName)
          if (kind === 'file-instead-of-directory')
            await writeFile(path, Buffer.from([0, 255, 13, 10]))
          else if (kind === 'junction') {
            const target = join(dirname(userData), 'foreign junction target')
            await mkdir(target)
            await writeFile(
              join(target, 'foreign-sentinel'),
              'These foreign bytes must remain unchanged\r\n',
            )
            await symlink(target, path, 'junction')
            // The target is inventoried separately; inventory() never follows the junction.
            return [rootName, '../foreign junction target']
          } else {
            await mkdir(path)
            if (kind === 'foreign-lease') {
              await mkdir(join(path, '.writer.lock'))
              await json(join(path, '.writer.lock/owner.json'), {
                pid: 2147483646,
                token: 'foreign-owner-token',
              })
            } else if (kind === 'valid-journal') {
              const journal = rootName === 'native-recovery' ? validJournal() : validAction()
              await writeFile(join(path, journal.name), journal.bytes)
            } else
              await writeFile(
                join(
                  path,
                  kind === 'temporary'
                    ? '.writer.lock.stale.fixture.tmp'
                    : kind === 'corrupt'
                      ? `${'f'.repeat(64)}.jsonl`
                      : 'foreign-unknown-file',
                ),
                kind === 'corrupt'
                  ? '{"format":"life-native-recovery",'
                  : `${kind} protected sentinel\n`,
              )
          }
          return [rootName]
        }),
      )
    }
  }
  for (const name of [
    'conversations.recovery-receipts.json',
    'conversations.recovery-receipts.json.fixture.tmp',
    'conversations.json.fixture.tmp',
    'Conversations.Recovery-Receipts.Json',
  ]) {
    cases.push(
      await makeCase(root, name.replaceAll('.', '-'), async (userData) => {
        await writeFile(join(userData, name), 'Protected history bytes\r\n')
        return [name]
      }),
    )
  }
  for (const kind of [
    'source-action',
    'source-corrupt',
    'source-invalid-utf8',
    'source-invalid-state-schema',
    'source-state-temp',
    'source-state-case-temp',
    'source-orphan-action',
    'source-action-case',
    'source-staging-temp',
    'source-incorporated-action',
    'source-incorporation-protected',
    'source-revisions-junction',
  ]) {
    cases.push(
      await makeCase(root, kind, async (userData) => {
        const source = join(userData, 'source-code')
        await mkdir(source)
        if (kind === 'source-action')
          await json(join(source, 'state.json'), {
            ...sourceState,
            recoveryActions: [protectedAction],
          })
        else if (kind === 'source-corrupt')
          await writeFile(join(source, 'state.json'), '{"format":1,')
        else if (kind === 'source-invalid-utf8')
          await writeFile(join(source, 'state.json'), Buffer.from([123, 34, 255, 34, 125]))
        else if (kind === 'source-invalid-state-schema')
          await json(join(source, 'state.json'), {
            ...sourceState,
            current: 0,
            history: [null, null, null, null, null, null],
            failed: [0],
          })
        else if (kind === 'source-state-temp')
          await writeFile(join(source, 'state.json.fixture.tmp'), 'Uncommitted state bytes\n')
        else if (kind === 'source-state-case-temp')
          await writeFile(
            join(source, 'STATE.JSON.fixture.TMP'),
            'Differently cased uncommitted state bytes\n',
          )
        else if (kind === 'source-revisions-junction') {
          const target = join(dirname(userData), 'foreign source target')
          await mkdir(target)
          await writeFile(join(target, 'foreign-sentinel'), 'Foreign source revision bytes\n')
          await symlink(target, join(source, 'revisions'), 'junction')
          return ['source-code', '../foreign source target']
        } else {
          const generation =
            kind === 'source-staging-temp'
              ? '.staging-fixture'
              : kind === 'source-incorporated-action'
                ? '.incorporated-fixture'
                : '37'
          const revision = join(source, 'revisions', generation)
          await mkdir(revision, { recursive: true })
          if (kind === 'source-incorporation-protected')
            await json(join(revision, 'incorporation-recovery.json'), {
              format: 1,
              originalState: { ...sourceState, recoveryActions: [protectedAction] },
              originalGeneration: 37,
            })
          else
            await writeFile(
              join(
                revision,
                kind === 'source-staging-temp'
                  ? 'recovery-action.json.fixture.tmp'
                  : kind === 'source-action-case'
                    ? 'Recovery-Action.JSON'
                    : 'recovery-action.json',
              ),
              'Private source recovery bytes\n',
            )
        }
        return ['source-code']
      }),
    )
  }
  cases.push(
    await makeCase(
      root,
      'ordinary-source-and-history',
      async (userData) => {
        await json(join(userData, 'source-code/state.json'), sourceState)
        await json(join(userData, 'conversations.json'), { version: 1, savedAt: 73, threads: [] })
        return ['source-code', 'conversations.json']
      },
      'unsupported-clean',
    ),
  )
  cases.push(
    await makeCase(
      root,
      'ordinary-marker-free-staging-and-incorporation',
      async (userData) => {
        await json(join(userData, 'source-code/state.json'), sourceState)
        const staging = join(userData, 'source-code/revisions/.staging-ordinary')
        const incorporated = join(userData, 'source-code/revisions/.incorporated-ordinary')
        await mkdir(staging, { recursive: true })
        await mkdir(incorporated, { recursive: true })
        await writeFile(join(staging, 'metadata.json'), '{"ordinary":true}\n')
        await json(join(incorporated, 'incorporation-recovery.json'), {
          format: 1,
          originalState: sourceState,
          originalGeneration: 1,
        })
        return ['source-code']
      },
      'unsupported-clean',
    ),
  )
  return cases
}

async function runPackagedNode(script, args, environment = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable, [script, ...args], {
      cwd: repository,
      windowsHide: true,
      env: { ...process.env, ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout += bytes.toString()
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('Packaged Windows Node probe timed out'))
    }, 120000)
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) fail(new Error(`Packaged Node probe exited ${code}\n${stdout}\n${stderr}`))
      else done({ stdout, stderr })
    })
  })
}

async function packagedCompiledInventory(root, suffix) {
  const script = join(root, 'packaged-compiled-inventory.cjs')
  const proofPath = join(output, `packaged-compiled-${suffix}.json`)
  await writeFile(
    script,
    `
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstat, readdir, readFile, writeFile } = require('node:fs/promises')
const { join, relative, sep } = require('node:path')
async function run() {
  assert.equal(process.platform,'win32')
  assert(process.versions.electron)
  const root = join(process.argv[2],'app.asar','out')
  const entries=[]
  async function visit(path) {
    const info=await lstat(path)
    assert(!info.isSymbolicLink(),'Packaged compiled graph contains a link')
    const name=relative(root,path).split(sep).join('/') || '.'
    if(info.isDirectory()) {
      entries.push({path:name,type:'directory'})
      for(const child of (await readdir(path)).sort()) await visit(join(path,child))
    } else {
      assert(info.isFile())
      const bytes=await readFile(path)
      entries.push({path:name,type:'file',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
    }
  }
  await visit(root)
  const graph=new Map(entries.map(entry=>[entry.path,entry]))
  const mappings=[['source/package.json','life-source/package.json'],['source/runtime-smoke.cjs','life-source-runtime.cjs']]
  const mapped=[]
  for(const [logical,physical] of mappings) {
    const path=join(process.argv[2],physical)
    const info=await lstat(path)
    assert(info.isFile() && !info.isSymbolicLink(),'Mapped compiled resource must be a regular file')
    const bytes=await readFile(path)
    const entry={path:logical,type:'file',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    if(graph.has(logical)) assert.deepEqual(graph.get(logical),entry,'ASAR and mapped resource disagree')
    graph.set(logical,entry)
    mapped.push({physical,...entry})
  }
  if(!graph.has('source')) graph.set('source',{path:'source',type:'directory'})
  const compiled=[]
  function logicalVisit(name) {
    compiled.push(graph.get(name))
    const children=[...graph.keys()].filter(key=>key!=='.' && (key.includes('/') ? key.slice(0,key.lastIndexOf('/')) : '.')===name).sort()
    for(const child of children) logicalVisit(child)
  }
  logicalVisit('.')
  assert.equal(compiled.length,graph.size,'Compiled logical graph is incomplete')
  await writeFile(process.argv[3],JSON.stringify({platform:process.platform,execPath:process.execPath,versions:process.versions,mapped,compiled},null,2))
}
run().catch(error=>{console.error(error);process.exitCode=1})
`,
  )
  await runPackagedNode(script, [resources, proofPath])
  const result = JSON.parse(await readFile(proofPath, 'utf8'))
  assert.equal(result.execPath.toLowerCase(), executable.toLowerCase())
  return result.compiled
}

async function policyProbe(root, cases) {
  const probe = join(root, 'packaged-policy-probe.cjs')
  const configuration = join(root, 'policy-cases.json')
  const proofPath = join(output, 'packaged-policy-proof.json')
  const entry = `
    import { Effect } from 'effect'
    import { assessNativeRecoveryPlatformEffect, validateNativeRecoveryPlatformPolicyEffect } from ${JSON.stringify(policyModule)}
    import { open, mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const serialize = (error) => ({ name:error?.name, tag:error?._tag, code:error?.code, operation:error?.operation, reason:error?.reason, message:String(error?.message || error), causeCode:error?.cause?.code })
    const result = async (effect) => {
      try { await Effect.runPromise(effect); return { ok:true } }
      catch (error) { return { ok:false, error:serialize(error) } }
    }
    async function run() {
      if (process.platform !== 'win32' || !process.versions.electron) throw new Error('Expected real packaged Windows Electron Node runtime')
      const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
      const scratch = join(config.root, 'real directory sync')
      await mkdir(scratch)
      let directorySync
      let handle
      try { handle = await open(scratch, 'r'); await handle.sync(); directorySync={ok:true} }
      catch (error) { directorySync={ok:false,error:serialize(error)} }
      finally { await handle?.close() }
      const results=[]
      for (const input of config.cases) {
        const policy = await Effect.runPromise(assessNativeRecoveryPlatformEffect({userData:input.userData,exclusiveRuntime:true}))
        results.push({ name:input.name, mode:policy.mode, status:policy.status, sourcePersistenceMode:policy.sourcePersistenceMode, ssh:await result(policy.assertFreshSshStartEffect('ssh')), local:await result(policy.assertFreshSshStartEffect('local')), source:await result(policy.assertOrdinarySourceWriteEffect()), history:await result(policy.assertOrdinaryHistoryWriteEffect()), native:await result(policy.assertNativeRecoveryEffect('windows-gate')), cloned:await result(validateNativeRecoveryPlatformPolicyEffect({...policy})) })
      }
      const noOwnership = await Effect.runPromise(assessNativeRecoveryPlatformEffect({userData:config.clean,exclusiveRuntime:false}))
      const late = await Effect.runPromise(assessNativeRecoveryPlatformEffect({userData:config.late,exclusiveRuntime:true}))
      await mkdir(join(config.late,'native-recovery'))
      await writeFile(join(config.late,'native-recovery','late-private-sentinel'),'State appeared after assessment\\n')
      const lateResults = { initialMode:late.mode, ssh:await result(late.assertFreshSshStartEffect()), source:await result(late.assertOrdinarySourceWriteEffect()), history:await result(late.assertOrdinaryHistoryWriteEffect()) }
      await writeFile(process.argv[4],JSON.stringify({ok:true,platform:process.platform,arch:process.arch,execPath:process.execPath,versions:process.versions,effectVersion:require('effect/package.json').version,directorySync,results,noOwnershipMode:noOwnership.mode,lateResults},null,2))
    }
    run().catch(error=>{console.error(error);process.exitCode=1})
  `
  // The policy and its local imports come from packaged source. External Effect
  // resolves from app.asar, so this cannot substitute the checkout's runtime.
  await build({
    stdin: { contents: entry, sourcefile: 'windows-policy-probe.ts', resolveDir: packagedSource },
    outfile: probe,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    banner: {
      js: "require = require('node:module').createRequire(require('node:path').join(process.argv[2], 'app.asar', 'package.json'));",
    },
  })
  const late = join(root, 'late assessment', 'user data')
  await mkdir(late, { recursive: true })
  await json(configuration, {
    root,
    clean: cases.find((entry) => entry.name === 'clean-missing').userData,
    late,
    cases: cases.map(({ name, userData }) => ({ name, userData })),
  })
  await runPackagedNode(probe, [resources, configuration, proofPath])
  const proof = JSON.parse(await readFile(proofPath, 'utf8'))
  assert.equal(proof.platform, 'win32')
  assert.equal(proof.execPath.toLowerCase(), executable.toLowerCase())
  assert(proof.versions.electron && proof.versions.node && proof.versions.uv)
  assert.equal(proof.noOwnershipMode, 'blocked')
  for (const caseInfo of cases) {
    const result = proof.results.find((entry) => entry.name === caseInfo.name)
    assert.equal(result.mode, caseInfo.expected, caseInfo.name)
    assert.equal(result.status.mode, caseInfo.expected, caseInfo.name)
    for (const operation of ['ssh', 'source', 'history'])
      assert.equal(
        result[operation].ok,
        caseInfo.expected === 'unsupported-clean',
        `${caseInfo.name}: ${operation}`,
      )
    for (const operation of ['local', 'native', 'cloned'])
      assert.equal(result[operation].ok, false, `${caseInfo.name}: ${operation}`)
    assert.deepEqual(
      await preserved(caseInfo),
      caseInfo.before,
      `${caseInfo.name}: assessment changed protected bytes or names`,
    )
  }
  assert.equal(proof.lateResults.initialMode, 'unsupported-clean')
  for (const operation of ['ssh', 'source', 'history'])
    assert.equal(proof.lateResults[operation].ok, false, `Late protected state: ${operation}`)
  return proof
}

async function seedConnection(userData, fixture) {
  const { password: _password, ...profile } = fixture.input()
  await json(join(userData, 'connections.json'), {
    profiles: [profile],
    knownHosts: {},
    selectedProfileId: profile.id,
    localProfileId: `local:${randomUUID()}`,
    localWorkspace: userData,
  })
}

async function launch(userData, fixture, name) {
  await seedConnection(userData, fixture)
  const appdata = join(dirname(userData), 'private appdata')
  await mkdir(appdata, { recursive: true })
  const environment = { ...process.env, APPDATA: appdata }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  const application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userData}`],
    cwd: repository,
    env: environment,
    timeout: 45000,
  })
  try {
    const logs = []
    for (const stream of ['stdout', 'stderr'])
      application
        .process()
        [stream]?.on('data', (bytes) => logs.push({ stream, text: String(bytes).slice(-16000) }))
    const page = await application.firstWindow()
    page.setDefaultTimeout(30000)
    const rendererErrors = []
    page.on('pageerror', (error) => rendererErrors.push(String(error)))
    await page.locator('.app-shell').waitFor()
    assert.match(page.url(), /^file:\/\//, 'The packaged renderer must load from its packaged file')
    assert.match(
      decodeURIComponent(page.url()).replaceAll('\\', '/').toLowerCase(),
      /\/resources\/app\.asar\/out\/renderer\/index\.html$/,
      'The gate loaded a renderer outside the package',
    )
    const identity = await application.evaluate(({ app }) => ({
      platform: process.platform,
      execPath: process.execPath,
      resources: process.resourcesPath,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      version: app.getVersion(),
      versions: process.versions,
    }))
    assert.equal(identity.platform, 'win32')
    assert.equal(identity.packaged, true)
    assert.equal(identity.execPath.toLowerCase(), executable.toLowerCase())
    assert.equal(
      resolve(identity.userData).toLowerCase(),
      resolve(userData).toLowerCase(),
      'Refusing to use an actual user profile',
    )
    assert.equal(resolve(identity.resources).toLowerCase(), resolve(resources).toLowerCase())
    const isolation = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(isolation.contextIsolation, true)
    assert.equal(isolation.nodeIntegration, false)
    assert.equal(isolation.sandbox, true)
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    await json(join(output, `${name}-main-runtime.json`), identity)
    await page.evaluate(() => {
      window.__windowsNativeEvents = []
      window.relay.onAgent((event) => window.__windowsNativeEvents.push(event))
    })
    return { application, page, identity, rendererErrors, logs }
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }
}

async function connect(page, fixture) {
  await page.evaluate((input) => {
    window.__windowsGateConnection = { settled: false }
    void window.relay.connection.connect(input).then(
      (state) => {
        window.__windowsGateConnection = { settled: true, state }
      },
      (error) => {
        window.__windowsGateConnection = { settled: true, error: String(error) }
      },
    )
  }, fixture.input())
  await waitUntil(async () => {
    const trust = page.getByRole('button', { name: 'Trust and connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    const attempt = await page.evaluate(() => window.__windowsGateConnection)
    if (attempt.error) throw new Error(attempt.error)
    return attempt.settled
  }, 'native connection and its real host-key confirmation')
  const state = await page.evaluate(() => window.__windowsGateConnection.state)
  assert.equal(state.status, 'connected')
  const selected = await page.evaluate(
    (workspace) => window.relay.connection.selectWorkspace(workspace),
    fixture.workspace,
  )
  assert.equal(selected.workspace, fixture.workspace)
  const project = page.getByRole('dialog', { name: 'Select a project', exact: true })
  if (await project.isVisible()) {
    await project.getByLabel('Project directory', { exact: true }).fill(fixture.workspace)
    await project.getByRole('button', { name: 'Open project', exact: true }).click()
    await project.waitFor({ state: 'hidden' })
    const current = await page.evaluate(() => window.relay.connection.state())
    assert.equal(current.workspace, fixture.workspace)
  }
}

async function expectRejected(page, operation, description) {
  const result = await page.evaluate(
    async ({ operation }) => {
      try {
        if (operation === 'agent')
          await window.relay.agent.start({
            sessionId: 'windows-blocked-session',
            provider: 'codex',
            prompt: 'Never send this protected-state prompt',
            model: 'fixture-model',
            mode: 'ask-for-approval',
          })
        if (operation === 'history') await window.relay.conversations.save([], Date.now() + 10000)
        if (operation === 'native-action') {
          if (typeof window.relay.agent.performRecoveryAction !== 'function')
            throw new Error('The packaged native recovery action API is missing')
          await window.relay.agent.performRecoveryAction({
            actionId: 'windows-native-action-must-stay-unsupported',
            transportId: 'windows-no-private-transport',
            sessionId: 'windows-blocked-session',
            ownerGeneration: 0,
            kind: 'settings-apply',
            intent: { theme: 'light' },
          })
        }
        if (operation === 'source') {
          const context = await window.relay.sourceCode.getContext({
            paths: ['src/renderer/main.tsx'],
          })
          await window.relay.sourceCode.apply({
            summary: 'Must reject blocked ordinary source writes',
            baseRevision: context.revision,
            files: [
              {
                path: 'src/renderer/main.tsx',
                content: context.files[0].content + '\n// rejected Windows gate change\n',
              },
            ],
          })
        }
        return { rejected: false }
      } catch (error) {
        return { rejected: true, message: String(error) }
      }
    },
    { operation },
  )
  assert.equal(result.rejected, true, description)
  assert.match(
    result.message,
    /recovery|protected|unsupported|read.only|preserv|unavailable/i,
    `${description}: explicit policy rejection`,
  )
  return result
}

async function nativeWorkflow(page, fixture, provider) {
  const prompt = `Windows ${provider} gate\nKeep this exact Unicode prompt: café 🧪 "quoted" \\ path.`
  const baseline = fixture.messages.length
  await page
    .getByRole('navigation', { name: 'Workspace views' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click()
  await page.getByRole('button', { name: 'New thread', exact: true }).click()
  await page.getByRole('combobox', { name: /^Model:/ }).click()
  await page
    .locator('.reference-select-content')
    .getByRole('option', {
      name: provider === 'codex' ? 'Codex default' : 'Claude default',
      exact: true,
    })
    .click()
  await page.getByRole('combobox', { name: /^Agent permission mode:/ }).click()
  await page
    .locator('.reference-permission-menu')
    .getByRole('option', {
      name: provider === 'codex' ? /^Ask for approval(?:[.\s]|$)/ : /^Manual(?:[.\s]|$)/,
    })
    .click()
  await page
    .getByRole('textbox', {
      name: /^(?:Message your coding agent|Message (?:Codex|Claude Code) about )/,
    })
    .fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = page.locator('.approval-card')
  await card.waitFor()
  await card.getByRole('button', { name: 'Allow once', exact: true }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
  let thread
  await waitUntil(async () => {
    const snapshot = await page.evaluate(() => window.relay.conversations.load())
    if (!snapshot) return false
    thread = snapshot.threads.find(
      (value) =>
        value.provider === provider &&
        value.messages.some((message) => message.role === 'user' && message.text === prompt),
    )
    return (
      thread &&
      !thread.busy &&
      thread.remoteId &&
      thread.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.text.includes('Windows native fixture completed.'),
      )
    )
  }, `${provider} native completion and ordinary saved history`)
  const wire = fixture.messages.slice(baseline).filter((entry) => entry.provider === provider)
  const prompts = wire.filter(
    (entry) =>
      entry.direction === 'in' &&
      (entry.message.method === 'turn/start' || entry.message.type === 'user'),
  )
  assert.equal(prompts.length, 1, `${provider}: original prompt sent once`)
  const blocks =
    provider === 'codex' ? prompts[0].message.params.input : prompts[0].message.message.content
  assert.deepEqual(
    blocks,
    [{ type: 'text', text: prompt }],
    `${provider}: exact native text blocks`,
  )
  const permissionRequest = wire.find(
    (entry) =>
      entry.direction === 'out' &&
      (entry.message.method === 'item/commandExecution/requestApproval' ||
        entry.message.type === 'control_request'),
  )
  const responses = wire.filter(
    (entry) =>
      entry.direction === 'in' &&
      (provider === 'codex'
        ? entry.message.id === permissionRequest.message.id && !entry.message.method
        : entry.message.type === 'control_response' &&
          entry.message.response.request_id === permissionRequest.message.request_id),
  )
  assert.equal(responses.length, 1, `${provider}: native permission response sent once`)
  if (provider === 'codex') assert.deepEqual(responses[0].message.result, { decision: 'accept' })
  else
    assert.deepEqual(responses[0].message, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: permissionRequest.message.request_id,
        response: { behavior: 'allow', updatedInput: permissionRequest.message.request.input },
      },
    })
  assert.equal(thread.workspace, fixture.workspace)
  assert.equal(thread.profileId, fixture.input().id)
  assert(!thread.nativeRecovery, `${provider}: an attached run must not acquire a recovery cursor`)
  const events = (await page.evaluate(() => window.__windowsNativeEvents)).filter(
    (event) => event.sessionId === thread.id,
  )
  assert(
    events.some((event) => event.type === 'session' && event.remoteId === thread.remoteId),
    `${provider}: native session identity event`,
  )
  assert(
    events.some((event) => event.type === 'complete' && event.status === 'completed'),
    `${provider}: authoritative native completion event`,
  )
  assert(!events.some((event) => event.type === 'error'), `${provider}: no native protocol error`)
  const channelWire = fixture.messages.filter((entry) => entry.channelId === prompts[0].channelId)
  const issuedIdentity =
    provider === 'codex'
      ? channelWire.find(
          (entry) =>
            entry.direction === 'out' &&
            entry.message.id ===
              channelWire.find(
                (value) => value.direction === 'in' && value.message.method === 'thread/start',
              )?.message.id,
        )?.message.result?.thread?.id
      : channelWire.find(
          (entry) =>
            entry.direction === 'out' &&
            entry.message.type === 'system' &&
            entry.message.subtype === 'init',
        )?.message.session_id
  assert.equal(
    thread.remoteId,
    issuedIdentity,
    `${provider}: saved identity equals the native peer's issued identity`,
  )
  assert.equal(
    provider === 'codex' ? prompts[0].message.params.threadId : prompts[0].message.session_id,
    issuedIdentity,
    `${provider}: original prompt binds to the issued native identity`,
  )
  const inbound = channelWire
    .filter((entry) => entry.direction === 'in')
    .map((entry) => entry.message)
  const initialization = inbound.findIndex((message) =>
    provider === 'codex'
      ? message.method === 'initialize'
      : message.type === 'control_request' && message.request.subtype === 'initialize',
  )
  const originalPrompt = inbound.indexOf(prompts[0].message)
  assert(
    initialization >= 0 && originalPrompt > initialization,
    `${provider}: initialization precedes the original prompt`,
  )
  if (provider === 'codex')
    assert(inbound.findIndex((message) => message.method === 'initialized') > initialization)
  return {
    provider,
    prompt,
    remoteId: thread.remoteId,
    sessionId: thread.id,
    responses: responses.map((entry) => entry.message),
    blocks,
    events,
  }
}

async function reloadSource(page) {
  const navigation = page.waitForEvent('domcontentloaded', { timeout: 120000 })
  await page
    .evaluate(() => window.relay.sourceCode.reload())
    .catch((error) => {
      if (!/Execution context was destroyed/i.test(String(error))) throw error
    })
  await navigation
  await page.locator('.app-shell').waitFor()
}

async function customizationWorkflow(page) {
  const initial = await page.evaluate(() => window.relay.customization.get())
  const theme = initial.config.theme === 'light' ? 'dark' : 'light'
  const applied = await page.evaluate((theme) => window.relay.customization.apply({ theme }), theme)
  assert.equal(applied.config.theme, theme)
  const restored = await page.evaluate(() => window.relay.customization.undo())
  assert.deepEqual(restored.config, initial.config)
  return {
    initialRevision: initial.revision,
    appliedRevision: applied.revision,
    restoredRevision: restored.revision,
    theme,
  }
}

async function studioWorkflow(page, fixture) {
  const request = 'Add the Windows Studio ordinary source marker Ω.'
  await page.getByRole('button', { name: 'Customize', exact: true }).click()
  const studio = page.getByRole('region', { name: 'Life Customization Studio', exact: true })
  await studio.waitFor()
  await studio.getByRole('checkbox', { name: 'Apply valid changes automatically' }).uncheck()
  await studio.getByRole('combobox', { name: /^Model:/ }).click()
  await page
    .locator('.reference-select-content')
    .getByRole('option', { name: 'Codex default', exact: true })
    .click()
  await studio.getByRole('textbox', { name: 'Describe a Life customization' }).fill(request)
  await studio.getByRole('button', { name: 'Send customization request', exact: true }).click()
  await studio.getByRole('region', { name: 'Customization proposal', exact: true }).waitFor()
  await studio
    .getByRole('region', { name: 'Customization proposal', exact: true })
    .getByText('Source extension', { exact: true })
    .waitFor()
  assert.equal(
    await page.locator('[data-windows-studio-proof="applied"]').count(),
    0,
    'The real planner holds its source proposal for review',
  )
  assert.deepEqual(
    fixture.studioPrompts.map(({ prompt, phase }) => ({ prompt, phase })),
    [
      { prompt: request, phase: 'request' },
      { prompt: request, phase: 'source-read' },
    ],
    'Studio source-read continuation retains the exact original native prompt',
  )
  const navigation = page.waitForEvent('domcontentloaded', { timeout: 120000 })
  await studio.getByRole('button', { name: 'Apply changes', exact: true }).click()
  await navigation
  await page.locator('[data-windows-studio-proof="applied"]').waitFor()
  const applied = await page.evaluate(() => window.relay.sourceCode.get())
  assert.equal(applied.enabled, true)
  assert(applied.active?.js)
  assert.equal(
    (await page.evaluate(() => window.relay.connection.state())).workspace,
    fixture.workspace,
    'Studio keeps the connected ordinary project',
  )
  return {
    request,
    prompts: fixture.studioPrompts,
    phases: fixture.studioContexts.map(({ context }) => context.phase),
    active: applied.active,
    revision: applied.revision,
  }
}

async function passiveRecoveryQueryWorkflow(application, page, userData, fixture) {
  const markers = {
    'life.studio.pending-source.v1': JSON.stringify({
      id: 'life-studio:archived',
      request: '  Archived exact request Ω\r\n  ',
      profileId: fixture.input().id,
      input: {
        sessionId: 'life-studio:archived',
        provider: 'codex',
        prompt: '  Archived exact request Ω\r\n  ',
        mode: 'plan',
        scope: 'life-customization',
      },
      reads: 0,
      repairs: 0,
      paths: ['src/renderer/main.tsx'],
    }),
    'life.pendingSourceApply': JSON.stringify({
      id: 'archived-main',
      turn: 1,
      request: '  Archived exact request Ω\r\n  ',
      profileId: fixture.input().id,
      reads: 0,
      repairs: 0,
      start: {
        sessionId: 'archived-main',
        provider: 'codex',
        prompt: '  Archived exact request Ω\r\n  ',
        mode: 'plan',
      },
      paths: ['src/renderer/main.tsx'],
    }),
  }
  await page.evaluate((markers) => {
    for (const [key, value] of Object.entries(markers)) localStorage.setItem(key, value)
  }, markers)
  const nativeBefore = { ...fixture.nativeChannels }
  const messagesBefore = fixture.messages.length
  const results = []
  for (const mode of ['hold', 'reject']) {
    const beforeReload = hash(await readFile(join(userData, 'conversations.json')))
    const studioHistoryBefore = await page.evaluate(() =>
      localStorage.getItem('life.studio.sessions.v1'),
    )
    await application.evaluate(({ ipcMain }, mode) => {
      const channel = 'agent:recovery-support'
      const original = ipcMain._invokeHandlers.get(channel)
      if (typeof original !== 'function')
        throw new Error('The genuine recovery-support IPC handler is missing')
      const state = { original, queries: 0, held: [], mode }
      globalThis.__windowsRecoveryQueryFixture = state
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        state.queries++
        if (mode === 'reject') throw new Error('Fixture injected recovery-support query rejection')
        await new Promise((resolve) => state.held.push(resolve))
        return original(event, ...args)
      })
    }, mode)
    try {
      phase = `passive recovery query ${mode}: reload`
      await page.reload()
      await page.locator('.app-shell').waitFor()
      await waitUntil(
        async () =>
          (await application.evaluate(() => globalThis.__windowsRecoveryQueryFixture.queries)) > 0,
        'the real production recovery-support IPC query',
      )
      // Main admits this new document's read only after the preceding
      // document's accepted history checkpoint has drained. Measure passive
      // behavior from that boundary, including the refused action below.
      phase = `passive recovery query ${mode}: native history read after handoff`
      const admittedHistory = await within(
        () => page.evaluate(() => window.relay.conversations.load()),
        `${mode} native history read after document handoff`,
      )
      assert(admittedHistory.threads.length >= 2)
      const before = hash(await readFile(join(userData, 'conversations.json')))
      phase = `passive recovery query ${mode}: refused Studio action`
      await page.getByRole('button', { name: 'Customize', exact: true }).click()
      const studio = page.getByRole('region', { name: 'Life Customization Studio', exact: true })
      await studio.waitFor()
      await studio
        .getByRole('textbox', { name: 'Describe a Life customization' })
        .fill('Keep this query fixture request unsent.')
      await studio.getByRole('button', { name: 'Send customization request', exact: true }).click()
      await studio
        .getByText(/verifying native recovery|could not be verified|read or export/i)
        .first()
        .waitFor()
      assert.equal(
        await page.evaluate(() => localStorage.getItem('life.studio.sessions.v1')),
        studioHistoryBefore,
        `${mode}: refused action preserves complete Studio history`,
      )
      const stored = await page.evaluate(
        (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
        Object.keys(markers),
      )
      assert.deepEqual(stored, markers, `${mode}: legacy pending markers remain exact and inert`)
      const history = await page.evaluate(() => window.relay.conversations.load())
      assert(history.threads.length >= 2, `${mode}: saved native history remains readable`)
      const source = await page.evaluate(() => window.relay.sourceCode.get())
      const custom = source.extensions.find((entry) => !entry.builtIn)
      if (custom)
        assert.equal(
          (await page.evaluate((id) => window.relay.sourceCode.exportExtension(id), custom.id))
            .format,
          'life-source-extension',
        )
      assert.equal(
        hash(await readFile(join(userData, 'conversations.json'))),
        before,
        `${mode}: the passive query did not mutate history`,
      )
      assert.deepEqual(fixture.nativeChannels, nativeBefore)
      assert.equal(fixture.messages.length, messagesBefore)
      results.push({
        mode,
        rawMarkers: stored,
        beforeReloadHistorySha256: beforeReload,
        historySha256: before,
        historyThreads: history.threads.length,
      })
    } catch (error) {
      await json(join(output, `passive-query-${mode}-failure.json`), {
        phase,
        error: String(error.stack || error),
        at: new Date().toISOString(),
      })
      throw error
    } finally {
      phase = `passive recovery query ${mode}: restore genuine handler`
      await within(
        () =>
          application.evaluate(({ ipcMain }) => {
            const state = globalThis.__windowsRecoveryQueryFixture
            ipcMain.removeHandler('agent:recovery-support')
            ipcMain.handle('agent:recovery-support', state.original)
            for (const resolve of state.held) resolve()
            delete globalThis.__windowsRecoveryQueryFixture
          }),
        `${mode} recovery query handler restoration`,
      )
    }
  }
  // End the explicit query-failure fixture with the genuine handler and a fresh
  // healthy document; raw pending markers remain available for manual recovery.
  phase = 'passive recovery queries: healthy document restore'
  await page.reload()
  await page.locator('.app-shell').waitFor()
  assert.deepEqual(
    await page.evaluate(
      (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
      Object.keys(markers),
    ),
    markers,
  )
  return results
}

async function sourceWorkflow(page) {
  const path = 'src/renderer/main.tsx'
  const original = await page.evaluate(
    (path) => window.relay.sourceCode.getContext({ paths: [path] }),
    path,
  )
  assert.equal(original.files[0].content.split('<App />').length, 2)
  const content = original.files[0].content.replace(
    '<App />',
    '<App />\n    <section data-windows-recovery-proof="first">Windows ordinary source proof</section>',
  )
  const first = await page.evaluate((patch) => window.relay.sourceCode.apply(patch), {
    summary: 'Windows ordinary Source compatibility gate',
    baseRevision: original.revision,
    files: [{ path, content }],
  })
  assert.equal(first.enabled, true)
  assert(first.active?.js)
  await reloadSource(page)
  await page.locator('[data-windows-recovery-proof="first"]').waitFor()
  const current = await page.evaluate(
    (path) => window.relay.sourceCode.getContext({ paths: [path] }),
    path,
  )
  const second = await page.evaluate((patch) => window.relay.sourceCode.apply(patch), {
    summary: 'Second ordinary generation for real rollback',
    baseRevision: current.revision,
    files: [{ path, content: current.files[0].content.replace('proof="first"', 'proof="second"') }],
  })
  assert.equal(second.enabled, true)
  await reloadSource(page)
  await page.locator('[data-windows-recovery-proof="second"]').waitFor()
  const rollback = await page.evaluate(() => window.relay.sourceCode.rollback())
  await reloadSource(page)
  await page.locator('[data-windows-recovery-proof="first"]').waitFor()
  assert.equal(await page.locator('[data-windows-recovery-proof="second"]').count(), 0)
  return {
    firstRevision: first.revision,
    secondRevision: second.revision,
    rollbackRevision: rollback.revision,
    active: rollback.active,
  }
}

async function blockedMainWorkflow(caseInfo, fixture) {
  const baseline = fixture.messages.length
  const channelBaseline = { ...fixture.nativeChannels }
  const before = await preserved(caseInfo)
  const namespacesBefore = await protectedInventory(caseInfo.userData)
  let current
  try {
    current = await launch(caseInfo.userData, fixture, caseInfo.name)
    await connect(current.page, fixture)
    const denials = {}
    for (const operation of ['agent', 'history', 'source', 'native-action'])
      denials[operation] = await expectRejected(
        current.page,
        operation,
        `${caseInfo.name}: ${operation}`,
      )
    assert.equal(fixture.messages.length, baseline, `${caseInfo.name}: no native provider messages`)
    assert.deepEqual(
      fixture.nativeChannels,
      channelBaseline,
      `${caseInfo.name}: no native provider channel was launched`,
    )
    return { name: caseInfo.name, denials, preserved: before }
  } finally {
    await current?.application.close()
    assert.deepEqual(
      await preserved(caseInfo),
      before,
      `${caseInfo.name}: Main changed protected bytes or names`,
    )
    assert.deepEqual(
      await protectedInventory(caseInfo.userData),
      namespacesBefore,
      `${caseInfo.name}: Main wrote into a protected namespace`,
    )
  }
}

async function run() {
  assert(
    provenancePath,
    "LIFE_RECOVERY_BUILD_PROVENANCE must name Root's exact frozen build/package manifest",
  )
  assert.equal(basename(executable).toLowerCase(), 'life.exe')
  assert(existsSync(executable), 'Build the real Windows package before this gate')
  assert(existsSync(join(resources, 'app.asar')), 'The executable must have packaged app.asar')
  assert(existsSync(policyModule), 'The release must ship its exact recovery platform source')
  await mkdir(output, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'Life Windows recovery gate '))
  const proof = {
    ok: false,
    startedAt: new Date().toISOString(),
    orchestrator: { platform: process.platform, arch: process.arch, versions: process.versions },
    fixture:
      'Real packaged Windows Electron Main/IPC and loopback SSH/SFTP; native protocol stand-ins; no authenticated upstream provider use',
    executable,
    resources,
  }
  let fixture, current
  const progress = setInterval(() => {
    console.log(`Windows compatibility gate: ${phase}`)
    void json(join(output, 'progress.json'), {
      ok: false,
      phase,
      at: new Date().toISOString(),
      privateFixtureRoot: root,
      mainLogs: current?.logs,
      rendererErrors: current?.rendererErrors,
    }).catch((error) => console.error('Could not retain Windows progress:', String(error)))
  }, 30000)
  try {
    const provenanceBytes = await readFile(resolve(provenancePath))
    const provenance = JSON.parse(provenanceBytes.toString('utf8'))
    assert.equal(provenance.format, 'life-recovery-release-build')
    assert.equal(provenance.version, 1)
    assert.equal(provenance.platform, 'win32')
    proof.buildProvenanceSha256 = hash(provenanceBytes)
    proof.buildContract =
      'Root captures source before the exact fresh build/package and seals unchanged source plus compiled/package hashes; this gate requires that manifest and verifies its actual packaged graph'
    proof.sourcesBefore = await sourceHashes(repository)
    proof.packagedSources = await sourceHashes(packagedSource)
    assert.deepEqual(
      proof.packagedSources,
      proof.sourcesBefore,
      'Packaged source differs from the tested checkout',
    )
    assert.deepEqual(
      provenance.sourceBefore,
      provenance.sourceAfter,
      'Source changed during the required build/package',
    )
    assert.deepEqual(
      provenance.sourceBefore,
      proof.sourcesBefore,
      'Build provenance names different source',
    )
    proof.compiledBefore = await inventory(join(repository, 'out'))
    assert(
      !proof.compiledBefore.some((entry) => entry.type === 'link'),
      'Compiled checkout graph contains a link',
    )
    assert.deepEqual(
      provenance.compiled,
      proof.compiledBefore,
      'Compiled checkout differs from the exact build provenance',
    )
    proof.packageHashes = {
      exe: hash(await readFile(executable)),
      asar: hash(await readFile(join(resources, 'app.asar'))),
    }
    assert.deepEqual(
      provenance.package,
      { executableSha256: proof.packageHashes.exe, asarSha256: proof.packageHashes.asar },
      'Package differs from the required build provenance',
    )
    proof.packagedCompiledBefore = await packagedCompiledInventory(root, 'before')
    assert.deepEqual(
      proof.packagedCompiledBefore,
      proof.compiledBefore,
      'Actual packaged Main/preload/renderer/source output differs from the exact frozen build',
    )
    phase = 'real Windows filesystem and packaged policy assessment'
    const cases = await filesystemCases(root)
    proof.policy = await policyProbe(root, cases)
    // Also record the orchestrator's real filesystem behavior; it cannot override
    // the packaged policy or substitute for the packaged runtime measurements.
    const nodeDirectory = join(root, 'system Node directory sync')
    await mkdir(nodeDirectory)
    const { open } = require('node:fs/promises')
    let handle
    try {
      handle = await open(nodeDirectory, 'r')
      await handle.sync()
      proof.orchestrator.directorySync = { ok: true }
    } catch (error) {
      proof.orchestrator.directorySync = { ok: false, code: error.code, message: error.message }
    } finally {
      await handle?.close()
    }
    phase = 'Windows-hostable loopback SSH fixture'
    const fixtureBundle = join(root, 'windows-ssh-fixture.cjs')
    await build({
      entryPoints: [join(repository, 'tests/helpers/windows-ssh-fixture.ts')],
      outfile: fixtureBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
    })
    // The bundled helper resides outside the checkout; resolve ssh2 from this
    // test installation without changing the app's packaged dependencies.
    const helperSource = await readFile(fixtureBundle, 'utf8')
    await writeFile(
      fixtureBundle,
      `require = require('node:module').createRequire(${JSON.stringify(join(repository, 'package.json'))});\n${helperSource}`,
    )
    const { WindowsSSHFixture } = require(fixtureBundle)
    const stageSource = await readFile(join(packagedSource, 'src/main/studio-context.ts'), 'utf8')
    const stageProgram = stageSource.match(
      /const stageContextProgram = String\.raw`([\s\S]*?)`\r?\n/,
    )
    assert(stageProgram, 'The packaged Studio staging program must remain identifiable')
    const stageProgramHash = hash(stageProgram[1].replace(/\r\n?/g, '\n'))
    fixture = new WindowsSSHFixture(join(root, 'logical remote HOME'), stageProgramHash)
    await fixture.start()
    const clean = await makeCase(root, 'main-clean', async () => [], 'unsupported-clean')
    phase = 'packaged Main fresh native SSH and ordinary history'
    current = await launch(clean.userData, fixture, clean.name)
    await connect(current.page, fixture)
    proof.native = []
    for (const provider of ['codex', 'claude'])
      proof.native.push(await nativeWorkflow(current.page, fixture, provider))
    assert.equal(
      await current.page.evaluate(() => typeof window.relay.agent.performRecoveryAction),
      'function',
      'The packaged native recovery action API must exist',
    )
    const configBeforeNativeAction = await current.page.evaluate(() =>
      window.relay.customization.get(),
    )
    proof.unsupportedAction = await expectRejected(
      current.page,
      'native-action',
      'Clean Windows native actions remain unsupported',
    )
    assert.deepEqual(
      await current.page.evaluate(() => window.relay.customization.get()),
      configBeforeNativeAction,
      'Unsupported native action did not invoke its settings driver',
    )
    await requireNoRecoveryArtifacts(clean.userData)
    phase = 'ordinary live Source apply and rollback in packaged Main'
    proof.customization = await customizationWorkflow(current.page)
    proof.source = await sourceWorkflow(current.page)
    phase = 'actual ordinary Studio source planner, native continuation and apply'
    proof.studio = await studioWorkflow(current.page, fixture)
    const savedBeforeCold = await current.page.evaluate(() => window.relay.conversations.load())
    assert(
      !savedBeforeCold.nativeRecovery && !savedBeforeCold.nativeRecoveryHash,
      'Ordinary saved history has no native durability receipt',
    )
    assert.deepEqual(savedBeforeCold.projectionAdmissions || [], [])
    assert.deepEqual(savedBeforeCold.membershipAdmissions || [], [])
    proof.historyBeforeCold = proof.native.map(({ sessionId }) => {
      const thread = savedBeforeCold.threads.find((value) => value.id === sessionId)
      return {
        id: thread.id,
        provider: thread.provider,
        profileId: thread.profileId,
        workspace: thread.workspace,
        remoteId: thread.remoteId,
        messages: thread.messages,
      }
    })
    assert.deepEqual(current.rendererErrors, [])
    await current.application.close()
    current = undefined
    await requireNoRecoveryArtifacts(clean.userData)
    phase = 'real cold reopen preserves ordinary history and Source'
    const priorNativeMessages = fixture.messages.length
    current = await launch(clean.userData, fixture, 'main-cold-reopen')
    await current.page.locator('[data-windows-recovery-proof="first"]').waitFor()
    assert.deepEqual(
      (await current.page.evaluate(() => window.relay.sourceCode.get())).active,
      proof.studio.active,
      'Cold reopen preserves the exact rolled-back Source generation',
    )
    const history = await current.page.evaluate(() => window.relay.conversations.load())
    for (const result of proof.native) {
      const thread = history.threads.find((value) => value.id === result.sessionId)
      assert(thread, 'Ordinary thread was lost on cold reopen')
      assert.equal(thread.remoteId, result.remoteId)
      assert(
        thread.messages.some(
          (message) => message.role === 'user' && message.text === result.prompt,
        ),
      )
      assert(!thread.nativeRecovery)
      assert.deepEqual(
        {
          id: thread.id,
          provider: thread.provider,
          profileId: thread.profileId,
          workspace: thread.workspace,
          remoteId: thread.remoteId,
          messages: thread.messages,
        },
        proof.historyBeforeCold.find((value) => value.id === thread.id),
        'Cold reopen preserves provider/workspace ownership and complete saved message/permission history',
      )
    }
    assert.equal(
      fixture.messages.length,
      priorNativeMessages,
      'Cold reopen sent no recovered native input',
    )
    phase = 'passive pending markers and held/rejected genuine recovery-support IPC'
    proof.passiveQueries = await passiveRecoveryQueryWorkflow(
      current.application,
      current.page,
      clean.userData,
      fixture,
    )
    await requireNoRecoveryArtifacts(clean.userData)
    await current.application.close()
    current = undefined
    phase = 'packaged Main preserves seeded protected state and rejects every write'
    proof.blockedMain = []
    for (const name of [
      'native-recovery-valid-journal',
      'native-recovery-actions-foreign-lease',
      'conversations-recovery-receipts-json',
      'Conversations-Recovery-Receipts-Json',
      'source-action',
      'source-corrupt',
      'source-invalid-state-schema',
      'source-state-case-temp',
      'source-action-case',
      'source-staging-temp',
      'source-incorporation-protected',
      'source-revisions-junction',
    ])
      proof.blockedMain.push(
        await blockedMainWorkflow(
          cases.find((value) => value.name === name),
          fixture,
        ),
      )
    phase = 'state appears after actual Main startup'
    const late = await makeCase(
      root,
      'main-late-protected-state',
      async () => [],
      'unsupported-clean',
    )
    current = await launch(late.userData, fixture, late.name)
    await connect(current.page, fixture)
    await mkdir(join(late.userData, 'native-recovery'))
    await writeFile(
      join(late.userData, 'native-recovery/late-sentinel'),
      'Late state must remain unchanged\n',
    )
    late.protectedPaths = ['native-recovery']
    const lateBefore = await preserved(late)
    const nativeBaseline = fixture.messages.length
    const lateChannelBaseline = { ...fixture.nativeChannels }
    proof.lateMain = {}
    for (const operation of ['agent', 'history', 'source', 'native-action'])
      proof.lateMain[operation] = await expectRejected(
        current.page,
        operation,
        `Late Main state: ${operation}`,
      )
    assert.equal(fixture.messages.length, nativeBaseline)
    assert.deepEqual(fixture.nativeChannels, lateChannelBaseline)
    await current.application.close()
    current = undefined
    assert.deepEqual(await preserved(late), lateBefore)
    assert.deepEqual(
      fixture.rejectedCommands,
      [],
      'The package attempted an unknown or detached broker command',
    )
    assert.deepEqual(
      fixture.protocolErrors,
      [],
      'The package violated native initialization or NDJSON protocol order',
    )
    for (const provider of ['codex', 'claude']) {
      const prompts = fixture.messages.filter(
        (entry) =>
          entry.provider === provider &&
          entry.direction === 'in' &&
          (entry.message.method === 'turn/start' || entry.message.type === 'user'),
      )
      assert.equal(
        prompts.length,
        provider === 'codex' ? 3 : 1,
        `${provider}: only the original ordinary prompt and explicit Studio source-read continuation were sent`,
      )
    }
    proof.fixtureCommands = fixture.commands
    proof.fixtureMessages = fixture.messages
    proof.nativeChannels = fixture.nativeChannels
    proof.sourcesAfter = await sourceHashes(repository)
    assert.deepEqual(
      proof.sourcesAfter,
      proof.sourcesBefore,
      'Source changed while the gate was running',
    )
    assert.deepEqual(
      await sourceHashes(packagedSource),
      proof.packagedSources,
      'Packaged source changed while the gate was running',
    )
    assert.deepEqual(
      await inventory(join(repository, 'out')),
      proof.compiledBefore,
      'Compiled checkout changed during the gate',
    )
    proof.packagedCompiledAfter = await packagedCompiledInventory(root, 'after')
    assert.deepEqual(
      proof.packagedCompiledAfter,
      proof.packagedCompiledBefore,
      'Actual packaged compiled graph changed during the gate',
    )
    assert.deepEqual(
      {
        exe: hash(await readFile(executable)),
        asar: hash(await readFile(join(resources, 'app.asar'))),
      },
      proof.packageHashes,
      'Packaged executable or app.asar changed while the gate was running',
    )
    proof.completedAt = new Date().toISOString()
    proof.ok = true
    await json(join(output, 'proof.json'), proof)
    console.log(
      `Windows packaged native compatibility gate passed. Proof: ${join(output, 'proof.json')}`,
    )
  } catch (error) {
    proof.phase = phase
    proof.error = String(error.stack || error)
    proof.privateFixtureRoot = root
    proof.fixtureCommands = fixture?.commands
    proof.fixtureMessages = fixture?.messages
    proof.mainLogs = current?.logs
    proof.rendererErrors = current?.rendererErrors
    await json(join(output, 'failure-proof.json'), proof)
    console.error('Windows compatibility failed:', phase, String(error.stack || error))
    await current?.page
      .screenshot({ path: join(output, 'failure.png'), timeout: 5000 })
      .catch(() => {})
    throw error
  } finally {
    clearInterval(progress)
    if (current) {
      if (proof.ok) await current.application.close()
      else
        await within(() => current.application.close(), 'failed fixture cleanup', 5000).catch(
          async () => {
            const child = current.application.process()
            const forced = child.exitCode === null && child.signalCode === null
            if (forced) child.kill('SIGKILL')
            await json(join(output, 'failed-fixture-cleanup.json'), {
              pid: child.pid,
              forcedOwnMain: forced,
              nativeProtocolExitConfirmed: false,
              reason: 'Only failed fixture cleanup; the original assertion remains failed',
            })
          },
        )
    }
    await fixture?.close()
    if (proof.ok) await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
