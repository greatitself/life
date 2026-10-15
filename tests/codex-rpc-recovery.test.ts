import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { Effect, Fiber } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexRPC,
  CodexRequestCancelled,
  CodexRequestError,
  CodexTransportError,
  type CodexRPCRecoveryOptions,
  type Wire,
} from '../src/main/codex-rpc'
import {
  NativeRecoveryError,
  type NativeRecoveryInputSemantic,
} from '../src/main/native-recovery-types'

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  nativeRecoveryTracked = true
  writes: string[] = []
  native: { message: Wire; semantic?: NativeRecoveryInputSemantic }[] = []
  signals: string[] = []
  closeCount = 0
  detachCount = 0
  write(message: string) {
    this.writes.push(message)
    return true
  }
  writeNative(message: Wire, semantic?: NativeRecoveryInputSemantic) {
    this.native.push({ message, semantic })
    return this.write(JSON.stringify(message) + '\n')
  }
  signal(signal: string) {
    this.signals.push(signal)
  }
  close() {
    this.closeCount++
    this.destroyed = true
    this.emit('close')
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
    return this
  }
  detach() {
    this.detachCount++
    this.destroy()
    return Promise.resolve()
  }
  reply(message: Wire) {
    this.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  }
}

function fixture(options: CodexRPCRecoveryOptions = {}, receive = vi.fn()) {
  const channel = new Channel()
  const failure = vi.fn()
  const rpc = new CodexRPC(channel as unknown as ClientChannel, receive, failure, options)
  return { channel, rpc, receive, failure }
}

function uncertainError(reason: NativeRecoveryError['reason'] = 'uncertain') {
  return new NativeRecoveryError({
    operation: 'test.recover',
    path: '/private/native-registry',
    reason,
    message: 'Native ownership needs reconciliation.',
  })
}

afterEach(() => vi.useRealTimers())

describe('Codex RPC restored request allocation', () => {
  it('reserves every previous allocation and offers late replies without recreating requests', async () => {
    vi.useFakeTimers()
    const orphan = vi.fn()
    const { channel, rpc, receive } = fixture({ nextRequestId: 83, onOrphanResponse: orphan })
    expect(rpc.nextRequestId).toBe(83)
    expect(channel.writes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    const response = { id: 82, result: { turn: { id: 'already-running' } } }
    channel.reply({ id: 1, result: { userAgent: 'old-initialization' } })
    channel.reply(response)
    expect(orphan).toHaveBeenLastCalledWith(response)
    expect(receive).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(channel.writes).toEqual([])

    const pending = rpc.request('model/list')
    let completed = false
    void pending.then(() => {
      completed = true
    })
    expect(channel.native[0].message).toEqual({ id: 83, method: 'model/list', params: {} })
    expect(rpc.nextRequestId).toBe(84)
    channel.reply({ id: 82, result: { data: ['old'] } })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    channel.reply({ id: 83, result: { data: ['fresh'] } })
    await expect(pending).resolves.toEqual({ data: ['fresh'] })
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.receivedMessageSequence).toBe(4)
    expect(channel.writes).toHaveLength(1)
  })

  it('does not reinitialize the existing native stream when constructed or replayed', () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture({ nextRequestId: 12 })
    rpc.replayOutput('{"id":1,"result":{"userAgent":"codex"}}\n')
    rpc.replayOutput('{"method":"turn/started","params":{"threadId":"saved"}}\n')
    expect(channel.writes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.nextRequestId).toBe(12)
  })

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 3])(
    'rejects invalid restored next-request ID %s before listening or transmitting',
    (nextRequestId) => {
      const channel = new Channel()
      expect(
        () =>
          new CodexRPC(channel as unknown as ClientChannel, vi.fn(), vi.fn(), { nextRequestId }),
      ).toThrow()
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.writes).toEqual([])
    },
  )

  it('uses the last safe request ID once and prohibits overflow without sending another request', async () => {
    const { rpc, channel } = fixture({ nextRequestId: Number.MAX_SAFE_INTEGER })
    const last = rpc.request('model/list')
    channel.reply({ id: Number.MAX_SAFE_INTEGER, result: { data: [] } })
    await expect(last).resolves.toEqual({ data: [] })
    const error = await Effect.runPromise(Effect.flip(rpc.requestEffect('model/list')))
    expect(error).toBeInstanceOf(NativeRecoveryError)
    expect(error.message).toMatch(/request IDs are exhausted/)
    expect(channel.writes).toHaveLength(1)
  })

  it('recovers exhausted request-ID ownership for replay while refusing every new allocation', async () => {
    const orphan = vi.fn()
    const { rpc, channel } = fixture({
      nextRequestId: Number.MAX_SAFE_INTEGER + 1,
      onOrphanResponse: orphan,
    })
    const response = { id: Number.MAX_SAFE_INTEGER, result: { turn: { id: 'running' } } }
    rpc.replayOutput(JSON.stringify(response) + '\n')
    expect(orphan).toHaveBeenCalledExactlyOnceWith(response)
    expect(rpc.receivedMessageSequence).toBe(1)
    await expect(rpc.request('model/list')).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      reason: 'uncertain',
      operation: 'codex.request',
    })
    expect(channel.writes).toEqual([])
    expect(channel.signals).toEqual([])
  })
})

