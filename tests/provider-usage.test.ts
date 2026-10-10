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

  it('preserves a reset-only window without inventing utilization or a standard duration', () => {
    const snapshot = codexUsageSnapshot({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: null, windowDurationMins: 15, resetsAt: 1800000000 },
        secondary: { usedPercent: undefined, resetsAt: 1800010000 },
      },
    })
    expect(snapshot.status).toBe('available')
    expect(snapshot.limits[0]).toMatchObject({
      primary: { windowDurationMins: 15, resetsAt: 1800000000 },
      secondary: { resetsAt: 1800010000 },
    })
    expect(snapshot.limits[0].primary?.usedPercent).toBeUndefined()
    expect(snapshot.limits[0].secondary?.usedPercent).toBeUndefined()
    expect(snapshot.limits[0].secondary?.windowDurationMins).toBeUndefined()
  })

  it('merges a sparse reset update while retaining reported utilization', () => {
    const previous = codexUsageSnapshot({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
      },
    })
    const snapshot = codexUsageSnapshot(
      { rateLimits: { limitId: 'codex', primary: { resetsAt: 1800020000 } } },
      previous,
      true,
    )
    expect(snapshot.limits[0].primary).toEqual({
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1800020000,
    })
  })

  it('keeps the modern bucket authoritative when a rolling update also includes its legacy mirror', () => {
    const snapshot = codexUsageSnapshot(
      {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 12.5 } },
        },
      },
      codexUsageSnapshot({ rateLimits: { limitId: 'codex', primary: { usedPercent: 40 } } }),
      true,
    )
    expect(snapshot.limits).toHaveLength(1)
    expect(snapshot.limits[0].primary?.usedPercent).toBe(12.5)
  })

  it("does not inherit another reported account's windows, credits or access state", () => {
    const previous = codexUsageSnapshot({
      accountId: 'account-before',
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 100 },
        secondary: { usedPercent: 50 },
        credits: { hasCredits: true, unlimited: false, balance: '123.45' },
      },
    })
    const snapshot = codexUsageSnapshot(
      {
        accountId: 'account-after',
        rateLimits: { limitId: 'codex', primary: { usedPercent: 0 } },
      },
      previous,
      true,
    )
    expect(snapshot.accountId).toBe('account-after')
    expect(snapshot.limits[0].primary?.usedPercent).toBe(0)
    expect(snapshot.limits[0].secondary).toBeUndefined()
    expect(snapshot.limits[0].credits).toBeUndefined()
    expect(snapshot.accountType).toBeUndefined()
    expect(snapshot.ordinaryUsageAllowed).toBeUndefined()
  })

  it('retains a reported account scope across sparse native notifications', () => {
    const previous = codexUsageSnapshot({
      accountId: 'same-account',
      rateLimits: { limitId: 'codex', primary: { usedPercent: 25 } },
    })
    const snapshot = codexUsageSnapshot(
      { rateLimits: { limitId: 'codex', primary: { usedPercent: 50 } } },
      previous,
      true,
    )
    expect(snapshot.accountId).toBe('same-account')
    expect(snapshot.limits[0].primary?.usedPercent).toBe(50)
    expect(codexUsageSnapshot({ rateLimits: {} }, previous).accountId).toBeUndefined()
  })
})
