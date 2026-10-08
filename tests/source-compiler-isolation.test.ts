import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { SourceCodeStore } from '../src/main/source-code'

const directories: string[] = []
const stores: SourceCodeStore[] = []
const childPids = new Set<number>()
const dependencies = {
  '@tailwindcss/postcss': '4.3.3',
  postcss: '8.5.29',
  tailwindcss: '4.3.3',
}

async function createFixture(behavior: 'abort' | 'hang' | 'exit-with-helper' | 'hang-with-helper') {
  const directory = await mkdtemp(join(tmpdir(), 'life-compiler-isolation-'))
  directories.push(directory)
  const sourceDir = join(directory, 'installed-source')
  const files = {
    'src/renderer/main.tsx':
      "import './styles.css'\n;(globalThis as any).__life_compiler_test = 'original'\n",
    'src/renderer/styles.css': '.workspace { color: #151515; }\n',
    'package.json': JSON.stringify({
      name: 'life-isolation-test',
      version: '1.0.0',
      dependencies: {},
    }),
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true })
    await writeFile(join(sourceDir, path), content)
  }
  const options = {
    sourceDir,
    nodeModulesDir: resolve('node_modules'),
    directory: join(directory, 'customizations'),
    compilerTimeoutMs: 5000,
    installTimeoutMs: 5000,
  }
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  const working = await store.apply({
    summary: 'Working renderer before stylesheet compilation',
    baseRevision: store.get().revision,
    files: [
      { path: 'src/renderer/main.tsx', edits: [{ find: "'original'", replace: "'working'" }] },
    ],
  })
  const sorted = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )
  const cacheKey = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 24)
  const packageDir = join(store.path, 'packages', cacheKey)
  const packageModules = join(packageDir, 'node_modules')
  const pidFile = join(directory, 'stylesheet-compiler.pid')
  const helperPidFile = join(directory, 'stylesheet-helper.pid')
  const helperReadyFile = join(directory, 'stylesheet-helper.ready')
  const marker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`
  const helperProgram = `${behavior === 'hang-with-helper' ? "process.on('SIGTERM', () => {})" : ''}
require('node:fs').writeFileSync(${JSON.stringify(helperReadyFile)}, 'ready')
setInterval(() => {}, 60000)
`
  const helperStdio =
    behavior === 'hang-with-helper' ? "'ignore'" : "['ignore', process.stdout, process.stderr]"
  const helper = `
