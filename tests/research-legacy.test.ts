import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchGoal } from '../src/renderer/workbench'
import { collectLegacyResearch, researchLinkedThreadIds } from '../src/renderer/research-legacy'

const localKey = 'life.research.workbench.v1'
const migratedKey = 'life.research.migrated-to.v1'
const cacheKey = (profileId: string, workspace: string, version = 1) =>
  `life.research.files.v${version}:` + JSON.stringify([profileId, workspace])

function storage(values: Record<string, unknown>) {
  const raw = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]))
  const target = {
    get length() {
      return raw.size
    },
    key: vi.fn((index: number) => [...raw.keys()][index] || null),
    getItem: vi.fn((key: string) => raw.get(key) || null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  return { target, raw }
}

function goal(id: string, updatedAt = 1, threadId = `chat:${id}`): ResearchGoal {
  return {
    id,
    title: `Goal ${id}`,
    goal: `Investigate ${id}`,
    threadId,
    directory: `folder-${id}`,
    problems: [
      {
        id: `${id}-problem`,
        title: 'Experiment',
        description: 'Test a hypothesis',
        notes: 'Findings',
        status: 'open',
        threadId: `${threadId}:problem`,
        updatedAt,
      },
    ],
    createdAt: 1,
    updatedAt,
  }
}

function cache(
  profileId: string,
  workspace: string,
  goals: ResearchGoal[],
  pending: unknown[] = [],
) {
  return {
    scope: { profileId, workspace, host: `${profileId}.example` },
    record: { goals },
    pending,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('legacy Research collection', () => {
  it('retains goal, problem and unknown agent metadata without rewriting the original storage', () => {
    const original = { ...goal('local'), evidence: { sources: ['paper'], confidence: 0.8 } }
    const problem = { ...original.problems[0], experiment: { seed: 42 } }
    original.problems = [problem]
    const { target, raw } = storage({ [localKey]: { goals: [original] } })
    const before = new Map(raw)
    const result = collectLegacyResearch(undefined, target)
    expect(result.goals).toEqual([original])
    expect(result.threadIds).toEqual(new Set(['chat:local', 'chat:local:problem']))
    expect(result.conflicts).toEqual([])
    expect(raw).toEqual(before)
    expect(target.setItem).not.toHaveBeenCalled()
    expect(target.removeItem).not.toHaveBeenCalled()
  })

  it('collects all selected-machine project caches and never imports another machine or unowned notebook', () => {
    const { target } = storage({
      [localKey]: { goals: [goal('unassigned')] },
      [cacheKey('chosen', '/projects/a')]: cache('chosen', '/projects/a', [goal('a')]),
      [cacheKey('chosen', '/projects/b')]: cache('chosen', '/projects/b', [goal('b')]),
      [cacheKey('other', '/private')]: cache('other', '/private', [goal('private')]),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals.map((goal) => goal.id)).toEqual(['a', 'b'])
    expect(result.workspaces).toEqual(['/projects/a', '/projects/b'])
    expect([...result.threadIds]).not.toContain('chat:private')
    expect([...result.threadIds]).not.toContain('chat:unassigned')
  })

  it('recognizes old migration ownership and preserves unscoped local pending edits only for its owner', () => {
    const after = goal('draft', 4)
    const { target, raw } = storage({
      [localKey]: { goals: [goal('local')] },
      'life.research.files.v1:local': {
        record: { goals: [] },
        pending: [{ directory: 'folder-draft', after }],
      },
    })
    // The previous implementation wrote this array-shaped scope key directly, without quoting it.
    raw.set(migratedKey, JSON.stringify(['chosen', '/projects/old']))
    expect(collectLegacyResearch('chosen', target).goals.map((item) => item.id)).toEqual([
      'local',
      'draft',
    ])
    expect(collectLegacyResearch('other', target).goals).toEqual([])
  })

  it('retains unsynchronized edits, their before and after links, and force-conflict decisions', () => {
    const before = goal('pending', 1, 'old-chat')
    const after = { ...goal('pending', 2, 'new-chat'), observation: 'Not saved remotely yet' }
    const pending = [{ directory: 'folder-pending', before, after, force: true }]
    const { target } = storage({
      [cacheKey('chosen', '/a')]: cache('chosen', '/a', [], pending),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.pending).toEqual(pending)
    expect(result.goals).toEqual([after])
    expect(result.threadIds).toEqual(
      new Set(['old-chat', 'old-chat:problem', 'new-chat', 'new-chat:problem']),
    )
  })

  it('recognizes the new machine-scoped Research ownership marker', () => {
    const { target, raw } = storage({ [localKey]: { goals: [goal('local')] } })
    raw.set(migratedKey, JSON.stringify(['research', 'chosen', '/home/chosen']))
    expect(collectLegacyResearch('chosen', target).goals.map((item) => item.id)).toEqual(['local'])
    expect(collectLegacyResearch('research', target).goals).toEqual([])
  })

  it('preserves edit ordering and selects the last cache edit without calling one edit chain a conflict', () => {
    const first = goal('chain', 1)
    const second = { ...first, updatedAt: 2, goal: 'Second revision' }
    const third = { ...second, updatedAt: 3, goal: 'Third revision' }
    const pending = [
      { directory: 'folder-chain', before: first, after: second },
      { directory: 'folder-chain', before: second, after: third },
    ]
    const { target } = storage({
      [cacheKey('chosen', '/a')]: cache('chosen', '/a', [first], pending),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals).toEqual([third])
    expect(result.pending).toEqual(pending)
    expect(result.conflicts).toEqual([])
  })

  it('deduplicates identical copies and retains every divergent copy while selecting the newest goal', () => {
    const first = goal('shared', 1, 'older-chat')
    const latest = { ...goal('shared', 5, 'newer-chat'), goal: 'New findings' }
    const { target } = storage({
      [cacheKey('chosen', '/a')]: cache('chosen', '/a', [first]),
      [cacheKey('chosen', '/a-copy')]: cache('chosen', '/a-copy', [{ ...first }]),
      [cacheKey('chosen', '/b')]: cache('chosen', '/b', [latest]),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals).toEqual([latest])
    expect(result.conflicts).toEqual([{ id: 'shared', variants: [first, latest] }])
    expect(result.threadIds).toContain('older-chat')
    expect(result.threadIds).toContain('newer-chat')
  })

  it('recovers ownership from scope keys and rejects mismatched scope metadata', () => {
    const { target } = storage({
      [cacheKey('chosen', '/key-owned')]: { record: { goals: [goal('key-owned')] } },
      [cacheKey('chosen', '/ambiguous')]: cache('other', '/ambiguous', [goal('wrong')]),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals.map((goal) => goal.id)).toEqual(['key-owned'])
    expect(result.workspaces).toEqual(['/key-owned'])
  })

  it('does not reimport v2 Research caches as old project-backed notebooks', () => {
    const { target } = storage({
      [cacheKey('chosen', '/old')]: cache('chosen', '/old', [goal('old')]),
      [cacheKey('chosen', '/home/chosen', 2)]: cache('chosen', '/home/chosen', [goal('current')]),
    })
    expect(collectLegacyResearch('chosen', target).goals.map((goal) => goal.id)).toEqual(['old'])
  })

  it('bounds entries and per-record goals while leaving malformed or oversized cache data untouched', () => {
    const values: Record<string, unknown> = {}
    for (let index = 0; index < 999; index++) values[`unrelated:${index}`] = ''
    values[cacheKey('chosen', '/within')] = cache(
      'chosen',
      '/within',
      Array.from({ length: 120 }, (_, index) => goal(`g${index}`)),
    )
    values[cacheKey('chosen', '/beyond-limit')] = cache('chosen', '/beyond-limit', [goal('beyond')])
    const { target, raw } = storage(values)
    raw.set(localKey, '{broken')
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals).toHaveLength(100)
    expect(result.goals.some((goal) => goal.id === 'beyond')).toBe(false)
    expect(target.key).toHaveBeenCalledTimes(1_000)
    raw.set(cacheKey('chosen', '/within'), ' '.repeat(4_000_001))
    expect(collectLegacyResearch('chosen', target).goals).toEqual([])
    expect(raw.get(localKey)).toBe('{broken')
  })

  it('handles unavailable storage, malformed pending rows and deep damaged metadata', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(collectLegacyResearch().goals).toEqual([])
    expect(researchLinkedThreadIds()).toEqual(new Set())
    const { target, raw } = storage({
      [cacheKey('chosen', '/a')]: cache(
        'chosen',
        '/a',
        [goal('valid')],
        [null, {}, { after: goal('invalid') }],
      ),
    })
    raw.set(localKey, '{"goals":' + '['.repeat(70) + 'null' + ']'.repeat(70) + '}')
    expect(collectLegacyResearch(undefined, target).goals.map((goal) => goal.id)).toEqual(['valid'])
    expect(collectLegacyResearch(undefined, target).pending).toEqual([])
    const blocked = {
      length: 1,
      key: () => {
        throw new Error('blocked')
      },
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(collectLegacyResearch(undefined, blocked).goals).toEqual([])
  })
})

describe('Research scan budget', () => {
  it('reports partial collection when multiple valid notebooks exceed the destination goal limit', () => {
    const { target, raw } = storage({
      [cacheKey('chosen', '/a')]: cache(
        'chosen',
        '/a',
        Array.from({ length: 60 }, (_, index) => goal(`a${index}`)),
      ),
      [cacheKey('chosen', '/b')]: cache(
        'chosen',
        '/b',
        Array.from({ length: 60 }, (_, index) => goal(`b${index}`)),
      ),
    })
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals).toHaveLength(100)
    expect(result.truncated).toBe(true)
    expect(result.threadIds).toContain('chat:b59')
    expect(raw.has(cacheKey('chosen', '/b'))).toBe(true)
  })

  it('bounds total parsed bytes and exposes incomplete migration without touching skipped caches', () => {
    const values: Record<string, unknown> = {}
    for (let index = 0; index < 12; index++) {
      values[cacheKey('chosen', `/large-${index}`)] = cache('chosen', `/large-${index}`, [
        { ...goal(`large-${index}`), metadata: 'x'.repeat(3_900_000) } as ResearchGoal,
      ])
    }
    const { target, raw } = storage(values)
    const result = collectLegacyResearch('chosen', target)
    expect(result.truncated).toBe(true)
    expect(result.goals).toHaveLength(8)
    expect(target.getItem).toHaveBeenCalledTimes(10) // Marker and nine cache reads; later caches are not loaded.
    expect(raw.has(cacheKey('chosen', '/large-11'))).toBe(true)
    expect(target.setItem).not.toHaveBeenCalled()
    expect(target.removeItem).not.toHaveBeenCalled()
  })

  it('skips caches belonging to other machines before spending the read budget', () => {
    const { target, raw } = storage({
      [cacheKey('other', '/private')]: {},
      [cacheKey('chosen', '/mine')]: cache('chosen', '/mine', [goal('mine')]),
    })
    raw.set(cacheKey('other', '/private'), 'x'.repeat(4_000_001))
    const result = collectLegacyResearch('chosen', target)
    expect(result.goals.map((item) => item.id)).toEqual(['mine'])
    expect(result.truncated).toBeUndefined()
    expect(target.getItem).not.toHaveBeenCalledWith(cacheKey('other', '/private'))
  })
})

describe('Research conversation classification', () => {
  it('includes every v1 and v2 scope, local notebooks and pending before/after links without mutation', () => {
    const { target, raw } = storage({
      [localKey]: { goals: [goal('local')] },
      [cacheKey('first', '/old')]: cache('first', '/old', [goal('old')]),
      ['life.research.files.v2:' + JSON.stringify(['research', 'second', '/home/second'])]: cache(
        'second',
        '/home/second',
        [goal('current')],
        [
          {
            directory: 'folder-edit',
            before: goal('edit', 1, 'before-chat'),
            after: goal('edit', 2, 'after-chat'),
          },
        ],
      ),
      'relay.threads.v1': [{ id: 'ordinary-chat', workspace: '/projects/research' }],
    })
    const before = new Map(raw)
    expect(researchLinkedThreadIds(target)).toEqual(
      new Set([
        'chat:local',
        'chat:local:problem',
        'chat:old',
        'chat:old:problem',
        'chat:current',
        'chat:current:problem',
        'before-chat',
        'before-chat:problem',
        'after-chat',
        'after-chat:problem',
      ]),
    )
    expect(raw).toEqual(before)
    expect(target.setItem).not.toHaveBeenCalled()
    expect(target.removeItem).not.toHaveBeenCalled()
  })
})