describe('Codex RPC native delivery semantics', () => {
  it.each([
    ['initialize', 'initialize'],
    ['initialized', 'initialize'],
    ['turn/start', 'user-prompt'],
    ['turn/steer', 'steer'],
    ['turn/interrupt', 'interrupt'],
    ['turn/settings/update', 'settings'],
    ['thread/settings/update', 'settings'],
    ['config/value/write', 'settings'],
    ['config/batchWrite', 'settings'],
    ['thread/start', 'transport'],
    ['thread/resume', 'transport'],
    ['config/read', 'transport'],
    ['model/list', 'transport'],
  ])('records %s as %s without changing provider fields', (method, kind) => {
    const { rpc, channel } = fixture()
    const message = {
      id: 17,
      method,
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        input: [{ type: 'text', text: '  Exact\r\nuser text 🧬\ud800  ' }],
        futureProviderOption: { unknown: true },
      },
    }
    const expectedWire = JSON.stringify(message) + '\n'
    rpc.send(message)
    expect(channel.writes).toEqual([expectedWire])
    expect(channel.native[0].message).toBe(message)
    expect(channel.native[0].semantic).toEqual({
      kind,
      method,
      requestId: 17,
      nativeThreadId: 'native-thread',
      nativeTurnId: 'native-turn',
    })
  })

  it('adds session ownership through the optional fifth argument while retaining actual wire identities', async () => {
    const { rpc, channel } = fixture({ nextRequestId: 40 })
    const params = {
      threadId: 'native-thread',
      input: [{ type: 'text', text: '  exact\r\nprompt  ' }],
    }
    const pending = rpc.request('turn/start', params, 60000, undefined, {
      kind: 'user-prompt',
      sessionId: 'local-studio',
      ownerGeneration: 3,
      requestId: 'incorrect-caller-id',
      nativeThreadId: 'incorrect-caller-thread',
      responseBinding: { sessionId: 'local-studio', phase: 'turn-start' },
    })
    expect(channel.native[0].message).toEqual({ id: 40, method: 'turn/start', params })
    expect(channel.native[0].message.params).toBe(params)
    expect(channel.native[0].semantic).toEqual({
      kind: 'user-prompt',
      method: 'turn/start',
      requestId: 40,
      nativeThreadId: 'native-thread',
      sessionId: 'local-studio',
      ownerGeneration: 3,
      responseBinding: { sessionId: 'local-studio', phase: 'turn-start' },
    })
    channel.reply({ id: 40, result: { turn: { id: 'accepted' } } })
    await expect(pending).resolves.toEqual({ turn: { id: 'accepted' } })
  })

  it.each([91, '91', 'permission-native-id'])(
    'preserves permission wire ID %s and its native type',
    (id) => {
      const { rpc, channel } = fixture()
      const message = { id, result: { decision: 'accept', futureNativeField: { exact: true } } }
      rpc.send(message, {
        kind: 'permission-response',
        sessionId: 'owner',
        ownerGeneration: 4,
        requestType: 'item/commandExecution/requestApproval',
        permissionRequestId: 'wrong-caller-id',
      })
      expect(channel.native[0].semantic).toEqual({
        kind: 'permission-response',
        sessionId: 'owner',
        ownerGeneration: 4,
        requestType: 'item/commandExecution/requestApproval',
        requestId: id,
        permissionRequestId: id,
      })
      expect(channel.writes).toEqual([JSON.stringify(message) + '\n'])
    },
  )

  it('retains valid native identities when an unrelated optional field is absent or invalid', () => {
    const { rpc, channel } = fixture()
    rpc.send({ id: 33, method: 'turn/interrupt', params: { threadId: 'saved', turnId: null } })
    expect(channel.native[0].semantic).toEqual({
      kind: 'interrupt',
      method: 'turn/interrupt',
      requestId: 33,
      nativeThreadId: 'saved',
    })
  })

  it('records the real native expectedTurnId used by steering without altering its provider payload', () => {
    const { rpc, channel } = fixture()
    const message = {
      id: 5,
      method: 'turn/steer',
      params: {
        threadId: 'saved',
        expectedTurnId: 'native-active-turn',
        input: [{ type: 'text', text: 'exact steering' }],
      },
    }
    rpc.send(message, { kind: 'steer', sessionId: 'owner', nativeTurnId: 'wrong-caller-turn' })
    expect(channel.native[0].semantic).toEqual({
      kind: 'steer',
      method: 'turn/steer',
      requestId: 5,
      sessionId: 'owner',
      nativeThreadId: 'saved',
      nativeTurnId: 'native-active-turn',
    })
    expect(channel.writes).toEqual([JSON.stringify(message) + '\n'])
  })

  it('keeps known native mutation semantics even when caller metadata supplies transport kind', () => {
    const { rpc, channel } = fixture()
    rpc.send(
      { id: 5, method: 'turn/steer', params: { threadId: 'saved', expectedTurnId: 'active' } },
      { kind: 'transport', sessionId: 'owner' },
    )
    expect(channel.native[0].semantic).toEqual({
      kind: 'steer',
      method: 'turn/steer',
      requestId: 5,
      sessionId: 'owner',
      nativeThreadId: 'saved',
      nativeTurnId: 'active',
    })
  })

  it('keeps the original stdio write fallback for channels without recovery support', () => {
    const { rpc, channel } = fixture()
    Object.defineProperty(channel, 'writeNative', { value: undefined })
    const message = { id: 'native-permission', result: { decision: 'decline' } }
    rpc.send(message, { kind: 'permission-response', sessionId: 'owner' })
    expect(channel.native).toEqual([])
    expect(channel.writes).toEqual([JSON.stringify(message) + '\n'])
  })

  it('acknowledges a native permission only after its exact delivery becomes durable', async () => {
    const { rpc, channel } = fixture()
    let commit: () => void = () => {}
    const writeNativeAndWait = vi.fn((message: Wire, semantic?: NativeRecoveryInputSemantic) => {
      channel.writeNative(message, semantic)
      return new Promise<void>((resolve) => {
        commit = resolve
      })
    })
    Object.assign(channel, { writeNativeAndWait })
    const message = {
      id: 'original-native-permission',
      result: { decision: 'accept', future: ['exact'] },
    }
    const program = rpc.sendAndWaitEffect(message, {
      kind: 'permission-response',
      sessionId: 'owner',
      ownerGeneration: 2,
      requestType: 'item/commandExecution/requestApproval',
    })
    expect(writeNativeAndWait).not.toHaveBeenCalled()
    const result = Effect.runPromise(program)
    let completed = false
    void result.then(() => {
      completed = true
    })
    expect(channel.writes).toEqual([JSON.stringify(message) + '\n'])
    expect(writeNativeAndWait).toHaveBeenCalledExactlyOnceWith(message, {
      kind: 'permission-response',
      sessionId: 'owner',
      ownerGeneration: 2,
      requestType: 'item/commandExecution/requestApproval',
      requestId: 'original-native-permission',
      permissionRequestId: 'original-native-permission',
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    commit()
    await result
    expect(completed).toBe(true)
    expect(channel.writes).toHaveLength(1)
  })

  it('rejects failed awaited native admission and quarantines the owned transport', async () => {
    const { rpc, channel } = fixture()
    const error = uncertainError('io')
    const writeNativeAndWait = vi.fn(() => Promise.reject(error))
    Object.assign(channel, { writeNativeAndWait })
    await expect(
      rpc.sendAndWait(
        { id: 91, result: { decision: 'accept' } },
        { kind: 'permission-response', sessionId: 'owner' },
      ),
    ).rejects.toBe(error)
    expect(channel.detachCount).toBe(1)
    expect(channel.writes).toEqual([])
    expect(channel.signals).toEqual([])
  })

  it('retains awaited-send compatibility on an ordinary stdio channel', async () => {
    const { rpc, channel } = fixture()
    Object.defineProperty(channel, 'writeNative', { value: undefined })
    const message = { id: 'original-native-permission', result: { decision: 'decline' } }
    await rpc.sendAndWait(message, { kind: 'permission-response', sessionId: 'owner' })
    expect(channel.writes).toEqual([JSON.stringify(message) + '\n'])
    expect(channel.native).toEqual([])
  })
})

describe('Codex RPC output replay framing', () => {
  it('preserves a split UTF-8 character and JSON frame across archived chunks and live output', () => {
    const received: { message: Wire; sequence: number; replaying: boolean }[] = []
    const channel = new Channel()
    const orphan = vi.fn()
    const rpc = new CodexRPC(
      channel as unknown as ClientChannel,
      (message) => {
        received.push({
          message,
          sequence: rpc.receivedMessageSequence,
          replaying: rpc.isReplaying,
        })
      },
      vi.fn(),
      { nextRequestId: 8, onOrphanResponse: orphan },
    )
    const response = { id: 7, result: { turn: { id: 'running' } } }
    const first = Buffer.from(
      JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Hello 🧬' } }) + '\n',
    )
    const split = first.indexOf(Buffer.from('🧬')) + 2
    rpc.replayOutput(Buffer.from('Login banner\n' + JSON.stringify(response) + '\n'))
    rpc.replayOutput(first.subarray(0, split))
    expect(rpc.receivedMessageSequence).toBe(1)
    expect(received).toEqual([])
    channel.emit('data', first.subarray(split))
    expect(received).toEqual([
      {
        message: { method: 'item/agentMessage/delta', params: { delta: 'Hello 🧬' } },
        sequence: 2,
        replaying: false,
      },
    ])
    expect(orphan).toHaveBeenCalledExactlyOnceWith(response)
    expect(channel.writes).toEqual([])
  })

  it('reconciles an archived partial response completed by live output without completing a newer waiter', async () => {
    const orphan = vi.fn()
    const { rpc, channel } = fixture({ nextRequestId: 8, onOrphanResponse: orphan })
    rpc.replayOutput('{"id":7,"result":{"turn":{"id":"already-')
    const reading = rpc.request('model/list')
    channel.emit('data', Buffer.from('running"}}}\n'))
    expect(orphan).toHaveBeenCalledExactlyOnceWith({
      id: 7,
      result: { turn: { id: 'already-running' } },
    })
    channel.reply({ id: 8, result: { data: ['fresh'] } })
    await expect(reading).resolves.toEqual({ data: ['fresh'] })
    expect(channel.writes).toHaveLength(1)
    expect(rpc.receivedMessageSequence).toBe(2)
  })

  it('offers replayed responses to recovery even when a fresh waiter has the same numeric ID', async () => {
    vi.useFakeTimers()
    const orphan = vi.fn()
    const { rpc, channel } = fixture({ onOrphanResponse: orphan })
    const pending = rpc.request('model/list')
    let completed = false
    void pending.then(() => {
      completed = true
    })
    rpc.replayOutput('{"id":1,"result":{"data":["recorded"]}}\n')
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(orphan).toHaveBeenCalledWith({ id: 1, result: { data: ['recorded'] } })
    expect(vi.getTimerCount()).toBe(1)
    channel.reply({ id: 1, result: { data: ['live'] } })
    await expect(pending).resolves.toEqual({ data: ['live'] })
    expect(channel.writes).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts every coalesced native response and notification in deterministic parsed order', () => {
    const orphan = vi.fn()
    const sequences: number[] = []
    const { rpc, channel } = fixture(
      { onOrphanResponse: orphan },
      vi.fn(() => {
        sequences.push(rpc.receivedMessageSequence)
      }),
    )
    rpc.replayOutput(
      '  \nLogin banner\n{"id":1,"result":{}}\n{"method":"turn/started","params":{}}\n{"id":2,"error":{"code":-1,"message":"old"}}\n',
    )
    channel.reply({ method: 'turn/completed', params: {} })
    expect(rpc.receivedMessageSequence).toBe(4)
    expect(sequences).toEqual([2, 4])
    expect(orphan.mock.calls.map(([message]) => message.id)).toEqual([1, 2])
  })

  it('blocks replay callbacks from sending initialization or allocating a new native request', async () => {
    vi.useFakeTimers()
    let effectResult: Promise<unknown> | undefined
    const failures: unknown[] = []
    const { rpc, channel } = fixture(
      {},
      vi.fn(() => {
        try {
          rpc.send({ method: 'initialized', params: {} })
        } catch (error) {
          failures.push(error)
        }
        effectResult = Effect.runPromise(
          Effect.flip(
            rpc.requestEffect('turn/start', {
              threadId: 'saved',
              input: [{ text: 'must not send' }],
            }),
          ),
        )
      }),
    )
    rpc.replayOutput('{"method":"turn/started","params":{}}\n')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(NativeRecoveryError)
    await expect(effectResult).resolves.toBeInstanceOf(NativeRecoveryError)
    expect(channel.writes).toEqual([])
    expect(rpc.nextRequestId).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.isReplaying).toBe(false)
  })

  it('restores replay mode after a legacy untracked callback fails', () => {
    const { rpc, channel } = fixture(
      {},
      vi.fn(() => {
        throw new Error('Recovery reducer failed')
      }),
    )
    channel.nativeRecoveryTracked = false
    expect(() => rpc.replayOutput('{"method":"turn/started","params":{}}\n')).toThrow(
      'Recovery reducer failed',
    )
    expect(rpc.isReplaying).toBe(false)
    rpc.send({ method: 'initialized', params: {} })
    expect(channel.writes).toHaveLength(1)
  })

  it('quarantines a tracked transport when its replay reducer fails after consuming output', async () => {
    const { rpc, channel } = fixture(
      {},
      vi.fn(() => {
        throw new Error('Recovery reducer failed')
      }),
    )
    expect(() => rpc.replayOutput('{"method":"turn/started","params":{}}\n')).toThrow(
      NativeRecoveryError,
    )
    expect(rpc.isReplaying).toBe(false)
    expect(rpc.receivedMessageSequence).toBe(1)
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    expect(() => rpc.send({ method: 'initialized', params: {} })).toThrow(NativeRecoveryError)
    await expect(rpc.request('turn/start', { threadId: 'saved' })).rejects.toBeInstanceOf(
      NativeRecoveryError,
    )
    expect(channel.writes).toEqual([])
  })

  it('quarantines failed orphan response correlation without throwing through the live data emitter', async () => {
    const { rpc, channel } = fixture({
      nextRequestId: 8,
      onOrphanResponse: () => {
        throw new Error('Missing owner')
      },
    })
    expect(() => channel.reply({ id: 7, result: { turn: { id: 'unbound' } } })).not.toThrow()
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    await expect(rpc.request('model/list')).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      operation: 'codex.recovery-response',
    })
    expect(channel.writes).toEqual([])
  })
})

