import { Effect, Option, Schema } from 'effect'
import type { ProviderUsageSnapshot, UsageRateLimit, UsageRateWindow } from '../shared/usage'

// Native notifications are sparse. A malformed field must not reject a valid sibling
// or remove previously reported metadata, so validation recovers at each field.
const sparse = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(schema).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))))
const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const RateWindowWire = Schema.Struct({
  usedPercent: sparse(NonNegativeNumber),
  windowDurationMins: sparse(NonNegativeNumber),
  resetsAt: sparse(NonNegativeNumber),
})
const RateLimitWire = Schema.Struct({
  limitId: sparse(Schema.String),
  limitName: sparse(Schema.String),
  planType: sparse(Schema.String),
  normalModelSlug: sparse(Schema.String),
  primary: sparse(RateWindowWire),
  secondary: sparse(RateWindowWire),
  spendControlReached: sparse(Schema.Boolean),
  rateLimitReachedType: sparse(Schema.String),
  individualLimit: sparse(
    Schema.Struct({
      limit: Schema.String,
      used: Schema.String,
      remainingPercent: sparse(NonNegativeNumber),
      resetsAt: sparse(NonNegativeNumber),
    }),
  ),
  credits: sparse(
    Schema.Struct({
      hasCredits: Schema.Boolean,
      unlimited: Schema.Boolean,
      balance: sparse(Schema.String),
    }),
  ),
})
const UsageWire = Schema.Struct({
  accountId: sparse(Schema.String),
  ordinaryUsageAllowed: sparse(Schema.Boolean),
  rateLimits: sparse(RateLimitWire),
  rateLimitsByLimitId: sparse(Schema.Record(Schema.String, sparse(RateLimitWire))),
  rateLimitResetCredits: sparse(Schema.Struct({ availableCount: sparse(NonNegativeNumber) })),
})
const decodeUsage = Schema.decodeUnknownOption(UsageWire)
type RateLimitWire = typeof RateLimitWire.Type
type RateWindowWire = typeof RateWindowWire.Type

function rateWindow(
  wire: RateWindowWire | undefined,
  previous?: UsageRateWindow,
): UsageRateWindow | undefined {
  if (!wire) return previous
  const { usedPercent, windowDurationMins, resetsAt } = wire
  if (usedPercent === undefined && windowDurationMins === undefined && resetsAt === undefined)
    return previous
  return {
    ...(previous || {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

function rateLimit(wire: RateLimitWire, key: string, previous?: UsageRateLimit): UsageRateLimit {
  const primary = rateWindow(wire.primary, previous?.primary)
  const secondary = rateWindow(wire.secondary, previous?.secondary)
  const { credits, individualLimit } = wire
  return {
    ...(previous || {}),
    id: wire.limitId || key,
    ...(wire.limitName ? { label: wire.limitName } : {}),
    ...(wire.planType ? { planType: wire.planType } : {}),
    ...(wire.normalModelSlug ? { normalModelSlug: wire.normalModelSlug } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(wire.spendControlReached !== undefined
      ? { spendControlReached: wire.spendControlReached }
      : {}),
    ...(wire.rateLimitReachedType ? { rateLimitReachedType: wire.rateLimitReachedType } : {}),
    ...(individualLimit
      ? {
          individualLimit: {
            ...(previous?.individualLimit || {}),
            limit: individualLimit.limit,
            used: individualLimit.used,
            ...(individualLimit.remainingPercent !== undefined
              ? { remainingPercent: individualLimit.remainingPercent }
              : {}),
            ...(individualLimit.resetsAt !== undefined
              ? { resetsAt: individualLimit.resetsAt }
              : {}),
          },
        }
      : {}),
    ...(credits
      ? {
          credits: {
            ...(previous?.credits || {}),
            hasCredits: credits.hasCredits,
            unlimited: credits.unlimited,
            ...(credits.balance !== undefined ? { balance: credits.balance } : {}),
          },
        }
      : {}),
  }
}

/** Sparse server notifications preserve unavailable account metadata until a fresh read. */
export function codexUsageSnapshot(
  result: unknown,
  previous?: ProviderUsageSnapshot,
  rollingUpdate = false,
  fetchedAt = Date.now(),
): ProviderUsageSnapshot {
  const wire: typeof UsageWire.Type = Option.getOrElse(decodeUsage(result), () => ({}))
  const accountId = wire.accountId || undefined
  // A reported account switch must not inherit another account's sparse metadata.
  if (rollingUpdate && accountId && previous?.accountId && accountId !== previous.accountId)
    previous = undefined
  const limits = new Map<string, UsageRateLimit>(
    rollingUpdate ? (previous?.limits || []).map((limit) => [limit.id, limit]) : [],
  )
  const updatedBuckets = new Set<string>()
  for (const [key, value] of Object.entries(wire.rateLimitsByLimitId || {})) {
    if (!value) continue
    const id = value.limitId || key
    limits.set(id, rateLimit(value, id, rollingUpdate ? limits.get(id) : undefined))
    updatedBuckets.add(id)
  }
  const legacy = wire.rateLimits
  if (legacy && Object.keys(legacy).length) {
    const id = legacy.limitId || 'codex'
    // The modern map is authoritative when both views contain the same bucket.
    if (!updatedBuckets.has(id))
      limits.set(id, rateLimit(legacy, id, rollingUpdate ? limits.get(id) : undefined))
  }
  const ordinaryUsageAllowed =
    wire.ordinaryUsageAllowed !== undefined
      ? wire.ordinaryUsageAllowed
      : rollingUpdate
        ? previous?.ordinaryUsageAllowed
        : undefined
  const availableResetCredits = wire.rateLimitResetCredits?.availableCount
  const buckets = [...limits.values()]
  const accountType = buckets.find((limit) => limit.planType)?.planType
  const available =
    buckets.some(
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
    limits: buckets,
    error: undefined,
    message: undefined,
    ...(accountId ? { accountId } : {}),
    ...(accountType ? { accountType } : {}),
    ...(ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed } : {}),
    ...(availableResetCredits !== undefined ? { availableResetCredits } : {}),
    ...(!available ? { message: 'Codex did not return account quota or credit information.' } : {}),
  }
}
