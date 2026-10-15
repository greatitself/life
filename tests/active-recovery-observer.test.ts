import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type ErrorSnapshot = {
  fields: Record<string, unknown>
  inheritedFields: string[]
  unsupportedFields: { key: string; reason: string }[]
}
const { serialize, deserialize, errorDTO, PortableWireError } =
  require('./helpers/active-recovery-observer/portable-wire.cjs') as {
    serialize: (value: unknown) => Buffer
    deserialize: (bytes: Buffer | Uint8Array) => unknown
    errorDTO: (error: unknown) => ErrorSnapshot
    PortableWireError: new (...args: unknown[]) => Error & { code: string }
  }
type Handler = (this: unknown, event: unknown, ...args: unknown[]) => unknown
type Observer = { failures: string[]; capture: (kind: string, value: unknown) => void }
const { install } = require('./helpers/active-recovery-observer/main-observer.cjs') as {
  install: (
    electron: {
      ipcMain: { handle: (channel: string, listener: unknown) => unknown }
      app: EventEmitter
    },
    configuration: { tape: string; appPath: string },
    append: (path: string, line: string) => void,
  ) => Observer
}

function roundtrip<T>(value: T): T {
  return deserialize(serialize(value)) as T
}

function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('The native operation was expected to throw')
}

function observer(options: { appendFailure?: unknown } = {}) {
  const handlers = new Map<string, Handler>()
  const lines: string[] = []
  const invalidListener = new Error('native registration rejected this listener')
  const registrationResult = { nativeRegistration: true }
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => '/private/unchanged-life',
    getName: () => 'Life',
    getVersion: () => '0.12.0',
    getPath: () => '/private/profile/Life',
  })
  const ipcMain = {
    handle(channel: string, listener: unknown) {
      if (typeof listener !== 'function') throw invalidListener
      handlers.set(channel, listener as Handler)
      return registrationResult
    },
  }
  const observation = install(
    { app, ipcMain },
    { tape: '/unused-observer-tape', appPath: '/private/unchanged-life' },
    (_path, line) => {
      if (Object.hasOwn(options, 'appendFailure')) throw options.appendFailure
      lines.push(line)
    },
  )
  const entries = () =>
    lines.map((line) => {
      const record = JSON.parse(line) as { kind: string; serializedBase64: string }
      return {
        kind: record.kind,
        value: deserialize(Buffer.from(record.serializedBase64, 'base64')) as Record<
          string,
          unknown
        >,
      }
    })
  const recover = (context: unknown, event: unknown, ...args: unknown[]) => {
    const handler = handlers.get('agent:recover')
    if (!handler) throw new Error('The native recovery handler was not registered')
    return Reflect.apply(handler, context, [event, ...args])
  }
  return {
    app,
    ipcMain,
    handlers,
    observation,
    entries,
    recover,
    invalidListener,
    registrationResult,
  }
}

const sender = {
  sender: { id: 17 },
  senderFrame: { processId: 23, routingId: 29, url: 'file:///private/unchanged-life' },
}
const unprintable = {
  toString: () => {
    throw new Error('must not stringify native data')
  },
}

