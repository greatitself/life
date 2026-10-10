import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import type { ConnectionProfile, Provider } from '../../shared/types'
import type { ProviderUsageSnapshot, UsageRateLimit, UsageRateWindow } from '../../shared/usage'
import type { Thread } from '../state'
import { errorText } from '../api'
import { formatUsageCost, formatUsageCount, savedUsageSessions, usageSummary } from '../usage'
import { Modal } from './Modal'
import './usage.css'

const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude Code' }
const providers: Provider[] = ['codex', 'claude']
type AccountState = { pending: boolean; snapshot?: ProviderUsageSnapshot; error?: string }

function windowName(window: UsageRateWindow, fallback: string) {
  const minutes = window.windowDurationMins
  if (!minutes) return fallback
  if (minutes % 10080 === 0) return `${minutes / 10080}-week window`
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}
function resetTime(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date)
    : undefined
}
function UsageWindow({ window, label }: { window: UsageRateWindow; label: string }) {
  const reset = resetTime(window.resetsAt)
  return (
    <div className="usage-window">
      <div>
        <span>{windowName(window, label)}</span>
        <strong>
          {window.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% used
        </strong>
      </div>
      <progress
        max={100}
        value={Math.min(100, Math.max(0, window.usedPercent))}
        aria-label={`${label} utilization`}
      />
      {reset ? <small>Resets {reset}</small> : <small>Reset time not reported</small>}
    </div>
  )
}
function RateLimit({ limit }: { limit: UsageRateLimit }) {
  return (
    <div className="usage-limit">
      <div className="usage-limit-heading">
        <strong>{limit.label || limit.id}</strong>
        {limit.planType ? <span>{limit.planType}</span> : null}
      </div>
      {limit.primary ? (
        <UsageWindow window={limit.primary} label={`${limit.label || limit.id} primary window`} />
      ) : null}
      {limit.secondary ? (
        <UsageWindow
          window={limit.secondary}
          label={`${limit.label || limit.id} secondary window`}
        />
      ) : null}
      {limit.credits ? (
        <p>
          {limit.credits.unlimited
            ? 'Unlimited credits reported'
            : limit.credits.balance !== undefined
              ? `Credits balance: ${limit.credits.balance}`
              : limit.credits.hasCredits
                ? 'Credits available; balance not reported'
                : 'No credits reported'}
        </p>
      ) : null}
      {limit.spendControlReached ? (
        <p className="usage-restriction">Provider reports that spend control has been reached.</p>
      ) : null}
      {limit.rateLimitReachedType ? <p>Limit status: {limit.rateLimitReachedType}</p> : null}
      {limit.normalModelSlug ? <p>Model: {limit.normalModelSlug}</p> : null}
      {limit.individualLimit ? (
        <p>
          Spend control: {limit.individualLimit.used} used of {limit.individualLimit.limit}
          {limit.individualLimit.remainingPercent !== undefined
            ? ` · ${limit.individualLimit.remainingPercent.toLocaleString()}% remaining`
            : ''}
          {resetTime(limit.individualLimit.resetsAt)
            ? ` · Resets ${resetTime(limit.individualLimit.resetsAt)}`
            : ''}
        </p>
      ) : null}
    </div>
  )
}
function accountSnapshot(value: unknown): ProviderUsageSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as ProviderUsageSnapshot
  return (item.provider === 'codex' || item.provider === 'claude') &&
    (item.status === 'available' || item.status === 'unavailable') &&
    typeof item.fetchedAt === 'number' &&
    Number.isFinite(item.fetchedAt) &&
    Array.isArray(item.limits)
    ? item
    : undefined
}
function AccountUsage({
  provider,
  state,
  connected,
}: {
  provider: Provider
  state: AccountState | undefined
  connected: boolean
}) {
  const snapshot = state?.snapshot
  return (
    <article
      className="usage-account"
      aria-label={`${providerNames[provider]} account usage`}
      aria-busy={state?.pending || false}
    >
      <div className="usage-account-heading">
        <h4>{providerNames[provider]}</h4>
        {state?.pending ? (
          <span role="status">Checking…</span>
        ) : snapshot?.accountType ? (
          <span>{snapshot.accountType}</span>
        ) : null}
      </div>
      {state?.error ? (
        <p role="alert" className="usage-error">
          {state.error}
        </p>
      ) : null}
      {snapshot?.ordinaryUsageAllowed !== undefined ? (
        <p className={snapshot.ordinaryUsageAllowed ? '' : 'usage-restriction'}>
          {snapshot.ordinaryUsageAllowed
            ? 'Provider reports ordinary usage available.'
            : 'Provider reports ordinary usage unavailable.'}
        </p>
      ) : null}
      {snapshot?.limits.map((limit) => (
        <RateLimit key={limit.id} limit={limit} />
      ))}
      {snapshot?.extraUsage ? (
        <div className="usage-limit">
          <strong>Extra usage</strong>
          <p>
            {snapshot.extraUsage.isEnabled ? 'Enabled' : 'Disabled'}
            {snapshot.extraUsage.usedCredits !== undefined
              ? ` · ${snapshot.extraUsage.usedCredits.toLocaleString()} credits used`
              : ''}
            {snapshot.extraUsage.monthlyLimit !== undefined
              ? ` of ${snapshot.extraUsage.monthlyLimit.toLocaleString()}`
              : ''}
            {snapshot.extraUsage.currency ? ` (${snapshot.extraUsage.currency})` : ''}
          </p>
          {snapshot.extraUsage.usedPercent !== undefined ? (
            <p>
              {snapshot.extraUsage.usedPercent.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}
              % used
            </p>
          ) : null}
        </div>
      ) : null}
      {snapshot?.availableResetCredits !== undefined ? (
        <p>Available reset credits: {snapshot.availableResetCredits.toLocaleString()}</p>
      ) : null}
      {snapshot?.message ? <p>{snapshot.message}</p> : null}
      {snapshot?.error ? (
        <p role="alert" className="usage-error">
          {snapshot.error}
        </p>
      ) : null}
      {!snapshot && !state?.pending && !state?.error ? (
        <p>
          {connected
            ? 'Account usage has not been reported.'
            : 'Connect to a machine to check account usage.'}
        </p>
      ) : null}
      {snapshot?.status === 'available' && !snapshot.limits.length && !snapshot.message ? (
        <p>No utilization windows were reported.</p>
      ) : null}
      {snapshot ? (
        <small>
          Reported {new Date(snapshot.fetchedAt).toLocaleString()}
          {!connected ? ' · Connect to refresh' : ''}
        </small>
      ) : null}
    </article>
  )
}

