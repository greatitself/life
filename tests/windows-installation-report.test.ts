import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { installationReport } = require('../scripts/windows-installation-report.cjs') as {
  installationReport: (proof: unknown) => string
}

const timing = (elapsedMilliseconds: number) => ({
  kind: 'nsis',
  ok: true,
  elapsedMilliseconds,
})
const proof = () => ({
  ok: true,
  targetVersion: '0.11.0',
  installerSHA256: 'target-sha256',
  runner: { name: 'disposable-runner', imageOS: 'win25', imageVersion: 'test' },
  pairs: [
    {
      baselineVersion: '0.10.0',
      targetVersion: '0.11.0',
      baselineInstallerBytes: 178_970_121,
      targetInstallerBytes: 130_000_000,
      baselineInstallerSHA256: 'baseline-sha256',
      installedFiles: {
        baseline: { fileCount: 22_000, fileBytes: 500_000_000 },
        upgraded: { fileCount: 100, fileBytes: 400_000_000 },
        freshTarget: { fileCount: 100, fileBytes: 400_000_000 },
      },
      timings: {
        baselineFreshInstall: timing(80_000),
        targetUpgrade: timing(22_000),
        targetFreshInstall: timing(20_000),
      },
    },
  ],
  phases: [
    {
      name: 'baseline-download:0.10.0',
      kind: 'verification',
      ok: true,
      elapsedMilliseconds: 3_000,
    },
  ],
})

describe('Windows installation benchmark report', () => {
  it('compares process timings and reports upgrade duration separately from overhead', () => {
    const result = installationReport(proof())
    expect(result).toContain('| Baseline 0.10.0 fresh install | 80.000 s | 170.68 MiB |')
    expect(result).toContain('| Target 0.11.0 fresh install | 20.000 s | 123.98 MiB |')
    expect(result).toContain('| Upgrade 0.10.0 → 0.11.0 | 22.000 s | 123.98 MiB |')
    expect(result).toContain('reduction: **75.0%** (4.00× baseline/target ratio)')
    expect(result).toContain('| baseline-download:0.10.0 | verification | 3.000 s | passed |')
    expect(result).toContain('later operations may benefit from warm caches')
    expect(result).toContain('Defender exclusions remain unchanged')
    expect(result).toContain('| Baseline | 22000 | 476.84 MiB |')
    expect(result).toContain('| Upgraded target | 100 | 381.47 MiB |')
    expect(result).toContain('exclude user data')
  })

  it('reports slower targets without labeling them as improvements', () => {
    const input = proof()
    input.pairs[0].timings.targetFreshInstall = timing(100_000)
    expect(installationReport(input)).toContain('increase: **25.0%** (0.80× baseline/target ratio)')
  })

  it('handles zero observations without infinite ratios', () => {
    const input = proof()
    input.pairs[0].timings.baselineFreshInstall = timing(0)
    expect(installationReport(input)).toContain('does not permit a timing ratio')
    input.pairs[0].timings.baselineFreshInstall = timing(80_000)
    input.pairs[0].timings.targetFreshInstall = timing(0)
    const result = installationReport(input)
    expect(result).toContain('reduction: **100.0%**')
    expect(result).not.toContain('Infinity')
  })

  it('retains partial failed phases without claiming an installation succeeded', () => {
    const input = {
      ok: false,
      targetVersion: '0.11.0',
      failure: 'NSIS installer failed with exit code 2',
      pairs: [],
      phases: [{ name: 'target-upgrade', kind: 'nsis', ok: false, elapsedMilliseconds: 900 }],
    }
    const result = installationReport(input)
    expect(result).toContain('Result: **failed**')
    expect(result).toContain('exit code 2')
    expect(result).toContain('| target-upgrade | nsis | 0.900 s | failed |')
    expect(result).not.toContain('Observed fresh-install time')
  })

  it.each([NaN, Infinity, -1])('rejects invalid installer elapsed times %s', (duration) => {
    const input = proof()
    input.pairs[0].timings.targetFreshInstall = timing(duration)
    expect(() => installationReport(input)).toThrow('valid NSIS elapsed timings')
  })

  it('rejects successful reports lacking benchmark evidence', () => {
    expect(() => installationReport({ ok: true, pairs: [] })).toThrow('include an upgrade pair')
    const input = proof()
    input.pairs[0].timings.targetUpgrade.ok = false
    expect(() => installationReport(input)).toThrow('valid NSIS elapsed timings')
    input.pairs[0].timings.targetUpgrade.ok = true
    input.pairs[0].targetInstallerBytes = 0
    expect(() => installationReport(input)).toThrow('installer byte sizes')
  })

  it('rejects invalid installed layout measurements', () => {
    const input = proof()
    input.pairs[0].installedFiles.freshTarget.fileCount = -1
    expect(() => installationReport(input)).toThrow('installed file count')
  })
})
