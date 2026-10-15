import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import type {
  ConversationCheckpointInput,
  ConversationProjectionAdmission,
} from '../src/shared/conversations'
import type { ConversationLoadPacket } from '../src/renderer/conversation-load-protocol'
import type { ThreadAttachment } from '../src/renderer/attachments'
import {
  applyEvent,
  finishThreadTurn,
  readThreads,
  type Message,
  type Thread,
} from '../src/renderer/state'
import { loadConversationHistory } from '../src/renderer/conversation-load-provenance'
import {
  carryNativeProjectionAttachmentUpdate,
  carryNativeProjectionAuthoredTransition,
  carryNativeProjectionOwnerSnapshot,
  nativeProjectionAdmissions,
  registerNativeProjectionDelivery,
  registerNativeProjectionLoadedBaseline,
} from '../src/renderer/native-projection-admissions'
import {
  ConversationCheckpointClient,
  createHistorySnapshotProjector,
} from '../src/renderer/conversation-checkpoint-client'

vi.mock('../src/renderer/conversation-load-worker?worker&inline', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: class {
      onmessage: ((event: MessageEvent<ConversationLoadPacket>) => void) | null = null
      onerror = null
      onmessageerror = null
      terminate() {}
      postMessage(input: { type: string; buffer?: ArrayBuffer }) {
        if (input.type !== 'load' || !input.buffer) return
        const bytes = new Uint8Array(input.buffer)
        const snapshot = JSON.parse(new TextDecoder().decode(bytes))
        const hash = createHash('sha256').update(bytes).digest('hex')
        queueMicrotask(() => {
          const emit = (data: ConversationLoadPacket) =>
            this.onmessage?.({ data } as MessageEvent<ConversationLoadPacket>)
          emit({
            type: 'start',
            savedAt: snapshot.savedAt,
            threadCount: snapshot.threads.length,
            checkpointEligible: true,
            hash,
          })
          for (let index = 0; index < snapshot.threads.length; index++) {
            const { messages, ...header } = snapshot.threads[index]
            emit({ type: 'thread', index, thread: header, messageCount: messages.length })
            if (messages.length) emit({ type: 'messages', index, messages })
          }
          emit({ type: 'done' })
        })
      }
    },
  }
})

const admission: ConversationProjectionAdmission = {
  sessionId: 'attachment-thread',
  transportId: 'attachment-transport',
  appliedRevision: 4,
  snapshotToken: 'actual-historical-snapshot',
  ownerGeneration: 2,
  deliveryToken: 'actual-private-attachment-delivery',
}
const userId = 'authored-upload-user'
const exactPrompt = '  Exact upload prompt\r\n\t🙂\ud800  '
const localAttachments: ThreadAttachment[] = [
  { id: 'first-upload', name: 'Exact file.txt', mime: 'text/plain', size: 12 },
  { id: 'second-upload', name: 'image.png', mime: 'image/png', size: 7 },
]
const remoteAttachments: ThreadAttachment[] = localAttachments.map((file, index) => ({
  ...file,
  remotePath: `/tmp/life-thread-attachments.actual/${index}-${file.id}`,
}))

function thread(): Thread {
  return {
    id: admission.sessionId,
    profileId: 'actual-machine',
    provider: 'codex',
    workspace: '/owned/project',
    remoteId: 'actual-native-thread',
    title: 'Attachment recovery',
    messages: [
      { id: 'historical-user', role: 'user', text: '  Earlier literal prompt  ', turn: 1 },
      {
        id: 'historical-assistant',
        role: 'assistant',
        text: '  Existing native output\r\n🙂  ',
        turn: 1,
        nativeRecovery: {
          transportId: admission.transportId,
          ownerGeneration: admission.ownerGeneration,
        },
      },
    ],
    pending: [],
    busy: false,
    turn: 1,
    updatedAt: 10,
    mode: 'review',
    model: '',
    nativeRecovery: {
      [admission.transportId]: {
        appliedRevision: admission.appliedRevision,
        snapshotToken: admission.snapshotToken,
        ownerGeneration: admission.ownerGeneration,
      },
    },
    nativeRecoveryOwner: {
      transportId: admission.transportId,
      snapshotToken: admission.snapshotToken,
      ownerGeneration: admission.ownerGeneration,
    },
  }
}

