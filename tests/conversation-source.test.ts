import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acknowledgeConversationSources,
  appendConversationSourceMessages,
  attachConversationSource,
  clearConversationSourceMessages,
  conversationSourceAttachmentIds,
  hasConversationSource,
  projectConversationSource,
  refreshConversationSources,
} from '../src/renderer/conversation-source'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'
import { ConversationCheckpointEngine } from '../src/main/conversation-checkpoint-engine'
import { runEffect } from '../src/main/effect-runtime'
import { readThreadMessages, readThreads, type Message, type Thread } from '../src/renderer/state'
import type { ConversationCheckpointInput } from '../src/shared/conversations'

type RawThread = Record<string, unknown> & {
  id: string
  profileId: string
  provider: 'codex' | 'claude'
  messages: unknown[]
}
const exact = '  Exact\r\n\tUnicode café e\u0301 漢字 🧪 👩🏽‍💻  \n'
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function known(id = 'known', text = exact, fields: Record<string, unknown> = {}) {
  return { id, role: 'user', text, input: text, turn: 2, ...fields }
}
function rawThread(fields: Partial<RawThread> = {}): RawThread {
  return {
    id: 'thread',
    profileId: 'machine',
    provider: 'claude',
    workspace: '/exact/project',
    remoteId: 'native-session-Ω',
    title: 'Exact history',
    messages: [known()],
    model: '',
    mode: 'review',
    updatedAt: 100,
    turn: 2,
    busy: false,
    pending: [],
    ...fields,
  }
}
function opaqueThread(): RawThread {
  return rawThread({
    futureThreadField: { exact, values: [null, 17, true] },
    messages: [
      null,
      'opaque native record\tΩ\r\n',
      47,
      { id: 'system', role: 'system', text: exact, futureRole: true },
      { role: 'user', text: exact, futureMissingIdentity: true },
      { id: 'future-shape', futureMessageField: { exact } },
      known('known', exact, { futureMessageField: { exact, retained: true } }),
      ['future', { exact }],
    ],
  })
}
function projected(thread: Thread): RawThread {
  return projectConversationSource(thread) as unknown as RawThread
}
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}
function attachment(id: string, fields: Record<string, unknown> = {}) {
  return { id, name: `${id}.txt`, mime: 'text/plain', size: 3, ...fields }
}