export function UsageDialog({
  open,
  onOpenChange,
  threads,
  profiles,
  activeThreadId,
  activeProfileId,
  activeMachineIdentity,
  connected,
  accountSnapshots,
  onReadUsage,
  onSelectThread,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: Thread[]
  profiles: ConnectionProfile[]
  activeThreadId?: string
  activeProfileId?: string
  activeMachineIdentity?: string
  connected: boolean
  accountSnapshots?: ProviderUsageSnapshot[]
  onReadUsage?: (provider: Provider) => Promise<ProviderUsageSnapshot>
  onSelectThread?: (threadId: string) => void
}) {
  const [machine, setMachine] = useState('all')
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [refresh, setRefresh] = useState(0)
  const machineIdentity = activeMachineIdentity || activeProfileId
  const [accounts, setAccounts] = useState<{
    profileId?: string
    machineIdentity?: string
    values: Partial<Record<Provider, AccountState>>
  }>({ values: {} })
  const readUsage = useRef(onReadUsage)
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement
  }, [open])
  useEffect(() => {
    readUsage.current = onReadUsage
  }, [onReadUsage])
  const sessions = useMemo(() => (open ? savedUsageSessions(threads) : []), [open, threads])
  const filtered = useMemo(
    () =>
      sessions.filter(
        (session) =>
          (machine === 'all' || session.profileId === machine) &&
          (provider === 'all' || session.provider === provider),
      ),
    [sessions, machine, provider],
  )
  const summary = useMemo(() => usageSummary(filtered), [filtered])
  // A retained import can be the representative row of a deduplicated native
  // session. Context still belongs to the actual selected conversation.
  const active = useMemo(() => {
    const thread = open ? threads.find((item) => item.id === activeThreadId) : undefined
    return thread
      ? savedUsageSessions([thread]).find((session) => !session.agentId && session.context)
      : undefined
  }, [open, threads, activeThreadId])
  const machineNames = useMemo(() => {
    const names = new Map(profiles.map((profile) => [profile.id, profile.name || profile.host]))
    for (const session of sessions)
      if (!names.has(session.profileId)) names.set(session.profileId, 'Saved machine')
    return names
  }, [profiles, sessions])
  const liveAccounts = useMemo(() => {
    const values: Partial<Record<Provider, ProviderUsageSnapshot>> = {}
    for (const thread of threads) {
      if (thread.profileId !== activeProfileId) continue
      const snapshot = accountSnapshot(thread.agentSettings?.accountUsage)
      if (
        snapshot &&
        (!activeMachineIdentity || snapshot.machineIdentity === activeMachineIdentity) &&
        (!values[snapshot.provider] || snapshot.fetchedAt > values[snapshot.provider]!.fetchedAt)
      )
        values[snapshot.provider] = snapshot
    }
    for (const snapshot of accountSnapshots || []) {
      if (activeMachineIdentity && snapshot.machineIdentity !== activeMachineIdentity) continue
      if (!values[snapshot.provider] || snapshot.fetchedAt > values[snapshot.provider]!.fetchedAt)
        values[snapshot.provider] = snapshot
    }
    return values
  }, [threads, activeProfileId, activeMachineIdentity, accountSnapshots])
  useEffect(() => {
    if (!open || !connected || !activeProfileId) return
    let disposed = false
    const read = readUsage.current
    if (!read) return
    setAccounts((previous) => ({
      profileId: activeProfileId,
      machineIdentity,
      values: Object.fromEntries(
        providers.map((name) => [
          name,
          {
            ...(previous.machineIdentity === machineIdentity ? previous.values[name] : {}),
            pending: true,
            error: undefined,
          },
        ]),
      ),
    }))
    void Promise.allSettled(
      providers.map(async (name) => {
        try {
          const snapshot = await read(name)
          if (
            activeMachineIdentity &&
            snapshot.machineIdentity &&
            snapshot.machineIdentity !== activeMachineIdentity
          )
            throw new Error(
              'Provider usage was reported for a different machine. Refresh limits to retry.',
            )
          if (!disposed)
            setAccounts((previous) =>
              previous.machineIdentity === machineIdentity
                ? {
                    ...previous,
                    values: { ...previous.values, [name]: { pending: false, snapshot } },
                  }
                : previous,
            )
        } catch (error) {
          if (!disposed)
            setAccounts((previous) =>
              previous.machineIdentity === machineIdentity
                ? {
                    ...previous,
                    values: {
                      ...previous.values,
                      [name]: { ...previous.values[name], pending: false, error: errorText(error) },
                    },
                  }
                : previous,
            )
        }
      }),
    )
    return () => {
      disposed = true
    }
  }, [open, connected, activeProfileId, machineIdentity, activeMachineIdentity, refresh])
  useEffect(() => {
    if (!open || !connected || !onReadUsage) return
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 60000)
    return () => window.clearInterval(timer)
  }, [open, connected, Boolean(onReadUsage)])
  const accountFor = (name: Provider): AccountState | undefined => {
    const value = accounts.machineIdentity === machineIdentity ? accounts.values[name] : undefined
    const live = liveAccounts[name]
    return live && (!value?.snapshot || live.fetchedAt > value.snapshot.fetchedAt)
      ? { ...value, pending: value?.pending || false, snapshot: live }
      : value
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Usage"
      description="Native provider usage from your saved Life sessions and the connected machine’s account."
      className="usage-modal"
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (opener.current?.isConnected) opener.current.focus()
      }}
    >
      <div className="usage-filters">
        <label>
          Machine
          <select
            aria-label="Usage machine"
            value={machine}
            onChange={(event) => setMachine(event.target.value)}
          >
            <option value="all">All saved machines</option>
            {[...machineNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            aria-label="Usage provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider | 'all')}
          >
            <option value="all">All providers</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <span>All retained sessions</span>
      </div>
      <section className="usage-summary" aria-label="Saved usage totals" aria-live="polite">
        <div>
          <span>Reported tokens</span>
          <strong data-usage="total-tokens">{formatUsageCount(summary.tokens.totalTokens)}</strong>
          <small>
            {filtered.length.toLocaleString()} native{' '}
            {filtered.length === 1 ? 'session' : 'sessions'}
          </small>
        </div>
        <div>
          <span>Provider cost estimate</span>
          <strong data-usage="estimated-cost">{formatUsageCost(summary.estimatedCostUsd)}</strong>
          <small>
            {summary.unpricedSessions
              ? `${summary.unpricedSessions} ${summary.unpricedSessions === 1 ? 'session has' : 'sessions have'} unreported or incomplete cost`
              : 'USD · provider estimate'}
          </small>
        </div>
        <div>
          <span>Cached input</span>
          <strong>{formatUsageCount(summary.tokens.cachedInputTokens)}</strong>
          <small>Included in input tokens</small>
        </div>
      </section>
      <dl className="usage-token-breakdown">
        <div>
          <dt>Input</dt>
          <dd>{formatUsageCount(summary.tokens.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{formatUsageCount(summary.tokens.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cache creation</dt>
          <dd>{formatUsageCount(summary.tokens.cacheCreationTokens)}</dd>
        </div>
        <div>
          <dt>Reasoning</dt>
          <dd>{formatUsageCount(summary.tokens.reasoningTokens)}</dd>
        </div>
      </dl>
      <p className="usage-explanation">
        Input includes cache reads and writes. Reasoning is included in output. Cost estimates are
        reported by the provider; subscription bills and unreported prices are not inferred.
      </p>
      {summary.mainAgentSessions ? (
        <p className="usage-explanation">
          {summary.mainAgentSessions}{' '}
          {summary.mainAgentSessions === 1 ? 'session reports' : 'sessions report'} main-agent
          tokens only; subagent tokens were not available.
        </p>
      ) : null}
      {summary.partialTokenSessions ? (
        <p className="usage-explanation">
          {summary.partialTokenSessions}{' '}
          {summary.partialTokenSessions === 1 ? 'session has' : 'sessions have'} incomplete token
          counts. Totals include only reported values.
        </p>
      ) : null}
      {filtered.some((session) => session.scopeUncertain) ? (
        <p className="usage-explanation">
          Some older records do not report whether session totals survive a restart. Their retained
          totals may be incomplete.
        </p>
      ) : null}
      {active?.context &&
      (machine === 'all' || machine === active.profileId) &&
      (provider === 'all' || provider === active.provider) ? (
        <section className="usage-context" aria-label="Current thread context">
          <div>
            <strong>Current thread context</strong>
            <span>
              {formatUsageCount(active.context.usedTokens)} /{' '}
              {formatUsageCount(active.context.windowTokens)} tokens
            </span>
          </div>
          <progress
            aria-label="Current thread context utilization"
            max={active.context.windowTokens}
            value={Math.min(active.context.windowTokens, active.context.usedTokens)}
          />
          <small>
            Last request ·{' '}
            {((active.context.usedTokens / active.context.windowTokens) * 100).toLocaleString(
              undefined,
              { maximumFractionDigits: 1 },
            )}
            % of the reported context window
          </small>
        </section>
      ) : null}
      <section className="usage-session-section" aria-label="Session usage">
        <h3>Saved sessions</h3>
        {filtered.length ? (
          <div className="usage-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Provider / machine</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Estimate</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((session) => (
                  <tr key={session.id}>
                    <td>
                      {onSelectThread ? (
                        <button
                          className="usage-thread-link"
                          onClick={() => {
                            onSelectThread(session.threadId)
                            onOpenChange(false)
                          }}
                        >
                          {session.title}
                          <ArrowUpRight size={12} />
                        </button>
                      ) : (
                        <strong>{session.title}</strong>
                      )}
                      <small>
                        {session.model}
                        {session.tokenCoverage === 'main-agent' ? ' · main agent only' : ''}
                      </small>
                      {session.models.length ? (
                        <details>
                          <summary>Model breakdown</summary>
                          <dl>
                            {session.models.map((model) => (
                              <div key={model.model}>
                                <dt>{model.model}</dt>
                                <dd>
                                  {formatUsageCount(model.tokens.totalTokens)} tokens ·{' '}
                                  {formatUsageCost(model.estimatedCostUsd)}
                                  {model.costBasis ? ` (${model.costBasis})` : ''}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      {providerNames[session.provider]}
                      <small>{machineNames.get(session.profileId) || 'Saved machine'}</small>
                    </td>
                    <td>{formatUsageCount(session.tokens.totalTokens)}</td>
                    <td>
                      {formatUsageCost(session.estimatedCostUsd)}
                      {session.unpricedModels?.length ? <small>Some models unpriced</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="usage-empty">
            No usage has been reported for this selection. Run an agent turn to begin tracking.
          </p>
        )}
      </section>
      <section className="usage-account-section" aria-label="Account limits">
        <div className="usage-section-heading">
          <div>
            <h3>Account limits</h3>
            <p>
              {activeProfileId
                ? `Connected machine · ${machineNames.get(activeProfileId) || 'Selected machine'}`
                : 'Connect to a machine to read its provider limits.'}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={
              !connected || !onReadUsage || providers.some((name) => accountFor(name)?.pending)
            }
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={14} />
            Refresh limits
          </button>
        </div>
        <div className="usage-accounts">
          {providers
            .filter((name) => provider === 'all' || provider === name)
            .map((name) => (
              <AccountUsage
                key={name}
                provider={name}
                state={accountFor(name)}
                connected={connected}
              />
            ))}
        </div>
        <p className="usage-explanation">
          Utilization and reset times are observations, not a guarantee that another request will be
          accepted.
        </p>
      </section>
      <p className="usage-footnote">
        Saved-session totals include the native usage retained in Life, including earlier spend
        restored by the provider. Work outside these sessions and deleted history are not included.
        Session totals are counted once across resumed turns; they are not assigned to dates.
      </p>
    </Modal>
  )
}
