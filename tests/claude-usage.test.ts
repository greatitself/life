import { describe, expect, it } from 'vitest'
import { claudeAccountInfo, normalizeClaudeUsageSnapshot } from '../src/main/claude-usage'

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

  it('preserves known resets when utilization is nullable or malformed without inventing remaining quota', () => {
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
    expect(snapshot.status).toBe('available')
    expect(snapshot.limits).toHaveLength(6)
    for (const limit of snapshot.limits) {
      expect(limit.primary).toEqual({
        windowDurationMins: limit.id === 'five_hour' ? 300 : 10_080,
        resetsAt,
      })
      expect(limit.primary).not.toHaveProperty('usedPercent')
    }
    expect(snapshot.limits.at(-1)).toMatchObject({ id: 'model_scoped:0', label: 'Unknown' })
  })

  it('leaves wholly unknown or malformed windows unavailable without replacing them with full quota', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: -1, resets_at: 'not a date' },
        seven_day_opus: { utilization: NaN, resets_at: null },
      }),
    )
    expect(snapshot).toMatchObject({ status: 'unavailable', limits: [] })
    expect(snapshot).not.toHaveProperty('ordinaryUsageAllowed')
  })

  it('ignores quota fields when native availability is explicitly false while preserving safe account identity', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      {
        subscription_type: 'pro',
        rate_limits_available: false,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: reset },
          extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 10_000 },
        },
      },
      123,
      { email: 'researcher@example.test', apiProvider: 'firstParty' },
    )
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      limits: [],
      fetchedAt: 123,
      accountType: 'pro',
      account: { email: 'researcher@example.test', apiProvider: 'firstParty' },
      message: expect.stringContaining('profile scope may be missing'),
    })
    expect(snapshot).not.toHaveProperty('extraUsage')
  })

  it('selects only documented safe account strings without leaking arbitrary fields or credential values', () => {
    const native = {
      email: '  researcher@example.test  ',
      organization: 'Test organization',
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      tokenSource: 'oauth',
      apiKeySource: 'none',
      subscriptionType: 'max',
      apiKey: 'never expose this fixture value',
      accessToken: 'also private fixture data',
      refreshToken: 'also never expose',
      secrets: { private: true },
      accountId: 'not documented for native AccountInfo',
    }
    const original = structuredClone(native)
    expect(claudeAccountInfo(native)).toEqual({
      email: 'researcher@example.test',
      organization: 'Test organization',
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      tokenSource: 'oauth',
      apiKeySource: 'none',
    })
    const snapshot = normalizeClaudeUsageSnapshot(
      response({ five_hour: { utilization: 25 } }),
      123,
      native,
    )
    expect(snapshot.account).toEqual(claudeAccountInfo(native))
    expect(JSON.stringify(snapshot)).not.toMatch(
      /never expose|private fixture|refreshToken|accessToken|apiKey"|secrets/,
    )
    expect(snapshot).not.toHaveProperty('accountId')
    expect(native).toEqual(original)
    expect(
      claudeAccountInfo({ email: null, organization: {}, apiKeySource: '', tokenSource: 123 }),
    ).toBeUndefined()
    expect(claudeAccountInfo(null)).toBeUndefined()
    expect(claudeAccountInfo([])).toBeUndefined()
  })

  it('falls back to native account subscription type only when the usage field is missing', () => {
    const native = { subscriptionType: 'max', email: 'researcher@example.test' }
    const base = { rate_limits_available: false, rate_limits: null }
    expect(normalizeClaudeUsageSnapshot(base, 123, native)).toMatchObject({ accountType: 'max' })
    expect(
      normalizeClaudeUsageSnapshot({ ...base, subscription_type: 'pro' }, 123, native),
    ).toMatchObject({ accountType: 'pro' })
    expect(
      normalizeClaudeUsageSnapshot({ ...base, subscription_type: null }, 123, native),
    ).not.toHaveProperty('accountType')
    expect(
      normalizeClaudeUsageSnapshot({ ...base, subscription_type: '' }, 123, native),
    ).not.toHaveProperty('accountType')
  })

  it.each(['bedrock', 'vertex', 'foundry', 'gateway'])(
    'explains unavailable native third-party subscription quota for %s without deriving a balance',
    (apiProvider) => {
      const snapshot = normalizeClaudeUsageSnapshot(
        { subscription_type: null, rate_limits_available: false, rate_limits: null },
        123,
        { apiProvider },
      )
      expect(snapshot).toMatchObject({
        status: 'unavailable',
        limits: [],
        account: { apiProvider },
        message: expect.stringContaining(`active ${apiProvider} provider`),
      })
      expect(snapshot).not.toHaveProperty('credits')
      expect(snapshot).not.toHaveProperty('ordinaryUsageAllowed')
    },
  )

  it.each([
    { apiProvider: 'firstParty', authMethod: 'api_key', apiKeySource: 'env' },
    { apiProvider: 'firstParty', authMethod: 'api_key_helper', apiKeySource: 'helper' },
    { apiProvider: 'firstParty', tokenSource: 'none', apiKeySource: 'env' },
  ])(
    'explains unavailable quota when native metadata identifies active API-key authentication: %j',
    (account) => {
      const snapshot = normalizeClaudeUsageSnapshot(
        { subscription_type: null, rate_limits_available: false, rate_limits: null },
        123,
        account,
      )
      expect(snapshot.message).toMatch(/API-key authentication; API usage is billed separately/)
    },
  )

  it.each([
    { tokenSource: 'none', apiKeySource: 'none' },
    { tokenSource: 'none', apiKeySource: 'unknown' },
    { tokenSource: 'oauth', apiKeySource: 'env' },
    { apiKeySource: 'env' },
    { authMethod: 'claude.ai', tokenSource: 'none', apiKeySource: 'env' },
    { authMethod: 'none', tokenSource: 'none', apiKeySource: 'env' },
  ])(
    'does not infer credential precedence or API authentication from absent or inactive source metadata: %j',
    (account) => {
      const snapshot = normalizeClaudeUsageSnapshot(
        { subscription_type: null, rate_limits_available: false, rate_limits: null },
        123,
        account,
      )
      expect(snapshot.message).not.toContain('API-key authentication')
      expect(snapshot.status).toBe('unavailable')
    },
  )

  it('uses an explicitly reported subscription instead of guessing credential precedence from conflicting cached metadata', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      { subscription_type: 'pro', rate_limits_available: false, rate_limits: null },
      123,
      { apiProvider: 'firstParty', tokenSource: 'none', apiKeySource: 'env' },
    )
    expect(snapshot.accountType).toBe('pro')
    expect(snapshot.message).toContain('profile scope may be missing')
    expect(snapshot.message).not.toContain('API-key authentication')
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
    expect(snapshot.extraUsage).toEqual({
      isEnabled: true,
      amountUnit: 'minor-currency',
      usedPercent: 25,
    })
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
      amountUnit: 'minor-currency',
      monthlyLimit: 0,
      usedCredits: 12.5,
      currency: 'GBP',
    })
    expect(snapshot).not.toHaveProperty('credits')
    expect(snapshot.limits).toEqual([])
  })

  it('preserves native over-cap extra utilization and minor-unit amounts without assuming currency or available credits', () => {
    const snapshot = normalizeClaudeUsageSnapshot(
      response({
        extra_usage: {
          is_enabled: true,
          monthly_limit: 500,
          used_credits: 550,
          utilization: 110,
          currency: null,
        },
      }),
    )
    expect(snapshot.extraUsage).toEqual({
      isEnabled: true,
      amountUnit: 'minor-currency',
      monthlyLimit: 500,
      usedCredits: 550,
      usedPercent: 110,
    })
    expect(snapshot.extraUsage).not.toHaveProperty('balance')
    expect(snapshot.extraUsage).not.toHaveProperty('currency')
    expect(snapshot).not.toHaveProperty('ordinaryUsageAllowed')
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
