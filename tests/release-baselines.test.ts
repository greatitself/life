import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { releaseBaselines } = require('../scripts/release-baselines.cjs') as {
  releaseBaselines: (version: string) => string[]
}

describe('Windows installer upgrade baselines', () => {
  it('checks only the latest preceding release for 0.10.0 without lexical comparisons', () => {
    expect(releaseBaselines('0.10.0')).toEqual(['0.9.0'])
    expect(releaseBaselines('1.0.0')).toEqual(['0.9.0'])
  })

  it('supports rebuilding 0.9.0 without trying to upgrade from the same version', () => {
    expect(releaseBaselines('0.9.0')).toEqual(['0.8.0'])
  })

  it('excludes future baselines for older rebuilds and handles patch differences', () => {
    expect(releaseBaselines('0.5.1')).toEqual(['0.1.0'])
    expect(releaseBaselines('0.5.2')).toEqual(['0.5.1'])
    expect(releaseBaselines('0.2.0')).toEqual(['0.1.0'])
  })

  it('skips installer upgrades when no preceding known release exists', () => {
    expect(releaseBaselines('0.1.0')).toEqual([])
    expect(releaseBaselines('0.0.1')).toEqual([])
  })

  it.each(['v0.10.0', '0.10', '0.10.0-beta', '999999999999999999999.0.0'])(
    'rejects invalid targets %s',
    (version) => {
      expect(() => releaseBaselines(version)).toThrow()
    },
  )
})
