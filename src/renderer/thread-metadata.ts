import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { ConnectionState } from '../shared/types'
import type { Thread } from './state'
import { api } from './api'

export interface ThreadMetadata {
  gitBranch?: string
  gitHost?: string
  gitObservedAt?: number
  pullRequest?: { number: number; title: string; url: string }
}
function clean(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined
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
) {
  useEffect(() => {
    const client = api
    const profile = connection.profile
    const workspace = connection.workspace
    if (!client || connection.status !== 'connected' || !profile || !workspace) return
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
  ])
}
