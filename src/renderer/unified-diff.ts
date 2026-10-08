export type DiffLineKind = 'context' | 'added' | 'removed' | 'annotation'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  previousPath?: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'
  additions: number
  removals: number
  hunks: DiffHunk[]
  metadata: string[]
}

export interface GitChange {
  status: string
  path: string
  previousPath?: string
  untracked: boolean
}

/** Git uses C-style quoting for paths containing control characters or quotes. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escaped: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '\\': 92,
    '"': 34,
  }
  for (let index = 1; index < value.length - 1;) {
    if (value[index] !== '\\') {
      const codePoint = value.codePointAt(index)!
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)))
      index += codePoint > 0xffff ? 2 : 1
      continue
    }
    index++
    const octal = value.slice(index).match(/^[0-7]{1,3}/)
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      index += octal[0].length
    } else {
      const character = value[index++]
      if (character !== undefined) bytes.push(escaped[character] ?? character.charCodeAt(0))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function filePath(value: string): string | undefined {
  // Git appends a tab separator to ---/+++ paths containing spaces. A tab inside
  // an actual filename is C-escaped, so this also handles timestamp suffixes.
  const decoded = decodeGitPath(value.split('\t', 1)[0])
  if (decoded === '/dev/null') return undefined
  return decoded.replace(/^[ab]\//, '')
}

function headerPaths(header: string): [string | undefined, string | undefined] {
  const paths = header.slice('diff --git '.length)
  const quoted = paths.match(/^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*"|b\/.*)$/)
  if (quoted) return [filePath(quoted[1]), filePath(quoted[2])]
  // Ordinary spaces are not necessarily quoted by git. File headers below remain authoritative.
  const separator = paths.indexOf(' b/')
  if (separator !== -1)
    return [filePath(paths.slice(0, separator)), filePath(paths.slice(separator + 1))]
  return [undefined, undefined]
}

/** Parse unified git output without treating file headers as source additions/deletions. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [previousPath, path] = headerPaths(line)
      file = {
        path: path ?? previousPath ?? 'Changed file',
        kind: 'modified',
        additions: 0,
        removals: 0,
        hunks: [],
        metadata: [],
      }
      if (previousPath && previousPath !== path) file.previousPath = previousPath
      files.push(file)
      hunk = undefined
      continue
    }
    if (!file) continue
    const range = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (range) {
      oldLine = Number(range[1])
      newLine = Number(range[3])
      hunk = {
        header: line,
        oldStart: oldLine,
        oldCount: range[2] === undefined ? 1 : Number(range[2]),
        newStart: newLine,
        newCount: range[4] === undefined ? 1 : Number(range[4]),
        lines: [],
      }
      file.hunks.push(hunk)
      continue
    }
    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'added', text: line.slice(1), newLine: newLine++ })
        file.additions++
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'removed', text: line.slice(1), oldLine: oldLine++ })
        file.removals++
      } else if (line.startsWith(' ')) {
        hunk.lines.push({
          kind: 'context',
          text: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        })
      } else if (line.startsWith('\\')) {
        hunk.lines.push({ kind: 'annotation', text: line })
      }
      continue
    }
    if (line.startsWith('--- ')) {
      const previousPath = filePath(line.slice(4))
      if (!previousPath) file.kind = 'added'
      else if (previousPath !== file.path) file.previousPath = previousPath
    } else if (line.startsWith('+++ ')) {
      const path = filePath(line.slice(4))
      if (!path) file.kind = 'deleted'
      else file.path = path
      if (file.previousPath === file.path) delete file.previousPath
    } else if (line.startsWith('rename from ')) {
      file.previousPath = decodeGitPath(line.slice(12))
      file.kind = 'renamed'
    } else if (line.startsWith('rename to ')) {
      file.path = decodeGitPath(line.slice(10))
      file.kind = 'renamed'
    } else if (line.startsWith('new file mode ')) {
      file.kind = 'added'
      file.metadata.push(line)
    } else if (line.startsWith('deleted file mode ')) {
      file.kind = 'deleted'
      file.metadata.push(line)
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.kind = 'binary'
      file.metadata.push('Binary contents changed')
    } else if (/^(old mode|new mode|similarity index|dissimilarity index) /.test(line)) {
      file.metadata.push(line)
    }
  }
  return files
}

/** Keep porcelain's two status columns and decode rename paths independently. */
export function parseGitStatus(status: string): GitChange[] {
  return status
    .split('\n')
    .filter((line) => line.length >= 4 && line.trim())
    .map((line) => {
      const code = line.slice(0, 2)
      const value = line.slice(3)
      if (/[RC]/.test(code)) {
        const rename = value.match(/^("(?:\\.|[^"\\])*"|.*?) -> (.*)$/)
        if (rename)
          return {
            status: code,
            previousPath: decodeGitPath(rename[1]),
            path: decodeGitPath(rename[2]),
            untracked: false,
          }
      }
      return { status: code, path: decodeGitPath(value), untracked: code === '??' }
    })
}
