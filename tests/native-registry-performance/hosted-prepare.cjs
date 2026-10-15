const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

assert.equal(process.platform, 'linux')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run the benchmark on an isolated hosted runner')
const repository = process.env.GITHUB_WORKSPACE
assert(repository)
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline-manifest.json')))
const archive = path.join(__dirname, 'baseline-streaming-checkpoints-9142998.tar.gz')
assert.equal(sha256(fs.readFileSync(archive)), manifest.archiveSha256)
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
assert.deepEqual(members.sort(), manifest.files.map((entry) => entry.path).sort())
assert(members.every((name) => !path.isAbsolute(name) && !name.split('/').includes('..')))
const output = path.join(repository, 'output/native-registry-performance')
const baseline = path.join(repository, 'output/immutable-app/performance-baseline')
const candidate = path.join(repository, 'output/immutable-app/performance-candidate')
assert(!fs.existsSync(baseline) && !fs.existsSync(candidate))
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(baseline, { recursive: true, mode: 0o700 })
fs.mkdirSync(candidate, { recursive: true, mode: 0o700 })
execFileSync('tar', ['-xzf', archive, '--no-same-owner', '-C', baseline])
for (const entry of manifest.files) {
  const file = path.join(baseline, entry.path)
  const info = fs.lstatSync(file)
  assert(info.isFile() && !info.isSymbolicLink())
  assert.equal(info.size, entry.bytes)
  assert.equal(info.mode & 0o7777, entry.mode)
  assert.equal(sha256(fs.readFileSync(file)), entry.sha256)
}
for (const name of [
  'AGENTS.md',
  'CLAUDE.md',
  'build',
  'out',
  'package-lock.json',
  'package.json',
  'scripts',
  'src',
])
  fs.cpSync(path.join(repository, name), path.join(candidate, name), { recursive: true })
for (const app of [baseline, candidate])
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(app, 'node_modules'), 'dir')
const benchmarkCheckout = path.resolve(__dirname, '../..')
fs.symlinkSync(
  path.join(repository, 'node_modules'),
  path.join(benchmarkCheckout, 'node_modules'),
  'dir',
)
const inputPaths = [
  ...[
    'provider.cjs',
    'probes.cjs',
    'identity.cjs',
    'run-paired.cjs',
    'plan.json',
    'hosted-prepare.cjs',
    'preparation-original.json',
    'baseline-manifest.json',
    'ssh-fixture.cjs',
  ].map((name) => path.join(__dirname, name)),
  ...['active-session-recovery-steps.cjs', 'desktop-history.cjs', 'ssh-fixture.ts'].map((name) =>
    path.join(__dirname, 'harness', name),
  ),
  path.join(repository, 'package-lock.json'),
]
fs.writeFileSync(
  path.join(__dirname, 'preparation-manifest.json'),
  JSON.stringify(
    {
      format: 'life-hosted-native-performance-preparation',
      scope:
        'Portable path adapters for the existing prepared benchmark; exact old application bytes and common current dependencies; no performance result yet',
      originalPreparationSha256: sha256(
        fs.readFileSync(path.join(__dirname, 'preparation-original.json')),
      ),
      baselineArchiveSha256: manifest.archiveSha256,
      inputs: inputPaths.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(file)) })),
    },
    null,
    2,
  ) + '\n',
)
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
}).trim()
const now = Date.now()
const lease = {
  rootQuietLeaseId: `hosted-exclusive-${process.env.GITHUB_RUN_ID}`,
  parentGoId: `release-closure-${sourceCommit}`,
  candidatePath: candidate,
  fixtureSha256: sha256(fs.readFileSync(path.join(__dirname, 'run-paired.cjs'))),
  validFrom: new Date(now - 1000).toISOString(),
  validUntil: new Date(now + 65 * 60 * 1000).toISOString(),
}
fs.writeFileSync(path.join(output, 'quiet-lease.json'), JSON.stringify(lease, null, 2) + '\n')
fs.writeFileSync(
  path.join(output, 'hosted-preparation.json'),
  JSON.stringify(
    {
      sourceCommit,
      baseline,
      candidate,
      archiveSha256: manifest.archiveSha256,
      originalIdentity: manifest.originalIdentity,
      fixtureSha256: lease.fixtureSha256,
      scope:
        'One dedicated hosted job, sequential ABBA samples; no authenticated inference or local machine benchmark',
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ sourceCommit, baseline, candidate, prepared: true }))