describe('portable recovery observation snapshots', () => {
  it('preserves full opaque DTO values, property presence, Unicode and negative zero', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>
    Object.defineProperty(nullPrototype, '__proto__', {
      value: { opaque: [undefined, null, '漢字🧪 trailing whitespace  '] },
      enumerable: true,
    })
    Object.defineProperty(nullPrototype, 'constructor', {
      value: 'opaque constructor',
      enumerable: true,
    })
    const input = {
      presentUndefined: undefined,
      booleans: [true, false],
      numbers: [0, -0, Number.MIN_VALUE, Number.MAX_VALUE],
      strings: ['\u0000', '\ud800', 'λ\n日本語'],
      pending: [{ details: { fixtureFutureField: { original: undefined } } }],
      nullPrototype,
    }
    const bytes = serialize(input)
    const restored = deserialize(bytes) as typeof input
    expect(restored).toStrictEqual(input)
    expect(Object.hasOwn(restored, 'absent')).toBe(false)
    expect(Object.hasOwn(restored, 'presentUndefined')).toBe(true)
    expect(Object.hasOwn(restored.nullPrototype, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(restored.nullPrototype)).toBe(null)
    expect(Object.is(restored.numbers[1], -0)).toBe(true)
    expect(serialize(restored)).toEqual(bytes)
  })

  it('keeps tag-shaped user values and __proto__ fields as ordinary data', () => {
    const input = Object.create(Object.prototype) as Record<string, unknown>
    Object.defineProperty(input, '__proto__', {
      value: ['object', 'plain', [['value', ['undefined']]]],
      enumerable: true,
    })
    input.format = 'life-observer-portable-wire'
    input.version = 1
    input.value = ['negative-zero']
    const restored = roundtrip(input)
    expect(restored).toStrictEqual(input)
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype)
    expect(Object.hasOwn(restored, '__proto__')).toBe(true)
  })

  it('accepts frozen and read-only enumerable data without modifying descriptors', () => {
    const input = Object.freeze({ field: Object.freeze([undefined, -0, 'opaque']) })
    const descriptors = Object.getOwnPropertyDescriptors(input)
    expect(roundtrip(input)).toStrictEqual(input)
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors)
    expect(Object.isFrozen(input.field)).toBe(true)
  })

  it('rejects unsupported values rather than converting or silently dropping them', () => {
    const unsupported = [
      1n,
      Symbol('opaque'),
      () => undefined,
      NaN,
      Infinity,
      -Infinity,
      new Date(0),
      new Map(),
      new Set(),
      /opaque/,
      Buffer.from('native bytes'),
      new Error('native'),
    ]
    for (const value of unsupported)
      expect(() => serialize({ future: value })).toThrow(PortableWireError)
  })

  it('rejects cycles while preserving all values of shared acyclic DTOs', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => serialize(cycle)).toThrow(PortableWireError)
    const shared = { presentUndefined: undefined, opaque: 'future' }
    expect(roundtrip([shared, shared])).toStrictEqual([shared, shared])
  })

  it('rejects getters, hidden fields, symbol keys and proxy traps without executing them', () => {
    const hook = vi.fn(() => {
      throw new Error('must not execute')
    })
    const accessor = Object.defineProperty({}, 'opaque', { get: hook, enumerable: true })
    const hidden = Object.defineProperty({}, 'opaque', { value: 'must not drop' })
    const proxy = new Proxy({}, { ownKeys: hook, getPrototypeOf: hook })
    for (const input of [accessor, hidden, { [Symbol('opaque')]: true }, proxy, { toJSON: hook }])
      expect(() => serialize(input)).toThrow(PortableWireError)
    expect(hook).not.toHaveBeenCalled()
  })

  it('requires dense arrays and rejects additional array payload fields', () => {
    const named = Object.assign([1], { future: 'must not drop' })
    const hiddenIndex = Object.defineProperty([1], '0', { enumerable: false })
    for (const input of [new Array(1), named, hiddenIndex])
      expect(() => serialize(input)).toThrow(PortableWireError)
    expect(Object.hasOwn(roundtrip([undefined]), '0')).toBe(true)
  })

  it('rejects malformed tags, duplicate object keys and noncanonical wire bytes', () => {
    const envelope = (value: unknown) =>
      Buffer.from(JSON.stringify({ format: 'life-observer-portable-wire', version: 1, value }))
    const malformed = [
      envelope(['future-tag']),
      envelope(['undefined', null]),
      envelope(['boolean', 'true']),
      envelope(['number', '1']),
      envelope(['object', 'custom', []]),
      envelope([
        'object',
        'plain',
        [
          ['__proto__', ['null']],
          ['__proto__', ['undefined']],
        ],
      ]),
      Buffer.from(' ' + serialize(null).toString()),
      Buffer.from('{"format":"life-observer-portable-wire","version":1,"value":["number",-0]}'),
      Buffer.from(
        '{"format":"life-observer-portable-wire","version":1,"value":["string","\\u0061"]}',
      ),
      Buffer.from(
        '{"format":"life-observer-portable-wire","version":1,"value":["null"],"value":["undefined"]}',
      ),
    ]
    for (const bytes of malformed) expect(() => deserialize(bytes)).toThrow(PortableWireError)
  })

  it('rejects invalid UTF-8, incomplete JSON and unexpected envelopes', () => {
    for (const bytes of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from('{'),
      Buffer.from('null'),
      Buffer.from('{"format":"other","version":1,"value":["null"]}'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), serialize(null)]),
    ])
      expect(() => deserialize(bytes)).toThrow(PortableWireError)
    expect(deserialize(new Uint8Array(serialize(true)))).toBe(true)
  })

  it('captures safe native error fields and cause values without retaining native references', () => {
    const native = Object.assign(
      new Error('cancelled 漢字🧪', { cause: { opaque: [undefined, -0] } }),
      {
        future: { original: undefined },
      },
    )
    Object.defineProperty(native, 'stack', { value: 'safe native stack', configurable: true })
    const dto = errorDTO(native)
    expect(dto.fields.name).toBe('Error')
    expect(dto.fields.message).toBe(native.message)
    expect(dto.fields.stack).toBe('safe native stack')
    expect(dto.fields.cause).toStrictEqual(native.cause)
    expect(dto.fields.cause).not.toBe(native.cause)
    expect(dto.fields.future).toStrictEqual(native.future)
    expect(dto.fields.future).not.toBe(native.future)
    expect(dto.unsupportedFields).toEqual([])
    expect(roundtrip(dto)).toStrictEqual(dto)
  })

  it('records unsupported error fields and cyclic causes without getters or stringification', () => {
    const hook = vi.fn(() => {
      throw new Error('must not execute')
    })
    const native = Object.assign(new Error('original'), { toString: hook, map: new Map() })
    Object.defineProperty(native, 'opaqueGetter', { get: hook })
    const child = new Error('child', { cause: native })
    Object.defineProperty(native, 'cause', { value: child })
    const dto = errorDTO(native)
    expect(dto.unsupportedFields).toEqual(
      expect.arrayContaining([
        { key: 'toString', reason: 'unsupported-function' },
        { key: 'map', reason: 'unsupported-prototype' },
        { key: 'opaqueGetter', reason: 'accessor' },
      ]),
    )
    const cause = dto.fields.cause as ErrorSnapshot
    expect(cause.fields.message).toBe('child')
    expect(cause.unsupportedFields).toContainEqual({ key: 'cause', reason: 'cycle-or-depth-limit' })
    expect(hook).not.toHaveBeenCalled()
    expect(() => serialize(dto)).not.toThrow()
  })
})

