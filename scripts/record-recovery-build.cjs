#!/usr/bin/env node
// Root integration proposal only. Capture immediately before the frozen build;
// seal immediately after packaging, before either executable compatibility gate.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstat, mkdir, readFile, readdir, writeFile } = require('node:fs/promises')
const { dirname, join, relative, resolve, sep } = require('node:path')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const repository = process.cwd()

async function inventory(root) {
  const entries = []
  async function visit(path) {
    const info = await lstat(path)
    assert(!info.isSymbolicLink(), `Build provenance refuses source/output links: ${path}`)
    const name = relative(root, path).split(sep).join('/') || '.'
    if (info.isDirectory()) {
      entries.push({ path: name, type: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else {
      assert(info.isFile())
      const bytes = await readFile(path)
      entries.push({ path: name, type: 'file', size: bytes.length, sha256: hash(bytes) })
    }
  }
  await visit(root)
  return entries
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

async function run() {
  const [operation, beforePath, executablePath, manifestPath] = process.argv.slice(2)
  assert(
    ['capture-source', 'seal'].includes(operation),
    'Use capture-source <before.json> or seal <before.json> <executable> <manifest.json>',
  )
  assert(beforePath)
  const source = (await inventory(join(repository, 'src'))).filter((entry) => entry.type === 'file')
  if (operation === 'capture-source') {
    await save(resolve(beforePath), { platform: process.platform, sourceBefore: source })
    return
  }
  assert(executablePath && manifestPath)
  const before = JSON.parse(await readFile(resolve(beforePath), 'utf8'))
  assert.equal(before.platform, process.platform, 'Build/package must occur on the same platform')
  assert.deepEqual(before.sourceBefore, source, 'Source changed during the exact build/package')
  const executable = resolve(executablePath)
  const resources =
    process.platform === 'darwin'
      ? resolve(dirname(executable), '..', 'Resources')
      : join(dirname(executable), 'resources')
  await save(resolve(manifestPath), {
    format: 'life-recovery-release-build',
    version: 1,
    platform: process.platform,
    sourceBefore: before.sourceBefore,
    sourceAfter: source,
    compiled: await inventory(join(repository, 'out')),
    package: {
      executableSha256: hash(await readFile(executable)),
      asarSha256: hash(await readFile(join(resources, 'app.asar'))),
    },
  })
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
