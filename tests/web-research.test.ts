import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import {
  exportWebResearchFiles,
  initializeWebResearchExample,
  performWebResearchOperation,
  WEB_PREVIEW_HOME,
  WEB_PREVIEW_PROFILE_ID,
} from '../src/renderer/web-research'
import type { ResearchScope } from '../src/renderer/research-storage'
import {
  analyzeResearchMethod,
  normalizeResearchMethod,
  researchOperationCatalog,
  type ResearchMethod,
} from '../src/shared/research-method'

const storageKey = 'life.web.research.files.v1'
const scope: ResearchScope = {
  key: JSON.stringify(['research', WEB_PREVIEW_PROFILE_ID, WEB_PREVIEW_HOME]),
  profileId: WEB_PREVIEW_PROFILE_ID,
  workspace: WEB_PREVIEW_HOME,
  root: '/browser/.life/research',
  host: 'browser.local',
}
let stored: Map<string, string>
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const encode = (value: string | Uint8Array) => Buffer.from(value).toString('base64')
function goal(title = 'A measurable goal') {
  return {
    id: 'goal-one',
    title,
    goal: 'Investigate requirements using measured evidence.',
    problems: [
      { id: 'problem-a', title: 'Accuracy', description: '', notes: '', status: 'open' },
      { id: 'problem-b', title: 'Latency', description: '', notes: '', status: 'blocked' },
    ],
    createdAt: 1,
    updatedAt: 2,
    extra: { keep: true },
  }
}
function call<T>(input: Record<string, unknown>) {
  return performWebResearchOperation<T>(scope, input)
}
async function stage(contents: string | Uint8Array) {
  const id = randomUUID()
  const bytes = Buffer.from(contents)
  for (let offset = 0; offset < bytes.length; offset += 32768)
    await call({
      op: 'stage',
      stage: id,
      offset,
      data: encode(bytes.subarray(offset, offset + 32768)),
    })
  return id
}
async function write(contents: string, directory = 'goal-one', expected: string | null = null) {
  return call<{ revision: string }>({
    op: 'commit',
    stage: await stage(contents),
    directory,
    expected,
  })
}

beforeEach(() => {
  stored = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, String(value)),
  })
  vi.stubGlobal('crypto', webcrypto)
  // Exercise the fallback used when Web Locks are unavailable as well as the
  // browser lock path below. No DOM, SSH, or real account data is required.
  vi.stubGlobal('navigator', {})
})
afterEach(() => vi.unstubAllGlobals())

