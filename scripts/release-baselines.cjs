const fs = require('node:fs')

const knownVersions = ['0.1.0', '0.5.1', '0.6.0', '0.7.0', '0.8.0', '0.9.0', '0.10.0', '0.11.0']

function releaseBaselines(targetVersion) {
  if (typeof targetVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    throw new Error('Windows upgrade target must be a stable three-part version.')
  }
  const target = targetVersion.split('.').map(Number)
  if (!target.every(Number.isSafeInteger))
    throw new Error('Invalid Windows upgrade target version.')
  const preceding = knownVersions.filter((version) => {
    const candidate = version.split('.').map(Number)
    for (let index = 0; index < target.length; index++) {
      if (candidate[index] !== target[index]) return candidate[index] < target[index]
    }
    return false
  })
  preceding.sort((left, right) => {
    const a = left.split('.').map(Number)
    const b = right.split('.').map(Number)
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return a[index] - b[index]
    }
    return 0
  })
  return preceding.slice(-1)
}

module.exports = { releaseBaselines }

if (require.main === module) {
  try {
    const packagePath = process.argv[2]
    if (!packagePath) throw new Error('Usage: node scripts/release-baselines.cjs <package.json>')
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
    console.log(`windows_baselines=${JSON.stringify(releaseBaselines(version))}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
