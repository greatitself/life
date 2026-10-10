import type { Provider } from './types'

/** Native provider account data. Percentages and reset times never imply access. */
export interface UsageRateWindow {
  /** Absent when the provider reports only a reset time or other metadata. */
  usedPercent?: number
  windowDurationMins?: number
  /** Unix seconds, as reported by the provider. */
  resetsAt?: number
}
export interface UsageRateLimit {
  id: string
  label?: string
  planType?: string
  primary?: UsageRateWindow
  secondary?: UsageRateWindow
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string }
  spendControlReached?: boolean
  rateLimitReachedType?: string
  normalModelSlug?: string
  individualLimit?: {
    limit: string
    used: string
    remainingPercent?: number
    resetsAt?: number
  }
}
export interface ProviderUsageSnapshot {
  provider: Provider
  machineIdentity?: string
  status: 'available' | 'unavailable'
  fetchedAt: number
  limits: UsageRateLimit[]
  ordinaryUsageAllowed?: boolean
  availableResetCredits?: number
  extraUsage?: {
    isEnabled: boolean
    /** Native Claude spend-cap amounts are minor units of the reported currency. */
    amountUnit?: 'minor-currency'
    monthlyLimit?: number
    usedCredits?: number
    usedPercent?: number
    currency?: string
  }
  accountType?: string
  /** Opaque native account identity; never infer it from the machine profile. */
  accountId?: string
  account?: {
    email?: string
    organization?: string
    authMethod?: string
    apiProvider?: string
    tokenSource?: string
    apiKeySource?: string
  }
  message?: string
  error?: string
}

/** Input includes cache reads and writes; reasoning is a subset of output. */
export interface UsageTokenTotals {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}
export interface UsageModelTotals {
  model: string
  tokens: UsageTokenTotals
  estimatedCostUsd?: number
  costBasis?: 'list' | 'managed' | 'unknown'
}
export interface UsageContext {
  usedTokens: number
  windowTokens: number
  /** Last request, rather than lifetime session spend. */
  source: 'last-request'
}
export interface UsageSessionTotals {
  id: string
  provider: Provider
  profileId: string
  threadId: string
  title: string
  model: string
  observedAt: number
  agentId?: string
  tokens: UsageTokenTotals
  models: UsageModelTotals[]
  estimatedCostUsd?: number
  tokenCoverage: 'session' | 'main-agent'
  context?: UsageContext
  /** Some old provider versions reset counters on resume. */
  scopeUncertain?: boolean
  /** Known token usage whose provider could not price. */
  unpricedModels?: string[]
}
