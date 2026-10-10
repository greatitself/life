import type { ProviderUsageSnapshot, UsageRateLimit, UsageRateWindow } from '../shared/usage'

type Wire = Record<string, unknown>

function object(value: unknown): Wire | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function percent(value: unknown): number | undefined {
  const result = nonNegativeNumber(value)
  return result !== undefined && result <= 100 ? result : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function resetSeconds(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.floor(milliseconds / 1_000)
    : undefined
}

function rateWindow(value: unknown, windowDurationMins: number): UsageRateWindow | undefined {
  const wire = object(value)
  if (!wire) return undefined
  const usedPercent = percent(wire.utilization)
  const resetsAt = resetSeconds(wire.resets_at)
  if (usedPercent === undefined && resetsAt === undefined) return undefined
  // A reset timestamp identifies the window without establishing any remaining quota.
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    windowDurationMins,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

/** Account source names are metadata; credential values and unrelated native fields stay private. */
export function claudeAccountInfo(account: unknown): ProviderUsageSnapshot['account'] {
  const wire = object(account)
  if (!wire) return undefined
  const entries = [
    'email',
    'organization',
    'authMethod',
    'apiProvider',
    'tokenSource',
    'apiKeySource',
  ].flatMap((key) => {
    const value = text(wire[key])
    return value ? [[key, value]] : []
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

function unavailableMessage(
  account: ProviderUsageSnapshot['account'],
  accountType: string | undefined,
) {
  if (account?.apiProvider && account.apiProvider !== 'firstParty')
    return `Claude subscription quota is unavailable for the active ${account.apiProvider} provider.`
  const source = account?.apiKeySource?.toLowerCase()
  const apiKeyActive =
    account?.authMethod === 'api_key' ||
    account?.authMethod === 'api_key_helper' ||
    (!account?.authMethod &&
      account?.tokenSource === 'none' &&
      Boolean(source && !['none', 'unknown'].includes(source)))
  if (apiKeyActive && !accountType)
    return 'Claude subscription quota is unavailable for API-key authentication; API usage is billed separately.'
  if (accountType)
    return 'Claude account quota information is unavailable. The native usage request returned no plan limits; profile scope may be missing or the usage endpoint could not be read.'
  return 'Claude account quota information is unavailable for this session.'
}

const windows = [
  ['five_hour', 'Five-hour usage', 300],
  ['seven_day', 'Weekly usage', 10_080],
  ['seven_day_oauth_apps', 'Weekly app usage', 10_080],
  ['seven_day_opus', 'Weekly Opus usage', 10_080],
  ['seven_day_sonnet', 'Weekly Sonnet usage', 10_080],
] as const

/** Normalize the experimental native get_usage response without inferring account access. */
export function normalizeClaudeUsageSnapshot(
  response: unknown,
  fetchedAt = Date.now(),
  nativeAccount?: unknown,
): ProviderUsageSnapshot {
  const wire = object(response)
  const account = claudeAccountInfo(nativeAccount)
  // Native null explicitly identifies an API/third-party session, unlike an omitted field.
  const accountType =
    wire?.subscription_type === undefined
      ? text(object(nativeAccount)?.subscriptionType)
      : text(wire.subscription_type)
  const rateLimits = wire?.rate_limits_available === true ? object(wire.rate_limits) : undefined
  const limits: UsageRateLimit[] = []

  if (rateLimits) {
    for (const [id, label, duration] of windows) {
      const primary = rateWindow(rateLimits[id], duration)
      if (primary)
        limits.push({ id, label, ...(accountType ? { planType: accountType } : {}), primary })
    }
    if (Array.isArray(rateLimits.model_scoped)) {
      for (const [index, value] of rateLimits.model_scoped.entries()) {
        const model = object(value)
        const label = text(model?.display_name)
        const primary = rateWindow(model, 10_080)
        if (label && primary)
          limits.push({
            id: `model_scoped:${index}`,
            label,
            ...(accountType ? { planType: accountType } : {}),
            primary,
          })
      }
    }
  }

  const extra = object(rateLimits?.extra_usage)
  const monthlyLimit = nonNegativeNumber(extra?.monthly_limit)
  const usedCredits = nonNegativeNumber(extra?.used_credits)
  const usedPercent = nonNegativeNumber(extra?.utilization)
  const currency = text(extra?.currency)
  // Native /usage amounts are minor currency units, not an account credit balance.
  const extraUsage =
    typeof extra?.is_enabled === 'boolean'
      ? {
          isEnabled: extra.is_enabled,
          amountUnit: 'minor-currency' as const,
          ...(monthlyLimit !== undefined ? { monthlyLimit } : {}),
          ...(usedCredits !== undefined ? { usedCredits } : {}),
          ...(usedPercent !== undefined ? { usedPercent } : {}),
          ...(currency ? { currency } : {}),
        }
      : undefined
  const available = limits.length > 0 || extraUsage !== undefined

  return {
    provider: 'claude',
    status: available ? 'available' : 'unavailable',
    fetchedAt,
    limits,
    ...(accountType ? { accountType } : {}),
    ...(account ? { account } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    ...(!available ? { message: unavailableMessage(account, accountType) } : {}),
  }
}
