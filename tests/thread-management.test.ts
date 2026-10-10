import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import { applyEvent, readThreads, type Thread } from '../src/renderer/state'
import {
  applyThreadAction,
  captureThreadArrangementChanges,
  compareManualThreads,
  isThreadSnoozed,
  threadCanArchive,
  threadCanMove,
  threadHasUnreadCompletion,
  threadSection,
  undoThreadArrangement,
} from '../src/renderer/thread-management'
import { compareSidebarThreads, readSidebarArrangement } from '../src/renderer/sidebar-ordering'

function thread(id = 'thread', overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    profileId: 'machine',
    workspace: '/srv/project',
    provider: 'codex',
    title: id,
    messages: [{ id: `${id}-user`, role: 'user', text: 'Exact prompt\n', turn: 1, createdAt: 50 }],
    busy: false,
    turnStatus: 'completed',
    model: '',
    mode: 'review',
    updatedAt: 100,
    turn: 1,
    pending: [],
    ...overrides,
  }
}
function event(type: AgentEvent['type'], extra: Partial<AgentEvent> = {}): AgentEvent {
  return { sessionId: 'thread', type, ...extra }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('durable thread lifecycle and attention', () => {
  it('restores lifecycle metadata without manufacturing unread completion from historical messages', () => {
    const legacy = thread('legacy', {
      updatedAt: 999,
      messages: [
        {
          id: 'old-answer',
          role: 'assistant',
          text: 'Older output',
          turn: 1,
          finishedAt: 998,
          finishStatus: 'completed',
        },
      ],
    })
    const current = thread('current', {
      createdAt: 100,
      pinnedAt: 200,
      pinOrder: 2,
      activeOrder: 3,
      lastReadAt: 300,
      completedAt: 400,
      attentionAt: 400,
      snoozedAt: 500,
      snoozedUntil: 900,
      settledAt: 600,
      archivedAt: 700,
    })
    const restored = readThreads([legacy, current])
    expect(threadHasUnreadCompletion(restored.find((item) => item.id === 'legacy')!)).toBe(false)
    expect(restored.find((item) => item.id === 'current')).toMatchObject({
      createdAt: 100,
      pinnedAt: 200,
      pinOrder: 2,
      activeOrder: 3,
      lastReadAt: 300,
      completedAt: 400,
      attentionAt: 400,
      snoozedAt: 500,
      snoozedUntil: 900,
      settledAt: 600,
      archivedAt: 700,
    })
    expect(threadHasUnreadCompletion(restored.find((item) => item.id === 'current')!)).toBe(true)
  })

  it('rejects malformed timestamp and rank metadata while retaining literal history', () => {
    const original = thread()
    const restored = readThreads([
      {
        ...original,
        createdAt: -1,
        completedAt: Infinity,
        lastReadAt: '100',
        pinnedAt: NaN,
        pinOrder: Infinity,
        activeOrder: 1e13,
        attentionAt: 1.25,
      },
    ])[0]
    for (const field of [
      'createdAt',
      'completedAt',
      'lastReadAt',
      'pinnedAt',
      'pinOrder',
      'activeOrder',
      'attentionAt',
    ] as const)
      expect(restored[field]).toBeUndefined()
    expect(restored.messages[0].text).toBe(original.messages[0].text)
    const malformedStatus = readThreads([
      {
        ...original,
        messages: [{ id: 'tool', role: 'tool', text: 'Preserved output', turn: 1, status: 42 }],
      },
    ])[0]
    expect(malformedStatus.messages[0]).toMatchObject({
      text: 'Preserved output',
      status: undefined,
    })
  })

  it('keeps parent and child provider title notifications from replacing a manual title', () => {
    let renamed = applyThreadAction([thread()], 'thread', 'rename', 200, '  User-chosen title  ')[0]
    renamed = applyEvent(
      renamed,
      event('session', { remoteId: 'new-remote', title: 'Provider session title' }),
    )
    renamed = applyEvent(renamed, event('title', { title: 'Provider generated title' }))
    expect(renamed).toMatchObject({
      title: 'User-chosen title',
      titleSource: 'manual',
      remoteId: 'new-remote',
    })
    expect(
      applyEvent(renamed, event('title', { agentId: 'child', title: 'Child title' })).title,
    ).toBe('User-chosen title')
    expect(applyEvent(thread(), event('title', { title: 'Generated title' })).title).toBe(
      'Generated title',
    )
  })

  it('only an explicit fresh completed turn creates unread and duplicate terminal events stay read', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const old = thread('thread', { busy: true, turnStatus: 'running' })
    const streamed = applyEvent(old, event('text', { text: 'Fresh text', phase: 'final_answer' }))
    expect(threadHasUnreadCompletion(streamed)).toBe(false)
    const completed = applyEvent(streamed, event('complete', { status: 'completed' }))
    expect(completed).toMatchObject({ completedAt: 1000, lastReadAt: 999, attentionAt: 1000 })
    expect(threadHasUnreadCompletion(completed)).toBe(true)
    const visited = applyThreadAction([completed], 'thread', 'mark-read', 1100)[0]
    vi.setSystemTime(1200)
    const repeated = applyEvent(visited, event('complete', { status: 'completed' }))
    expect(repeated.completedAt).toBe(1000)
    expect(threadHasUnreadCompletion(repeated)).toBe(false)
  })

  it('pending requests cannot be hidden by settling, snoozing or archiving', () => {
    const pending = thread('thread', { pending: [event('approval', { requestId: 'approval' })] })
    const current = [pending]
    for (const action of ['settle', 'snooze', 'archive'] as const)
      expect(applyThreadAction(current, 'thread', action, 200, 900)).toBe(current)
    expect(
      threadSection({ ...pending, archivedAt: 100, settled: true, snoozedUntil: 900 }, 200),
    ).toBe('active')
  })

  it('snoozing a running pinned thread preserves its run and ordering and wakes for a fresh request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300)
    const initial = thread('thread', {
      busy: true,
      turnStatus: 'running',
      pinnedAt: 100,
      pinOrder: 4,
      activeOrder: 8,
    })
    const snoozed = applyThreadAction([initial], 'thread', 'snooze', 200, 900)[0]
    expect(snoozed).toMatchObject({
      busy: true,
      turnStatus: 'running',
      pinnedAt: 100,
      pinOrder: 4,
      activeOrder: 8,
    })
    expect(isThreadSnoozed(snoozed, 250)).toBe(true)
    const awake = applyEvent(
      snoozed,
      event('question', { requestId: 'question', text: 'Which file?' }),
    )
    expect(threadSection(awake, 300)).toBe('pinned')
    expect(awake.snoozedUntil).toBeUndefined()
    expect(awake.attentionAt).toBe(300)
    expect(awake.busy).toBe(true)
  })

  it('a fresh completion or failure wakes parked work, while acknowledged old failure can be snoozed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(400)
    const running = thread('thread', { busy: true, turnStatus: 'running' })
    const snoozed = applyThreadAction([running], 'thread', 'snooze', 200, 900)[0]
    const complete = applyEvent(snoozed, event('complete', { status: 'completed' }))
    expect(complete.snoozedUntil).toBeUndefined()
    expect(complete.completedAt).toBe(400)
    const failed = applyEvent(snoozed, event('error', { text: 'Connection failed' }))
    expect(failed).toMatchObject({ turnStatus: 'failed', attentionAt: 400 })
    expect(failed.snoozedUntil).toBeUndefined()
    const acknowledged = applyThreadAction([failed], 'thread', 'snooze', 500, 900)[0]
    expect(isThreadSnoozed(acknowledged, 550)).toBe(true)
    expect(isThreadSnoozed(acknowledged, 900)).toBe(false)
    const settled = applyThreadAction([running], 'thread', 'settle', 200)[0]
    expect(applyEvent(settled, event('complete', { status: 'completed' })).settled).toBe(false)
  })

  it('recoverable errors and child failures do not finish the parent or create a parent completion', () => {
    const running = thread('thread', {
      busy: true,
      turnStatus: 'running',
      snoozedAt: 100,
      snoozedUntil: 900,
    })
    const retry = applyEvent(
      running,
      event('error', { text: 'Retrying', details: { recoverable: true } }),
    )
    expect(retry).toMatchObject({ busy: true, turnStatus: 'running', snoozedUntil: 900 })
    expect(retry.completedAt).toBeUndefined()
    const child = applyEvent(running, event('error', { agentId: 'child', text: 'Child failed' }))
    expect(child).toMatchObject({ busy: true, turnStatus: 'running' })
    expect(child.completedAt).toBeUndefined()
  })

  it('archiving rejects live work and active queues but keeps stopped history, files and queued drafts intact', () => {
    const pendingQueue = [{ id: 'followup', text: 'Next task', createdAt: 100, attachments: [] }]
    for (const current of [
      thread('thread', { busy: true }),
      thread('thread', { queue: pendingQueue }),
      thread('thread', {
        messages: [
          {
            id: 'child',
            role: 'tool',
            text: 'Child output',
            turn: 1,
            kind: 'subagent',
            status: 'running',
          },
        ],
      }),
    ])
      expect(threadCanArchive(current)).toBe(false)
    const stopped = thread('thread', { queue: [{ ...pendingQueue[0], paused: true }] })
    const archived = applyThreadAction([stopped], 'thread', 'archive', 300)[0]
    expect(archived.archivedAt).toBe(300)
    expect(archived.messages).toBe(stopped.messages)
    expect(archived.queue).toBe(stopped.queue)
    const restored = applyThreadAction([archived], 'thread', 'unarchive', 400)[0]
    expect(threadSection(restored, 400)).toBe('active')
    expect(restored.messages).toBe(stopped.messages)
  })

  it.each([
    'running',
    'waiting',
    'inProgress',
    'in_progress',
    'spawning',
    'initializing',
    'pendingInit',
    'pending_init',
    'pending-init',
    'PENDING_INIT',
    'pending',
    'queued',
    'started',
  ])('restored child status %s cannot impersonate a still-connected running child', (status) => {
    const restored = readThreads([
      thread('thread', {
        messages: [
          {
            id: 'child',
            role: 'assistant',
            text: 'Retained child output',
            agentId: 'child',
            status,
            turn: 1,
          },
        ],
      }),
    ])[0]
    expect(restored.messages[0]).toMatchObject({
      text: 'Retained child output',
      status: 'interrupted',
    })
    expect(threadCanArchive(restored)).toBe(true)
  })

  it('mark unread uses only explicit completion and marking read never rewinds a newer clock', () => {
    const legacy = [thread()]
    expect(applyThreadAction(legacy, 'thread', 'mark-unread', 300)).toBe(legacy)
    const completed = thread('thread', { completedAt: 500, lastReadAt: 600 })
    const unread = applyThreadAction([completed], 'thread', 'mark-unread', 700)[0]
    expect(unread.lastReadAt).toBe(499)
    const read = applyThreadAction([unread], 'thread', 'mark-read', 100)[0]
    expect(read.lastReadAt).toBe(500)
    expect(threadHasUnreadCompletion(read)).toBe(false)
    expect(applyThreadAction([completed], 'thread', 'mark-read', 100)[0].lastReadAt).toBe(600)
  })
})

