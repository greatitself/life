import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { prepareMacPtyHelpers } = require('../scripts/package-dependencies.cjs') as {
  prepareMacPtyHelpers(resources: string): Promise<void>
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('packaged macOS PTY helpers', () => {
  it('repairs both prebuilt helpers before they enter the executable dependency manifest', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'life-pty-packaging-'))
    roots.push(resources)
    const helpers = ['darwin-arm64', 'darwin-x64'].map((architecture) =>
      join(
        resources,
        'app.asar.unpacked/node_modules/node-pty/prebuilds',
        architecture,
        'spawn-helper',
      ),
    )
    for (const helper of helpers) {
      await mkdir(join(helper, '..'), { recursive: true })
      await writeFile(helper, 'native helper bytes', { mode: 0o644 })
      expect((await stat(helper)).mode & 0o111).toBe(0)
    }
    await prepareMacPtyHelpers(resources)
    for (const helper of helpers) {
      expect((await stat(helper)).mode & 0o777).toBe(0o755)
      expect(await readFile(helper, 'utf8')).toBe('native helper bytes')
    }
    await prepareMacPtyHelpers(resources)
    expect((await stat(helpers[0])).mode & 0o777).toBe(0o755)
  })

  it('supports a source-built helper without requiring unused prebuilt architectures', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'life-pty-packaging-'))
    roots.push(resources)
    const helper = join(
      resources,
      'app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper',
    )
    await mkdir(join(helper, '..'), { recursive: true })
    await writeFile(helper, 'compiled helper', { mode: 0o644 })
    await expect(prepareMacPtyHelpers(resources)).resolves.toBeUndefined()
    expect((await stat(helper)).mode & 0o777).toBe(0o755)
  })

  it('does not conceal invalid extracted helper paths', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'life-pty-packaging-'))
    roots.push(resources)
    const blocker = join(resources, 'app.asar.unpacked/node_modules/node-pty')
    await mkdir(join(blocker, '..'), { recursive: true })
    await writeFile(blocker, 'not a directory')
    await expect(prepareMacPtyHelpers(resources)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
