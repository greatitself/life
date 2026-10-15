const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstat, readdir, readFile, readlink, realpath } = require('node:fs/promises')
const { join, relative, resolve } = require('node:path')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function walk(root, directory = '', dependencies = false) {
  const path = join(root, directory)
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    assert.ok(dependencies, 'Application source and output contain no undeclared symlinks')
    assert.notEqual(relative(root, await realpath(path)).split('/')[0], '..')
    return [
      { path: directory, kind: 'symlink', mode: info.mode & 0o7777, target: await readlink(path) },
    ]
  }
  if (info.isFile())
    return [
      {
        path: directory,
        kind: 'file',
        mode: info.mode & 0o7777,
        bytes: info.size,
        sha256: sha256(await readFile(path)),
      },
    ]
  assert.ok(info.isDirectory())
  const entries = [{ path: directory, kind: 'directory', mode: info.mode & 0o7777 }]
  for (const name of (await readdir(path)).sort()) {
    if (
      dependencies &&
      !directory &&
      (name === '.cache' || name === '.vite' || name.startsWith('.vite-'))
    )
      continue
    entries.push(...(await walk(root, directory ? join(directory, name) : name, dependencies)))
  }
  return entries
}
async function application(root) {
  const entries = []
  const names = (await readdir(root)).filter((name) => name !== 'node_modules').sort()
  for (const name of names) entries.push(...(await walk(root, name)))
  const source = entries.filter((entry) => entry.path !== 'out' && !entry.path.startsWith('out/'))
  const output = entries.filter((entry) => entry.path === 'out' || entry.path.startsWith('out/'))
  return {
    root: resolve(root),
    sourceGraphSha256: sha256(JSON.stringify(source)),
    outGraphSha256: sha256(JSON.stringify(output)),
    entries,
    declaredDependencyRoot: await realpath(join(root, 'node_modules')),
  }
}
async function runtime(repository, apps) {
  const root = await realpath(join(repository, 'node_modules'))
  for (const app of apps)
    assert.equal(
      await realpath(join(app, 'node_modules')),
      root,
      'Both exact app runs use the same fingerprinted current installed dependency bytes',
    )
  const entries = await walk(root, '', true)
  const electron = require('electron')
  return {
    root,
    graphSha256: sha256(JSON.stringify(entries)),
    entries,
    excludedDevelopmentCaches: ['.cache', '.vite', '.vite-*'],
    electron: {
      path: electron,
      version: require('electron/package.json').version,
      sha256: sha256(await readFile(electron)),
    },
    node: {
      path: process.execPath,
      version: process.version,
      sha256: sha256(await readFile(process.execPath)),
    },
  }
}
async function files(paths) {
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(path)) })))
}
module.exports = { sha256, walk, application, runtime, files }