describe('thread arrangement undo remains attached to the original work', () => {
  it('does not archive or settle a thread again after a new send has started', () => {
    for (const parked of [
      thread('thread', { archivedAt: 100 }),
      thread('thread', { settled: true, settledAt: 100 }),
    ]) {
      const before = [parked]
      const action = parked.archivedAt ? 'unarchive' : 'restore'
      const after = applyThreadAction(before, 'thread', action, 200)
      const changes = captureThreadArrangementChanges(before, after)
      const newer = [
        {
          ...after[0],
          turn: 2,
          busy: true,
          turnStatus: 'running' as const,
          messages: [
            ...after[0].messages,
            { id: 'new-send', role: 'user' as const, text: 'New work', turn: 2 },
          ],
        },
      ]
      expect(undoThreadArrangement(newer, changes)).toBe(newer)
      expect(threadSection(newer[0], 300)).toBe('active')
    }
  })

  it('does not hide a new completion, failure or user request from the same parent turn', () => {
    const before = [
      thread('thread', { settled: true, settledAt: 100, attentionAt: 100, completedAt: 90 }),
    ]
    const after = applyThreadAction(before, 'thread', 'restore', 200)
    const changes = captureThreadArrangementChanges(before, after)
    for (const next of [
      { ...after[0], completedAt: 300 },
      { ...after[0], attentionAt: 300, turnStatus: 'failed' as const },
      { ...after[0], pending: [event('approval', { requestId: 'new-request' })] },
    ]) {
      const newer = [next]
      expect(undoThreadArrangement(newer, changes)).toBe(newer)
    }
  })

  it('undoing a pin during the same running turn retains every streamed message and current run field', () => {
    const before = [thread('thread', { busy: true, turnStatus: 'running', attentionAt: 100 })]
    const after = applyThreadAction(before, 'thread', 'pin', 200)
    const changes = captureThreadArrangementChanges(before, after)
    const streamed = applyEvent(
      after[0],
      event('text', { itemId: 'response', text: 'Still working\n' }),
    )
    const undone = undoThreadArrangement([streamed], changes)[0]
    expect(undone.pinnedAt).toBeUndefined()
    expect(undone.messages).toBe(streamed.messages)
    expect(undone.busy).toBe(true)
    expect(undone.turnStatus).toBe('running')
    expect(undone.attentionAt).toBe(100)
  })

  it('only restores fields changed by that action and preserves a later arrangement edit', () => {
    const before = [thread('thread', { pinnedAt: 100, pinOrder: 3, activeOrder: 7 })]
    const after = applyThreadAction(before, 'thread', 'unpin', 200)
    const changes = captureThreadArrangementChanges(before, after)
    const newer = [{ ...after[0], activeOrder: 11, lastReadAt: 300 }]
    const undone = undoThreadArrangement(newer, changes)[0]
    expect(undone).toMatchObject({ pinnedAt: 100, pinOrder: 3, activeOrder: 11, lastReadAt: 300 })
    const changedPin = [{ ...after[0], pinnedAt: 400, pinOrder: 8 }]
    expect(undoThreadArrangement(changedPin, changes)).toBe(changedPin)
  })

  it('rejects restoring an archive when new live children or queued work would be hidden', () => {
    const before = [thread('thread', { archivedAt: 100 })]
    const after = applyThreadAction(before, 'thread', 'unarchive', 200)
    const changes = captureThreadArrangementChanges(before, after)
    for (const next of [
      { ...after[0], busy: true },
      {
        ...after[0],
        messages: [
          ...after[0].messages,
          {
            id: 'child',
            role: 'tool' as const,
            text: 'Child working',
            kind: 'subagent' as const,
            agentId: 'child',
            status: 'running',
            turn: 1,
          },
        ],
      },
      {
        ...after[0],
        queue: [{ id: 'queued', text: 'Next task', createdAt: 250, attachments: [] }],
      },
    ]) {
      const current = [next]
      expect(undoThreadArrangement(current, changes)).toBe(current)
    }
  })

  it('captures only arrangement changes and can restore all ranks affected by a reorder', () => {
    const before = [thread('a', { createdAt: 100 }), thread('b', { createdAt: 200 })]
    const after = applyThreadAction(before, 'a', 'move-up', 300)
    const changes = captureThreadArrangementChanges(before, after)
    expect(changes).toHaveLength(2)
    expect(undoThreadArrangement(after, changes)).toEqual(before)
    const streamed = [{ ...before[0], messages: [] }, before[1]]
    expect(captureThreadArrangementChanges(before, streamed)).toEqual([])
    expect(undoThreadArrangement(streamed, [])).toBe(streamed)
  })
})

