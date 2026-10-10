import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as {
  load: (input: string) => Record<string, any>
  dump: (input: unknown) => string
}
const { prepareRelease } = require('../scripts/prepare-release.cjs') as {
  prepareRelease: (artifacts: string, output: string, version: string) => Promise<string[]>
}

const version = '0.10.0'
const platforms = {
  'linux-x64': ['linux-x86_64.AppImage', 'linux-amd64.deb'],
  'windows-x64': ['win-x64.exe', 'win-x64.exe.blockmap'],
  'macos-arm64': ['mac-arm64.dmg', 'mac-arm64.dmg.blockmap'],
  'macos-x64': ['mac-x64.dmg', 'mac-x64.dmg.blockmap'],
}

describe('release artifact assembly', () => {
  let root: string
  let artifacts: string
  let output: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'life-release-assets-'))
    artifacts = join(root, 'artifacts')
    output = join(root, 'installers')
    for (const [platform, suffixes] of Object.entries(platforms)) {
      const directory = join(artifacts, `life-${platform}`)
      await mkdir(directory, { recursive: true })
      const files = []
      for (const suffix of suffixes) {
        const name = `Life-${version}-${suffix}`
        const content = Buffer.from(`packaged-${name}`)
        await writeFile(join(directory, name), content)
        if (!suffix.endsWith('.blockmap')) {
          files.push({
            url: name,
            sha512: createHash('sha512').update(content).digest('base64'),
            size: content.length,
          })
        }
      }
      await writeFile(
        join(directory, metadataName(platform)),
        yaml.dump({
          version,
          files,
          path: files[0].url,
          sha512: files[0].sha512,
          releaseDate:
            platform === 'macos-arm64' ? '2026-10-10T06:01:00.000Z' : '2026-10-10T06:00:00.000Z',
        }),
      )
    }
  })

  afterEach(async () => rm(root, { recursive: true, force: true }))

  function metadataName(platform: string) {
    if (platform === 'linux-x64') return 'latest-linux.yml'
    if (platform === 'windows-x64') return 'latest.yml'
    return 'latest-mac.yml'
  }

  async function changeMetadata(platform: string, change: (value: Record<string, any>) => void) {
    const file = join(artifacts, `life-${platform}`, metadataName(platform))
    const info = yaml.load(await readFile(file, 'utf8'))
    change(info)
    await writeFile(file, yaml.dump(info))
  }

  it('publishes both macOS architectures without overwriting updater metadata', async () => {
    await mkdir(join(artifacts, 'life-windows-upgrade-proof'), { recursive: true })
    await writeFile(join(artifacts, 'life-windows-upgrade-proof', 'unrelated.json'), '{}')
    const assets = await prepareRelease(artifacts, output, version)
    const mac = yaml.load(await readFile(join(output, 'latest-mac.yml'), 'utf8'))
    expect(mac.files.map((file: { url: string }) => file.url)).toEqual([
      'Life-0.10.0-mac-arm64.dmg',
      'Life-0.10.0-mac-x64.dmg',
    ])
    expect(mac.path).toBe('Life-0.10.0-mac-x64.dmg')
    expect(mac.sha512).toBe(mac.files[1].sha512)
    expect(mac.releaseDate).toBe('2026-10-10T06:01:00.000Z')
    expect(assets).toHaveLength(11)
    expect((await readdir(output)).sort()).toEqual(assets)
    expect(await readFile(join(output, 'Life-0.10.0-win-x64.exe'), 'utf8')).toBe(
      'packaged-Life-0.10.0-win-x64.exe',
    )
  })

  it('rejects a tampered installer even when its byte length is unchanged', async () => {
    const installer = join(artifacts, 'life-windows-x64', 'Life-0.10.0-win-x64.exe')
    const content = await readFile(installer)
    content[0] ^= 1
    await writeFile(installer, content)
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow('SHA-512 checksum')
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an installer that disagrees with the metadata size', async () => {
    await changeMetadata('linux-x64', (info) => info.files[0].size++)
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow('advertised size')
  })

  it('rejects missing architectures and version mismatches before publication', async () => {
    await changeMetadata('macos-arm64', (info) => (info.version = '0.9.0'))
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow(
      'must describe Life 0.10.0',
    )
    await changeMetadata('macos-arm64', (info) => {
      info.version = version
      info.files = []
    })
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow(
      'contains no installers',
    )
  })

  it('rejects references outside the expected platform installer list', async () => {
    await changeMetadata('windows-x64', (info) => (info.files[0].url = '../unexpected.exe'))
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow('unexpected')
  })

  it('rejects conflicting macOS rollout metadata rather than silently choosing an architecture', async () => {
    await changeMetadata('macos-arm64', (info) => (info.stagingPercentage = 20))
    await changeMetadata('macos-x64', (info) => (info.stagingPercentage = 100))
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow(
      'disagree on updater field',
    )
  })

  it('rejects inconsistent legacy updater fields', async () => {
    await changeMetadata('windows-x64', (info) => (info.sha512 = 'wrong-checksum'))
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow(
      'legacy updater fields',
    )
  })

  it('refuses stale output and invalid release versions', async () => {
    await expect(prepareRelease(artifacts, output, 'v0.10.0')).rejects.toThrow(
      'three-part release version',
    )
    await mkdir(output)
    await writeFile(join(output, 'old-installer.exe'), 'previous build')
    await expect(prepareRelease(artifacts, output, version)).rejects.toThrow('must be empty')
  })
})
