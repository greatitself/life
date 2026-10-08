import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeGitPath, parseGitStatus, parseUnifiedDiff } from '../src/renderer/unified-diff'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('unified diff rendering data', () => {
  it('counts source changes and preserves separate old/new numbering across hunks', () => {
    const [file] = parseUnifiedDiff(
      [
        'diff --git a/src/index.ts b/src/index.ts',
        'index 123..456 100644',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -4,3 +4,4 @@ export function research() {',
        ' first',
        '-previous',
        '+replacement',
        '+++ source content starting with plus signs',
        ' last',
        '@@ -20 +21 @@',
        '-old end',
        '+new end',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    expect(file.path).toBe('src/index.ts')
    expect(file.additions).toBe(3)
    expect(file.removals).toBe(2)
    expect(file.hunks.map((hunk) => hunk.lines)).toEqual([
      [
        { kind: 'context', text: 'first', oldLine: 4, newLine: 4 },
        { kind: 'removed', text: 'previous', oldLine: 5 },
        { kind: 'added', text: 'replacement', newLine: 5 },
        { kind: 'added', text: '++ source content starting with plus signs', newLine: 6 },
        { kind: 'context', text: 'last', oldLine: 6, newLine: 7 },
      ],
      [
        { kind: 'removed', text: 'old end', oldLine: 20 },
        { kind: 'added', text: 'new end', newLine: 21 },
        { kind: 'annotation', text: '\\ No newline at end of file' },
      ],
    ])
    expect(file.hunks[1]).toMatchObject({ oldCount: 1, newCount: 1 })
  })

  it('handles added/deleted files with zero-length ranges and empty source lines', () => {
    const [added, deleted] = parseUnifiedDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+hello',
        '+',
        'diff --git a/old.ts b/old.ts',
        'deleted file mode 100644',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
      ].join('\n'),
    )
    expect(added).toMatchObject({ kind: 'added', path: 'new.ts', additions: 2, removals: 0 })
    expect(added.hunks[0]).toMatchObject({ oldCount: 0, newCount: 2 })
    expect(added.hunks[0].lines[1]).toEqual({ kind: 'added', text: '', newLine: 2 })
    expect(deleted).toMatchObject({ kind: 'deleted', path: 'old.ts', additions: 0, removals: 1 })
    expect(deleted.hunks[0]).toMatchObject({ oldCount: 1, newCount: 0 })
  })

  it('retains rename, binary and mode-only sections even when there are no source hunks', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old name.ts b/new name.ts',
        'similarity index 100%',
        'rename from old name.ts',
        'rename to new name.ts',
        'diff --git a/image.png b/image.png',
        'Binary files a/image.png and b/image.png differ',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
    )
    expect(files[0]).toMatchObject({
      path: 'new name.ts',
      previousPath: 'old name.ts',
      kind: 'renamed',
      hunks: [],
    })
    expect(files[1]).toMatchObject({
      path: 'image.png',
      kind: 'binary',
      metadata: ['Binary contents changed'],
    })
    expect(files[2]).toMatchObject({
      path: 'run.sh',
      kind: 'modified',
      metadata: ['old mode 100644', 'new mode 100755'],
    })
  })

  it('keeps malicious-looking source as plain text, including markup and header-like contents', () => {
    const [file] = parseUnifiedDiff(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+<img src=x onerror=alert(1)>\n+diff --git a/fake b/fake\n',
    )
    expect(file.additions).toBe(2)
    expect(file.hunks[0].lines.map((line) => line.text)).toEqual([
      '<img src=x onerror=alert(1)>',
      'diff --git a/fake b/fake',
    ])
  })

  it('parses real git output with spaces, quotes, Unicode and a header-like path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-diff-'))
    directories.push(directory)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' })
    git('init', '--quiet')
    const paths = ['src/a b/name.ts', 'quote "日本".ts', 'ordinary.ts']
    for (const path of paths) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), 'export const before = 1\n')
    }
    git('add', '.')
    git(
      '-c',
      'user.name=Life test',
      '-c',
      'user.email=life@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    )
    for (const path of paths) await writeFile(join(directory, path), 'export const after = 2\n')
    const output = git('-c', 'core.quotePath=false', 'diff', '--no-color', 'HEAD', '--')
    const files = parseUnifiedDiff(output)
    expect(files.map((file) => file.path).sort()).toEqual([...paths].sort())
    expect(files.every((file) => file.additions === 1 && file.removals === 1)).toBe(true)
    expect(files.every((file) => !file.previousPath)).toBe(true)
    const statuses = parseGitStatus(git('-c', 'core.quotePath=false', 'status', '--short'))
    expect(statuses.map((file) => file.path).sort()).toEqual([...paths].sort())
    expect(statuses.every((file) => file.status === ' M')).toBe(true)
  })
})

describe('git path and status decoding', () => {
  it('decodes octal UTF-8 and C escapes without altering ordinary paths', () => {
    expect(decodeGitPath('"quote \\"\\346\\227\\245\\346\\234\\254\\"\\t.ts"')).toBe(
      'quote "日本"\t.ts',
    )
    expect(decodeGitPath('"emoji 🚀.ts"')).toBe('emoji 🚀.ts')
    expect(decodeGitPath('my folder/index.ts')).toBe('my folder/index.ts')
  })

  it('preserves untracked/index/worktree states and decodes rename paths independently', () => {
    expect(
      parseGitStatus(
        [
          ' M src/index.ts',
          'A  added.ts',
          '?? new folder/file.ts',
          'R  "old \\"quoted\\".ts" -> "new \\"quoted\\".ts"',
          '?? arrow -> name.txt',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { status: ' M', path: 'src/index.ts', untracked: false },
      { status: 'A ', path: 'added.ts', untracked: false },
      { status: '??', path: 'new folder/file.ts', untracked: true },
      { status: 'R ', previousPath: 'old "quoted".ts', path: 'new "quoted".ts', untracked: false },
      { status: '??', path: 'arrow -> name.txt', untracked: true },
    ])
  })
})