describe('stable thread arrangement', () => {
  it('defaults to manual order while retaining an explicitly saved older sort', () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(readSidebarArrangement().sort).toBe('manual')
    expect(readSidebarArrangement().group).toBe('none')
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ sort: 'recent' }) })
    expect(readSidebarArrangement().sort).toBe('recent')
  })

  it('migrates the automatically saved old default inbox without replacing custom arrangements', () => {
    const oldDefault = { provider: 'all', status: 'all', sort: 'recent', group: 'project' }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(oldDefault) })
    expect(readSidebarArrangement()).toEqual({
      provider: 'all',
      status: 'all',
      sort: 'manual',
      group: 'none',
    })
    for (const custom of [
      { ...oldDefault, provider: 'claude' },
      { ...oldDefault, status: 'waiting' },
      { ...oldDefault, sort: 'title' },
      { ...oldDefault, group: 'machine' },
    ]) {
      vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(custom) })
      expect(readSidebarArrangement()).toEqual(custom)
    }
  })

  it('manual ordering survives streaming, metadata, reload and an explicit reorder', () => {
    const original = [
      thread('a', { createdAt: 100 }),
      thread('b', { createdAt: 200 }),
      thread('c', { createdAt: 300 }),
    ]
    expect([...original].sort(compareManualThreads).map((item) => item.id)).toEqual(['c', 'b', 'a'])
    const moved = applyThreadAction(original, 'a', 'move-up', 400)
    expect([...moved].sort(compareManualThreads).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    const streamed = moved.map((item) =>
      item.id === 'b' ? { ...item, updatedAt: 9999, gitBranch: 'new-observation' } : item,
    )
    expect(
      readThreads(streamed)
        .sort(compareManualThreads)
        .map((item) => item.id),
    ).toEqual(['c', 'a', 'b'])
    expect(threadCanMove(moved, 'c', 'move-up', 400)).toBe(false)
    expect(threadCanMove(moved, 'b', 'move-down', 400)).toBe(false)
  })

  it('manual moves cannot swap a visible Agents thread with hidden Research or Studio threads', () => {
    const before = [
      thread('a', { createdAt: 100 }),
      thread('research', { createdAt: 200, purpose: 'research' }),
      thread('studio', { createdAt: 300, purpose: 'customization' }),
      thread('b', { createdAt: 400 }),
    ]
    const moved = applyThreadAction(before, 'a', 'move-up', 500)
    expect(
      moved
        .filter((item) => !item.purpose)
        .sort(compareManualThreads)
        .map((item) => item.id),
    ).toEqual(['a', 'b'])
    expect(moved[1]).toBe(before[1])
    expect(moved[2]).toBe(before[2])
    expect(threadCanMove(moved, 'a', 'move-up', 500)).toBe(false)
    expect(threadCanMove(moved, 'b', 'move-down', 500)).toBe(false)
  })

  it('pin ordering is global and independent of active sorting and snoozing preserves active position', () => {
    const current = [
      thread('z', { pinnedAt: 100, pinOrder: 2 }),
      thread('a', { pinnedAt: 200, pinOrder: 1 }),
      thread('active', { createdAt: 999, activeOrder: 4 }),
    ]
    expect(
      [...current].sort((a, b) => compareSidebarThreads(a, b, 'title')).map((item) => item.id),
    ).toEqual(['a', 'z', 'active'])
    const moved = applyThreadAction(current, 'z', 'move-up', 300)
    expect([...moved].sort(compareManualThreads).map((item) => item.id)).toEqual([
      'z',
      'a',
      'active',
    ])
    const snoozed = applyThreadAction(moved, 'active', 'snooze', 400, 900)[2]
    expect(snoozed.activeOrder).toBe(4)
    const settled = applyThreadAction(moved, 'z', 'settle', 400)[0]
    expect(settled).toMatchObject({ settled: true, settledAt: 400 })
    expect(settled.pinnedAt).toBeUndefined()
    expect(settled.pinOrder).toBeUndefined()
  })

  it('restoring settled or archived work places it first, while waking preserves its saved active position', () => {
    const active = thread('active', { createdAt: 300, activeOrder: 1 })
    const settled = thread('settled', { createdAt: 100, settled: true, settledAt: 400 })
    const restored = applyThreadAction([active, settled], 'settled', 'restore', 500)
    expect([...restored].sort(compareManualThreads).map((item) => item.id)).toEqual([
      'settled',
      'active',
    ])
    const archived = { ...settled, settled: false, archivedAt: 400 }
    const unarchived = applyThreadAction([active, archived], 'settled', 'unarchive', 500)
    expect([...unarchived].sort(compareManualThreads).map((item) => item.id)).toEqual([
      'settled',
      'active',
    ])
    const sleeping = thread('sleeping', {
      createdAt: 100,
      activeOrder: 4,
      snoozedAt: 200,
      snoozedUntil: 900,
    })
    const awake = applyThreadAction([active, sleeping], 'sleeping', 'wake', 500)
    expect(awake[1].activeOrder).toBe(4)
    expect([...awake].sort(compareManualThreads).map((item) => item.id)).toEqual([
      'active',
      'sleeping',
    ])
  })
})
