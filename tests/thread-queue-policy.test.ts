import { describe, expect, it } from 'vitest'
import {
  canAutoSendQueuedMessage,
  normalizeQueuedMessages,
  pauseQueuedMessages,
  queueConnectionMatches,
  type QueuedMessage,
} from '../src/renderer/thread-queue'
import { applyEvent, type Thread } from '../src/renderer/state'
import type { ConnectionProfile, ConnectionState } from '../src/shared/types'
import { researchOperations } from '../src/shared/research-method'

const profile: ConnectionProfile = {
  id: 'machine',
  name: 'Research server',
  host: 'research.example',
  port: 22,
  username: 'researcher',
  auth: 'agent',
  privateKeyPath: '',
  workspace: '/srv/project',
}
const connection: ConnectionState = { status: 'connected', profile, workspace: '/srv/project' }
const queued: QueuedMessage = {
  id: 'queued-first',
  text: '  Inspect exactly this text.\n\nNo additional words.\n',
  createdAt: 10,
  attachments: [],
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    profileId: profile.id,
    workspace: connection.workspace,
    provider: 'codex',
    title: 'Provider title',
    remoteId: 'provider-conversation',
    messages: [],
    queue: [{ ...queued }],
    busy: false,
    turnStatus: 'completed',
    model: '',
    mode: 'review',
    updatedAt: 10,
    turn: 1,
    pending: [],
    ...overrides,
  }
}

describe('queued messages wait for actual provider completion', () => {
  it('sends a ready first message after an explicitly completed provider turn', () => {
    expect(canAutoSendQueuedMessage(thread(), connection)).toBe(true)
  })

  it('allows a fresh thread to start without inventing an earlier completion', () => {
    expect(canAutoSendQueuedMessage(thread({ turn: 0, turnStatus: undefined }), connection)).toBe(
      true,
    )
  })

  it.each(['running', 'interrupted', 'failed', 'reconnecting', 'unknown'] as const)(
    'does not send automatically after a %s turn, even when the renderer is not busy',
    (turnStatus) => {
      expect(canAutoSendQueuedMessage(thread({ turnStatus, busy: false }), connection)).toBe(false)
    },
  )

  it('keeps waiting through streamed final text until the provider emits its completion event', () => {
    const active = thread({ busy: true, turnStatus: 'running' })
    const finalText = applyEvent(active, {
      sessionId: active.id,
      type: 'text',
      itemId: 'final',
      phase: 'final_answer',
      status: 'replace',
      text: 'The final answer has arrived, but the provider is still running.',
    })
    expect(canAutoSendQueuedMessage(finalText, connection)).toBe(false)
    const completed = applyEvent(finalText, {
      sessionId: active.id,
      type: 'complete',
      status: 'completed',
    })
    expect(canAutoSendQueuedMessage(completed, connection)).toBe(true)
  })

  it('accepts completed legacy history only when its most recent user turn has completion evidence', () => {
    const legacy = thread({
      turnStatus: undefined,
      messages: [
        { id: 'older', role: 'user', text: 'Old message', turn: 1, finishStatus: 'completed' },
        { id: 'latest', role: 'user', text: 'Current message', turn: 2 },
      ],
      turn: 2,
    })
    expect(canAutoSendQueuedMessage(legacy, connection)).toBe(false)
    expect(
      canAutoSendQueuedMessage(
        {
          ...legacy,
          messages: legacy.messages.map((message) =>
            message.id === 'latest' ? { ...message, finishStatus: 'completed' } : message,
          ),
        },
        connection,
      ),
    ).toBe(true)
  })

  it.each([
    { busy: true },
    { pending: [{ sessionId: 'thread', type: 'approval' as const, requestId: 'approval' }] },
    { pending: [{ sessionId: 'thread', type: 'question' as const, requestId: 'question' }] },
    { queue: [{ ...queued, paused: true }] },
    { queue: [{ ...queued, error: 'Attachment missing' }] },
    { queue: [] },
    { queue: undefined },
  ])('does not pump blocked or incomplete state %j', (overrides) => {
    expect(canAutoSendQueuedMessage(thread(overrides), connection)).toBe(false)
  })

  it('honors external send blockers independently from busy and completion state', () => {
    expect(canAutoSendQueuedMessage(thread(), connection, true)).toBe(false)
    expect(canAutoSendQueuedMessage(thread(), connection, false)).toBe(true)
  })

  it('does not bypass a paused first message to send a later message out of order', () => {
    const updated = thread({
      queue: [
        { ...queued, paused: true },
        { ...queued, id: 'queued-second', paused: false },
      ],
    })
    expect(canAutoSendQueuedMessage(updated, connection)).toBe(false)
  })
})

