const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const yaml = require('js-yaml')

const platforms = {
  'linux-x64': {
    installers: ['linux-x86_64.AppImage', 'linux-amd64.deb'],
    metadata: 'latest-linux.yml',
  },
  'windows-x64': { installers: ['win-x64.exe', 'win-x64.exe.blockmap'], metadata: 'latest.yml' },
  'macos-arm64': {
    installers: ['mac-arm64.dmg', 'mac-arm64.dmg.blockmap'],
    metadata: 'latest-mac.yml',
  },
  'macos-x64': { installers: ['mac-x64.dmg', 'mac-x64.dmg.blockmap'], metadata: 'latest-mac.yml' },
}

async function sha512(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

async function readMetadata(directory, metadataName, version, installers) {
  const metadata = yaml.load(await fs.readFile(path.join(directory, metadataName), 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  })
  if (!metadata || metadata.version !== version || !Array.isArray(metadata.files)) {
    throw new Error(`${metadataName} must describe Life ${version} with an installer file list.`)
  }
  const seen = new Set()
  for (const file of metadata.files) {
    if (!file || !installers.includes(file.url) || seen.has(file.url)) {
      throw new Error(`${metadataName} contains a missing, unexpected, or duplicate installer.`)
    }
    seen.add(file.url)
    const installer = path.join(directory, file.url)
    const stat = await fs.stat(installer)
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== stat.size) {
      throw new Error(`${file.url} does not match its advertised size.`)
    }
    if (typeof file.sha512 !== 'string' || file.sha512 !== (await sha512(installer))) {
      throw new Error(`${file.url} does not match its advertised SHA-512 checksum.`)
    }
  }
  if (!metadata.files.length) throw new Error(`${metadataName} contains no installers.`)
  const required = installers.filter((name) => !name.endsWith('.blockmap'))
  if (required.some((name) => !seen.has(name))) {
    throw new Error(`${metadataName} omits a required installer.`)
  }
  if (metadata.path !== undefined || metadata.sha512 !== undefined) {
    const legacyFile = metadata.files.find((file) => file.url === metadata.path)
    if (!legacyFile || legacyFile.sha512 !== metadata.sha512) {
      throw new Error(`${metadataName} has inconsistent legacy updater fields.`)
    }
  }
  if (!Number.isFinite(Date.parse(metadata.releaseDate))) {
    throw new Error(`${metadataName} has no valid release date.`)
  }
  return metadata
}

function mergeMacMetadata(arm, intel) {
  const merged = { ...intel }
  const architectureFields = new Set(['files', 'path', 'sha512', 'releaseDate'])
  for (const field of new Set([...Object.keys(arm), ...Object.keys(intel)])) {
    if (
      !architectureFields.has(field) &&
      JSON.stringify(arm[field]) !== JSON.stringify(intel[field])
    ) {
      throw new Error(`macOS builds disagree on updater field ${field}.`)
    }
  }
  merged.files = [...arm.files, ...intel.files].sort((a, b) => a.url.localeCompare(b.url))
  merged.releaseDate = new Date(
    Math.max(Date.parse(arm.releaseDate), Date.parse(intel.releaseDate)),
  ).toISOString()
  return merged
}

async function prepareRelease(artifactsPath, outputPath, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('A stable three-part release version is required.')
  }
  const artifacts = path.resolve(artifactsPath)
  const output = path.resolve(outputPath)
  if (output === artifacts || output.startsWith(`${artifacts}${path.sep}`)) {
    throw new Error('Release output must be separate from the downloaded artifacts.')
  }
  const existing = await fs.readdir(output).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (existing.length) throw new Error('Release output must be empty to prevent stale assets.')
  const copies = []
  const metadata = new Map()
  for (const [platform, config] of Object.entries(platforms)) {
    const directory = path.join(artifacts, `life-${platform}`)
    const installers = config.installers.map((suffix) => `Life-${version}-${suffix}`)
    for (const name of installers) {
      const stat = await fs.lstat(path.join(directory, name))
      if (!stat.isFile() || stat.size <= 0)
        throw new Error(`${name} is not a nonempty installer asset.`)
      copies.push({ source: path.join(directory, name), name })
    }
    metadata.set(platform, await readMetadata(directory, config.metadata, version, installers))
  }
  const combined = {
    'latest-linux.yml': metadata.get('linux-x64'),
    'latest.yml': metadata.get('windows-x64'),
    'latest-mac.yml': mergeMacMetadata(metadata.get('macos-arm64'), metadata.get('macos-x64')),
  }
  // Validate all inputs before creating publishable files. Keeping each platform's
  // artifact directory separate prevents a matrix download from overwriting YAML.
  await fs.mkdir(output, { recursive: true })
  for (const { source, name } of copies) await fs.copyFile(source, path.join(output, name))
  for (const [name, info] of Object.entries(combined)) {
    await fs.writeFile(path.join(output, name), yaml.dump(info, { lineWidth: -1, noRefs: true }))
  }
  return [...copies.map(({ name }) => name), ...Object.keys(combined)].sort()
}

module.exports = { prepareRelease }

if (require.main === module) {
  const [artifacts, output, version] = process.argv.slice(2)
  if (!artifacts || !output || !version) {
    console.error('Usage: node scripts/prepare-release.cjs <artifacts> <output> <version>')
    process.exitCode = 1
  } else {
    prepareRelease(artifacts, output, version)
      .then((assets) =>
        console.log(`Validated ${assets.length} release assets for Life ${version}.`),
      )
      .catch((error) => {
        console.error(error.message)
        process.exitCode = 1
      })
  }
}
