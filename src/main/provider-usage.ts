import type { ProviderUsageSnapshot, UsageRateLimit, UsageRateWindow } from '../shared/usage'

type Wire = Record<string, unknown>
const object = (value: unknown): Wire =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : undefined)
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function rateWindow(value: unknown, previous?: UsageRateWindow): UsageRateWindow | undefined {
  const wire = object(value)
  const usedPercent = number(wire.usedPercent)
  if (usedPercent === undefined) return previous
  return {
    ...(previous || {}),
    usedPercent,
    ...(number(wire.windowDurationMins) !== undefined
      ? { windowDurationMins: number(wire.windowDurationMins) }
      : {}),
    ...(number(wire.resetsAt) !== undefined ? { resetsAt: number(wire.resetsAt) } : {}),
  }
}

function rateLimit(value: unknown, key: string, previous?: UsageRateLimit): UsageRateLimit {
  const wire = object(value)
  const primary = rateWindow(wire.primary, previous?.primary)
  const secondary = rateWindow(wire.secondary, previous?.secondary)
  const credits = object(wire.credits)
  const individualLimit = object(wire.individualLimit)
  return {
    ...(previous || {}),
    id: string(wire.limitId) || key,
    ...(string(wire.limitName) ? { label: string(wire.limitName) } : {}),
    ...(string(wire.planType) ? { planType: string(wire.planType) } : {}),
    ...(string(wire.normalModelSlug) ? { normalModelSlug: string(wire.normalModelSlug) } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(typeof wire.spendControlReached === 'boolean'
      ? { spendControlReached: wire.spendControlReached }
      : {}),
    ...(string(wire.rateLimitReachedType)
      ? { rateLimitReachedType: string(wire.rateLimitReachedType) }
      : {}),
    ...(typeof individualLimit.limit === 'string' && typeof individualLimit.used === 'string'
      ? {
          individualLimit: {
            ...(previous?.individualLimit || {}),
            limit: individualLimit.limit,
            used: individualLimit.used,
            ...(number(individualLimit.remainingPercent) !== undefined
              ? { remainingPercent: number(individualLimit.remainingPercent) }
              : {}),
            ...(number(individualLimit.resetsAt) !== undefined
              ? { resetsAt: number(individualLimit.resetsAt) }
              : {}),
          },
        }
      : {}),
    ...(typeof credits.hasCredits === 'boolean' && typeof credits.unlimited === 'boolean'
      ? {
          credits: {
            ...(previous?.credits || {}),
            hasCredits: credits.hasCredits,
            unlimited: credits.unlimited,
            ...(string(credits.balance) !== undefined ? { balance: string(credits.balance) } : {}),
          },
        }
      : {}),
  }
}

/** Sparse server notifications preserve unavailable account metadata until a fresh read. */
export function codexUsageSnapshot(
  result: Wire,
  previous?: ProviderUsageSnapshot,
  rollingUpdate = false,
  fetchedAt = Date.now(),
): ProviderUsageSnapshot {
  const limits = new Map<string, UsageRateLimit>(
    rollingUpdate ? (previous?.limits || []).map((limit) => [limit.id, limit]) : [],
  )
  for (const [key, value] of Object.entries(object(result.rateLimitsByLimitId))) {
    if (!value || typeof value !== 'object') continue
    const id = string(object(value).limitId) || key
    limits.set(id, rateLimit(value, id, rollingUpdate ? limits.get(id) : undefined))
  }
  const legacy = object(result.rateLimits)
  if (Object.keys(legacy).length) {
    const id = string(legacy.limitId) || 'codex'
    // The modern map is authoritative when both views contain the same bucket.
    if (rollingUpdate || !limits.has(id))
      limits.set(id, rateLimit(legacy, id, rollingUpdate ? limits.get(id) : undefined))
  }
  const ordinaryUsageAllowed =
    typeof result.ordinaryUsageAllowed === 'boolean'
      ? result.ordinaryUsageAllowed
      : rollingUpdate
        ? previous?.ordinaryUsageAllowed
        : undefined
  const availableResetCredits = number(object(result.rateLimitResetCredits).availableCount)
  const accountType = [...limits.values()].find((limit) => limit.planType)?.planType
  const available =
    [...limits.values()].some(
      (limit) =>
        limit.primary ||
        limit.secondary ||
        limit.credits ||
        limit.individualLimit ||
        limit.spendControlReached !== undefined,
    ) ||
    ordinaryUsageAllowed !== undefined ||
    availableResetCredits !== undefined
  return {
    ...(rollingUpdate && previous ? previous : {}),
    provider: 'codex',
    status: available ? 'available' : 'unavailable',
    fetchedAt,
    limits: [...limits.values()],
    error: undefined,
    message: undefined,
    ...(accountType ? { accountType } : {}),
    ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
    ...(availableResetCredits !== undefined ? { availableResetCredits } : {}),
    ...(!available ? { message: 'Codex did not return account quota or credit information.' } : {}),
  }
}