describe('queued work stays bound to its original environment', () => {
  it.each([
    { status: 'disconnected' as const },
    { status: 'connecting' as const, profile },
    { ...connection, workspace: undefined },
    { ...connection, profile: undefined },
    { ...connection, profile: { ...profile, id: 'other-machine' } },
    { ...connection, workspace: '/srv/other-project' },
  ])('rejects a disconnected or different context %j', (otherConnection) => {
    expect(queueConnectionMatches(thread(), otherConnection)).toBe(false)
    expect(canAutoSendQueuedMessage(thread(), otherConnection)).toBe(false)
  })

  it('preserves exact queued user text on restore and pauses it instead of replaying saved work', () => {
    const restored = normalizeQueuedMessages([{ ...queued, paused: false }])
    expect(restored).toHaveLength(1)
    expect(restored[0].text).toBe(queued.text)
    expect(restored[0].paused).toBe(true)
    expect(canAutoSendQueuedMessage(thread({ queue: restored }), connection)).toBe(false)
  })

  it.each(['', '  \n'])(
    'restores attachment-only input %j without adding synthetic prompt text',
    (text) => {
      const attachment = { id: 'attachment', name: 'diagram.svg', mime: 'image/svg+xml', size: 120 }
      const restored = normalizeQueuedMessages([{ ...queued, text, attachments: [attachment] }])
      expect(restored).toHaveLength(1)
      expect(restored[0].text).toBe(text)
      expect(restored[0].attachments).toEqual([attachment])
      expect(restored[0].paused).toBe(true)
      const explicitlyResumed = thread({ queue: [{ ...restored[0], paused: false }] })
      expect(canAutoSendQueuedMessage(explicitlyResumed, connection)).toBe(true)
    },
  )

  it('rejects blank queued input when its only saved attachment metadata is invalid', () => {
    expect(
      normalizeQueuedMessages([
        { ...queued, text: '', attachments: [{ id: 'invalid', name: 'diagram.svg', size: -1 }] },
      ]),
    ).toEqual([])
  })

  it('does not treat an interrupted completion as authorization to send the next message', () => {
    const interrupted = applyEvent(thread({ busy: true, turnStatus: 'running' }), {
      sessionId: 'thread',
      type: 'complete',
      status: 'interrupted',
    })
    expect(interrupted.queue?.[0].paused).toBe(true)
    expect(canAutoSendQueuedMessage(interrupted, connection)).toBe(false)
  })

  it('allows a separate research thread to use its saved research directory without switching the active agent project', () => {
    const research = thread({
      purpose: 'research',
      workspace: '/srv/root/.life/research',
      researchContext: {
        scopeKey: JSON.stringify(['research', profile.id, '/srv/root']),
        goalId: 'goal',
      },
    })
    const researchConnection = { ...connection, home: '/srv/root' }
    expect(queueConnectionMatches(research, researchConnection)).toBe(true)
    expect(canAutoSendQueuedMessage(research, researchConnection)).toBe(true)
    expect(connection.workspace).toBe('/srv/project')
    expect(research.workspace).toBe('/srv/root/.life/research')
  })
  it('rejects the same profile after its remote home changes, even if the saved folder is selected', () => {
    const research = thread({
      purpose: 'research',
      workspace: '/srv/root/.life/research/goal',
      researchContext: {
        scopeKey: JSON.stringify(['research', profile.id, '/srv/root']),
        goalId: 'goal',
      },
    })
    const changed = { ...connection, home: '/srv/another-user', workspace: research.workspace }
    expect(queueConnectionMatches(research, changed)).toBe(false)
    expect(canAutoSendQueuedMessage(research, changed)).toBe(false)
  })
  it.each([undefined, '/another-home'])(
    'does not infer a recorded research home from the active project when actual home is %j',
    (home) => {
      const research = thread({
        purpose: 'research',
        workspace: '/srv/root/.life/research',
        researchContext: {
          scopeKey: JSON.stringify(['research', profile.id, '/srv/root']),
          goalId: 'goal',
        },
      })
      expect(queueConnectionMatches(research, { ...connection, home })).toBe(false)
    },
  )
  it.each(
    [
      ['research', 'different-profile', '/srv/root'],
      ['research', profile.id, 'relative-home'],
      ['research', profile.id],
      ['research', profile.id, '/srv/root', 'unexpected-field'],
    ].map((scope) => [scope]),
  )('rejects an inconsistent modern research scope %j', (scope) => {
    const research = thread({
      purpose: 'research',
      workspace: '/srv/root/.life/research',
      researchContext: { scopeKey: JSON.stringify(scope), goalId: 'goal' },
    })
    expect(queueConnectionMatches(research, { ...connection, home: '/srv/root' })).toBe(false)
  })
  it.each(['/srv/root', '/srv/root/', '/srv/root///'])(
    'normalizes remote home trailing separators without switching agent project: %s',
    (home) => {
      const research = thread({
        purpose: 'research',
        workspace: '/srv/root/.life/research/goal',
        researchContext: {
          scopeKey: JSON.stringify(['research', profile.id, '/srv/root/']),
          goalId: 'goal',
        },
      })
      expect(queueConnectionMatches(research, { ...connection, home })).toBe(true)
      expect(connection.workspace).toBe('/srv/project')
    },
  )
  it('supports the machine filesystem root as a research home', () => {
    const research = thread({
      purpose: 'research',
      workspace: '/.life/research/goal',
      researchContext: { scopeKey: JSON.stringify(['research', profile.id, '/']), goalId: 'goal' },
    })
    expect(queueConnectionMatches(research, { ...connection, home: '/' })).toBe(true)
  })
  it.each(['/.life/research/goal', '/.research/goal'])(
    'proves legacy research context from the actual machine home and saved folder %s',
    (directory) => {
      const research = thread({ purpose: 'research', workspace: '/srv/root' + directory })
      expect(queueConnectionMatches(research, { ...connection, home: '/srv/root' })).toBe(true)
      expect(queueConnectionMatches(research, { ...connection, home: '/srv/different' })).toBe(
        false,
      )
    },
  )
  it('does not match a different folder sharing only a legacy research path prefix', () => {
    const research = thread({
      purpose: 'research',
      workspace: '/srv/root/.life/research-unrelated',
    })
    expect(queueConnectionMatches(research, { ...connection, home: '/srv/root' })).toBe(false)
  })
  it('keeps legacy research without recorded home bound to its explicitly selected saved folder', () => {
    const research = thread({ purpose: 'research', workspace: '/legacy/project/.research/goal' })
    expect(queueConnectionMatches(research, { ...connection, workspace: research.workspace })).toBe(
      true,
    )
    expect(queueConnectionMatches(research, connection)).toBe(false)
  })

  it('still rejects a different machine for isolated research work', () => {
    const research = thread({ purpose: 'research', workspace: '/srv/root/.life/research' })
    expect(
      canAutoSendQueuedMessage(research, {
        ...connection,
        profile: { ...profile, id: 'another-machine' },
      }),
    ).toBe(false)
  })

  it('keeps unresolved research directories paused instead of adopting the selected agent project', () => {
    const research = thread({ purpose: 'research', workspace: undefined, workspaceUnknown: true })
    expect(queueConnectionMatches(research, connection)).toBe(false)
    expect(canAutoSendQueuedMessage(research, connection)).toBe(false)
  })
})

