const { createHash } = require('node:crypto')
const { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

async function main() {
  const root = resolve(__dirname, '..')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable release version is required')
  await stat(join(root, 'dist-web/index.html'))
  await stat(join(root, 'out/web/server.cjs'))
  const output = join(root, 'release/web')
  await mkdir(output, { recursive: true })
  const staging = await mkdtemp(join(tmpdir(), 'life-web-release-'))
  const name = `Life-${version}-web`
  const bundle = join(staging, name)
  try {
    await mkdir(bundle)
    // An explicit list keeps local Research, histories, credentials, and backups
    // out of the release even when packaging a working checkout.
    for (const path of [
      'src',
      'scripts',
      'tests',
      'docs',
      'build',
      'dist-web',
      'out/web',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'vite.web.config.ts',
      'electron.vite.config.ts',
      'vitest.config.ts',
      'README.md',
      '.gitignore',
    ]) {
      await cp(join(root, path), join(bundle, path), { recursive: true })
    }
    const archives = [`${name}.tar.gz`, `${name}.zip`]
    for (const archive of archives) await rm(join(output, archive), { force: true })
    execFileSync('tar', ['-czf', join(output, archives[0]), '-C', staging, name])
    execFileSync('zip', ['-q', '-r', join(output, archives[1]), name], { cwd: staging })
    const checksums = await Promise.all(
      archives.map(async (archive) => {
        const data = await readFile(join(output, archive))
        return `${createHash('sha256').update(data).digest('hex')}  ${archive}`
      }),
    )
    await writeFile(join(output, 'SHA256SUMS-web.txt'), checksums.join('\n') + '\n')
    console.log(`Packaged Life ${version} web app in ${output}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
