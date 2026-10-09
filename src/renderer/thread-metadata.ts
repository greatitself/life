import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { ConnectionState, Provider } from '../shared/types'
import type { Thread } from './state'
import { api } from './api'

export interface ThreadMetadata {
  gitBranch?: string
  gitHost?: string
  gitObservedAt?: number
  pullRequest?: { number: number; title: string; url: string }
}
/** Provider output annotations stay separate from the user's literal message. */
export interface MessageMetadata {
  phase?: 'commentary' | 'final_answer'
  kind?: 'reasoning' | 'plan' | 'subagent' | 'status' | 'attachment' | 'event'
  agentId?: string
  agentName?: string
  parentItemId?: string
  turnId?: string
  parentAgentId?: string
  provider?: Provider
  details?: Record<string, unknown>
  submission?: 'message' | 'steering'
}
export interface ResearchThreadContext {
  scopeKey: string
  goalId: string
  problemId?: string
}
export interface ImportedThreadHistory {
  provider: Provider
  remoteId: string
  importedAt: number
  nextCursor?: string
}
function clean(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined
}
export function normalizeMessageMetadata(value: unknown): MessageMetadata {
  if (!value || typeof value !== 'object') return {}
  const item = value as Record<string, unknown>
  const metadata: MessageMetadata = {}
  if (item.phase === 'commentary' || item.phase === 'final_answer') metadata.phase = item.phase
  if (
    ['reasoning', 'plan', 'subagent', 'status', 'attachment', 'event'].includes(String(item.kind))
  )
    metadata.kind = item.kind as MessageMetadata['kind']
  for (const key of ['agentId', 'agentName', 'parentItemId', 'turnId', 'parentAgentId'] as const) {
    const result = clean(item[key], 2000)
    if (result) metadata[key] = result
  }
  if (item.provider === 'codex' || item.provider === 'claude') metadata.provider = item.provider
  if (item.details && typeof item.details === 'object' && !Array.isArray(item.details))
    metadata.details = item.details as Record<string, unknown>
  if (item.submission === 'message' || item.submission === 'steering')
    metadata.submission = item.submission
  return metadata
}
export function normalizeImportedThreadHistory(value: unknown): ImportedThreadHistory | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const remoteId = clean(item.remoteId, 2000)
  if (
    (item.provider !== 'codex' && item.provider !== 'claude') ||
    !remoteId ||
    typeof item.importedAt !== 'number' ||
    !Number.isFinite(item.importedAt) ||
    item.importedAt <= 0
  )
    return undefined
  const nextCursor = clean(item.nextCursor, 16000)
  return {
    provider: item.provider,
    remoteId,
    importedAt: item.importedAt,
    ...(nextCursor ? { nextCursor } : {}),
  }
}
export function normalizeResearchThreadContext(value: unknown): ResearchThreadContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const scopeKey = clean(item.scopeKey, 4096)
  const goalId = clean(item.goalId, 2000)
  const problemId = clean(item.problemId, 2000)
  return scopeKey && goalId ? { scopeKey, goalId, ...(problemId ? { problemId } : {}) } : undefined
}
export function normalizeThreadMetadata(value: unknown): ThreadMetadata {
  if (!value || typeof value !== 'object') return {}
  const item = value as Record<string, unknown>
  const result: ThreadMetadata = {}
  result.gitBranch = clean(item.gitBranch, 400)
  result.gitHost = clean(item.gitHost, 1000)
  if (
    typeof item.gitObservedAt === 'number' &&
    Number.isFinite(item.gitObservedAt) &&
    item.gitObservedAt > 0
  )
    result.gitObservedAt = item.gitObservedAt
  if (item.pullRequest && typeof item.pullRequest === 'object') {
    const pr = item.pullRequest as Record<string, unknown>
    const title = clean(pr.title, 1000)
    const url = clean(pr.url, 4096)
    if (
      typeof pr.number === 'number' &&
      Number.isSafeInteger(pr.number) &&
      pr.number > 0 &&
      title &&
      url &&
      /^https:\/\/github\.com\/[^\s]+\/pull\/\d+(?:[?#].*)?$/.test(url)
    )
      result.pullRequest = { number: pr.number, title, url }
  }
  return result
}

/** Read the selected project only; retain observations for other projects. */
export function useThreadMetadata(
  connection: ConnectionState,
  refreshKey: number,
  threadCount: number,
  onThreads: Dispatch<SetStateAction<Thread[]>>,
  enabled = true,
) {
  useEffect(() => {
    const client = api
    const profile = connection.profile
    const workspace = connection.workspace
    if (!enabled || !client || connection.status !== 'connected' || !profile || !workspace) return
    let disposed = false
    let reading = false
    const matches = (state: ConnectionState) =>
      state.status === 'connected' &&
      state.profile?.id === profile.id &&
      state.workspace === workspace
    const off = client.onConnection((state) => {
      if (!matches(state)) disposed = true
    })
    const read = async () => {
      if (disposed || reading) return
      reading = true
      try {
        if (!matches(await client.connection.state()) || disposed) return
        const output = await client.connection.execute({
          workspace,
          timeoutMs: 15000,
          command: [
            "printf 'LIFE_BRANCH='",
            "git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || printf '\\n'",
            "printf '\\nLIFE_PR='",
            'if command -v gh >/dev/null 2>&1; then gh pr view --json number,title,url 2>/dev/null || true; fi',
          ].join('\n'),
        })
        if (disposed || !matches(await client.connection.state())) return
        const gitBranch = output.match(/^LIFE_BRANCH=([^\r\n]*)/m)?.[1].trim() || undefined
        let pullRequest: unknown
        const prText = output.split('LIFE_PR=')[1]?.trim()
        if (prText) {
          try {
            pullRequest = JSON.parse(prText)
          } catch {
            /* No PR metadata was returned. */
          }
        }
        const metadata = normalizeThreadMetadata({
          gitBranch,
          gitHost: profile.host,
          gitObservedAt: Date.now(),
          pullRequest,
        })
        onThreads((previous) =>
          previous.map((thread) =>
            thread.profileId === profile.id && thread.workspace === workspace
              ? { ...thread, ...metadata }
              : thread,
          ),
        )
      } catch {
        /* Keep the last observation when the machine is unavailable. */
      } finally {
        reading = false
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 60000)
    const focus = () => void read()
    window.addEventListener('focus', focus)
    return () => {
      disposed = true
      off()
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [
    connection.status,
    connection.profile?.id,
    connection.workspace,
    refreshKey,
    threadCount,
    onThreads,
    enabled,
  ])
}
