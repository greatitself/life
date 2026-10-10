import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SourceCodeStore } from '../src/main/source-code'
import { PackagedDependencies } from '../src/main/packaged-dependencies'

let currentStage = 'starting verification'
let failedStage: string | undefined

function stage(name: string) {
  currentStage = name
  // Synchronous stderr preserves the last phase even if a native module crashes.
  writeSync(2, `[Life runtime proof] ${name}\n`)
}

/**
 * This entry is bundled and shipped as a release-verification tool. It deliberately
 * runs with the packaged Electron executable in Node mode, so it cannot silently use
 * a system Node/npm/esbuild installation to hide a broken Windows package.
 */
async function run() {
  stage('verify packaged executable and resources')
  const startedAt = new Date().toISOString()
  const resources = resolve(process.argv[2] || '')
  const proofPath = process.argv[3] ? resolve(process.argv[3]) : undefined
  assert(process.argv[2], 'Pass the packaged resources directory')
  assert(process.versions.electron, 'Run this proof with the packaged Electron executable')
  const sourceDir = join(resources, 'life-source')
  const nodeModulesDir = join(resources, 'app.asar', 'node_modules')
  assert(
    existsSync(join(sourceDir, 'src', 'renderer', 'App.tsx')),
    'Packaged renderer source is missing',
  )
  assert(
    existsSync(join(nodeModulesDir, 'esbuild', 'lib', 'main.js')),
    'Bundled esbuild is missing',
  )
  assert(existsSync(join(nodeModulesDir, 'npm', 'bin', 'npm-cli.js')), 'Bundled npm is missing')
  // Spaces also exercise Windows npm/esbuild argument handling and junction paths.
  stage('create isolated source extension store')
  const directory = await mkdtemp(join(tmpdir(), 'life packaged source proof '))
  const compilerCache = join(directory, 'compiler-cache')
  const packagedDependencies = new PackagedDependencies({
    sourceDirectory: nodeModulesDir,
    manifestPath: join(resources, 'life-dependencies.json'),
    cacheDirectory: compilerCache,
  })
  const options = {
    sourceDir,
    nodeModulesDir,
    directory,
    prepareNodeModules: (signal: AbortSignal) => packagedDependencies.ensure(signal),
    compilerTimeoutMs: 90_000,
    installTimeoutMs: 180_000,
  }
  let store = new SourceCodeStore(options)
  const checks: string[] = []
  let assetDigest = ''
  try {
    stage('initialize source extension store')
    const initial = await store.init()
    assert.equal(initial.enabled, false)
    assert.equal(
      existsSync(compilerCache),
      false,
      'Startup eagerly extracted compiler dependencies',
    )
    checks.push('Source initialization keeps compiler dependencies archived until the first change')
    stage('read packaged renderer source')
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const main = context.files[0].content
    assert.equal(
      main.split('<App />').length,
      2,
      'The packaged renderer entry must contain the real app',
    )
    stage('compile initial source extension with npm dependencies and Tailwind')
    const active = await store.apply({
      summary: 'Verify packaged live React, npm, and Tailwind source customization',
      baseRevision: context.revision,
      dependencies: {
        clsx: '2.1.1',
        tailwindcss: '4.3.3',
        '@tailwindcss/postcss': '4.3.3',
        postcss: '8.5.29',
      },
      files: [
        {
          path: 'src/renderer/main.tsx',
          content: `import { RuntimeProof } from './RuntimeProof'\n${main.replace('<App />', '<App />\n    <RuntimeProof />')}`,
        },
        {
          path: 'src/renderer/RuntimeProof.tsx',
          content: `import { useState } from 'react'
import clsx from 'clsx'
import './RuntimeProof.css'
export function RuntimeProof() {
  const [selected, setSelected] = useState(false)
  return <section className={clsx('life-runtime-proof', selected && 'underline decoration-4')}>
    <span>Life packaged live source runtime proof</span>
    <button type="button" onClick={() => setSelected(value => !value)}>Toggle runtime proof</button>
  </section>
}
`,
        },
        {
          path: 'src/renderer/RuntimeProof.css',
          content: `@import "tailwindcss";
@theme { --color-runtime-proof: #123456; }
@source inline("underline decoration-4");
.life-runtime-proof { @apply grid gap-7 bg-runtime-proof; }
`,
        },
      ],
    })
    stage('export compiled source extension')
    assert.equal(
      existsSync(compilerCache),
      true,
      'Studio did not prepare its native compiler cache',
    )
    assert.equal(active.enabled, true)
    assert.equal(active.extensions.length, 1, 'The source change was not installed as an extension')
    const portable = await store.exportExtension(active.extensions[0].id)
    assert.equal(portable.format, 'life-source-extension')
    stage('verify compiled React bundle and generated Tailwind CSS')
    assert(active.active?.css, 'The committed generation has no CSS asset')
    const jsPath = store.assetPath(active.active.js)
    const cssPath = store.assetPath(active.active.css)
    assert(jsPath && cssPath, 'Committed protocol assets cannot be resolved')
    const [js, css] = await Promise.all([readFile(jsPath, 'utf8'), readFile(cssPath, 'utf8')])
    assert(
      js.includes('Life packaged live source runtime proof'),
      'The custom React component did not reach the bundle',
    )
    assert(css.includes('.life-runtime-proof'), 'The custom stylesheet did not reach the bundle')
    assert(
      /\.life-runtime-proof\{[^}]*display:grid/.test(css),
      'Tailwind @apply did not compile its grid utility',
    )
    assert(css.includes('#123456'), 'Tailwind @theme did not compile the custom color')
    assert(css.includes('.decoration-4'), 'Tailwind inline source utilities were not generated')
    assert(
      !/@(?:apply|theme|source)\b/.test(css),
      'Raw Tailwind directives escaped into the browser stylesheet',
    )
    assetDigest = createHash('sha256').update(js).update(css).digest('hex')
    checks.push(
      'Full packaged renderer compiled with a new React component and an npm-installed dependency',
    )
    checks.push(
      'Bundled Electron npm, native esbuild, isolated Tailwind PostCSS process, native scanner and dependency junction succeeded',
    )
    checks.push('Tailwind @theme, @apply and inline source utilities emitted real browser CSS')

    const beforeInvalid = store.get()
    stage('compile invalid source extension and verify atomic failure')
    await assert.rejects(
      store.apply({
        summary: 'Deliberately invalid proposal must preserve the active application',
        baseRevision: beforeInvalid.revision,
        files: [
          {
            path: 'src/renderer/RuntimeProof.tsx',
            content: 'export function RuntimeProof( { syntax is broken',
          },
        ],
      }),
      /Life source build failed/,
    )
    assert.equal(store.get().active?.js, beforeInvalid.active?.js)
    assert.equal(store.get().revision, beforeInvalid.revision)
    assert.equal(store.get().extensions.length, 1, 'A failed build saved a broken extension')
    assert.equal(await readFile(jsPath, 'utf8'), js)
    checks.push(
      'A failed compilation retained the previous active revision and its immutable assets',
    )

    stage('close store before restart')
    await store.close()
    store = new SourceCodeStore(options)
    stage('reopen store and verify persisted source extension')
    const reopened = await store.init()
    assert.equal(reopened.enabled, true, 'A clean restart disabled the committed customization')
    assert.equal(reopened.recovered, false)
    assert.equal(reopened.active?.js, active.active.js)
    const preserved = await store.getContext({ paths: ['src/renderer/RuntimeProof.tsx'] })
    assert(preserved.files[0].content.includes('Life packaged live source runtime proof'))
    checks.push('A clean store restart preserved the active source, dependency metadata and assets')

    stage('roll back source extension to built-in interface')
    const rolledBack = await store.rollback()
    assert.equal(rolledBack.enabled, false)
    assert.equal(rolledBack.active, undefined)
    checks.push('Rollback restored the built-in application')
    stage('import exported source extension and compile')
    const imported = await store.importExtension(portable)
    assert.equal(imported.enabled, true)
    assert.equal(imported.extensions[0].id, portable.id)
    checks.push(
      'An exported source extension installed independently from the built-in application',
    )
    stage('disable imported source extension')
    const disabled = await store.setExtensionEnabled(portable.id, false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.extensions[0].enabled, false)
    stage('enable imported source extension and compile')
    const reenabled = await store.setExtensionEnabled(portable.id, true)
    assert.equal(reenabled.enabled, true)
    assert.equal(reenabled.extensions[0].enabled, true)
    checks.push('Per-extension disable and enable recomposed the packaged interface')
    stage('remove source extension')
    const removed = await store.removeExtension(portable.id)
    assert.equal(removed.enabled, false)
    assert.equal(removed.extensions.length, 0)
    stage('close store after source extension removal')
    await store.close()
    store = new SourceCodeStore(options)
    stage('reopen store and verify persisted source extension removal')
    const afterRemoval = await store.init()
    assert.equal(afterRemoval.enabled, false)
    assert.equal(afterRemoval.extensions.length, 0)
    checks.push('Extension removal restored the built-in interface and persisted across restart')
  } catch (error) {
    failedStage = currentStage
    throw error
  } finally {
    stage('close source extension store for cleanup')
    await store.close()
    stage('remove isolated source extension store')
    await rm(directory, { recursive: true, force: true })
  }
  const proof = {
    ok: true,
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    executable: process.execPath,
    resources,
    startedAt,
    finishedAt: new Date().toISOString(),
    assetDigest,
    checks,
  }
  stage('write completed runtime proof')
  if (proofPath) {
    await mkdir(dirname(proofPath), { recursive: true })
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8')
  }
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
}

run().catch((error) => {
  writeSync(2, `[Life runtime proof] FAILED during ${failedStage || currentStage}\n`)
  process.stderr.write(
    (error instanceof Error ? error.stack || error.message : String(error)) + '\n',
  )
  process.exitCode = 1
})
