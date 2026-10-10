import { describe, expect, it } from 'vitest'
import { normalizeClaudeUsageSnapshot } from '../src/main/claude-usage'

const reset = '2026-10-10T08:00:00.000Z'
const resetsAt = Date.parse(reset) / 1_000

function response(rate_limits: unknown) {
  return { subscription_type: 'max', rate_limits_available: true, rate_limits }
}

describe('native Claude account quota snapshots', () => {
  it('preserves all native fixed and model-scoped windows with provider reset seconds', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        five_hour: { utilization: 24.5, resets_at: reset },
        seven_day: { utilization: 50, resets_at: reset },
        seven_day_oauth_apps: { utilization: 2, resets_at: reset },
        seven_day_opus: { utilization: 100, resets_at: reset },
        seven_day_sonnet: { utilization: 0, resets_at: reset },
        model_scoped: [
          { display_name: 'Fable', utilization: 15, resets_at: reset },
          { display_name: 'Fable', utilization: 20, resets_at: reset },
        ],
      }),
      123,
    )
    expect(snapshot).toMatchObject({
      provider: 'claude',
      status: 'available',
      fetchedAt: 123,
      accountType: 'max',
    })
    expect(snapshot.limits.map(({ id, primary, planType }) => ({ id, primary, planType }))).toEqual(
      [
        {
          id: 'five_hour',
          planType: 'max',
          primary: { usedPercent: 24.5, windowDurationMins: 300, resetsAt },
        },
        ...[
          ['seven_day', 50],
          ['seven_day_oauth_apps', 2],
          ['seven_day_opus', 100],
          ['seven_day_sonnet', 0],
          ['model_scoped:0', 15],
          ['model_scoped:1', 20],
        ].map(([id, usedPercent]) => ({
          id,
          planType: 'max',
          primary: { usedPercent, windowDurationMins: 10_080, resetsAt },
        })),
      ],
    )
    expect(snapshot.limits.slice(-2).map((limit) => limit.label)).toEqual(['Fable', 'Fable'])
  })

  it.each([
    { subscription_type: null, rate_limits_available: false, rate_limits: null },
    { subscription_type: 'pro', rate_limits_available: false, rate_limits: null },
    {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: { five_hour: { utilization: 0 } },
    },
    response(null),
    response({}),
    null,
    [],
  ])('reports unavailable account limits explicitly for absent native account data: %j', (wire) => {
    const snapshot = normalizeClaudeUsageSnapshot(wire, 123)
    expect(snapshot).toMatchObject({
      provider: 'claude',
      status: 'unavailable',
      fetchedAt: 123,
      limits: [],
      message: expect.stringContaining('unavailable'),
    })
    expect(snapshot).not.toHaveProperty('ordinaryUsageAllowed')
  })

  it('keeps nullable or malformed utilization unavailable instead of turning it into zero', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        five_hour: { utilization: null, resets_at: reset },
        seven_day: { utilization: 101, resets_at: reset },
        seven_day_oauth_apps: { utilization: -1, resets_at: reset },
        seven_day_opus: { utilization: Infinity, resets_at: reset },
        seven_day_sonnet: { utilization: '50', resets_at: reset },
        model_scoped: [
          { display_name: 'Unknown', utilization: null, resets_at: reset },
          { display_name: '', utilization: 10, resets_at: reset },
        ],
      }),
    )
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.limits).toEqual([])
  })

  it('does not infer access or credits from low utilization, full utilization, or elapsed resets', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        five_hour: { utilization: 100, resets_at: '1970-01-01T00:00:00Z' },
        seven_day: { utilization: 0, resets_at: reset },
        extra_usage: { is_enabled: true, utilization: 25, monthly_limit: null, used_credits: null },
      }),
    )
    expect(snapshot).not.toHaveProperty('ordinaryUsageAllowed')
    expect(snapshot).not.toHaveProperty('availableResetCredits')
    for (const limit of snapshot.limits) {
      expect(limit).not.toHaveProperty('credits')
      expect(limit).not.toHaveProperty('spendControlReached')
    }
    expect(snapshot.extraUsage).toEqual({ isEnabled: true, usedPercent: 25 })
  })

  it('preserves extra usage provider amounts and currency without deriving a balance', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        extra_usage: {
          is_enabled: false,
          monthly_limit: 0,
          used_credits: 12.5,
          utilization: null,
          currency: 'GBP',
        },
      }),
    )
    expect(snapshot.status).toBe('available')
    expect(snapshot.extraUsage).toEqual({
      isEnabled: false,
      monthlyLimit: 0,
      usedCredits: 12.5,
      currency: 'GBP',
    })
    expect(snapshot).not.toHaveProperty('credits')
    expect(snapshot.limits).toEqual([])
  })

  it('ignores malformed resets while accepting ISO offsets and fractional seconds', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        five_hour: { utilization: 1, resets_at: 'not a date' },
        seven_day: { utilization: 2, resets_at: '12345' },
        seven_day_opus: { utilization: 3, resets_at: '2026-10-10T09:00:00.500+01:00' },
        seven_day_sonnet: { utilization: 4, resets_at: null },
      }),
    )
    expect(snapshot.limits.map((limit) => limit.primary?.resetsAt)).toEqual([
      undefined,
      undefined,
      resetsAt,
      undefined,
    ])
  })

  it('keeps session costs and behavior attribution separate from account quotas', () => {
    const wire = {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      session: { total_cost_usd: 5, model_usage: { opus: { inputTokens: 100 } } },
      behaviors: { utilization: 20 },
    }
    const original = structuredClone(wire)
    const snapshot = normalizeClaudeUsageSnapshot(wire, 123)
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.limits).toEqual([])
    expect(snapshot).not.toHaveProperty('estimatedCostUsd')
    expect(wire).toEqual(original)
  })
})
