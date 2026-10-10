import type { Provider } from '../shared/types'
import type {
  ProviderUsageSnapshot,
  UsageContext,
  UsageModelTotals,
  UsageSessionTotals,
  UsageTokenTotals,
} from '../shared/usage'
import type { Message, Thread } from './state'

/** Native quota utilization is percent used; absence never means a full allowance. */
export function remainingUsagePercent(usedPercent: number | undefined): number | undefined {
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 0
    ? Math.max(0, Math.min(100, 100 - usedPercent))
    : undefined
}
export function usageWindowName(minutes: number | undefined, fallback: string): string {
  if (!minutes || !Number.isFinite(minutes) || minutes < 0) return fallback
  if (minutes === 10080) return 'Weekly allowance'
  if (minutes === 1440) return 'Daily allowance'
  if (minutes % 10080 === 0) return `${minutes / 10080}-week allowance`
  if (minutes % 1440 === 0) return `${minutes / 1440}-day allowance`
  if (minutes % 60 === 0) return `${minutes / 60}-hour allowance`
  return `${minutes}-minute allowance`
}
/** Convert only explicitly currency-denominated native minor units. */
export function formatUsageMinorCurrency(amount: number, currency?: string): string {
  const code = currency?.toUpperCase()
  if (code && Intl.supportedValuesOf('currency').includes(code)) {
    const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0
    return formatter.format(amount / 10 ** digits)
  }
  return `${amount.toLocaleString()} minor currency units${code ? ` (${code})` : ' (currency not reported)'}`
}
/** Share a pending native read across StrictMode effect replay, then allow refresh. */
export function createUsageReader() {
  const pending = new Map<string, Promise<ProviderUsageSnapshot>>()
  const readPending = (
    machineIdentity: string,
    provider: Provider,
    read: (provider: Provider) => Promise<ProviderUsageSnapshot>,
  ): Promise<ProviderUsageSnapshot> => {
    const key = JSON.stringify([machineIdentity, provider])
    const existing = pending.get(key)
    if (existing) return existing
    const request = Promise.resolve().then(() => read(provider))
    pending.set(key, request)
    const settled = () => {
      if (pending.get(key) === request) pending.delete(key)
    }
    void request.then(settled, settled)
    return request
  }
  readPending.clear = () => pending.clear()
  return readPending
}

const tokenKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'totalTokens',
] as const
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2000 ? value : undefined
}
function sumKnown(values: (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined)
  if (!known.length) return undefined
  const total = known.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}
