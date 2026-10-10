const fs = require('node:fs')
const path = require('node:path')

function milliseconds(timing) {
  if (
    timing?.kind !== 'nsis' ||
    timing.ok !== true ||
    typeof timing.elapsedMilliseconds !== 'number' ||
    !Number.isFinite(timing.elapsedMilliseconds) ||
    timing.elapsedMilliseconds < 0
  ) {
    throw new Error('A successful installation benchmark requires valid NSIS elapsed timings.')
  }
  return timing.elapsedMilliseconds
}

const cell = (value) => String(value ?? 'unknown').replace(/[\r\n|]/g, ' ')
const seconds = (value) => `${(value / 1000).toFixed(3)} s`
const size = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('A successful installation benchmark requires installer byte sizes.')
  return `${(value / 1024 / 1024).toFixed(2)} MiB`
}

function installationReport(proof) {
  if (typeof proof?.ok !== 'boolean' || !Array.isArray(proof.pairs))
    throw new Error('Invalid Windows installation proof.')
  if (proof.ok && proof.pairs.length === 0)
    throw new Error('A successful installation benchmark must include an upgrade pair.')
  const lines = [
    '## Windows installation benchmark',
    '',
    `Target: **${cell(proof.targetVersion)}**. Result: **${proof.ok ? 'passed' : 'failed'}**.`,
    '',
    'Each installer is measured from NSIS process launch through exit with System.Diagnostics.Stopwatch. Downloads, verification, and cleanup are excluded from the installation comparison.',
    '',
  ]
  if (!proof.ok) lines.push(`Failure: ${cell(proof.failure)}.`, '')
  for (const pair of proof.pairs) {
    const baseline = milliseconds(pair.timings?.baselineFreshInstall)
    const upgrade = milliseconds(pair.timings?.targetUpgrade)
    const fresh = milliseconds(pair.timings?.targetFreshInstall)
    lines.push(
      `### ${cell(pair.baselineVersion)} → ${cell(pair.targetVersion)}`,
      '',
      '| Operation | NSIS elapsed | Installer size |',
      '| --- | ---: | ---: |',
      `| Baseline ${cell(pair.baselineVersion)} fresh install | ${seconds(baseline)} | ${size(pair.baselineInstallerBytes)} |`,
      `| Target ${cell(pair.targetVersion)} fresh install | ${seconds(fresh)} | ${size(pair.targetInstallerBytes)} |`,
      `| Upgrade ${cell(pair.baselineVersion)} → ${cell(pair.targetVersion)} | ${seconds(upgrade)} | ${size(pair.targetInstallerBytes)} |`,
      '',
    )
    if (pair.installedFiles) {
      lines.push(
        '| Installation | Files on filesystem | Sum of file sizes |',
        '| --- | ---: | ---: |',
      )
      for (const [label, layout] of [
        ['Baseline', pair.installedFiles.baseline],
        ['Upgraded target', pair.installedFiles.upgraded],
        ['Fresh target', pair.installedFiles.freshTarget],
      ]) {
        if (!Number.isSafeInteger(layout?.fileCount) || layout.fileCount <= 0)
          throw new Error('Invalid installed file count.')
        lines.push(`| ${label} | ${layout.fileCount} | ${size(layout.fileBytes)} |`)
      }
      lines.push(
        '',
        'File counts include only the installation directory and exclude user data. Bytes sum file lengths rather than allocated disk clusters.',
        '',
      )
    }
    if (baseline > 0) {
      const difference = ((baseline - fresh) / baseline) * 100
      const ratio = fresh > 0 ? ` (${(baseline / fresh).toFixed(2)}× baseline/target ratio)` : ''
      lines.push(
        `Observed fresh-install time ${difference >= 0 ? 'reduction' : 'increase'}: **${Math.abs(difference).toFixed(1)}%**${ratio}.`,
        '',
      )
    } else {
      lines.push('The zero-duration baseline does not permit a timing ratio.', '')
    }
    lines.push(
      `Baseline installer SHA-256: \`${cell(pair.baselineInstallerSHA256)}\`.`,
      '',
      `Target installer SHA-256: \`${cell(proof.installerSHA256)}\`.`,
      '',
      'Upgrade verification retains the same installation registration, GUID, location and executable, and checks unchanged hashes for all five saved-data fixtures. The subsequent fresh target install verifies the same default installation identity.',
      '',
    )
  }
  lines.push(
    '### Measurement context',
    '',
    'One sample per operation on the same disposable Windows runner. Order: baseline fresh install, target upgrade, owned cleanup, target fresh install. Operating-system and filesystem caches are not flushed; later operations may benefit from warm caches. These are observations for this runner, not a population-wide speed guarantee. Security settings and Defender exclusions remain unchanged.',
    '',
    `Runner: ${cell(proof.runner?.name)}; image: ${cell(proof.runner?.imageOS)} ${cell(proof.runner?.imageVersion)}; architecture: ${cell(proof.runner?.architecture)}; logical processors: ${cell(proof.runner?.logicalProcessors)}.`,
    '',
    `Windows: ${cell(proof.runner?.windowsVersion)}; PowerShell: ${cell(proof.runner?.powerShellVersion)}.`,
    '',
    '### Recorded phases',
    '',
    '| Phase | Type | Elapsed | Result |',
    '| --- | --- | ---: | --- |',
  )
  for (const phase of proof.phases ?? []) {
    if (
      typeof phase.elapsedMilliseconds !== 'number' ||
      !Number.isFinite(phase.elapsedMilliseconds) ||
      phase.elapsedMilliseconds < 0
    ) {
      throw new Error('Invalid phase elapsed time.')
    }
    lines.push(
      `| ${cell(phase.name)} | ${cell(phase.kind)} | ${seconds(phase.elapsedMilliseconds)} | ${phase.ok ? 'passed' : 'failed'} |`,
    )
  }
  lines.push(
    '',
    'The cleanup verification phase includes its nested NSIS cleanup phase; phase rows are not additive. The JSON artifact contains timestamps, process exit codes, runner metadata, installation identity, installer hashes, and saved-data checks.',
    '',
  )
  return lines.join('\n')
}

module.exports = { installationReport }

if (require.main === module) {
  try {
    const proofPath = process.argv[2]
    const outputPath = process.argv[3] || 'output/windows-installation-benchmark.md'
    if (!proofPath)
      throw new Error(
        'Usage: node scripts/windows-installation-report.cjs <proof.json> [report.md]',
      )
    const report = installationReport(JSON.parse(fs.readFileSync(proofPath, 'utf8')))
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, report)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
    console.log(report)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
