import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SourceCodeStore } from '../src/main/source-code'

/**
 * This entry is bundled and shipped as a release-verification tool. It deliberately
 * runs with the packaged Electron executable in Node mode, so it cannot silently use
 * a system Node/npm/esbuild installation to hide a broken Windows package.
 */
async function run() {
  const startedAt = new Date().toISOString()
  const resources = resolve(process.argv[2] || '')
  const proofPath = process.argv[3] ? resolve(process.argv[3]) : undefined
  assert(process.argv[2], 'Pass the packaged resources directory')
  assert(process.versions.electron, 'Run this proof with the packaged Electron executable')
  const sourceDir = join(resources, 'life-source')
  const nodeModulesDir = join(resources, 'app.asar.unpacked', 'node_modules')
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
  const directory = await mkdtemp(join(tmpdir(), 'life packaged source proof '))
  const options = {
    sourceDir,
    nodeModulesDir,
    directory,
    compilerTimeoutMs: 90_000,
    installTimeoutMs: 180_000,
  }
  let store = new SourceCodeStore(options)
  const checks: string[] = []
  let assetDigest = ''
  try {
    const initial = await store.init()
    assert.equal(initial.enabled, false)
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const main = context.files[0].content
    assert.equal(
      main.split('<App />').length,
      2,
      'The packaged renderer entry must contain the real app',
    )
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
    assert.equal(active.enabled, true)
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
      'Bundled Electron npm, native esbuild, Tailwind PostCSS worker, native scanner and dependency junction succeeded',
    )
    checks.push('Tailwind @theme, @apply and inline source utilities emitted real browser CSS')

    const beforeInvalid = store.get()
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
    assert.equal(await readFile(jsPath, 'utf8'), js)
    checks.push(
      'A failed compilation retained the previous active revision and its immutable assets',
    )

    await store.close()
    store = new SourceCodeStore(options)
    const reopened = await store.init()
    assert.equal(reopened.enabled, true, 'A clean restart disabled the committed customization')
    assert.equal(reopened.recovered, false)
    assert.equal(reopened.active?.js, active.active.js)
    const preserved = await store.getContext({ paths: ['src/renderer/RuntimeProof.tsx'] })
    assert(preserved.files[0].content.includes('Life packaged live source runtime proof'))
    checks.push('A clean store restart preserved the active source, dependency metadata and assets')

    const rolledBack = await store.rollback()
    assert.equal(rolledBack.enabled, false)
    assert.equal(rolledBack.active, undefined)
    checks.push('Rollback restored the built-in application')
  } finally {
    await store.close()
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
  if (proofPath) {
    await mkdir(dirname(proofPath), { recursive: true })
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8')
  }
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
}

run().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.stack || error.message : String(error)) + '\n',
  )
  process.exitCode = 1
})
