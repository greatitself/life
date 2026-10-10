import { describe, expect, it } from 'vitest'
import { codexUsageSnapshot } from '../src/main/provider-usage'

describe('native Codex account quota snapshots', () => {
  it('uses each metered bucket once and preserves provider reset seconds and exact credit balance', () => {
    const response = {
      ordinaryUsageAllowed: false,
      rateLimits: { limitId: 'codex', primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
          credits: { hasCredits: true, unlimited: false, balance: '10.125' },
          planType: 'pro',
        },
        review: {
          limitId: 'review',
          limitName: 'Code review',
          secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1800010000 },
        },
      },
      rateLimitResetCredits: { availableCount: 2 },
    }
    expect(codexUsageSnapshot(response, undefined, false, 100)).toEqual({
      provider: 'codex',
      status: 'available',
      fetchedAt: 100,
      accountType: 'pro',
      ordinaryUsageAllowed: false,
      availableResetCredits: 2,
      limits: [
        {
          id: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
          credits: { hasCredits: true, unlimited: false, balance: '10.125' },
          planType: 'pro',
        },
        {
          id: 'review',
          label: 'Code review',
          secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1800010000 },
        },
      ],
    })
  })

  it('does not infer backend access recovery from a lower percentage or a reset timestamp', () => {
    const previous = codexUsageSnapshot({
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: 'codex',
        planType: 'pro',
        spendControlReached: true,
        rateLimitReachedType: 'workspace_member_usage_limit_reached',
        primary: { usedPercent: 100, resetsAt: 1 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
    })
    const rolling = codexUsageSnapshot(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 0 },
          planType: null,
          spendControlReached: null,
          credits: null,
        },
      },
      previous,
      true,
    )
    expect(rolling).toMatchObject({
      ordinaryUsageAllowed: false,
      limits: [
        {
          primary: { usedPercent: 0, resetsAt: 1 },
          planType: 'pro',
          spendControlReached: true,
          credits: { balance: '0' },
        },
      ],
    })
  })

  it('replaces metadata on an authoritative read and reports missing quota information explicitly', () => {
    const previous = codexUsageSnapshot({
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 10 } },
    })
    const empty = codexUsageSnapshot(
      {
        ordinaryUsageAllowed: null,
        rateLimits: { limitId: 'codex', primary: null, planType: null },
      },
      previous,
    )
    expect(empty.status).toBe('unavailable')
    expect(empty.ordinaryUsageAllowed).toBeUndefined()
    expect(empty.limits[0].primary).toBeUndefined()
    expect(empty.limits[0].planType).toBeUndefined()
  })

  it('ignores malformed window values while preserving valid additional buckets', () => {
    const snapshot = codexUsageSnapshot({
      rateLimitsByLimitId: {
        invalid: { primary: { usedPercent: -1 } },
        extra: {
          primary: { usedPercent: 110 },
          secondary: { usedPercent: 20, resetsAt: Infinity },
        },
      },
    })
    expect(snapshot.status).toBe('available')
    expect(snapshot.limits[0].primary).toBeUndefined()
    expect(snapshot.limits[1].primary?.usedPercent).toBe(110)
    expect(snapshot.limits[1].secondary?.resetsAt).toBeUndefined()
  })

  it('preserves the native individual spend-control decimals without estimating account costs', () => {
    const result = codexUsageSnapshot({
      rateLimits: {
        limitId: 'codex',
        individualLimit: {
          limit: '100.001',
          used: '42.005',
          remainingPercent: 58,
          resetsAt: 1800010000,
        },
        spendControlReached: false,
      },
    })
    expect(result.status).toBe('available')
    expect(result.limits[0]).toMatchObject({
      individualLimit: {
        limit: '100.001',
        used: '42.005',
        remainingPercent: 58,
        resetsAt: 1800010000,
      },
      spendControlReached: false,
    })
  })
})