/** Normalize native counts without adding cache or reasoning twice. */
export function usageTokens(provider: Provider, value: unknown): UsageTokenTotals {
  const item = record(value)
  const cachedInputTokens = count(
    item.cachedInputTokens ?? item.cacheReadInputTokens ?? item.cache_read_input_tokens,
  )
  const cacheCreationTokens = count(
    item.cacheCreationInputTokens ?? item.cache_creation_input_tokens,
  )
  const baseInput = count(item.inputTokens ?? item.input_tokens)
  const inputTokens =
    provider === 'claude'
      ? baseInput !== undefined &&
        cachedInputTokens !== undefined &&
        cacheCreationTokens !== undefined
        ? sumKnown([baseInput, cachedInputTokens, cacheCreationTokens])
        : undefined
      : baseInput
  const outputTokens = count(item.outputTokens ?? item.output_tokens)
  const reasoningTokens = count(
    item.reasoningOutputTokens ?? item.reasoningTokens ?? item.thinkingTokens,
  )
  const totalTokens =
    count(item.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? sumKnown([inputTokens, outputTokens])
      : undefined)
  return Object.fromEntries(
    Object.entries({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      reasoningTokens,
      totalTokens,
    }).filter(([, amount]) => amount !== undefined),
  )
}
export function addUsageTokens(values: UsageTokenTotals[]): UsageTokenTotals {
  return Object.fromEntries(
    tokenKeys
      .map((key) => [key, sumKnown(values.map((value) => value[key]))])
      .filter(([, amount]) => amount !== undefined),
  )
}
function highWater(previous: UsageTokenTotals, next: UsageTokenTotals): UsageTokenTotals {
  return Object.fromEntries(
    tokenKeys
      .map((key) => {
        const before = previous[key]
        const after = next[key]
        return [
          key,
          before === undefined ? after : after === undefined ? before : Math.max(before, after),
        ]
      })
      .filter(([, amount]) => amount !== undefined),
  )
}
function contextUsage(details: Record<string, unknown>): UsageContext | undefined {
  const usage = record(details.tokenUsage)
  const last = record(usage.last)
  const windowTokens = count(usage.modelContextWindow)
  const input = count(last.inputTokens)
  const output = count(last.outputTokens)
  const usedTokens =
    count(last.totalTokens) ??
    (input !== undefined && output !== undefined ? sumKnown([input, output]) : undefined)
  return windowTokens && usedTokens !== undefined
    ? { usedTokens, windowTokens, source: 'last-request' }
    : undefined
}
function claudeModels(value: unknown): UsageModelTotals[] {
  return Object.entries(record(value)).flatMap(([model, raw]) => {
    const item = record(raw)
    const tokens = usageTokens('claude', item)
    if (!Object.keys(tokens).length) return []
    const costBasis = ['list', 'managed', 'unknown'].includes(String(item.costBasis))
      ? (item.costBasis as UsageModelTotals['costBasis'])
      : undefined
    const estimatedCostUsd = costBasis === 'unknown' ? undefined : money(item.costUSD)
    return [
      {
        model,
        tokens,
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        ...(costBasis ? { costBasis } : {}),
      },
    ]
  })
}
interface SessionAccumulator {
  session: UsageSessionTotals
  cumulative: UsageTokenTotals
  models: Map<string, UsageModelTotals>
  /** The fallback main-loop usage is per-turn, even when cost is cumulative. */
  turns: Map<string, UsageTokenTotals>
  hasCumulative: boolean
}
function sessionKey(thread: Thread, message: Message, details: Record<string, unknown>): string {
  const remote = text(details.usageSessionId) || message.agentId || thread.remoteId || thread.id
  // Claude <2.1.277 did not restore session counters on a new process. Its
  // process UUID prevents losing spend when a resumed call starts at zero.
  const call = details.usageRestoresSessionTotals === false ? text(details.usageCallId) : undefined
  return JSON.stringify([thread.profileId, thread.provider, remote, call || 'session'])
}
/**
 * Aggregate retained native snapshots. Session counters use their high-water
 * mark; repeated results, resumed threads and imported copies are counted once.
 * Lifetime totals cannot be assigned to a date using a thread's updatedAt.
 */