${marker}
const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperProgram)}], { stdio: ${helperStdio}, windowsHide: true, env: process.env })
require('node:fs').writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid))
helper.unref()
`
  const postcssSource =
    behavior === 'abort'
      ? `${marker}\nprocess.abort()\n`
      : behavior === 'exit-with-helper'
        ? `${helper}\nprocess.exit(0)\n`
        : `${behavior === 'hang-with-helper' ? helper : ''}module.exports = () => ({ process() { ${marker}; return new Promise(() => { setInterval(() => {}, 60000) }) } })\n`
  const packageSources = {
    postcss: postcssSource,
    '@tailwindcss/postcss': 'module.exports = () => ({})\n',
    tailwindcss: 'module.exports = {}\n',
  }
  for (const [name, content] of Object.entries(packageSources)) {
    await mkdir(join(packageModules, name), { recursive: true })
    await writeFile(
      join(packageModules, name, 'package.json'),
      JSON.stringify({
        name,
        version: dependencies[name as keyof typeof dependencies],
        main: 'index.js',
      }),
    )
    await writeFile(join(packageModules, name, 'index.js'), content)
  }
  await writeFile(join(packageDir, '.complete'), 'installed')
  return { store, options, working, pidFile, helperPidFile, helperReadyFile }
}

function applyTailwind(store: SourceCodeStore) {
  return store.apply({
    summary: 'Compile an isolated third-party stylesheet',
    baseRevision: store.get().revision,
    files: [{ path: 'src/renderer/styles.css', content: '@import "tailwindcss";\n' }],
    dependencies,
  })
}

async function recordedPid(file: string) {
  await expect.poll(() => existsSync(file), { timeout: 2500, interval: 10 }).toBe(true)
  const pid = Number(await readFile(file, 'utf8'))
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  expect(pid).not.toBe(process.pid)
  childPids.add(pid)
  return pid
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) return false
    }
    return true
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) return false
    throw error
  }
}

async function assertStopped(pid: number) {
  await expect.poll(() => running(pid), { timeout: 2500, interval: 10 }).toBe(false)
  childPids.delete(pid)
}

async function executeWorking(store: SourceCodeStore) {
  const asset = store.assetPath(store.get().active!.js)
  const scope: Record<string, unknown> = {}
  runInNewContext(await readFile(asset!, 'utf8'), { globalThis: scope })
  expect(scope.__life_compiler_test).toBe('working')
}

afterEach(async () => {
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  childPids.clear()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('native stylesheet compiler process isolation', () => {
  it('survives a stylesheet compiler abort and preserves the working revision, source and extensions', async () => {
    const { store, working, pidFile } = await createFixture('abort')
    const hostPid = process.pid
    const bundle = await store.exportExtension(working.extensions[0].id)
    const source = await store.getContext({ paths: ['src/renderer/styles.css'] })
    await expect(applyTailwind(store)).rejects.toThrow()
    const pid = await recordedPid(pidFile)
    await assertStopped(pid)
    expect(process.pid).toBe(hostPid)
    expect(store.get().revision).toBe(working.revision)
    expect(store.get().active?.js).toBe(working.active!.js)
    expect(store.get().extensions.map((extension) => extension.id)).toEqual(
      working.extensions.map((extension) => extension.id),
    )
    expect(await store.exportExtension(bundle.id)).toEqual(bundle)
    expect((await store.getContext({ paths: ['src/renderer/styles.css'] })).files).toEqual(
      source.files,
    )
    await executeWorking(store)
  })

  it('terminates a hung stylesheet compiler on timeout without replacing the working interface', async () => {
    const { store, options, working, pidFile } = await createFixture('hang')
    await store.close()
    const timed = new SourceCodeStore({ ...options, compilerTimeoutMs: 200 })
    stores.push(timed)
    await timed.init()
    const started = Date.now()
    await expect(applyTailwind(timed)).rejects.toThrow(/timed out/i)
    expect(Date.now() - started).toBeLessThan(3000)
    const pid = await recordedPid(pidFile)
    await assertStopped(pid)
    expect(timed.get().revision).toBe(working.revision)
    expect(timed.get().active?.js).toBe(working.active!.js)
    expect(timed.get().extensions).toHaveLength(1)
    await executeWorking(timed)
  })

  it('bounds compilation failure when an exited compiler leaves stdout open in a helper process', async () => {
    const {
      store: initial,
      options,
      working,
      pidFile,
      helperPidFile,
    } = await createFixture('exit-with-helper')
    await initial.close()
    const store = new SourceCodeStore({ ...options, compilerTimeoutMs: 200 })
    stores.push(store)
    await store.init()
    const bundle = await store.exportExtension(working.extensions[0].id)
    const started = Date.now()
    const application = applyTailwind(store).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    const pid = await recordedPid(pidFile)
    const helperPid = await recordedPid(helperPidFile)
    const result = await application
    expect(result.status).toBe('rejected')
    expect(Date.now() - started).toBeLessThan(3000)
    await assertStopped(pid)
    if (process.platform !== 'win32') await assertStopped(helperPid)
    expect(store.get().revision).toBe(working.revision)
    expect(store.get().active?.js).toBe(working.active!.js)
    expect(await store.exportExtension(bundle.id)).toEqual(bundle)
    await executeWorking(store)
  })

  it('terminates a SIGTERM-resistant helper after its live compiler closes during disable', async () => {
    const { store, working, pidFile, helperPidFile, helperReadyFile } =
      await createFixture('hang-with-helper')
    const application = applyTailwind(store).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    const pid = await recordedPid(pidFile)
    const helperPid = await recordedPid(helperPidFile)
    await expect.poll(() => existsSync(helperReadyFile), { timeout: 2500, interval: 10 }).toBe(true)
    const started = Date.now()
    await store.disable()
    const result = await application
    expect(result.status).toBe('rejected')
    expect(Date.now() - started).toBeLessThan(3000)
    await assertStopped(pid)
    await assertStopped(helperPid)
    expect(store.get().enabled).toBe(false)
    expect(store.get().active).toBeUndefined()
    expect(store.get().extensions.map((extension) => extension.id)).toEqual(
      working.extensions.map((extension) => extension.id),
    )
  })

  it.each(['disable', 'close'] as const)(
    'terminates a hung stylesheet compiler when the store is asked to %s',
    async (action) => {
      const { store, working, pidFile } = await createFixture('hang')
      const application = applyTailwind(store).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      const pid = await recordedPid(pidFile)
      const started = Date.now()
      if (action === 'disable') await store.disable()
      else await store.close()
      expect(Date.now() - started).toBeLessThan(3000)
      const result = await application
      expect(result.status).toBe('rejected')
      await assertStopped(pid)
      expect(store.get().extensions.map((extension) => extension.id)).toEqual(
        working.extensions.map((extension) => extension.id),
      )
      if (action === 'disable') {
        expect(store.get().enabled).toBe(false)
        expect(store.get().active).toBeUndefined()
      } else {
        expect(store.get().revision).toBe(working.revision)
        expect(store.get().active?.js).toBe(working.active!.js)
      }
    },
  )
})