describe('Codex RPC canonical native response observation', () => {
  it('observes normal replies at their original output ordinal before Promise continuations', async () => {
    const order: {
      phase: string
      sequence: number
      message?: Wire
      semantic?: NativeRecoveryInputSemantic
    }[] = []
    const { rpc, channel } = fixture({
      nextRequestId: 8,
      onOrphanResponse: (message) =>
        order.push({ phase: 'orphan', sequence: rpc.receivedMessageSequence, message }),
      onResponse: (message, semantic) =>
        order.push({ phase: 'response', sequence: rpc.receivedMessageSequence, message, semantic }),
    })
    rpc.replayOutput('{"id":7,"result":{"thread":{"id":"old-thread"}}}\n')
    const pending = rpc
      .request('thread/start', { cwd: '/owned/workspace' }, 60000, undefined, {
        kind: 'transport',
        sessionId: 'owner',
        ownerGeneration: 4,
        responseBinding: { phase: 'thread-start', sessionId: 'owner' },
      })
      .then((value) => {
        order.push({ phase: 'continuation', sequence: rpc.receivedMessageSequence })
        return value
      })
    channel.reply({ method: 'thread/status/changed', params: { threadId: 'new-thread' } })
    const response = { id: 8, result: { thread: { id: 'new-thread', name: 'Native title' } } }
    channel.reply(response)
    expect(order).toEqual([
      {
        phase: 'orphan',
        sequence: 1,
        message: { id: 7, result: { thread: { id: 'old-thread' } } },
      },
      {
        phase: 'response',
        sequence: 3,
        message: response,
        semantic: {
          kind: 'transport',
          method: 'thread/start',
          requestId: 8,
          sessionId: 'owner',
          ownerGeneration: 4,
          responseBinding: { phase: 'thread-start', sessionId: 'owner' },
        },
      },
    ])
    await expect(pending).resolves.toEqual(response.result)
    expect(order.map((entry) => entry.phase)).toEqual(['orphan', 'response', 'continuation'])
    expect(channel.writes).toHaveLength(1)
  })

  it('observes native error replies without replacing their typed request failure', async () => {
    const onResponse = vi.fn()
    const { rpc, channel } = fixture({ onResponse })
    const pending = rpc.request('turn/settings/update', { threadId: 'saved', turnId: 'active' })
    const rejected = expect(pending).rejects.toMatchObject({
      _tag: 'CodexRequestError',
      method: 'turn/settings/update',
      code: -32601,
      message: 'Unsupported settings',
    })
    const message = {
      id: 1,
      error: { code: -32601, message: 'Unsupported settings', futureDiagnostic: ['exact'] },
    }
    channel.reply(message)
    await rejected
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(message, {
      kind: 'settings',
      method: 'turn/settings/update',
      requestId: 1,
      nativeThreadId: 'saved',
      nativeTurnId: 'active',
    })
    expect(channel.detachCount).toBe(0)
  })

  it('does not notify the normal response observer for orphan, cancelled or replayed replies', async () => {
    const onResponse = vi.fn()
    const onOrphanResponse = vi.fn()
    const { rpc, channel } = fixture({ onResponse, onOrphanResponse, nextRequestId: 8 })
    rpc.replayOutput('{"id":7,"result":{}}\n')
    const controller = new AbortController()
    const pending = rpc.request('model/list', {}, 60000, controller.signal)
    const cancelled = expect(pending).rejects.toBeInstanceOf(CodexRequestCancelled)
    controller.abort()
    await cancelled
    channel.reply({ id: 8, result: { data: [] } })
    expect(onResponse).not.toHaveBeenCalled()
    expect(onOrphanResponse.mock.calls.map(([message]) => message.id)).toEqual([7, 8])
  })

  it('quarantines a failed normal response reconciliation before any waiter can succeed', async () => {
    vi.useFakeTimers()
    const onResponse = vi.fn(() => {
      throw new Error('Native owner could not bind')
    })
    const { rpc, channel } = fixture({ onResponse })
    const mutating = rpc.request('thread/start', {}, 60000, undefined, {
      kind: 'transport',
      sessionId: 'owner',
    })
    const reading = rpc.request('model/list')
    const failedMutation = expect(mutating).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      operation: 'codex.recovery-response',
      reason: 'uncertain',
    })
    const failedRead = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
    expect(() =>
      channel.reply({ id: 1, result: { thread: { id: 'native-thread' } } }),
    ).not.toThrow()
    await Promise.all([failedMutation, failedRead])
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Codex RPC durable uncertainty detaches without provider termination', () => {
  it.each(['io', 'ownership', 'uncertain', 'corrupt', 'unsupported'] as const)(
    'preserves a typed %s recovery failure, fails live waiters, and detaches only once',
    async (reason) => {
      vi.useFakeTimers()
      const { rpc, channel, failure } = fixture()
      const pending = rpc.request('turn/start', {
        threadId: 'saved',
        input: [{ text: 'exact user prompt' }],
      })
      const reading = rpc.request('model/list')
      const mutationFailure = expect(pending).rejects.toBeInstanceOf(NativeRecoveryError)
      const readFailure = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
      const error = uncertainError(reason)
      channel.emit('error', error)
      await Promise.all([mutationFailure, readFailure])
      expect(failure).toHaveBeenCalledExactlyOnceWith(error)
      expect(channel.detachCount).toBe(1)
      expect(channel.signals).toEqual([])
      expect(channel.closeCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(rpc.closed).toBe(true)
      channel.emit('error', error)
      rpc.close(error)
      expect(channel.detachCount).toBe(1)
      await expect(rpc.request('model/list')).rejects.toBe(error)
      expect(channel.writes).toHaveLength(2)
    },
  )

  it.each([
    'initialize',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'thread/settings/update',
    'turn/settings/update',
    'config/value/write',
    'config/batchWrite',
  ])(
    'detaches an uncertain tracked %s timeout while leaving the original request intact',
    async (method) => {
      vi.useFakeTimers()
      const { rpc, channel } = fixture()
      const params = { threadId: 'saved', input: [{ text: '  exactly once\r\n🧬  ' }] }
      const pending = rpc.request(method, params, 1000)
      const rejected = expect(pending).rejects.toMatchObject({
        _tag: 'NativeRecoveryError',
        reason: 'uncertain',
        operation: method,
      })
      const reading = rpc.request('model/list', {}, 5000)
      const rejectedReading = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.all([rejected, rejectedReading])
      expect(channel.writes[0]).toBe(JSON.stringify({ id: 1, method, params }) + '\n')
      expect(channel.writes).toHaveLength(2)
      expect(channel.signals).toEqual([])
      expect(channel.closeCount).toBe(0)
      expect(channel.detachCount).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each([
    'initialize',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'thread/settings/update',
    'turn/settings/update',
    'config/value/write',
    'config/batchWrite',
  ])(
    'detaches a tracked %s after caller cancellation without inventing native Stop',
    async (method) => {
      vi.useFakeTimers()
      const { rpc, channel } = fixture()
      const controller = new AbortController()
      const pending = rpc.request(method, { threadId: 'saved' }, 60000, controller.signal)
      const cancelled = expect(pending).rejects.toBeInstanceOf(CodexRequestCancelled)
      const reading = rpc.request('model/list')
      const readFailure = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
      controller.abort()
      await Promise.all([cancelled, readFailure])
      expect(channel.detachCount).toBe(1)
      expect(channel.signals).toEqual([])
      expect(channel.closeCount).toBe(0)
      expect(channel.writes).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('detaches a tracked mutation after Effect fiber interruption and releases all local deadlines', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    const fiber = Effect.runFork(
      rpc.requestEffect('turn/start', { threadId: 'saved', input: [{ text: 'exact' }] }),
    )
    const reading = rpc.request('model/list')
    const readFailure = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await readFailure
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detaches malformed native output instead of terminating potentially active owned work', async () => {
    const { rpc, channel } = fixture()
    const pending = rpc.request('model/list')
    const rejected = expect(pending).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      operation: 'codex.output',
    })
    channel.emit('data', Buffer.from('{broken-json}\n'))
    await rejected
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
  })

  it('detaches on an unclassified channel error while owned native work may still be running', async () => {
    const { rpc, channel } = fixture()
    const pending = rpc.request('turn/start', { threadId: 'saved' })
    const rejected = expect(pending).rejects.toMatchObject({
      _tag: 'NativeRecoveryError',
      reason: 'uncertain',
      operation: 'codex.transport',
    })
    channel.emit('error', new Error('SSH stream failed'))
    await rejected
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
  })

  it('rejects a durable write failure immediately and prevents additional writes or native termination', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    const reading = rpc.request('model/list')
    const readFailure = expect(reading).rejects.toBeInstanceOf(NativeRecoveryError)
    const error = uncertainError('io')
    vi.spyOn(channel, 'writeNative').mockImplementationOnce(() => {
      throw error
    })
    const rejected = rpc.request('turn/start', {
      threadId: 'saved',
      input: [{ text: 'exact user' }],
    })
    await expect(rejected).rejects.toBe(error)
    await readFailure
    await expect(rpc.request('model/list')).rejects.toBe(error)
    expect(channel.detachCount).toBe(1)
    expect(channel.writes).toHaveLength(1)
    expect(channel.signals).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detaches after a permission delivery fails without deleting or replacing its native identity', () => {
    const { rpc, channel } = fixture()
    const error = uncertainError('io')
    vi.spyOn(channel, 'writeNative').mockImplementationOnce(() => {
      throw error
    })
    expect(() =>
      rpc.send(
        { id: 'native-approval', result: { decision: 'accept' } },
        {
          kind: 'permission-response',
          sessionId: 'owner',
          requestType: 'item/commandExecution/requestApproval',
        },
      ),
    ).toThrow(error)
    expect(channel.detachCount).toBe(1)
    expect(channel.writes).toEqual([])
    expect(channel.signals).toEqual([])
  })

  it('waits for non-destructive channel detachment after immediately failing local waiters', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    let completeDetach: () => void = () => {}
    vi.spyOn(channel, 'detach').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completeDetach = resolve
        }),
    )
    const reading = rpc.request('model/list')
    const readFailure = expect(reading).rejects.toBeInstanceOf(CodexTransportError)
    const detached = rpc.detach()
    const alsoDetached = rpc.detach()
    let finished = false
    let alsoFinished = false
    void detached.then(() => {
      finished = true
    })
    void alsoDetached.then(() => {
      alsoFinished = true
    })
    await readFailure
    expect(finished).toBe(false)
    expect(alsoFinished).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    completeDetach()
    await detached
    await alsoDetached
    expect(finished).toBe(true)
    expect(alsoFinished).toBe(true)
    expect(channel.detach).toHaveBeenCalledTimes(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
  })

  it('detaches the channel even if the failure observer throws, and settles both detach waiters', async () => {
    const channel = new Channel()
    const failure = new Error('Failure observer crashed')
    const rpc = new CodexRPC(channel as unknown as ClientChannel, vi.fn(), () => {
      throw failure
    })
    const first = rpc.detach()
    const second = rpc.detach()
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
  })

  it('preserves typed flush failure for both callers without turning it into native termination', async () => {
    const { rpc, channel } = fixture()
    const error = uncertainError('io')
    vi.spyOn(channel, 'detach').mockRejectedValueOnce(error)
    const first = rpc.detach()
    const second = rpc.detach()
    await expect(first).rejects.toBe(error)
    await expect(second).rejects.toBe(error)
    expect(channel.detach).toHaveBeenCalledTimes(1)
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
  })

  it('releases an idle durable writer even if the failure observer throws', async () => {
    const channel = new Channel()
    const closeAndWaitEffect = vi.fn(() =>
      Effect.sync(() => {
        channel.close()
        return true
      }),
    )
    Object.assign(channel, { closeAndWaitEffect })
    const rpc = new CodexRPC(channel as unknown as ClientChannel, vi.fn(), () => {
      throw new Error('Failure observer crashed')
    })
    await expect(Effect.runPromise(rpc.releaseEffect())).rejects.toThrow('Failure observer crashed')
    expect(closeAndWaitEffect).toHaveBeenCalledTimes(1)
    expect(channel.closeCount).toBe(1)
    expect(channel.destroyed).toBe(true)
    expect(channel.signals).toEqual([])
  })

  it('prevents later idle cleanup from closing a transport already detached for uncertain ownership', async () => {
    const { rpc, channel } = fixture()
    const closeAndWaitEffect = vi.fn(() => Effect.succeed(true))
    Object.assign(channel, { closeAndWaitEffect })
    rpc.close(uncertainError())
    await expect(Effect.runPromise(rpc.releaseEffect())).resolves.toBe(false)
    expect(channel.detachCount).toBe(1)
    expect(closeAndWaitEffect).not.toHaveBeenCalled()
    expect(channel.signals).toEqual([])
    expect(channel.closeCount).toBe(0)
  })

  it('allows explicit user termination to retain the ordinary native TERM and close path', () => {
    const { rpc, channel } = fixture()
    rpc.close()
    expect(channel.signals).toEqual(['TERM'])
    expect(channel.closeCount).toBe(1)
    expect(channel.detachCount).toBe(0)
  })

  it('does not detach a working durable transport for an optional read timeout', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    const pending = rpc.request('config/read', {}, 1000)
    const rejected = expect(pending).rejects.toBeInstanceOf(CodexRequestError)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    const listing = rpc.request('model/list')
    channel.reply({ id: 2, result: { data: [] } })
    await expect(listing).resolves.toEqual({ data: [] })
    expect(channel.detachCount).toBe(0)
    expect(channel.signals).toEqual([])
  })

  it('tracks durable steering as a pending mutation until its response arrives', async () => {
    const { rpc, channel } = fixture()
    const pending = rpc.request('turn/steer', {
      threadId: 'saved',
      expectedTurnId: 'active',
      input: [{ text: 'exact steering' }],
    })
    expect(rpc.hasPendingMutation).toBe(true)
    channel.reply({ id: 1, result: { turnId: 'active' } })
    await pending
    expect(rpc.hasPendingMutation).toBe(false)
  })

  it('detaches an uncertain tracked steer even when caller metadata attempts to downgrade its kind', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    const pending = rpc.request(
      'turn/steer',
      { threadId: 'saved', expectedTurnId: 'active', input: [{ text: 'exact' }] },
      1000,
      undefined,
      { kind: 'transport', sessionId: 'owner' },
    )
    const rejected = expect(pending).rejects.toBeInstanceOf(NativeRecoveryError)
    expect(rpc.hasPendingMutation).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(channel.detachCount).toBe(1)
    expect(channel.signals).toEqual([])
  })

  it('retains legacy steering timeout behavior for an untracked native transport', async () => {
    vi.useFakeTimers()
    const { rpc, channel } = fixture()
    channel.nativeRecoveryTracked = false
    const pending = rpc.request(
      'turn/steer',
      { threadId: 'saved', expectedTurnId: 'active', input: [{ text: 'exact' }] },
      1000,
    )
    expect(rpc.hasPendingMutation).toBe(false)
    const rejected = expect(pending).rejects.toBeInstanceOf(CodexRequestError)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(channel.detachCount).toBe(0)
    expect(channel.signals).toEqual([])
  })
})
