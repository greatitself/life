#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')

async function run() {
  const repository = resolve(__dirname, '..')
  const executable = resolve(process.env.LIFE_ELECTRON_BINARY || require('electron'))
  const packagedSource = join(dirname(executable), 'resources/life-source/src')
  const sourceRoot = resolve(
    process.env.LIFE_HELPER_SOURCE_ROOT ||
      (existsSync(packagedSource)
        ? packagedSource
        : join(process.env.LIFE_TEST_APP_PATH || repository, 'src')),
  )
  const artifacts = resolve(
    repository,
    process.env.LIFE_TEST_ARTIFACTS_DIR || 'output/playwright/local-owned-helpers-native',
  )
  await mkdir(artifacts, { recursive: true })
  const entry = join(artifacts, 'fixture-entry.cjs')
  const sources = [
    'main/studio-context.ts',
    'main/agent-attachments.ts',
    'main/agent-history.ts',
    'main/local-owned-runtime.ts',
    'main/ssh.ts',
    'main/local-transport.ts',
    'main/local-files.ts',
    'main/store.ts',
  ]
  const hashes = async () =>
    Promise.all(
      sources.map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(sourceRoot, path)))
          .digest('hex'),
      })),
    )
  const before = await hashes()
  await build({
    entryPoints: [join(repository, 'tests/local-owned-helpers-native.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    plugins: [
      {
        name: 'selected-life-source',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\// }, ({ path }) => ({
            path: join(sourceRoot, path.slice('../src/'.length) + '.ts'),
          }))
        },
      },
    ],
  })
  const child = spawn(executable, [entry, join(artifacts, 'proof.json')], {
    cwd: repository,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const after = await hashes()
  assert.deepEqual(
    after,
    before,
    'Production source must remain frozen throughout this native proof',
  )
  const manifest = {
    executable,
    sourceRoot,
    sourceInputs: before,
    entrySha256: createHash('sha256')
      .update(await readFile(entry))
      .digest('hex'),
    code,
  }
  await writeFile(join(artifacts, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  assert.equal(code, 0, 'Native helper fixture must complete successfully')
  const proof = JSON.parse(await readFile(join(artifacts, 'proof.json'), 'utf8'))
  assert.equal(proof.passed, true)
  assert.equal(proof.inferenceRequests, 0)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