describe('lossless renderer conversation sources', () => {
  it('retains all eight native records while exposing only the readable message', () => {
    const raw = opaqueThread()
    const restored = readThreads([raw])[0]
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0].text).toBe(exact)
    expect(restored.messages[0].input).toBe(exact)
    expect(restored.workspace).toBe(raw.workspace)
    expect(restored.remoteId).toBe(raw.remoteId)
    expect(hasConversationSource(restored)).toBe(true)
    const saved = projected(restored)
    expect(saved.messages).toHaveLength(8)
    expect(json(saved)).toEqual(raw)
    expect(saved.messages[0]).toBe(raw.messages[0])
    expect(saved.messages[3]).toBe(raw.messages[3])
    expect(saved.futureThreadField).toBe(raw.futureThreadField)
  })

  it('can explicitly attach a raw source to a normalized baseline without changing rendering', () => {
    const raw = opaqueThread()
    const baseline = readThreads([raw])[0]
    const plain = JSON.parse(JSON.stringify(baseline)) as Thread
    expect(hasConversationSource(plain)).toBe(false)
    const attached = attachConversationSource(plain, raw)
    expect(attached.messages).toEqual(plain.messages)
    expect(hasConversationSource(attached)).toBe(true)
    expect(json(projected(attached))).toEqual(raw)
  })

  it('preserves raw metadata rejected or transformed by display sanitizers', () => {
    const raw = rawThread({
      title: '   ',
      workspace: 'relative/project',
      gitBranch: 'native\nbranch',
      gitHost: 17,
      researchContext: { futureContext: exact },
      reasoningEffort: 'native\nchoice',
      busy: true,
      turnStatus: 'running',
      pending: [{ type: 'approval', sessionId: 'native-session-Ω', requestId: 'original-request' }],
      messages: [
        known('known', exact, {
          phase: 'future-phase',
          kind: 'future-kind',
          agentName: 'native\nname',
          createdAt: -3,
          turn: 'legacy-turn',
          input: { futureInput: exact },
          attachments: [{ id: 'future-attachment', futureAttachment: exact }],
          fileChanges: [{ futureChange: exact }],
        }),
      ],
    })
    const restored = readThreads([raw])[0]
    expect(restored.title).toBe('Untitled thread')
    expect(restored.workspace).toBeUndefined()
    expect(restored.reasoningEffort).toBe('')
    expect(restored.busy).toBe(false)
    expect(restored.turnStatus).toBe('unknown')
    expect(restored.pending).toEqual([])
    expect(restored.messages[0].turn).toBe(0)
    expect(restored.messages[0].attachments).toEqual([])
    expect(json(projected(restored))).toEqual(raw)
    expect(json(createHistorySnapshotProjector()([restored])[0])).toEqual(raw)
  })

  it('merges immutable field edits and deliberate property removals into the original record', () => {
    const raw = rawThread({
      gitBranch: 'main',
      futureThreadField: { retained: exact },
      messages: [
        known('known', exact, { status: 'completed', futureMessageField: { retained: exact } }),
      ],
    })
    const restored = readThreads([raw])[0]
    const message = { ...restored.messages[0], text: '  Edited\r\nΩ  ', status: 'failed' }
    delete message.input
    Reflect.deleteProperty(message, 'futureMessageField')
    const edited = { ...restored, title: 'Renamed', messages: [message] }
    delete edited.remoteId
    delete edited.gitBranch
    const saved = projected(edited)
    const expectedMessage: Record<string, unknown> = {
      ...(raw.messages[0] as Record<string, unknown>),
      text: message.text,
      status: 'failed',
    }
    delete expectedMessage.input
    delete expectedMessage.futureMessageField
    const expected: RawThread = { ...raw, title: 'Renamed', messages: [expectedMessage] }
    delete expected.remoteId
    delete expected.gitBranch
    expect(json(saved)).toEqual(expected)
    expect(saved.futureThreadField).toBe(raw.futureThreadField)
    expect((raw.messages[0] as Record<string, unknown>).input).toBe(exact)
    expect(raw.remoteId).toBe('native-session-Ω')
    expect(json(projected(restored))).toEqual(raw)
  })

  it('edits and deletes duplicate and empty-ID occurrences without deleting their opaque neighbors', () => {
    const first = known('duplicate', 'First exact\r\n')
    const second = known('duplicate', 'Second exact\r\n')
    const empty = known('', 'Empty native identity\r\n')
    const last = known('last', 'Last exact\r\n')
    const future = { id: 'future', role: 'future-role', text: exact }
    const raw = rawThread({ messages: ['head', first, null, second, empty, last, future] })
    const restored = readThreads([raw])[0]
    expect(restored.messages.map((message) => message.id)).toEqual([
      'duplicate',
      'duplicate',
      '',
      'last',
    ])
    const edits = projected({
      ...restored,
      messages: restored.messages.map((message, index) =>
        index === 1 ? { ...message, text: 'Changed second occurrence\r\n' } : message,
      ),
    })
    expect((edits.messages[1] as Record<string, unknown>).text).toBe(first.text)
    expect((edits.messages[3] as Record<string, unknown>).text).toBe(
      'Changed second occurrence\r\n',
    )
    const removed = projected({
      ...restored,
      messages: [{ ...restored.messages[0], text: 'Edited first\r\n' }, restored.messages[3]],
    })
    expect(json(removed.messages)).toEqual([
      'head',
      { ...first, text: 'Edited first\r\n' },
      null,
      last,
      future,
    ])
    expect(raw.messages).toEqual(['head', first, null, second, empty, last, future])
  })

  it('honors visible occurrence reordering and insertion while retaining opaque slot order', () => {
    const first = known('first', 'First exact\r\n')
    const second = known('second', 'Second exact\r\n')
    const raw = rawThread({ messages: ['head', first, null, second, 'tail'] })
    const restored = readThreads([raw])[0]
    expect(
      json(projected({ ...restored, messages: [...restored.messages].reverse() }).messages),
    ).toEqual(['head', second, null, first, 'tail'])
    const added: Message = { id: 'added', role: 'user', text: '  New exact prompt\r\nΩ  ', turn: 3 }
    expect(
      json(projected({ ...restored, messages: [added, ...restored.messages] }).messages),
    ).toEqual(['head', added, first, null, second, 'tail'])
  })

  it('reorders duplicate messages with identical normalized fields by their distinct raw occurrences', () => {
    const first = known('same', exact, { phase: 'legacy-first' })
    const second = known('same', exact, { phase: 'legacy-second' })
    const raw = rawThread({ messages: [first, second] })
    const restored = readThreads([raw])[0]
    expect(restored.messages[0].phase).toBeUndefined()
    expect(restored.messages[1].phase).toBeUndefined()
    expect(json(restored.messages[0])).toEqual(json(restored.messages[1]))
    const saved = projected({ ...restored, messages: [...restored.messages].reverse() })
    expect(json(saved.messages)).toEqual([second, first])
    expect(saved.messages[0]).toBe(second)
    expect(saved.messages[1]).toBe(first)
    expect(raw.messages).toEqual([first, second])
  })

  it('reorders identical normalized attachments while preserving their distinct hidden metadata', () => {
    const first = attachment('same', { futureAttachmentField: 'first' })
    const second = attachment('same', { futureAttachmentField: 'second' })
    const raw = rawThread({ messages: [known('known', exact, { attachments: [first, second] })] })
    const restored = readThreads([raw])[0]
    const attachments = restored.messages[0].attachments!
    expect(json(attachments[0])).toEqual(json(attachments[1]))
    const saved = projected({
      ...restored,
      messages: [{ ...restored.messages[0], attachments: [...attachments].reverse() }],
    })
    const savedAttachments = (saved.messages[0] as Record<string, unknown>).attachments as unknown[]
    expect(json(savedAttachments)).toEqual([second, first])
    expect(savedAttachments[0]).toBe(second)
    expect(savedAttachments[1]).toBe(first)
    expect((raw.messages[0] as Record<string, unknown>).attachments).toEqual([first, second])
  })

  it('preserves opaque records when every visible row is removed until clear is explicit', () => {
    const raw = opaqueThread()
    const restored = readThreads([raw])[0]
    const visibleRemoved = projected({ ...restored, messages: [] })
    expect(json(visibleRemoved.messages)).toEqual(raw.messages.filter((_, index) => index !== 6))
    const cleared = clearConversationSourceMessages(restored)
    expect(cleared.messages).toEqual([])
    expect(projected(cleared).messages).toEqual([])
    expect(projected({ ...cleared, title: 'After clear' }).messages).toEqual([])
    expect(projected(restored).messages).toHaveLength(8)
  })

  it('persists new messages appended after an explicit clear before the clear is acknowledged', () => {
    const restored = readThreads([opaqueThread()])[0]
    const cleared = clearConversationSourceMessages(restored)
    const added: Message = { id: 'new', role: 'user', text: exact, turn: 3 }
    expect(json(projected({ ...cleared, messages: [added] }).messages)).toEqual([added])
    expect(projected(restored).messages).toHaveLength(8)
    expect(projected(cleared).messages).toEqual([])
  })

  it('does not inherit a source when a cloned thread changes native ownership or identity', () => {
    const restored = readThreads([opaqueThread()])[0]
    for (const fields of [
      { id: 'fork' },
      { profileId: 'other-machine' },
      { provider: 'codex' as const },
    ]) {
      const fork = { ...restored, ...fields }
      expect(hasConversationSource(fork)).toBe(false)
      const saved = projected(fork)
      expect(saved.messages).toHaveLength(1)
      expect(saved.futureThreadField).toBeUndefined()
      expect(saved.id).toBe(fork.id)
      expect(saved.profileId).toBe(fork.profileId)
      expect(saved.provider).toBe(fork.provider)
    }
    expect(hasConversationSource({ ...restored, workspace: '/resolved/project' })).toBe(true)
  })

  it('retains raw attachment and queue entries through unrelated and nested edits', () => {
    const visibleAttachment = attachment('visible-blob', { futureAttachmentField: { exact } })
    const opaqueAttachment = { id: 'opaque-blob', futureAttachmentField: { exact } }
    const queuedAttachment = attachment('queued-blob', { futureQueueAttachmentField: { exact } })
    const futureQueue = {
      id: 'future-queue',
      futureQueueField: { exact },
      attachments: [{ id: 'queue-opaque-blob' }],
    }
    const rawQueue = {
      id: 'queue',
      text: exact,
      createdAt: 5,
      paused: false,
      futureQueueField: { exact },
      attachments: [queuedAttachment, { id: 'queued-opaque-blob' }, null],
    }
    const raw = rawThread({
      messages: [
        known('known', exact, { attachments: [visibleAttachment, opaqueAttachment, null] }),
      ],
      queue: [null, rawQueue, futureQueue, 'future queue row'],
    })
    const restored = readThreads([raw])[0]
    expect(restored.messages[0].attachments).toHaveLength(1)
    expect(restored.queue).toHaveLength(1)
    expect(restored.queue![0].paused).toBe(true)
    expect(json(projected({ ...restored, title: 'Renamed' }))).toEqual({ ...raw, title: 'Renamed' })
    const edited = {
      ...restored,
      messages: [
        {
          ...restored.messages[0],
          attachments: [{ ...restored.messages[0].attachments![0], name: 'renamed.txt' }],
        },
      ],
      queue: [{ ...restored.queue![0], text: '  Edited queue\r\nΩ  ' }],
    }
    const saved = projected(edited)
    expect(json(saved.messages)).toEqual([
      {
        ...known(),
        attachments: [{ ...visibleAttachment, name: 'renamed.txt' }, opaqueAttachment, null],
      },
    ])
    expect(json(saved.queue)).toEqual([
      null,
      { ...rawQueue, text: edited.queue[0].text },
      futureQueue,
      'future queue row',
    ])
    expect(json(projected({ ...restored, queue: [] }).queue)).toEqual([
      null,
      futureQueue,
      'future queue row',
    ])
  })

  it('edits the admitted queued occurrence when an earlier opaque row has the same ID', () => {
    const opaque = { id: 'same', futureOpaque: true }
    const visible = { id: 'same', text: exact, createdAt: 1, attachments: [] }
    const raw = rawThread({ queue: [opaque, visible] })
    const restored = readThreads([raw])[0]
    expect(restored.queue).toHaveLength(1)
    const text = '  Edited visible queue occurrence\r\nΩ  '
    const saved = projected({ ...restored, queue: [{ ...restored.queue![0], text }] })
    expect(json(saved.queue)).toEqual([opaque, { ...visible, text }])
    expect((saved.queue as unknown[])[0]).toBe(opaque)
    expect(Object.hasOwn(opaque, 'text')).toBe(false)
    expect(visible.text).toBe(exact)
  })

  it('edits and deletes the admitted attachment occurrences after an opaque row with the same ID', () => {
    const opaque = { id: 'same', futureOpaque: true }
    const first = attachment('same', { name: 'first.txt' })
    const second = attachment('same', { name: 'second.txt' })
    const raw = rawThread({
      messages: [known('known', exact, { attachments: [opaque, first, second] })],
    })
    const restored = readThreads([raw])[0]
    const visible = restored.messages[0].attachments!
    expect(visible.map((item) => item.name)).toEqual(['first.txt', 'second.txt'])
    const edited = projected({
      ...restored,
      messages: [
        {
          ...restored.messages[0],
          attachments: [visible[0], { ...visible[1], name: 'edited-second.txt' }],
        },
      ],
    })
    const editedAttachments = (edited.messages[0] as Record<string, unknown>)
      .attachments as unknown[]
    expect(json(editedAttachments)).toEqual([
      opaque,
      first,
      { ...second, name: 'edited-second.txt' },
    ])
    expect(editedAttachments[0]).toBe(opaque)
    const removed = projected({
      ...restored,
      messages: [{ ...restored.messages[0], attachments: [visible[0]] }],
    })
    expect(json((removed.messages[0] as Record<string, unknown>).attachments)).toEqual([
      opaque,
      first,
    ])
    expect(second.name).toBe('second.txt')
    expect(Object.hasOwn(opaque, 'name')).toBe(false)
  })

  it('counts attachment references that exist only in opaque surviving messages and queue rows', () => {
    const raw = rawThread({
      messages: [
        known('known', exact, { attachments: [attachment('visible-blob')] }),
        { role: 'future-role', attachments: [{ id: 'opaque-blob' }, { id: 'shared-blob' }] },
      ],
      queue: [
        { id: 'future-queue', attachments: [{ id: 'queued-opaque-blob' }, { id: 'shared-blob' }] },
      ],
    })
    const restored = readThreads([raw])[0]
    expect(new Set(conversationSourceAttachmentIds(restored))).toEqual(
      new Set(['visible-blob', 'opaque-blob', 'shared-blob', 'queued-opaque-blob']),
    )
    const removed = { ...restored, messages: [] }
    expect(new Set(conversationSourceAttachmentIds(removed))).toEqual(
      new Set(['opaque-blob', 'shared-blob', 'queued-opaque-blob']),
    )
    expect(
      new Set(conversationSourceAttachmentIds(clearConversationSourceMessages(restored))),
    ).toEqual(new Set(['queued-opaque-blob', 'shared-blob']))
  })

  it('preserves attachment and queue overflow records that the renderer cannot admit', () => {
    const attachments = Array.from({ length: 9 }, (_, index) => attachment(`blob-${index}`))
    const queue = Array.from({ length: 33 }, (_, index) => ({
      id: `queued-${index}`,
      text: exact,
      createdAt: index,
      paused: false,
      attachments: [],
      futureQueueField: { exact },
    }))
    const raw = rawThread({ messages: [known('known', exact, { attachments })], queue })
    const restored = readThreads([raw])[0]
    expect(restored.messages[0].attachments).toHaveLength(8)
    expect(restored.queue).toHaveLength(32)
    expect(json(projected({ ...restored, title: 'Renamed' }))).toEqual({ ...raw, title: 'Renamed' })
    const edited = {
      ...restored,
      messages: [{ ...restored.messages[0], attachments: [] }],
      queue: [],
    }
    const saved = projected(edited)
    expect(json((saved.messages[0] as Record<string, unknown>).attachments)).toEqual([
      attachments[8],
    ])
    expect(json(saved.queue)).toEqual([queue[32]])
  })

  it('retains prototype-named own JSON fields without altering object prototypes', () => {
    const raw = JSON.parse(JSON.stringify(rawThread())) as RawThread
    const own = JSON.parse(
      '{"__proto__":{"polluted":"raw"},"constructor":{"exact":"native"},"prototype":{"retained":true}}',
    ) as Record<string, unknown>
    Object.defineProperties(raw, Object.getOwnPropertyDescriptors(own))
    Object.defineProperties(raw.messages[0], Object.getOwnPropertyDescriptors(own))
    const restored = readThreads([raw])[0]
    const saved = projected({
      ...restored,
      title: 'Edited',
      messages: [{ ...restored.messages[0], text: 'Edited' }],
    })
    expect(Object.hasOwn(saved, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
    expect(Object.hasOwn(saved.messages[0]!, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(saved.messages[0])).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((saved as Record<string, unknown>).__proto__).toEqual({ polluted: 'raw' })
    expect((saved.messages[0] as Record<string, unknown>).constructor).toEqual({ exact: 'native' })
  })

  it('keeps deep future values by reference across repeated immutable projections', () => {
    let future: Record<string, unknown> = { exact }
    for (let index = 0; index < 12_000; index++) future = { next: future }
    const raw = rawThread({
      futureThreadField: future,
      messages: [known('known', exact, { futureMessageField: future })],
    })
    const restored = readThreads([raw])[0]
    for (let index = 0; index < 5; index++) {
      const saved = projected({ ...restored, title: `Rename ${index}` })
      expect(saved.futureThreadField).toBe(future)
      expect((saved.messages[0] as Record<string, unknown>).futureMessageField).toBe(future)
      expect(saved.messages[0]).toBe(raw.messages[0])
    }
  })

  it('merges an edited leaf through twelve thousand nested future records without recursion', () => {
    let original: Record<string, unknown> = { text: exact, retained: 17 }
    let edited: Record<string, unknown> = { text: '  Changed deep leaf\r\nΩ  ', retained: 17 }
    for (let index = 0; index < 12_000; index++) {
      original = { next: original }
      edited = { next: edited }
    }
    const raw = rawThread({ messages: [known('known', exact, { futureMessageField: original })] })
    const restored = readThreads([raw])[0]
    const changedMessage = { ...restored.messages[0], futureMessageField: edited }
    const saved = projected({
      ...restored,
      messages: [changedMessage],
    })
    let savedLeaf = (saved.messages[0] as Record<string, unknown>).futureMessageField as Record<
      string,
      unknown
    >
    let originalLeaf = original
    for (let index = 0; index < 12_000; index++) {
      savedLeaf = savedLeaf.next as Record<string, unknown>
      originalLeaf = originalLeaf.next as Record<string, unknown>
    }
    expect(savedLeaf).toEqual({ text: '  Changed deep leaf\r\nΩ  ', retained: 17 })
    expect(originalLeaf).toEqual({ text: exact, retained: 17 })
  })

  it('deletes prototype-named own message fields without persisting inherited properties', () => {
    const raw = rawThread()
    const own = JSON.parse(
      '{"__proto__":{"retained":true},"constructor":{"retained":true},"prototype":{"retained":true}}',
    ) as Record<string, unknown>
    Object.defineProperties(raw.messages[0], Object.getOwnPropertyDescriptors(own))
    const restored = readThreads([raw])[0]
    const edited = { ...restored.messages[0] }
    for (const key of Object.keys(own)) Reflect.deleteProperty(edited, key)
    const saved = projected({ ...restored, messages: [edited] })
    for (const key of Object.keys(own)) expect(Object.hasOwn(saved.messages[0]!, key)).toBe(false)
    expect(Object.getPrototypeOf(saved.messages[0])).toBe(Object.prototype)
    expect(json(saved.messages)).toEqual([known()])
    expect(Object.hasOwn(raw.messages[0]!, 'constructor')).toBe(true)
  })

  it('preserves recovery records across repeated serialized restoration', () => {
    const raw = opaqueThread()
    let restored = readThreads([raw])[0]
    for (let index = 0; index < 3; index++) {
      const snapshot = json(projected(restored))
      expect(snapshot).toEqual(raw)
      restored = readThreads([snapshot])[0]
      expect(restored.messages).toHaveLength(1)
      expect(restored.messages[0].text).toBe(exact)
    }
  })

  it('refreshes a queued return to the restored mode against a newly acknowledged edit', () => {
    const raw = rawThread({ mode: 'future-mode', futureThreadField: { exact } })
    const restored = readThreads([raw])[0]
    expect(restored.mode).toBe('review')
    const first = { ...restored, mode: 'full-access' as const }
    const second = { ...first, mode: 'review' as const }
    const firstHistory = createHistorySnapshotProjector()([first])
    const queuedHistory = createHistorySnapshotProjector()([second])
    expect(firstHistory[0].mode).toBe('full-access')
    expect(queuedHistory[0].mode).toBe('future-mode')
    acknowledgeConversationSources(firstHistory, 100)
    const refreshed = refreshConversationSources(queuedHistory)
    expect(refreshed[0].mode).toBe('review')
    expect((refreshed[0] as unknown as RawThread).futureThreadField).toBe(raw.futureThreadField)
    acknowledgeConversationSources(refreshed, 200)
    acknowledgeConversationSources(firstHistory, 150)
    expect(refreshConversationSources(queuedHistory)[0].mode).toBe('review')
    expect(raw.mode).toBe('future-mode')
  })

  it('rebases acknowledged edits and ignores older acknowledgements during subsequent immutable edits', () => {
    const raw = opaqueThread()
    const restored = readThreads([raw])[0]
    const first = {
      ...restored,
      title: 'First durable title',
      messages: [{ ...restored.messages[0], text: '  First durable prompt\r\nΩ  ' }],
    }
    const firstHistory = createHistorySnapshotProjector()([first])
    acknowledgeConversationSources(firstHistory, 100)
    const second = { ...first, title: 'Second durable title' }
    const secondHistory = createHistorySnapshotProjector()([second])
    acknowledgeConversationSources(secondHistory, 200)
    acknowledgeConversationSources(firstHistory, 150)
    const third = { ...second, updatedAt: 300 }
    const saved = projected(third)
    expect(json(saved)).toEqual({
      ...raw,
      title: 'Second durable title',
      updatedAt: 300,
      messages: raw.messages.map((message, index) =>
        index === 6
          ? { ...(message as Record<string, unknown>), text: first.messages[0].text }
          : message,
      ),
    })
    expect(saved.messages[3]).toBe(raw.messages[3])
    expect(saved.futureThreadField).toBe(raw.futureThreadField)
  })
})

describe('bounded conversation source message restoration', () => {
  it('owns both batch appends and returns the final raw thread unchanged', () => {
    const header = rawThread({ messages: [], futureThreadField: { exact } })
    const restored = readThreads([header])[0]
    const rawAccumulator: unknown[] = []
    const batches = [
      [null, known('first')],
      ['opaque', known('second'), 17],
    ]
    for (const batch of batches) {
      const normalized = readThreadMessages(batch)
      appendConversationSourceMessages(restored, rawAccumulator, normalized, batch)
    }
    expect(restored.messages.map((message) => message.id)).toEqual(['first', 'second'])
    expect(rawAccumulator).toEqual(batches.flat())
    const finalRaw = { ...header, messages: rawAccumulator }
    attachConversationSource(restored, finalRaw)
    expect(projectConversationSource(restored)).toBe(finalRaw)
    expect(header.messages).toEqual([])
  })

  it('retains duplicate and empty native identities across batch boundaries by source occurrence', () => {
    const first = known('duplicate', 'First batch exact\r\n')
    const second = known('duplicate', 'Second batch exact\r\n')
    const empty = known('', 'Empty native identity\r\n')
    const opaque = { id: 'future', role: 'future-role', text: exact }
    const header = rawThread({ messages: [] })
    const restored = readThreads([header])[0]
    const rawAccumulator: unknown[] = []
    for (const batch of [
      [null, first],
      [opaque, second, empty],
    ])
      appendConversationSourceMessages(restored, rawAccumulator, readThreadMessages(batch), batch)
    attachConversationSource(restored, { ...header, messages: rawAccumulator })
    expect(restored.messages.map((message) => message.id)).toEqual(['duplicate', 'duplicate', ''])
    const text = '  Edited second batch occurrence\r\nΩ  '
    const saved = projected({
      ...restored,
      messages: [{ ...restored.messages[1], text }, restored.messages[2]],
    })
    expect(json(saved.messages)).toEqual([null, opaque, { ...second, text }, empty])
    expect(saved.messages[1]).toBe(opaque)
    expect(rawAccumulator).toEqual([null, first, opaque, second, empty])
  })

  it('reuses captured batch baselines when attaching a completed 32,000-message history', () => {
    const header = rawThread({ messages: [] })
    const restored = readThreads([header])[0]
    const rawAccumulator: unknown[] = []
    for (let batchIndex = 0; batchIndex < 32; batchIndex++) {
      const batch = Array.from({ length: 1_000 }, (_, index) =>
        known(`message-${batchIndex * 1_000 + index}`),
      )
      const normalized = readThreadMessages(batch)
      appendConversationSourceMessages(restored, rawAccumulator, normalized, batch)
      for (const message of normalized)
        Object.defineProperty(message, 'text', {
          enumerable: true,
          configurable: true,
          get: () => {
            throw new Error('Reread captured historical body during final attachment')
          },
        })
    }
    expect(restored.messages).toHaveLength(32_000)
    const finalRaw = { ...header, messages: rawAccumulator }
    expect(() => attachConversationSource(restored, finalRaw)).not.toThrow()
    expect(projectConversationSource(restored)).toBe(finalRaw)
  })

  it('acknowledges an appended message without rereading captured settled message bodies', () => {
    const header = rawThread({ messages: [], futureThreadField: { exact } })
    const restored = readThreads([header])[0]
    const rawAccumulator: unknown[] = []
    for (let offset = 0; offset < 1_000; offset += 256) {
      const batch = Array.from({ length: Math.min(256, 1_000 - offset) }, (_, index) =>
        known(`settled-${offset + index}`),
      )
      appendConversationSourceMessages(restored, rawAccumulator, readThreadMessages(batch), batch)
    }
    attachConversationSource(restored, { ...header, messages: rawAccumulator })
    for (const message of restored.messages)
      Object.defineProperty(message, 'text', {
        enumerable: true,
        configurable: true,
        get: () => {
          throw new Error('Read captured settled body while acknowledging an append')
        },
      })
    const added: Message = { id: 'appended', role: 'user', text: exact, turn: 3 }
    const appended = { ...restored, messages: [...restored.messages, added] }
    const history = createHistorySnapshotProjector()([appended])
    expect(history[0].messages).toHaveLength(1_001)
    expect(history[0].messages[0]).toBe(rawAccumulator[0])
    expect(history[0].messages[1_000].text).toBe(exact)
    expect(() => acknowledgeConversationSources(history, 100)).not.toThrow()
    const renamed = projected({ ...appended, title: 'After append acknowledgement' })
    expect(renamed.messages).toHaveLength(1_001)
    expect(renamed.messages[0]).toBe(rawAccumulator[0])
    expect(renamed.futureThreadField).toBe(header.futureThreadField)
    const followup: Message = {
      id: 'followup',
      role: 'user',
      text: '  Exact followup\r\nΩ  ',
      turn: 4,
    }
    const next = projected({ ...appended, messages: [...appended.messages, followup] })
    expect(next.messages).toHaveLength(1_002)
    expect(next.messages[0]).toBe(rawAccumulator[0])
    expect((next.messages[1_001] as Record<string, unknown>).text).toBe(followup.text)
    expect(() => acknowledgeConversationSources([next as unknown as Thread], 200)).not.toThrow()
  })

  it('preserves a role object with an own nonfunction toString as opaque raw data', () => {
    const opaque = { id: 'future', role: { toString: 'native' }, text: exact }
    const raw = rawThread({ messages: [opaque, known()] })
    const restored = readThreads([raw])[0]
    expect(restored.messages).toHaveLength(1)
    const saved = projected({ ...restored, title: 'Renamed' })
    expect(json(saved)).toEqual({ ...raw, title: 'Renamed' })
    expect(saved.messages[0]).toBe(opaque)
  })

  it('does not add absent raw defaults when normalized empty arrays and objects are cloned', () => {
    const raw = rawThread({ messages: [known('known', exact, { details: {} })] })
    const restored = readThreads([raw])[0]
    restored.statusDetails = {}
    attachConversationSource(restored, raw)
    const clone = {
      ...restored,
      queue: [...restored.queue!],
      statusDetails: { ...restored.statusDetails },
      messages: [
        {
          ...restored.messages[0],
          details: { ...restored.messages[0].details },
          attachments: [...restored.messages[0].attachments!],
          fileChanges: [...restored.messages[0].fileChanges!],
        },
      ],
    }
    const saved = projected(clone)
    expect(json(saved)).toEqual(raw)
    expect(Object.hasOwn(saved, 'queue')).toBe(false)
    expect(Object.hasOwn(saved, 'statusDetails')).toBe(false)
    expect(Object.hasOwn(saved.messages[0]!, 'attachments')).toBe(false)
    expect(Object.hasOwn(saved.messages[0]!, 'fileChanges')).toBe(false)
    expect((saved.messages[0] as Record<string, unknown>).details).toBe(
      (raw.messages[0] as Record<string, unknown>).details,
    )
  })
})

describe('source-aware complete history persistence', () => {
  it('saves merged recovery records through the actual native atomic engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-conversation-source-'))
    directories.push(directory)
    const engine = new ConversationCheckpointEngine(directory)
    const raw = opaqueThread()
    await runEffect(engine.saveEffect([raw], 10))
    const native = (await runEffect(engine.loadEffect()))!
    const restored = readThreads(native.threads)[0]
    const snapshot = createHistorySnapshotProjector()
    const client = new ConversationCheckpointClient()
    const save = vi.fn(async (history: unknown[], savedAt?: number) => {
      await runEffect(engine.saveEffect(history, savedAt!))
    })
    const checkpoint = vi.fn((input: ConversationCheckpointInput) =>
      runEffect(engine.checkpointEffect(input)),
    )
    await client.submit(snapshot([restored]), 11, save, checkpoint)
    const editedText = '  Exact edited native prompt\r\nΩ  '
    const edited = {
      ...restored,
      title: 'Renamed',
      messages: [{ ...restored.messages[0], text: editedText }],
    }
    await client.submit(snapshot([edited]), 12, save, checkpoint)
    const expected = {
      ...raw,
      title: 'Renamed',
      messages: raw.messages.map((message, index) =>
        index === 6 ? { ...(message as Record<string, unknown>), text: editedText } : message,
      ),
    }
    expect(save.mock.calls[0]).toEqual([[raw], 11])
    expect(
      (await runEffect(new ConversationCheckpointEngine(directory).loadEffect()))?.threads,
    ).toEqual([expected])
    expect(JSON.parse(await readFile(join(directory, 'conversations.json'), 'utf8'))).toEqual({
      version: 1,
      savedAt: 12,
      threads: [expected],
    })
  })

  it('keeps source occurrence ordering despite renderer sorting and explicitly deletes one duplicate thread occurrence', () => {
    const older = rawThread({ id: 'duplicate', title: 'Older source occurrence', updatedAt: 10 })
    const newer = rawThread({ id: 'duplicate', title: 'Newer source occurrence', updatedAt: 20 })
    const restored = readThreads([older, newer])
    expect(restored.map((thread) => thread.title)).toEqual([
      'Newer source occurrence',
      'Older source occurrence',
    ])
    const snapshot = createHistorySnapshotProjector()
    expect(json(snapshot(restored))).toEqual([older, newer])
    expect(json(snapshot([restored[0]]))).toEqual([newer])
  })
})
