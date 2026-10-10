import { describe, expect, it } from 'vitest'
import type { ResearchGoal, ResearchRecord } from '../src/renderer/workbench'
import {
  beginResearchThreadUnlink,
  restoreResearchThreadLinks,
  unlinkResearchThread,
} from '../src/renderer/research-thread-links'

function goal(id: string, threadId = 'removed-thread'): ResearchGoal {
  return {
    id,
    title: `Goal ${id}`,
    goal: 'Retain the current research',
    threadId,
    createdAt: 1,
    updatedAt: 2,
    problems: [
      {
        id: `${id}-problem`,
        title: 'Problem',
        description: 'Preserve the details',
        notes: 'Exact findings\n',
        status: 'open',
        threadId,
        updatedAt: 2,
      },
    ],
  }
}

describe('research conversation deletion rollback', () => {
  it('removes only matching goal and problem links and remembers every removed target', () => {
    const unrelated = goal('unrelated', 'other-thread')
    const original: ResearchRecord = {
      goals: [goal('first'), goal('second'), unrelated],
      goalId: 'first',
      problemId: 'first-problem',
    }
    const removed = unlinkResearchThread(original, 'removed-thread')
    expect(removed.links).toEqual([
      { goalId: 'first' },
      { goalId: 'first', problemId: 'first-problem' },
      { goalId: 'second' },
      { goalId: 'second', problemId: 'second-problem' },
    ])
    expect(removed.record.goals[0].threadId).toBeUndefined()
    expect(removed.record.goals[0].problems[0].threadId).toBeUndefined()
    expect(removed.record.goals[2]).toBe(unrelated)
    expect(original.goals[0].threadId).toBe('removed-thread')
    expect(restoreResearchThreadLinks(removed.record, 'removed-thread', removed.links)).toEqual(
      original,
    )
  })

  it('retains intervening findings and newly linked conversations while restoring empty targets', () => {
    const removed = unlinkResearchThread(
      { goals: [goal('first'), goal('second')] },
      'removed-thread',
    )
    const updated: ResearchRecord = {
      ...removed.record,
      goals: removed.record.goals.map((item, index) => ({
        ...item,
        title: 'Title edited while history was saving',
        ...(index === 0 ? { threadId: 'new-goal-thread' } : {}),
        problems: item.problems.map((problem) => ({
          ...problem,
          notes: 'New exact findings\n',
          ...(index === 1 ? { threadId: 'new-problem-thread' } : {}),
        })),
      })),
    }
    const restored = restoreResearchThreadLinks(updated, 'removed-thread', removed.links)
    expect(restored.goals[0].threadId).toBe('new-goal-thread')
    expect(restored.goals[0].problems[0].threadId).toBe('removed-thread')
    expect(restored.goals[1].threadId).toBe('removed-thread')
    expect(restored.goals[1].problems[0].threadId).toBe('new-problem-thread')
    expect(restored.goals.every((item) => item.title === updated.goals[0].title)).toBe(true)
    expect(restored.goals.every((item) => item.problems[0].notes === 'New exact findings\n')).toBe(
      true,
    )
  })

  it('does not revive deleted goals or problems or attach newly created targets', () => {
    const removed = unlinkResearchThread(
      { goals: [goal('first'), goal('second')] },
      'removed-thread',
    )
    const updated: ResearchRecord = {
      goals: [
        { ...removed.record.goals[0], problems: [] },
        { ...goal('new'), threadId: undefined },
      ],
    }
    const restored = restoreResearchThreadLinks(updated, 'removed-thread', removed.links)
    expect(restored.goals.map((item) => item.id)).toEqual(['first', 'new'])
    expect(restored.goals[0]).toMatchObject({ threadId: 'removed-thread', problems: [] })
    expect(restored.goals[1]).toBe(updated.goals[1])
  })

  it('keeps the captured machine scope when the selected workspace changes before rollback', () => {
    const original: ResearchRecord = { goals: [goal('same-id')] }
    const other: ResearchRecord = { goals: [goal('same-id', 'other-thread')] }
    const records = new Map([
      ['original-machine', original],
      ['other-machine', other],
    ])
    let selected = 'original-machine'
    const writes: string[] = []
    const update = (change: (record: ResearchRecord) => ResearchRecord, scopeKey = selected) => {
      writes.push(scopeKey)
      records.set(scopeKey, change(records.get(scopeKey)!))
      return true
    }
    const rollback = beginResearchThreadUnlink('removed-thread', selected, update)
    expect(records.get('original-machine')!.goals[0].threadId).toBeUndefined()
    selected = 'other-machine'
    expect(rollback?.()).toBe(true)
    expect(records.get('original-machine')).toEqual(original)
    expect(records.get('other-machine')).toBe(other)
    expect(writes).toEqual(['original-machine', 'original-machine'])
  })

  it('does not provide a rollback after a failed unlink and reports a failed rollback save', () => {
    const original: ResearchRecord = { goals: [goal('first')] }
    expect(beginResearchThreadUnlink('removed-thread', 'machine', () => false)).toBeUndefined()
    let current = original
    let writable = true
    const update = (change: (record: ResearchRecord) => ResearchRecord) => {
      if (!writable) return false
      current = change(current)
      return true
    }
    const rollback = beginResearchThreadUnlink('removed-thread', 'machine', update)
    writable = false
    expect(rollback?.()).toBe(false)
    expect(current.goals[0].threadId).toBeUndefined()
  })

  it('keeps missing links and repeated rollbacks idempotent', () => {
    const original: ResearchRecord = { goals: [goal('first', 'different-thread')] }
    const removed = unlinkResearchThread(original, 'removed-thread')
    expect(removed.record).toBe(original)
    expect(removed.links).toEqual([])
    expect(restoreResearchThreadLinks(original, 'removed-thread', removed.links)).toBe(original)
    const matching = unlinkResearchThread({ goals: [goal('first')] }, 'removed-thread')
    const restored = restoreResearchThreadLinks(matching.record, 'removed-thread', matching.links)
    expect(restoreResearchThreadLinks(restored, 'removed-thread', matching.links)).toBe(restored)
  })
})