export function savedUsageSessions(threads: Thread[]): UsageSessionTotals[] {
  const sessions = new Map<string, SessionAccumulator>()
  for (const thread of threads) {
    for (const message of thread.messages) {
      const details = record(message.details)
      const codexTotal = record(record(details.tokenUsage).total)
      const models =
        thread.provider === 'claude' ? claudeModels(details.modelUsage ?? details.model_usage) : []
      const main = thread.provider === 'claude' ? usageTokens('claude', details.usage) : {}
      const cumulative =
        thread.provider === 'codex'
          ? usageTokens('codex', codexTotal)
          : addUsageTokens(models.map((model) => model.tokens))
      const reportedCost = thread.provider === 'claude' ? money(details.total_cost_usd) : undefined
      if (
        !Object.keys(cumulative).length &&
        !Object.keys(main).length &&
        reportedCost === undefined
      )
        continue
      const id = sessionKey(thread, message, details)
      let accumulator = sessions.get(id)
      const observedAt = count(details.usageObservedAt) ?? message.createdAt ?? thread.updatedAt
      if (!accumulator) {
        accumulator = {
          session: {
            id,
            provider: thread.provider,
            profileId: thread.profileId,
            threadId: thread.id,
            title: message.agentName || thread.title,
            model: 'Not reported',
            observedAt,
            ...(message.agentId ? { agentId: message.agentId } : {}),
            tokens: {},
            models: [],
            tokenCoverage: 'main-agent',
            ...(thread.provider === 'claude' && details.usageRestoresSessionTotals === undefined
              ? { scopeUncertain: true }
              : {}),
          },
          cumulative: {},
          models: new Map(),
          turns: new Map(),
          hasCumulative: false,
        }
        sessions.set(id, accumulator)
      }
      if (observedAt >= accumulator.session.observedAt) {
        accumulator.session.observedAt = observedAt
        accumulator.session.threadId = thread.id
        accumulator.session.title = message.agentName || thread.title
        const context = contextUsage(details)
        if (context) accumulator.session.context = context
      }
      if (Object.keys(cumulative).length) {
        accumulator.hasCumulative = true
        accumulator.cumulative = highWater(accumulator.cumulative, cumulative)
      }
      for (const model of models) {
        const previous = accumulator.models.get(model.model)
        // costBasis describes the model's latest request. A later known rate
        // cannot validate guessed cost already included in cumulative costUSD.
        const costBasis = previous?.costBasis === 'unknown' ? 'unknown' : model.costBasis
        accumulator.models.set(model.model, {
          ...model,
          costBasis,
          tokens: highWater(previous?.tokens || {}, model.tokens),
          estimatedCostUsd:
            costBasis === 'unknown'
              ? undefined
              : model.estimatedCostUsd === undefined
                ? previous?.estimatedCostUsd
                : Math.max(previous?.estimatedCostUsd ?? 0, model.estimatedCostUsd),
        })
      }
      if (Object.keys(main).length) {
        const turnId = text(details.usageResultId) || message.turnId || String(message.turn)
        const turnKey = JSON.stringify([text(details.usageCallId) || 'session', turnId])
        accumulator.turns.set(turnKey, highWater(accumulator.turns.get(turnKey) || {}, main))
      }
      if (reportedCost !== undefined)
        accumulator.session.estimatedCostUsd = Math.max(
          accumulator.session.estimatedCostUsd ?? 0,
          reportedCost,
        )
    }
  }
  return [...sessions.values()]
    .map(({ session, cumulative, models, turns, hasCumulative }) => {
      const breakdown = [...models.values()]
      const unpricedModels = breakdown
        .filter((model) => model.costBasis === 'unknown')
        .map((model) => model.model)
      const allUnpriced = breakdown.length > 0 && unpricedModels.length === breakdown.length
      const modelCosts = breakdown.flatMap((model) =>
        model.estimatedCostUsd === undefined ? [] : [model.estimatedCostUsd],
      )
      return {
        ...session,
        tokens: hasCumulative ? cumulative : addUsageTokens([...turns.values()]),
        tokenCoverage: hasCumulative ? 'session' : 'main-agent',
        models: breakdown,
        model: breakdown.length ? breakdown.map((model) => model.model).join(', ') : 'Not reported',
        ...(unpricedModels.length ? { unpricedModels } : {}),
        estimatedCostUsd: allUnpriced
          ? undefined
          : ((unpricedModels.length ? undefined : session.estimatedCostUsd) ??
            (modelCosts.length ? modelCosts.reduce((sum, cost) => sum + cost, 0) : undefined)),
      } as UsageSessionTotals
    })
    .sort((a, b) => b.observedAt - a.observedAt)
}
export function usageSummary(sessions: UsageSessionTotals[]) {
  const costs = sessions.flatMap((session) =>
    session.estimatedCostUsd === undefined ? [] : [session.estimatedCostUsd],
  )
  return {
    tokens: addUsageTokens(sessions.map((session) => session.tokens)),
    estimatedCostUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : undefined,
    unpricedSessions: sessions.filter(
      (session) => session.estimatedCostUsd === undefined || session.unpricedModels?.length,
    ).length,
    mainAgentSessions: sessions.filter((session) => session.tokenCoverage === 'main-agent').length,
    partialTokenSessions: sessions.filter((session) => session.tokens.totalTokens === undefined)
      .length,
  }
}
export function formatUsageCount(value: number | undefined): string {
  return value === undefined ? 'Not reported' : value.toLocaleString()
}
export function formatUsageCost(value: number | undefined): string {
  return value === undefined
    ? 'Not reported'
    : new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value)
}