describe('browser Research file transactions', () => {
  it('accepts exactly one concurrent replacement of the same expected revision', async () => {
    const original = JSON.stringify(goal())
    const saved = await write(original)
    const first = JSON.stringify(goal('First edit'))
    const second = JSON.stringify(goal('Second edit'))
    const stages = await Promise.all([stage(first), stage(second)])
    const results = await Promise.allSettled(
      stages.map((id) =>
        call({ op: 'commit', stage: id, directory: 'goal-one', expected: saved.revision }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' && rejected.reason.message).toBe(
      'RESEARCH_CHANGED',
    )
    expect([first, second]).toContain(exportWebResearchFiles()['goal-one/goal.json'])
    // A rejected transaction must release the queue for later operations.
    expect((await call<{ entries: unknown[] }>({ op: 'scan' })).entries).toHaveLength(1)
  })

  it('preserves unrelated goals during concurrent whole-store writes', async () => {
    const existing = JSON.stringify(goal('Existing goal'))
    await write(existing, 'existing')
    await Promise.all(
      ['new-a', 'new-b', 'new-c'].map((directory) =>
        write(JSON.stringify({ ...goal(directory), id: directory }), directory),
      ),
    )
    const files = exportWebResearchFiles()
    expect(files['existing/goal.json']).toBe(existing)
    expect(Object.keys(files).sort()).toEqual([
      'existing/goal.json',
      'new-a/goal.json',
      'new-b/goal.json',
      'new-c/goal.json',
    ])
  })

  it('uses the same browser lock for independently loaded tabs', async () => {
    const names: string[] = []
    let lockTail: Promise<unknown> = Promise.resolve()
    const request = (name: string, run: () => unknown) => {
      names.push(name)
      const next = lockTail.then(run, run)
      lockTail = next.catch(() => {})
      return next
    }
    vi.stubGlobal('navigator', { locks: { request } })
    const saved = await write(JSON.stringify(goal()))
    vi.resetModules()
    const otherTab = await import('../src/renderer/web-research')
    const ourStage = await stage(JSON.stringify(goal('First tab')))
    const theirStage = randomUUID()
    await otherTab.performWebResearchOperation(scope, {
      op: 'stage',
      stage: theirStage,
      offset: 0,
      data: encode(JSON.stringify(goal('Second tab'))),
    })
    const results = await Promise.allSettled([
      call({ op: 'commit', stage: ourStage, directory: 'goal-one', expected: saved.revision }),
      otherTab.performWebResearchOperation(scope, {
        op: 'commit',
        stage: theirStage,
        directory: 'goal-one',
        expected: saved.revision,
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(new Set(names)).toEqual(new Set(['life.web.research.files']))
  })

  it('round-trips UTF-8 across chunk boundaries with a byte-based revision', async () => {
    const content = JSON.stringify({ ...goal(), notes: 'A'.repeat(32750) + '🧪证据'.repeat(9000) })
    const saved = await write(content)
    expect(saved.revision).toBe(hash(content))
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const part = await call<{ revision: string; data: string; done: boolean }>({
        op: 'read',
        directory: 'goal-one',
        file: 'goal.json',
        offset,
        expected: saved.revision,
      })
      const bytes = Buffer.from(part.data, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(32768)
      expect(part.revision).toBe(saved.revision)
      chunks.push(bytes)
      offset += bytes.length
      if (part.done) break
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content)
    expect(offset).toBe(Buffer.byteLength(content))
  })

  it('rejects a stale paged read after a committed change', async () => {
    const saved = await write(JSON.stringify(goal()))
    await write(JSON.stringify(goal('Changed')), 'goal-one', saved.revision)
    await expect(
      call({
        op: 'read',
        directory: 'goal-one',
        file: 'goal.json',
        offset: 0,
        expected: saved.revision,
      }),
    ).rejects.toThrow('RESEARCH_CHANGED')
  })

  it('rejects overlapping or skipped chunks without corrupting the staged bytes', async () => {
    const id = randomUUID()
    const content = JSON.stringify(goal())
    const split = 15
    await call({ op: 'stage', stage: id, offset: 0, data: encode(content.slice(0, split)) })
    for (const offset of [0, split - 1, split + 1, -1, 0.5])
      await expect(
        call({ op: 'stage', stage: id, offset, data: encode(content.slice(split)) }),
      ).rejects.toThrow('Invalid write chunk')
    await call({ op: 'stage', stage: id, offset: split, data: encode(content.slice(split)) })
    await call({ op: 'commit', stage: id, directory: 'goal-one', expected: null })
    expect(exportWebResearchFiles()['goal-one/goal.json']).toBe(content)
  })

  it('rejects oversized chunks and files while retaining the current goal', async () => {
    const original = JSON.stringify(goal())
    const saved = await write(original)
    await expect(
      call({ op: 'stage', stage: randomUUID(), offset: 0, data: encode(new Uint8Array(32769)) }),
    ).rejects.toThrow('Invalid write chunk')
    stored.set(storageKey, JSON.stringify({ 'goal-one/goal.json': '🧪'.repeat(1_000_001) }))
    await expect(call({ op: 'scan' })).rejects.toThrow('Research file exceeds 4 MB')
    stored.set(storageKey, JSON.stringify({ 'goal-one/goal.json': original }))
    expect(
      (await call<{ entries: { revision: string }[] }>({ op: 'scan' })).entries[0].revision,
    ).toBe(saved.revision)
  })

  it('rejects malformed UTF-8 and invalid JSON without replacing existing contents', async () => {
    const original = JSON.stringify(goal())
    const saved = await write(original)
    for (const bytes of [new Uint8Array([0xc3, 0x28]), Buffer.from('{"id":"incomplete"}')]) {
      const id = await stage(bytes)
      await expect(
        call({ op: 'commit', stage: id, directory: 'goal-one', expected: saved.revision }),
      ).rejects.toThrow()
      expect(exportWebResearchFiles()['goal-one/goal.json']).toBe(original)
      await call({ op: 'discard', stage: id })
    }
  })

  it('retains the original file and staged edit when browser storage is full', async () => {
    const original = JSON.stringify(goal())
    const saved = await write(original)
    const replacement = JSON.stringify(goal('Recoverable write'))
    const id = await stage(replacement)
    const originalSet = localStorage.setItem
    const failingSet = vi.fn(() => {
      throw new Error('QuotaExceededError')
    })
    localStorage.setItem = failingSet
    await expect(
      call({ op: 'commit', stage: id, directory: 'goal-one', expected: saved.revision }),
    ).rejects.toThrow('QuotaExceededError')
    expect(exportWebResearchFiles()['goal-one/goal.json']).toBe(original)
    localStorage.setItem = originalSet
    await call({ op: 'commit', stage: id, directory: 'goal-one', expected: saved.revision })
    expect(exportWebResearchFiles()['goal-one/goal.json']).toBe(replacement)
  })
})

describe('browser Research context and access boundaries', () => {
  it('updates managed guide and schema files while preserving user instruction files', async () => {
    await call({
      op: 'init',
      readme: 'Original README',
      instructions: 'Original app instructions',
      methodGuide: 'Guide version one',
      methodSchema: '{"version":1}',
    })
    const custom = exportWebResearchFiles()
    custom['AGENTS.md'] = 'My Codex instructions'
    custom['CLAUDE.md'] = 'My Claude instructions'
    stored.set(storageKey, JSON.stringify(custom))
    await call({
      op: 'init',
      readme: 'New README',
      instructions: 'New app instructions',
      methodGuide: 'Guide version two',
      methodSchema: '{"version":2}',
    })
    const files = exportWebResearchFiles()
    expect(files['.life-method.md']).toBe('Guide version two')
    expect(files['.life-method-schema.json']).toBe('{"version":2}')
    expect(files['AGENTS.md']).toBe('My Codex instructions')
    expect(files['CLAUDE.md']).toBe('My Claude instructions')
    expect(files['README.md']).toBe('Original README')
  })

  it('rejects invalid managed files without partially updating other instructions', async () => {
    await call({ op: 'init', methodGuide: 'Existing guide', methodSchema: '{"version":1}' })
    const before = exportWebResearchFiles()
    for (const invalid of [123, '🧪'.repeat(50_001)])
      await expect(
        call({
          op: 'init',
          instructions: 'Must not be persisted',
          methodGuide: 'Must not replace existing guide',
          methodSchema: invalid,
        }),
      ).rejects.toThrow('Invalid Research instruction or schema')
    expect(exportWebResearchFiles()).toEqual(before)
  })

  it('preserves immutable per-invocation operations independently of the current operation', async () => {
    await write(JSON.stringify(goal()))
    const firstId = randomUUID()
    const secondId = randomUUID()
    const firstOperation = researchOperationCatalog.find((row) => row.id === 'anti-abstraction')!
    const secondOperation = researchOperationCatalog.find((row) => row.id === 'abstraction')!
    const request = {
      op: 'context',
      directory: 'goal-one',
      problemId: 'problem-a',
      problemDirectory: 'problem-a',
      instructions: 'Read the invocation metadata without changing the user message.',
    }
    await call({ ...request, invocationId: firstId, operation: firstOperation })
    const root = 'goal-one/problems/problem-a'
    const firstFile = `${root}/.life-invocations/${firstId}.json`
    const initial = exportWebResearchFiles()[firstFile]
    expect(JSON.parse(initial)).toMatchObject({
      goalId: 'goal-one',
      problemId: 'problem-a',
      invocationId: firstId,
      executionId: firstId,
      invocationFile: `.life-invocations/${firstId}.json`,
      operation: firstOperation,
      methodGuideFile: '../../../.life-method.md',
      methodSchemaFile: '../../../.life-method-schema.json',
      goalFile: '../../goal.json',
    })
    await call({ ...request, invocationId: firstId, operation: firstOperation })
    await call({ ...request, invocationId: secondId, operation: secondOperation })
    const files = exportWebResearchFiles()
    expect(files[firstFile]).toBe(initial)
    expect(JSON.parse(files[`${root}/.life-context.json`])).toMatchObject({
      invocationId: secondId,
      operation: secondOperation,
    })
    await expect(
      call({ ...request, invocationId: firstId, operation: secondOperation }),
    ).rejects.toThrow('Research invocation metadata is immutable')
    expect(exportWebResearchFiles()).toEqual(files)
  })

  it('rejects reassignment of a problem conversation directory without changing user files', async () => {
    await write(JSON.stringify(goal()))
    await call({
      op: 'context',
      directory: 'goal-one',
      problemId: 'problem-a',
      problemDirectory: 'shared-directory',
      invocationId: randomUUID(),
      instructions: 'Initial instructions',
    })
    const before = exportWebResearchFiles()
    before['goal-one/problems/shared-directory/AGENTS.md'] = 'Custom Codex instructions'
    before['goal-one/problems/shared-directory/CLAUDE.md'] = 'Custom Claude instructions'
    stored.set(storageKey, JSON.stringify(before))
    await expect(
      call({
        op: 'context',
        directory: 'goal-one',
        problemId: 'problem-b',
        problemDirectory: 'shared-directory',
        invocationId: randomUUID(),
        instructions: 'Replacement instructions',
      }),
    ).rejects.toThrow('already belongs to another context')
    expect(exportWebResearchFiles()).toEqual(before)
  })

  it('rejects unsafe invocation identities and oversized contexts without creating files', async () => {
    await write(JSON.stringify(goal()))
    const before = exportWebResearchFiles()
    await expect(
      call({ op: 'context', directory: 'goal-one', invocationId: '../escape' }),
    ).rejects.toThrow('Invalid Research invocation identity')
    await expect(
      call({
        op: 'context',
        directory: 'goal-one',
        invocationId: randomUUID(),
        operation: { description: '🧪'.repeat(16_385) },
      }),
    ).rejects.toThrow('Research conversation context is too large')
    expect(exportWebResearchFiles()).toEqual(before)
  })

  it('isolates selected-problem instruction files and preserves user edits', async () => {
    await write(JSON.stringify(goal()))
    for (const problemId of ['problem-a', 'problem-b'])
      await call({
        op: 'context',
        directory: 'goal-one',
        problemId,
        problemDirectory: problemId,
        instructions: `Read this problem's .life-context.json; ${problemId}`,
      })
    let files = exportWebResearchFiles()
    for (const problemId of ['problem-a', 'problem-b']) {
      const directory = `goal-one/problems/${problemId}`
      expect(JSON.parse(files[`${directory}/.life-context.json`])).toMatchObject({
        goalId: 'goal-one',
        problemId,
        goalFile: '../../goal.json',
        readmeFile: '../../../README.md',
        mapFiles: { html: '../../map.html' },
      })
      expect(files[`${directory}/AGENTS.md`]).toContain(problemId)
      expect(files[`${directory}/CLAUDE.md`]).toContain(problemId)
    }
    files['goal-one/problems/problem-a/AGENTS.md'] = 'My own instructions'
    stored.set(storageKey, JSON.stringify(files))
    await call({
      op: 'context',
      directory: 'goal-one',
      problemId: 'problem-a',
      problemDirectory: 'problem-a',
      instructions: 'Replacement must not overwrite user instructions',
    })
    files = exportWebResearchFiles()
    expect(files['goal-one/problems/problem-a/AGENTS.md']).toBe('My own instructions')
    expect(JSON.parse(files['goal-one/goal.json']).extra).toEqual({ keep: true })
  })

  it('rejects missing problems without creating instruction files', async () => {
    await write(JSON.stringify(goal()))
    const before = exportWebResearchFiles()
    await expect(
      call({
        op: 'context',
        directory: 'goal-one',
        problemId: 'missing',
        problemDirectory: 'missing',
        instructions: 'Invalid target',
      }),
    ).rejects.toThrow('selected Research problem no longer exists')
    expect(exportWebResearchFiles()).toEqual(before)
  })

  it('cannot operate on desktop scopes or paths outside valid goal directories', async () => {
    await write(JSON.stringify(goal()))
    const before = exportWebResearchFiles()
    for (const override of [{ profileId: 'ssh-machine' }, { workspace: '/root' }])
      await expect(
        performWebResearchOperation({ ...scope, ...override }, { op: 'init', instructions: 'x' }),
      ).rejects.toThrow('cannot access a desktop or SSH machine')
    for (const directory of ['..', '.hidden', '../escape', 'nested/file', 'back\\slash', 'null\0'])
      await expect(call({ op: 'read', directory, file: 'goal.json', offset: 0 })).rejects.toThrow(
        'Invalid goal directory',
      )
    for (const file of ['AGENTS.md', '.life-context.json', '../README.md', '/etc/passwd'])
      await expect(call({ op: 'read', directory: 'goal-one', file, offset: 0 })).rejects.toThrow(
        'Invalid Research file',
      )
    expect(exportWebResearchFiles()).toEqual(before)
  })

  it('refuses malformed local storage without overwriting or seeding it', async () => {
    const malformed = JSON.stringify(['user data must remain recoverable'])
    stored.set(storageKey, malformed)
    initializeWebResearchExample()
    await expect(call({ op: 'init', readme: 'replacement' })).rejects.toThrow(
      'browser Research file store is invalid',
    )
    expect(stored.get(storageKey)).toBe(malformed)
  })

  it('seeds only public example content and leaves pre-existing user files untouched', () => {
    stored.set('life-extension-backup-2026-10-09.json', '{"private":"never export me"}')
    initializeWebResearchExample()
    const files = exportWebResearchFiles()
    expect(Object.keys(files)).toEqual(['example-research/goal.json'])
    expect(JSON.stringify(files)).not.toContain('never export me')
    stored.set(
      storageKey,
      JSON.stringify({ 'mine/goal.json': JSON.stringify(goal('My research')) }),
    )
    initializeWebResearchExample()
    expect(Object.keys(exportWebResearchFiles())).toEqual(['mine/goal.json'])
  })

  it('normalizes the public example without repairs or invented evidence and test outcomes', () => {
    initializeWebResearchExample()
    const example = JSON.parse(exportWebResearchFiles()['example-research/goal.json']) as {
      method: ResearchMethod
    }
    const method = normalizeResearchMethod(example.method)
    expect(method).toEqual(example.method)
    expect(method.normalizationIssues).toEqual([])
    expect(method.requirements.length).toBeGreaterThan(0)
    expect(method.candidates.length).toBeGreaterThan(0)
    expect(method.evidence).toEqual([])
    expect(method.requirements.every((row) => row.status === 'proposed')).toBe(true)
    expect(method.assumptions.every((row) => row.status === 'unverified')).toBe(true)
    expect(method.candidates.every((row) => row.status === 'proposed')).toBe(true)
    expect(method.validations.every((row) => row.outcome === 'pending' && row.actual === '')).toBe(
      true,
    )
    expect(method.inquiries.every((row) => row.status === 'proposed' && row.result === '')).toBe(
      true,
    )
    expect(analyzeResearchMethod(method).verifiedRequirementIds).toEqual([])
  })
})
