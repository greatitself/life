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
  // A reset timestamp alone does not say how much of the window was used.
  if (usedPercent === undefined) return undefined
  const resetsAt = resetSeconds(wire.resets_at)
  return {
    usedPercent,
    windowDurationMins,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
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
): ProviderUsageSnapshot {
  const wire = object(response)
  const accountType = text(wire?.subscription_type)
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
  const usedPercent = percent(extra?.utilization)
  const currency = text(extra?.currency)
  // Keep provider-reported units. Utilization does not establish a credit balance or access.
  const extraUsage =
    typeof extra?.is_enabled === 'boolean'
      ? {
          isEnabled: extra.is_enabled,
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
    ...(extraUsage ? { extraUsage } : {}),
    ...(!available
      ? { message: 'Claude account quota information is unavailable for this session.' }
      : {}),
  }
}