function delivery(): AgentEvent {
  return {
    sessionId: admission.sessionId,
    type: 'text',
    text: '  Existing native output\r\n🙂  ',
    nativeRecovery: {
      transportId: admission.transportId,
      revision: admission.appliedRevision,
      eventId: 'actual-historical-event',
      snapshotToken: admission.snapshotToken,
      ownerGeneration: admission.ownerGeneration,
      deliveryToken: admission.deliveryToken,
    },
  }
}

function live(value = thread()): Thread {
  return registerNativeProjectionDelivery(value, delivery())
}

function userMessage(): Message {
  return { id: userId, role: 'user', text: exactPrompt, input: exactPrompt, turn: 2, createdAt: 20 }
}

function append(current: Thread, mark = true): Thread {
  const next = {
    ...current,
    turn: 2,
    busy: true,
    turnStatus: 'running' as const,
    messages: [...current.messages, userMessage()],
  }
  return carryNativeProjectionAuthoredTransition(current, next, mark ? userId : undefined)
}

function authored(current = live()): Thread {
  const next = append(current)
  expect(nativeProjectionAdmissions([next])).toEqual([admission])
  return next
}

function withAttachments(current: Thread, attachments = localAttachments): Thread {
  return {
    ...current,
    messages: current.messages.map((message) =>
      message.id === userId ? { ...message, attachments } : message,
    ),
  }
}

function update(current: Thread, attachments = localAttachments): Thread {
  return carryNativeProjectionAttachmentUpdate(
    current,
    withAttachments(current, attachments),
    userId,
  )
}

function withUserChanges(current: Thread, fields: Partial<Message>): Thread {
  return {
    ...current,
    messages: current.messages.map((message) =>
      message.id === userId ? { ...message, attachments: localAttachments, ...fields } : message,
    ),
  }
}

function expectDenied(before: Thread, after: Thread, id = userId): void {
  expect(carryNativeProjectionAttachmentUpdate(before, after, id)).toBe(after)
  expect(nativeProjectionAdmissions([after])).toBeUndefined()
}

async function nativeLoaded(value: Thread): Promise<Thread> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, savedAt: 10, threads: [value] }),
  ).buffer
  const loaded = await loadConversationHistory({
    loadEncoded: vi.fn(async () => bytes),
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
  })
  const restored = loaded!.threads[0] as Thread
  registerNativeProjectionLoadedBaseline(restored, admission)
  expect(nativeProjectionAdmissions([restored])).toEqual([admission])
  return restored
}

