#!/usr/bin/env node
// Metadata and reporting only. The measured fixtures remain separate programs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const repository = path.resolve(__dirname, '../..')
const baseline = path.join(repository, '.center-right-baseline')
const output = path.join(repository, 'output/thread-feedback/center-right')
const baselineCommit = '2c16b519670eb8e40c05b87b6cab2de61ff8eb49'
const order = ['t3-ref-a', 't3-current-a', 't3-current-b', 't3-ref-b']
const fixtures = [
  'tests/transcript-performance.cjs',
  'tests/workspace-surfaces-performance.cjs',
  'tests/app-live-controls-smoke.cjs',
]
const sharedFiles = [
  'package.json',
  'package-lock.json',
  'tests/helpers/browser-build.cjs',
  'tests/helpers/app-workflow-fixture.cjs',
  'src/main/inline-worker-plugin.ts',
]
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (directory, ...args) =>
  execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

function requireProductionSourceUnchanged() {
  assert.equal(
    git(baseline, 'status', '--porcelain', '--untracked-files=all', '--', 'src'),
    '',
    'The pinned baseline production source must remain unchanged',
  )
}

function prepare() {
  fs.mkdirSync(output, { recursive: true })
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), baselineCommit)
  requireProductionSourceUnchanged()
  const shared = sharedFiles.map((file) => {
    const candidateSha256 = hash(path.join(repository, file))
    assert.equal(hash(path.join(baseline, file)), candidateSha256, 'Shared file differs: ' + file)
    return { path: file, sha256: candidateSha256 }
  })
  const overlays = fixtures.map((file) => {
    assert(file.startsWith('tests/'), 'Only test fixture overlays are permitted')
    const candidateFile = path.join(repository, file)
    const baselineFile = path.join(baseline, file)
    const originalBaselineSha256 = hash(baselineFile)
    const candidateSha256 = hash(candidateFile)
    fs.copyFileSync(candidateFile, baselineFile)
    const appliedBaselineSha256 = hash(baselineFile)
    assert.equal(appliedBaselineSha256, candidateSha256)
    return {
      path: file,
      originalBaselineSha256,
      appliedBaselineSha256,
      candidateSha256,
    }
  })
  requireProductionSourceUnchanged()
  writeJson(path.join(output, 'provenance.json'), {
    candidate: git(repository, 'rev-parse', 'HEAD'),
    baseline: baselineCommit,
    baselineSourceTree: git(baseline, 'rev-parse', 'HEAD:src'),
    order,
    fixtureOverlays: overlays,
    shared,
    overlayScope:
      'Only the listed test fixture files are copied. Both source trees execute identical fixture bytes; no production source is overlaid.',
    fixtureCompatibility:
      'Fixture adaptations and native-shaped agent data are shared by both trees. Per-fixture compatibility details and checks remain in the archived fixture programs and proof files.',
    timingScope:
      'Sequential production transcript/workspace fixture measurements and instrumented App interactions. No authenticated upstream provider session is measured.',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      playwright: require('playwright/package.json').version,
    },
  })
}

function timingRows(value, scenario = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const fields = ['medianMs', 'p95Ms', 'elapsedMs', 'totalRenderMs', 'worstRenderMs']
  const measured = fields.filter((field) => typeof value[field] === 'number')
  const rows = measured.length
    ? [
        {
          scenario: scenario || 'root',
          ...Object.fromEntries(measured.map((key) => [key, value[key]])),
        },
      ]
    : []
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child))
      rows.push(...timingRows(child, scenario ? scenario + '.' + key : key))
  }
  return rows
}

function report() {
  const provenance = readJson(path.join(output, 'provenance.json'))
  assert.equal(git(repository, 'rev-parse', 'HEAD'), provenance.candidate)
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), provenance.baseline)
  requireProductionSourceUnchanged()
  for (const overlay of provenance.fixtureOverlays) {
    assert.equal(hash(path.join(repository, overlay.path)), overlay.candidateSha256)
    assert.equal(hash(path.join(baseline, overlay.path)), overlay.candidateSha256)
  }
  for (const shared of provenance.shared) {
    assert.equal(hash(path.join(repository, shared.path)), shared.sha256)
    assert.equal(hash(path.join(baseline, shared.path)), shared.sha256)
  }
  const runs = provenance.order.map((label) => {
    const sourceRoot = label.startsWith('t3-ref-') ? baseline : repository
    const transcript = readJson(
      path.join(sourceRoot, 'output/playwright/transcript-performance-v011', label + '.json'),
    )
    const workspace = readJson(
      path.join(sourceRoot, 'output/playwright/workspace-surfaces-performance', label + '.json'),
    )
    const app = readJson(path.join(output, 'app-fluidity-' + label + '.json'))
    assert.equal(transcript.label, label)
    assert.equal(workspace.label, label)
    // These options would replace production modules or disable assertions.
    assert.equal(transcript.baselineRevision, undefined)
    assert.equal(workspace.referenceRef, provenance.baseline)
    assert.notEqual(workspace.fixture.agentsVariant, undefined)
    assert.equal(app.baseline, false)
    for (const proof of [transcript, workspace]) assert.deepEqual(proof.errors, [])
    return {
      label,
      source: label.startsWith('t3-ref-') ? provenance.baseline : provenance.candidate,
      transcript,
      workspace,
      app,
    }
  })
  const semanticVariants = runs.map((run) => ({
    label: run.label,
    workspaceAgentsVariant: run.workspace.fixture.agentsVariant,
    workspaceChecks: run.workspace.checks,
  }))
  writeJson(path.join(output, 'comparison.json'), { provenance, semanticVariants, runs })
  const lines = [
    'Same-fixture center conversation and right workspace comparison: pinned 2c16b51 versus candidate, sequential ABBA order.',
    '',
    'Common workload timings are compared below. Workspace Agents capabilities differ by production revision; variant-specific functional checks run after the common measurements and are retained separately in the raw proof.',
    '',
    '| Run | Workspace Agents semantics |',
    '| --- | --- |',
    ...semanticVariants.map(
      (variant) =>
        '| ' + variant.label + ' | ' + JSON.stringify(variant.workspaceAgentsVariant) + ' |',
    ),
    '',
    '| Run | Fixture / scenario | Median ms | p95 ms | Elapsed ms | Total render ms | Worst render ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const run of runs) {
    for (const fixture of ['transcript', 'workspace', 'app']) {
      for (const row of timingRows(run[fixture])) {
        lines.push(
          '| ' +
            [
              run.label,
              fixture + ' / ' + row.scenario,
              row.medianMs ?? '',
              row.p95Ms ?? '',
              row.elapsedMs ?? '',
              row.totalRenderMs ?? '',
              row.worstRenderMs ?? '',
            ].join(' | ') +
            ' |',
        )
      }
    }
  }
  lines.push(
    '',
    'Raw metrics, structural performance checks, fixture compatibility details and all executed fixture hashes are archived. Timing comparisons impose no new threshold and are not authenticated upstream-provider evidence.',
  )
  fs.writeFileSync(path.join(output, 'comparison.md'), lines.join('\n') + '\n')
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
  console.log(
    JSON.stringify({
      baseline: provenance.baseline,
      candidate: provenance.candidate,
      runs: runs.length,
    }),
  )
}

if (process.argv[2] === 'prepare') prepare()
else if (process.argv[2] === 'report') report()
else throw new Error('Use prepare or report.')