describe('transparent native recovery observation', () => {
  it('returns the original Promise and result with exact arguments, receiver and one listener call', async () => {
    const state = observer()
    const context = { nativeReceiver: true }
    const input = Object.freeze({ consumers: Object.freeze([{ sessionId: 'original' }]) })
    const additional = { opaque: undefined }
    const result = { owners: [{ pending: [{ details: { future: [undefined, '漢字🧪'] } }] }] }
    const promise = Promise.resolve(result)
    const listener = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(context)
      expect(args).toEqual([sender, input, additional])
      expect(args[0]).toBe(sender)
      expect(args[1]).toBe(input)
      expect(args[2]).toBe(additional)
      return promise
    })
    expect(state.ipcMain.handle('agent:recover', listener)).toBe(state.registrationResult)
    const returned = state.recover(context, sender, input, additional)
    expect(returned).toBe(promise)
    expect(await returned).toBe(result)
    expect(listener).toHaveBeenCalledOnce()
    const captured = state.entries().find((entry) => entry.kind === 'recover-fulfilled')
    expect(captured?.value.result).toStrictEqual(result)
    expect(result.owners[0].pending[0].details.future).toEqual([undefined, '漢字🧪'])
  })

  it('returns an original synchronous result without wrapping or mutation', () => {
    const state = observer()
    const result = Object.freeze({ opaque: undefined })
    state.ipcMain.handle('agent:recover', () => result)
    expect(state.recover({}, sender, {})).toBe(result)
    expect(
      state.entries().find((entry) => entry.kind === 'recover-fulfilled')?.value.result,
    ).toStrictEqual(result)
  })

  it('preserves the original fulfilled Promise and unsupported result when capture rejects its DTO', async () => {
    const state = observer()
    const result = { owners: [], futureNativeValue: new Map([['opaque', 1]]) }
    const promise = Promise.resolve(result)
    const listener = vi.fn(() => promise)
    state.ipcMain.handle('agent:recover', listener)
    const returned = state.recover({}, sender, {})
    expect(returned).toBe(promise)
    expect(await returned).toBe(result)
    expect(result.futureNativeValue).toBeInstanceOf(Map)
    expect(listener).toHaveBeenCalledOnce()
    expect(state.observation.failures).not.toEqual([])
    expect(state.entries().some((entry) => entry.kind === 'recover-fulfilled')).toBe(false)
  })

  it('rethrows the exact native synchronous error, including unprintable thrown values', () => {
    for (const native of [new Error('original'), unprintable]) {
      const state = observer()
      const listener = vi.fn(() => {
        throw native
      })
      state.ipcMain.handle('agent:recover', listener)
      expect(thrown(() => state.recover({}, sender, {}))).toBe(native)
      expect(listener).toHaveBeenCalledOnce()
    }
  })

  it('returns the exact rejected native Promise and cancellation reason', async () => {
    const state = observer()
    const cancellation = Object.assign(new Error('native cancellation'), { code: 'CANCELLED' })
    const promise = Promise.reject(cancellation)
    const listener = vi.fn(() => promise)
    state.ipcMain.handle('agent:recover', listener)
    const returned = state.recover({}, sender, {})
    expect(returned).toBe(promise)
    await expect(returned).rejects.toBe(cancellation)
    expect(listener).toHaveBeenCalledOnce()
    const captured = state.entries().find((entry) => entry.kind === 'recover-rejected')
    expect((captured?.value.error as ErrorSnapshot).fields.code).toBe('CANCELLED')
  })

  it('keeps native values and rejections unchanged when appending observations fails unprintably', async () => {
    const state = observer({ appendFailure: unprintable })
    const result = { original: true }
    const fulfilled = Promise.resolve(result)
    state.ipcMain.handle('agent:recover', () => fulfilled)
    expect(state.recover({}, sender, {})).toBe(fulfilled)
    expect(await fulfilled).toBe(result)
    const native = new Error('native rejection')
    const rejected = Promise.reject(native)
    state.ipcMain.handle('agent:recover', () => rejected)
    const returned = state.recover({}, sender, {})
    expect(returned).toBe(rejected)
    await expect(returned).rejects.toBe(native)
    expect(state.observation.failures).not.toEqual([])
  })

  it('preserves unrelated listener identity and native registration validation', () => {
    const state = observer()
    const listener = () => undefined
    expect(state.ipcMain.handle('unrelated', listener)).toBe(state.registrationResult)
    expect(state.handlers.get('unrelated')).toBe(listener)
    expect(thrown(() => state.ipcMain.handle('agent:recover', null))).toBe(state.invalidListener)
    expect(state.handlers.has('agent:recover')).toBe(false)
  })

  it('keeps the original listener error when sender provenance has already been destroyed', () => {
    const state = observer()
    const native = new Error('native owner unavailable')
    const destroyed = Object.defineProperty({}, 'senderFrame', {
      get: () => {
        throw unprintable
      },
    })
    state.ipcMain.handle('agent:recover', () => {
      throw native
    })
    expect(thrown(() => state.recover({}, destroyed, {}))).toBe(native)
    expect(state.observation.failures).not.toEqual([])
  })

  it('preserves the exact agent event arguments, receiver, return and immutable original payload', () => {
    const state = observer()
    const payload = Object.freeze({
      sessionId: 'native-owner',
      future: Object.freeze([undefined, '🧪']),
    })
    const extra = { nativeOpaque: true }
    const returned = { nativeSend: true }
    const send = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(contents)
      expect(args).toEqual(['agent:event', payload, extra])
      expect(args[1]).toBe(payload)
      expect(args[2]).toBe(extra)
      return returned
    })
    const contents = { id: 31, send }
    state.app.emit('web-contents-created', {}, contents)
    expect(contents.send('agent:event', payload, extra)).toBe(returned)
    expect(send).toHaveBeenCalledOnce()
    expect(Object.isFrozen(payload)).toBe(true)
    expect(Object.isFrozen(payload.future)).toBe(true)
    expect(
      state.entries().find((entry) => entry.kind === 'agent-event-sent')?.value.args,
    ).toStrictEqual([payload, extra])
  })

  it('rethrows the original agent send error despite observation and contents getter failures', () => {
    const state = observer({ appendFailure: unprintable })
    const native = new Error('native send failed')
    const send = vi.fn((..._args: unknown[]) => {
      throw native
    })
    const contents = Object.defineProperty({ send }, 'id', {
      get: () => {
        throw unprintable
      },
    })
    state.app.emit('web-contents-created', {}, contents)
    expect(thrown(() => contents.send('agent:event', { opaque: true }))).toBe(native)
    expect(send).toHaveBeenCalledOnce()
    expect(state.observation.failures).not.toEqual([])
  })

  it('does not assimilate a synchronous thenable when its DTO cannot be captured', () => {
    const state = observer()
    const then = vi.fn()
    const result = { then, opaque: true }
    state.ipcMain.handle('agent:recover', () => result)
    expect(state.recover({}, sender, {})).toBe(result)
    expect(then).not.toHaveBeenCalled()
    expect(state.observation.failures).not.toEqual([])
  })

  it('returns an original Promise even when its species blocks the observation callback', () => {
    const state = observer()
    class Exotic extends Promise<unknown> {
      static get [Symbol.species](): never {
        throw unprintable
      }
    }
    const promise = new Exotic((resolve) => resolve({ original: true }))
    // Mock libraries can attach their own settlement observers to returned
    // Promises. Count directly so only the boundary under test sees this one.
    let calls = 0
    const listener = () => {
      calls++
      return promise
    }
    state.ipcMain.handle('agent:recover', listener)
    expect(state.recover({}, sender, {}) === promise).toBe(true)
    expect(calls).toBe(1)
    expect(state.observation.failures).not.toEqual([])
  })
})