describe('private authored attachment transitions', () => {
  it('carries the exact authored input through local metadata and uploaded paths without another event', () => {
    const current = authored()
    const local = update(current)
    expect(nativeProjectionAdmissions([local])).toEqual([admission])
    const uploaded = update(local, remoteAttachments)
    expect(nativeProjectionAdmissions([uploaded])).toEqual([admission])
    expect(uploaded.messages.at(-1)).toEqual({ ...userMessage(), attachments: remoteAttachments })
    expect(uploaded.messages.slice(0, -1)).toEqual(thread().messages)
    expect(uploaded.nativeRecovery).toBe(current.nativeRecovery)
    expect(uploaded.nativeRecoveryOwner).toBe(current.nativeRecoveryOwner)
    expect(uploaded.nativeRecovery![admission.transportId]).toEqual({
      appliedRevision: 4,
      snapshotToken: admission.snapshotToken,
      ownerGeneration: 2,
    })
  })

  it.each(['failed-upload', 'cancelled-upload'] as const)(
    'retains historical proof and exact metadata after %s before another native event',
    (outcome) => {
      const local = update(authored())
      const finished =
        outcome === 'failed-upload'
          ? applyEvent(local, {
              sessionId: local.id,
              type: 'error',
              text: 'The attachment upload failed before provider startup.',
            })
          : finishThreadTurn(local, 'interrupted', 30)
      const history = createHistorySnapshotProjector()([finished])
      expect(nativeProjectionAdmissions(history)).toEqual([admission])
      const user = history[0].messages.find((message) => message.id === userId)!
      expect(user.text).toBe(exactPrompt)
      expect(user.input).toBe(exactPrompt)
      expect(user.attachments).toEqual(localAttachments)
      expect(finished.nativeRecovery).toBe(local.nativeRecovery)
      expect(JSON.stringify(history)).not.toContain(admission.deliveryToken)
    },
  )

  it('retains the authored mark through a permitted completion lifecycle clone', () => {
    const current = authored()
    const completed = finishThreadTurn(current, 'interrupted', 30)
    expect(completed.messages.at(-1)).not.toBe(current.messages.at(-1))
    const uploaded = update(completed, remoteAttachments)
    expect(nativeProjectionAdmissions([uploaded])).toEqual([admission])
    expect(uploaded.messages.at(-1)).toEqual({
      ...userMessage(),
      finishedAt: 30,
      finishStatus: 'interrupted',
      attachments: remoteAttachments,
    })
  })

  it('retains the authored mark through a permitted owner snapshot lifecycle clone', () => {
    const current = authored()
    const snapshot = carryNativeProjectionOwnerSnapshot(current, {
      ...current,
      messages: current.messages.map((message) =>
        message.id === userId ? { ...message, status: 'completed', finishedAt: 30 } : message,
      ),
    })
    expect(nativeProjectionAdmissions([snapshot])).toEqual([admission])
    const uploaded = update(snapshot, remoteAttachments)
    expect(nativeProjectionAdmissions([uploaded])).toEqual([admission])
  })

  it('allows attachment metadata and lifecycle changes together without modifying literal input', () => {
    const current = authored()
    const after = withUserChanges(current, { status: 'completed', finishedAt: 30 })
    carryNativeProjectionAttachmentUpdate(current, after, userId)
    expect(nativeProjectionAdmissions([after])).toEqual([admission])
    expect(after.messages.at(-1)).toEqual({
      ...userMessage(),
      status: 'completed',
      finishedAt: 30,
      attachments: localAttachments,
    })
  })

  it('does not mint the attachment exception for an unmarked authored append', () => {
    const current = append(live(), false)
    expect(nativeProjectionAdmissions([current])).toEqual([admission])
    expectDenied(current, withAttachments(current))
  })

  it('does not mark an existing current-turn user row when the caller supplies its ID', () => {
    const current = live({ ...thread(), turn: 2, messages: [...thread().messages, userMessage()] })
    const unchanged = carryNativeProjectionAuthoredTransition(
      current,
      { ...current, messages: [...current.messages] },
      userId,
    )
    expect(nativeProjectionAdmissions([unchanged])).toEqual([admission])
    expectDenied(unchanged, withAttachments(unchanged))
  })

  it('does not mark a native-loaded historical user row despite genuine hash-attested admission', async () => {
    const current = await nativeLoaded({
      ...thread(),
      turn: 2,
      messages: [...thread().messages, userMessage()],
    })
    expectDenied(current, withAttachments(current))
  })

  it('does not mark a parsed imported row after its history receives actual native admission', () => {
    const imported = readThreads([
      { ...thread(), turn: 2, messages: [...thread().messages, userMessage()] },
    ])[0]
    const current = live(imported)
    expect(nativeProjectionAdmissions([current])).toEqual([admission])
    expectDenied(current, withAttachments(current))
  })

  it('does not admit JSON copies or re-read projections of a marked authored row', () => {
    const current = authored()
    const copied = JSON.parse(JSON.stringify(current)) as Thread
    expectDenied(copied, withAttachments(copied))
    const projected = createHistorySnapshotProjector()([current])
    expect(nativeProjectionAdmissions(projected)).toEqual([admission])
    const restored = readThreads(projected)[0]
    expectDenied(restored, withAttachments(restored))
  })

  it.each([
    ['non-user', { role: 'assistant' as const }],
    ['historical turn', { turn: 1 }],
    [
      'native identity',
      { nativeRecovery: { transportId: admission.transportId, ownerGeneration: 2 } },
    ],
  ] as const)(
    'does not issue an authored mark to a fresh appended row with %s',
    (_name, change) => {
      const before = live()
      const after = {
        ...before,
        turn: 2,
        messages: [...before.messages, { ...userMessage(), ...change }],
      }
      carryNativeProjectionAuthoredTransition(before, after, userId)
      expect(nativeProjectionAdmissions([after])).toEqual([admission])
      expectDenied(after, withAttachments(after))
    },
  )

  it.each([
    ['different id', { id: 'rewritten-user' }],
    ['role', { role: 'assistant' as const }],
    ['text', { text: 'trimmed or rewritten prompt' }],
    ['input', { input: 'replaced input' }],
    ['turn', { turn: 3 }],
    ['creation time', { createdAt: 21 }],
    ['agent identity', { agentId: 'different-agent' }],
    ['parent identity', { parentItemId: 'different-parent' }],
    ['native turn identity', { turnId: 'different-native-turn' }],
    [
      'native delivery identity',
      { nativeRecovery: { transportId: admission.transportId, ownerGeneration: 2 } },
    ],
  ] as const)('rejects a changed target %s during attachment update', (_name, fields) => {
    const current = authored()
    expectDenied(current, withUserChanges(current, fields))
  })

  it.each([
    ['session', { id: 'different-session' }],
    ['profile', { profileId: 'different-machine' }],
    ['provider', { provider: 'claude' as const }],
    ['workspace', { workspace: '/different/project' }],
    ['native thread', { remoteId: 'different-native-thread' }],
    ['current local turn', { turn: 3 }],
    [
      'native owner generation',
      {
        nativeRecoveryOwner: {
          transportId: admission.transportId,
          ownerGeneration: 3,
          snapshotToken: 'different-native-owner',
        },
      },
    ],
    [
      'native owner transport',
      {
        nativeRecoveryOwner: {
          transportId: 'different-transport',
          ownerGeneration: 2,
          snapshotToken: admission.snapshotToken,
        },
      },
    ],
  ] as const)('rejects a changed %s owner or scope during attachment update', (_name, fields) => {
    const current = authored()
    expectDenied(current, { ...withAttachments(current), ...fields })
  })

  it('rejects a copied cursor and does not renew the historical tuple', () => {
    const current = authored()
    expectDenied(current, {
      ...withAttachments(current),
      nativeRecovery: {
        [admission.transportId]: { ...current.nativeRecovery![admission.transportId] },
      },
    })
  })

  it.each([
    ['revision', { appliedRevision: 5 }],
    ['token', { snapshotToken: 'different-token' }],
    ['generation', { ownerGeneration: 3 }],
  ] as const)('rejects an in-place changed native cursor %s', (_name, fields) => {
    const current = authored()
    Object.assign(current.nativeRecovery![admission.transportId], fields)
    expectDenied(current, withAttachments(current))
  })

  it.each(['id', 'text', 'input', 'turn'] as const)(
    'rejects an in-place changed authored %s captured before attachment upload',
    (key) => {
      const current = authored()
      Object.assign(current.messages.at(-1)!, {
        [key]: key === 'turn' ? 3 : 'in-place replacement',
      })
      expectDenied(current, withAttachments(current))
    },
  )

  it('rejects a missing target ID instead of carrying proof for another rewritten row', () => {
    const current = authored()
    expectDenied(current, withAttachments(current), 'unknown-upload-user')
  })

  it('rejects duplicate target IDs even when the original marked row is retained', () => {
    const current = authored()
    const duplicated = carryNativeProjectionAuthoredTransition(current, {
      ...current,
      messages: [...current.messages, { ...userMessage() }],
    })
    expect(nativeProjectionAdmissions([duplicated])).toEqual([admission])
    expectDenied(duplicated, withAttachments(duplicated))
  })

  it.each(['drop', 'reorder', 'append'] as const)(
    'rejects transcript membership changes (%s) during attachment update',
    (kind) => {
      const current = authored()
      const after = withAttachments(current)
      after.messages =
        kind === 'drop'
          ? after.messages.slice(1)
          : kind === 'reorder'
            ? [after.messages[2], after.messages[0], after.messages[1]]
            : [...after.messages, { id: 'extra', role: 'tool', text: '', turn: 2 }]
      expectDenied(current, after)
    },
  )

  it('rejects a changed attachment on a historical user row while the marked target is updated', () => {
    const current = authored()
    const after = withAttachments(current)
    after.messages = after.messages.map((message) =>
      message.id === 'historical-user' ? { ...message, attachments: remoteAttachments } : message,
    )
    expectDenied(current, after)
  })

  it('rejects rewritten covered native output while the marked target is updated', () => {
    const current = authored()
    const after = withAttachments(current)
    after.messages = after.messages.map((message) =>
      message.id === 'historical-assistant' ? { ...message, text: 'rewritten output' } : message,
    )
    expectDenied(current, after)
  })

  it('does not invoke an accessor on the target during admission checks', () => {
    const current = authored()
    const after = withAttachments(current)
    const getter = vi.fn(() => {
      throw new Error('Untrusted target accessor was invoked')
    })
    Object.defineProperty(after.messages.at(-1)!, 'text', { enumerable: true, get: getter })
    expectDenied(current, after)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['checkpoint', 'full-save'] as const)(
    'keeps admission outside opaque history through the %s persistence path',
    async (path) => {
      const original = {
        ...thread(),
        futureField: { exact: '  opaque archive\r\n🙂  ' },
        messages: [
          ...thread().messages,
          { id: 'opaque-future-row', role: 'future-native-role', payload: { exact: '\tkeep\r\n' } },
          null,
        ],
      }
      const initial = live(readThreads([original])[0])
      const client = new ConversationCheckpointClient()
      const snapshot = createHistorySnapshotProjector()
      const save = vi.fn(async () => {})
      const checkpoint = vi.fn(async (input: ConversationCheckpointInput) => ({
        savedAt: input.savedAt,
      }))
      const options = { supportsMessageFields: true, supportsMessageAppends: true }
      await client.submit(
        snapshot([initial]),
        10,
        save,
        path === 'checkpoint' ? checkpoint : undefined,
        options,
      )
      const current = authored(initial)
      const uploaded = update(update(current), remoteAttachments)
      const history = snapshot([uploaded])
      const row = history[0] as Thread & { futureField: unknown }
      expect(nativeProjectionAdmissions(history)).toEqual([admission])
      expect(row.futureField).toEqual(original.futureField)
      expect(row.messages.slice(0, -1)).toEqual(original.messages)
      expect(row.messages.at(-1)).toEqual({ ...userMessage(), attachments: remoteAttachments })
      expect(JSON.stringify(history)).not.toContain(admission.deliveryToken)
      expect(Reflect.ownKeys(uploaded.messages.at(-1)!)).toEqual([
        ...Reflect.ownKeys(userMessage()),
        'attachments',
      ])
      await client.submit(
        history,
        20,
        save,
        path === 'checkpoint' ? checkpoint : undefined,
        options,
      )
      if (path === 'checkpoint') {
        expect(checkpoint).toHaveBeenCalledOnce()
        const packet = checkpoint.mock.calls[0][0]
        expect(packet.projectionAdmissions).toEqual([admission])
        expect(JSON.stringify(packet.upserts)).not.toContain(admission.deliveryToken)
      } else {
        expect(checkpoint).not.toHaveBeenCalled()
        expect(save).toHaveBeenCalledTimes(2)
        expect(save.mock.calls.at(-1)).toEqual([history, 20, [admission]])
      }
    },
  )
})
