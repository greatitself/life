export interface SourceFileSummary {
  path: string
  kind: 'edit' | 'write' | 'delete'
}

export interface SourceChangeSummary {
  summary: string
  files: SourceFileSummary[]
  dependencies: { name: string; version: string }[]
  baseRevision?: number
}

export interface SourceChangeReceipt extends SourceChangeSummary {
  status: 'applied' | 'failed'
  revision?: number
}

export type SourceMessagePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'source'
      summary: SourceChangeSummary
      raw: string
      complete: boolean
      malformed: boolean
    }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function revision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function describeSourcePatch(value: unknown): SourceChangeSummary {
  const patch = record(value)
  const files: SourceFileSummary[] = []
  if (patch && Array.isArray(patch.files))
    for (const value of patch.files.slice(0, 100)) {
      const file = record(value)
      if (typeof file?.path !== 'string' || !file.path) continue
      files.push({
        path: file.path.slice(0, 240),
        kind: file.content === null ? 'delete' : Array.isArray(file.edits) ? 'edit' : 'write',
      })
    }
  const dependencies: SourceChangeSummary['dependencies'] = []
  const packages = record(patch?.dependencies)
  if (packages)
    for (const [name, version] of Object.entries(packages).slice(0, 100))
      if (typeof version === 'string')
        dependencies.push({ name: name.slice(0, 240), version: version.slice(0, 100) })
  return {
    summary:
      typeof patch?.summary === 'string' && patch.summary.trim()
        ? patch.summary.slice(0, 2000)
        : 'Life source change',
    files,
    dependencies,
    baseRevision: revision(patch?.baseRevision),
  }
}

export function normalizeSourceChange(value: unknown): SourceChangeReceipt | undefined {
  const receipt = record(value)
  if (
    !receipt ||
    (receipt.status !== 'applied' && receipt.status !== 'failed') ||
    typeof receipt.summary !== 'string'
  )
    return undefined
  const files: SourceFileSummary[] = []
  if (Array.isArray(receipt.files))
    for (const value of receipt.files.slice(0, 100)) {
      const file = record(value)
      if (
        typeof file?.path !== 'string' ||
        !file.path ||
        (file.kind !== 'edit' && file.kind !== 'write' && file.kind !== 'delete')
      )
        continue
      files.push({ path: file.path.slice(0, 240), kind: file.kind })
    }
  const dependencies: SourceChangeSummary['dependencies'] = []
  if (Array.isArray(receipt.dependencies))
    for (const value of receipt.dependencies.slice(0, 100)) {
      const dependency = record(value)
      if (typeof dependency?.name === 'string' && typeof dependency.version === 'string')
        dependencies.push({
          name: dependency.name.slice(0, 240),
          version: dependency.version.slice(0, 100),
        })
    }
  return {
    summary: receipt.summary.slice(0, 2000),
    files,
    dependencies,
    status: receipt.status,
    baseRevision: revision(receipt.baseRevision),
    revision: revision(receipt.revision),
  }
}

export function withoutSourceReceiptNotice(text: string, receipt?: SourceChangeReceipt): string {
  if (!receipt) return text
  const notice =
    'Applied source extension: ' +
    receipt.summary +
    '. Disable, export, or share it in Manage extensions. The compiled interface will reload; your conversation is preserved.'
  return text.endsWith(notice) ? text.slice(0, -notice.length).trimEnd() : text
}

const tagName = ['life', 'source'].join('-')
const opening = '<' + tagName + '>'
const closing = '</' + tagName + '>'

function closingIndex(text: string, start: number): number {
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else {
      if (text.startsWith(closing, index)) return index
      if (character === '"') quoted = true
    }
  }
  return -1
}

function streamingSummary(raw: string): SourceChangeSummary {
  const result: SourceChangeSummary = {
    summary: 'Preparing a Life change',
    files: [],
    dependencies: [],
  }
  const title = /"summary"\s*:\s*("(?:\\.|[^"\\])*")/.exec(raw)
  if (title)
    try {
      const value: unknown = JSON.parse(title[1]!)
      if (typeof value === 'string' && value.trim()) result.summary = value.slice(0, 2000)
    } catch {
      // A partial scalar is not ready to display.
    }
  const paths = /"path"\s*:\s*("(?:\\.|[^"\\])*")/g
  let match: RegExpExecArray | null
  while (result.files.length < 100 && (match = paths.exec(raw)))
    try {
      const path: unknown = JSON.parse(match[1]!)
      if (typeof path === 'string' && path)
        result.files.push({ path: path.slice(0, 240), kind: 'edit' })
    } catch {
      // Keep receiving the remaining source.
    }
  return result
}

function sourcePart(
  raw: string,
  complete: boolean,
): Extract<SourceMessagePart, { kind: 'source' }> {
  let summary = streamingSummary(raw)
  let malformed = false
  if (complete)
    try {
      const value: unknown = JSON.parse(raw)
      const patch = record(value)
      if (!patch || typeof patch.summary !== 'string' || !Array.isArray(patch.files))
        malformed = true
      else summary = describeSourcePatch(patch)
    } catch {
      malformed = true
    }
  return { kind: 'source', raw, complete, malformed, summary }
}

export function splitSourceMessage(text: string): SourceMessagePart[] {
  const parts: SourceMessagePart[] = []
  let cursor = 0
  let plainStart = 0
  let fence: { character: string; length: number } | undefined
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor)
    const end = newline < 0 ? text.length : newline + 1
    const line = text.slice(cursor, end).replace(/\r?\n$/, '')
    const marker = /^ {0,3}((?:\x60){3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined
    } else if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }
    } else {
      const indent = /^ {0,3}/.exec(line)![0].length
      const start = cursor + indent
      if (text.startsWith(opening, start)) {
        const payloadStart = start + opening.length
        let first = payloadStart
        while (first < text.length && /\s/.test(text[first]!)) first++
        if (first === text.length || text[first] === '{') {
          if (start > plainStart) parts.push({ kind: 'text', text: text.slice(plainStart, start) })
          const close = closingIndex(text, payloadStart)
          parts.push(
            sourcePart(
              text.slice(payloadStart, close < 0 ? text.length : close).trim(),
              close >= 0,
            ),
          )
          cursor = close < 0 ? text.length : close + closing.length
          plainStart = cursor
          continue
        }
      }
    }
    cursor = end
  }
  if (plainStart < text.length) parts.push({ kind: 'text', text: text.slice(plainStart) })
  return parts
}