describe('queued research operation snapshots', () => {
  it.each(researchOperations)(
    'retains the selected %s operation without altering the user message',
    (researchOperation) => {
      const restored = normalizeQueuedMessages([{ ...queued, researchOperation }])
      expect(restored).toEqual([{ ...queued, researchOperation, paused: true }])
      expect(restored[0].text).toBe(queued.text)
      expect(pauseQueuedMessages(restored)[0].researchOperation).toBe(researchOperation)
    },
  )
  it.each(['', 'unknown', 'decompose', 'synthesize', null, 42, { operation: 'ground' }])(
    'omits unsupported stored operation %j while retaining the paused user message',
    (researchOperation) => {
      expect(normalizeQueuedMessages([{ ...queued, researchOperation }])).toEqual([
        { ...queued, paused: true },
      ])
    },
  )
  it('keeps ordinary and legacy queued messages unchanged', () => {
    const restored = normalizeQueuedMessages([queued])
    expect(restored).toEqual([{ ...queued, paused: true }])
    expect(Object.hasOwn(restored[0], 'researchOperation')).toBe(false)
  })
  it('preserves each queued operation through provider completion instead of adopting a later selected method', () => {
    const active = thread({
      busy: true,
      turnStatus: 'running',
      queue: [
        { ...queued, researchOperation: 'ground' },
        { ...queued, id: 'next-message', researchOperation: 'counterfactual' },
      ],
    })
    const completed = applyEvent(active, {
      sessionId: active.id,
      type: 'complete',
      status: 'completed',
    })
    expect(completed.queue?.map((message) => message.researchOperation)).toEqual([
      'ground',
      'counterfactual',
    ])
    expect(completed.queue?.[0].text).toBe(queued.text)
    expect(canAutoSendQueuedMessage(completed, connection)).toBe(true)
    expect(active.queue?.[0].researchOperation).toBe('ground')
  })
})
