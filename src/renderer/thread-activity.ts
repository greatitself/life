import { formatPatch, structuredPatch } from 'diff'
import type { LifeSourceContext, LifeSourcePatch } from '../shared/source-code'
import type { Message } from './state'
import { parseUnifiedDiff } from './unified-diff'

export interface ThreadFileChange {
  path: string
  additions?: number
  removals?: number
  kind?: string
  diff?: string
  truncated?: boolean
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000

export function normalizeFileChanges(value: unknown): ThreadFileChange[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap((value) => {
    const row = record(value)
    if (
      typeof row.path !== 'string' ||
      !row.path ||
      row.path.length > 4096 ||
      /[\x00-\x1f]/.test(row.path)
    )
      return []
    return [
      {
        path: row.path,
        ...(validCount(row.additions) ? { additions: row.additions } : {}),
        ...(validCount(row.removals) ? { removals: row.removals } : {}),
        ...(typeof row.kind === 'string' ? { kind: row.kind.slice(0, 40) } : {}),
        ...(typeof row.diff === 'string' ? { diff: row.diff.slice(0, 12_000) } : {}),
        ...(row.truncated === true || (typeof row.diff === 'string' && row.diff.length > 12_000)
          ? { truncated: true }
          : {}),
      },
    ]
  })
}

const maximumDiffCharacters = 128_000
const cachedToolChanges = new WeakMap<Message, ThreadFileChange[]>()

function compareContents(
  path: string,
  before: string,
  after: string,
  deadline = Date.now() + 12,
): ThreadFileChange {
  // Provider edit strings can be megabytes long or entirely different. Diffing them
  // has quadratic worst-case cost; a preview must never stall the conversation.
  const remaining = deadline - Date.now()
  if (before.length + after.length > maximumDiffCharacters || remaining <= 0)
    return { path, truncated: true }
  const structured = structuredPatch(path, path, before, after, undefined, undefined, {
    context: 3,
    timeout: Math.min(8, remaining),
    maxEditLength: 512,
  })
  if (!structured) return { path, truncated: true }
  let additions = 0
  let removals = 0
  for (const hunk of structured.hunks)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  const patch = formatPatch(structured)
  return {
    path,
    additions,
    removals,
    diff: patch.slice(0, 12_000),
    truncated: patch.length > 12_000,
  }
}

export function summarizeSourceChanges(
  patch: LifeSourcePatch,
  source?: LifeSourceContext,
): ThreadFileChange[] {
  const deadline = Date.now() + 16
  return patch.files.map((file) => {
    const original = source?.files.find((item) => item.path === file.path)
    const newFile = Boolean(source && !source.paths.includes(file.path))
    const before = original?.content ?? (newFile ? '' : undefined)
    let after: string | undefined
    if (file.content !== undefined) after = file.content ?? ''
    else if (before !== undefined) {
      after = before
      for (const edit of file.edits || []) {
        const position = after.indexOf(edit.find)
        if (position < 0 || after.indexOf(edit.find, position + edit.find.length) !== -1) {
          after = undefined
          break
        }
        after = after.slice(0, position) + edit.replace + after.slice(position + edit.find.length)
      }
    }
    return {
      ...(before !== undefined && after !== undefined
        ? compareContents(file.path, before, after, deadline)
        : { path: file.path }),
      kind: file.content === null ? 'deleted' : newFile ? 'added' : 'modified',
    }
  })
}

export function isSubagentActivity(message: Message): boolean {
  return (
    message.role === 'tool' &&
    (message.kind === 'subagent' ||
      /(?:collabAgent|(?:spawn|send|wait|close|resume|interrupt|followup)[_-]?(?:agent|message|task)|agent[_-]?spawn|^Agent$|^Task(?:Output|Stop)?$|^wait$)/i.test(
        message.title || '',
      ))
  )
}
export function isSubagentLaunch(message: Message): boolean {
  return (
    message.role === 'tool' &&
    /(?:spawn[_-]?agent|agent[_-]?spawn|^Agent$|^Task$)/i.test(message.title || '')
  )
}
export function subagentTitle(message: Message): string {
  if (message.agentName) return message.agentName
  try {
    const input = record(JSON.parse(message.input || 'null'))
    const description = input.task_name || input.description || input.name || input.subagent_type
    if (typeof description === 'string' && description.trim()) return description.slice(0, 180)
  } catch {
    /* Older or provider-specific events may have no structured input. */
  }
  return message.title || 'Subagent activity'
}

export function reportedFileChanges(
  messages: Message[],
  saved?: ThreadFileChange[],
): ThreadFileChange[] {
  if (saved?.length) return saved
  const changes: ThreadFileChange[] = []
  const deadline = Date.now() + 16
  for (const message of messages) {
    if (
      message.role !== 'tool' ||
      ['failed', 'interrupted', 'running'].includes(message.status || '')
    )
      continue
    const cached = cachedToolChanges.get(message)
    if (cached) {
      changes.push(...cached)
      continue
    }
    const messageChanges: ThreadFileChange[] = []
    if (message.title === 'Editing files') {
      try {
        const data: unknown = JSON.parse(message.text)
        const rows = Array.isArray(data)
          ? data
          : Array.isArray(record(data).changes)
            ? (record(data).changes as unknown[])
            : [data]
        for (const value of rows.slice(0, 100)) {
          const row = record(value)
          if (typeof row.path !== 'string') continue
          const diff = typeof row.diff === 'string' ? row.diff : undefined
          const parsed =
            diff && diff.length <= maximumDiffCharacters
              ? parseUnifiedDiff(
                  diff.startsWith('diff --git ')
                    ? diff
                    : `diff --git a/${row.path} b/${row.path}\n--- a/${row.path}\n+++ b/${row.path}\n${diff}`,
                )
              : []
          const hasHunks = parsed.some((file) => file.hunks.length)
          messageChanges.push({
            path: row.path,
            kind:
              typeof row.kind === 'string'
                ? row.kind
                : typeof record(row.kind).type === 'string'
                  ? (record(row.kind).type as string)
                  : undefined,
            ...(hasHunks
              ? {
                  additions: parsed.reduce((sum, file) => sum + file.additions, 0),
                  removals: parsed.reduce((sum, file) => sum + file.removals, 0),
                }
              : {}),
            diff: diff?.slice(0, 12_000),
            truncated: Boolean(diff && diff.length > 12_000),
          })
        }
      } catch {
        /* Render only paths actually reported by the provider. */
      }
    } else if (/^(Edit|Write|MultiEdit)$/i.test(message.title || '')) {
      try {
        const input = record(JSON.parse(message.input || 'null'))
        if (typeof input.file_path !== 'string') continue
        if (
          message.title?.toLowerCase() === 'edit' &&
          input.replace_all !== true &&
          typeof input.old_string === 'string' &&
          typeof input.new_string === 'string'
        )
          messageChanges.push(
            compareContents(input.file_path, input.old_string, input.new_string, deadline),
          )
        else messageChanges.push({ path: input.file_path })
      } catch {
        /* Unstructured tool output remains available in activity. */
      }
    }
    const normalized = normalizeFileChanges(messageChanges)
    cachedToolChanges.set(message, normalized)
    changes.push(...normalized)
  }
  const merged = new Map<string, ThreadFileChange>()
  for (const change of normalizeFileChanges(changes)) {
    const previous = merged.get(change.path)
    if (!previous) {
      merged.set(change.path, change)
      continue
    }
    const diff = [previous.diff, change.diff].filter(Boolean).join('\n')
    merged.set(change.path, {
      path: change.path,
      kind: change.kind || previous.kind,
      additions:
        previous.additions !== undefined && change.additions !== undefined
          ? previous.additions + change.additions
          : undefined,
      removals:
        previous.removals !== undefined && change.removals !== undefined
          ? previous.removals + change.removals
          : undefined,
      diff: diff.slice(0, 12_000) || undefined,
      truncated: previous.truncated || change.truncated || diff.length > 12_000,
    })
  }
  return [...merged.values()]
}
