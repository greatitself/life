#!/usr/bin/env node
// Drive the production Studio hook in Chromium. Relay is a deterministic native stand-in;
// this does not authenticate, launch providers, or claim full native recovery verification.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { build } = require('./helpers/browser-build.cjs')
const {
  fixtureSource,
  initializeNativeFixture,
} = require('./helpers/studio-native-recovery-fixture.cjs')

async function sourceManifest(repository) {
  const paths = [
    'package.json',
    'package-lock.json',
    'tests/studio-native-recovery-hook-smoke.cjs',
    'tests/helpers/studio-native-recovery-fixture.cjs',
    'tests/helpers/studio-native-recovery-browser.py',
    'tests/helpers/browser-build.cjs',
    'src/main/inline-worker-plugin.ts',
  ]
  const pending = ['src/renderer', 'src/shared']
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      const name = directory + '/' + entry.name
      if (entry.isDirectory()) pending.push(name)
      else if (entry.isFile()) paths.push(name)
    }
  }
  return Promise.all(
    paths.sort().map(async (name) => ({
      path: name,
      sha256: createHash('sha256')
        .update(await readFile(join(repository, name)))
        .digest('hex'),
    })),
  )
}

async function run() {
  const repository = resolve(__dirname, '..')
  const output = resolve(
    process.env.LIFE_STUDIO_NATIVE_OUTPUT ||
      join(repository, 'output/playwright/studio-native-recovery-hook'),
  )
  const temporary = await mkdtemp(join(tmpdir(), 'life-studio-native-recovery-'))
  let server
  try {
    await mkdir(output, { recursive: true })
    const before = await sourceManifest(repository)
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: repository,
        sourcefile: 'studio-native-recovery-hook-fixture.tsx',
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      outfile: join(temporary, 'fixture.js'),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    await writeFile(join(temporary, 'initialize.js'), `(${initializeNativeFixture.toString()})()`)
    server = createServer(async (request, response) => {
      if (request.url === '/fixture.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(join(temporary, 'fixture.js')))
      } else {
        response.setHeader('Content-Type', 'text/html')
        response.end(
          '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        )
      }
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const child = spawn(
      'python3',
      [
        join(__dirname, 'helpers/studio-native-recovery-browser.py'),
        `http://127.0.0.1:${server.address().port}`,
        join(temporary, 'initialize.js'),
        output,
      ],
      {
        cwd: repository,
        stdio: 'inherit',
        env: process.env,
      },
    )
    const exitCode = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', done)
    })
    const after = await sourceManifest(repository)
    await writeFile(join(output, 'source-inputs.json'), JSON.stringify({ before, after }, null, 2))
    assert.deepEqual(
      after,
      before,
      'Production source must remain frozen during this browser fixture',
    )
    assert.equal(exitCode, 0, 'The actual Studio recovery hook browser checks must pass')
  } finally {
    if (server) await new Promise((closed) => server.close(closed))
    await rm(temporary, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
