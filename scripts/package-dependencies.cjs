/** Build a content-addressed manifest from the exact target-platform ASAR payload. */
const { createHash } = require('node:crypto')
const { stat, writeFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { join } = require('node:path')

module.exports = async function packageDependencies(context) {
  const builderRequire = createRequire(require.resolve('app-builder-lib'))
  const asar = await import(builderRequire.resolve('@electron/asar'))
  const resources = context.packager.getResourcesDir(context.appOutDir)
  const archive = join(resources, 'app.asar')
  const files = []
  for (const listed of asar.listPackage(archive)) {
    const name = listed.replace(/^[/\\]/, '').replaceAll('\\', '/')
    if (!name.startsWith('node_modules/')) continue
    const entry = asar.statFile(archive, name, true)
    if (entry.files || entry.size === undefined) continue
    // ASAR records the executable flag only for packed files; native binaries are
    // deliberately unpacked, so preserve their actual target-platform file mode.
    const executable =
      entry.executable ||
      (entry.unpacked && Boolean((await stat(join(`${archive}.unpacked`, name))).mode & 0o111))
    files.push({
      path: name.slice('node_modules/'.length),
      size: entry.size,
      sha256:
        entry.integrity?.algorithm === 'SHA256'
          ? entry.integrity.hash
          : createHash('sha256').update(asar.extractFile(archive, name)).digest('hex'),
      ...(executable ? { executable: true } : {}),
    })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!files.some((file) => file.path === 'npm/bin/npm-cli.js'))
    throw new Error('Packaged npm is missing from the compiler payload')
  if (!files.some((file) => file.path === 'esbuild/lib/main.js'))
    throw new Error('Packaged esbuild is missing from the compiler payload')
  if (!files.some((file) => /^@esbuild\/[^/]+\/(?:bin\/esbuild|esbuild\.exe)$/.test(file.path)))
    throw new Error('The target-platform esbuild executable is missing from the compiler payload')
  const key = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  await writeFile(
    join(resources, 'life-dependencies.json'),
    JSON.stringify({ format: 1, key, files }),
    'utf8',
  )
  console.log(
    `  • compiler dependencies archived: ${files.length} files, cache ${key.slice(0, 12)}`,
  )
}
