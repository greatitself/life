import { describe, expect, it } from 'vitest'
import {
  encodePendingSourceApply,
  loadPendingSourceApply,
  parsePendingSourceApply,
  pendingSourceApplyKey,
  type PendingSourceApply,
} from '../src/renderer/source-session'

const pending = (): PendingSourceApply => ({
  id: 'original-thread',
  turn: 12,
  request: 'Replace Life’s built-in select components with real shadcn components.',
  profileId: 'research-machine',
  reads: 2,
  repairs: 1,
  start: {
    sessionId: 'original-thread',
    provider: 'codex',
    remoteId: 'remote-conversation-42',
    workspace: '/home/researcher/project',
    prompt: 'A very large generated prompt with current source code.',
    model: 'selected-model',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    providerOptions: {
      thread: { dynamicProtocolOption: { nested: ['existing', 42, true, null] } },
      turn: { customTurnOption: 'retained' },
      settings: { customClaudeOption: false },
      args: ['--custom-argument', 'a value with spaces'],
    },
    mode: 'edit',
  },
  paths: ['src/renderer/App.tsx', 'src/shared/types.ts'],
})

describe('pending source activation session', () => {
  it('retains provider identity, model options, workspace, and counters across reload', () => {
    expect(pendingSourceApplyKey).toBe('life.pendingSourceApply')
    for (const provider of ['codex', 'claude'] as const) {
      const input = pending()
      input.start.provider = provider
      const serialized = encodePendingSourceApply(input)
      expect(loadPendingSourceApply(serialized)).toEqual({
        ...input,
        start: { ...input.start, prompt: input.request, mode: 'plan' },
      })
      expect(input.start.mode).toBe('edit')
      expect(input.start.prompt).toBe('A very large generated prompt with current source code.')
    }
  })

  it('persists the original request instead of generated code or source context', () => {
    const input = pending()
    input.start.prompt = '<life-source-context>' + 'source code'.repeat(200_000)
    const encoded = encodePendingSourceApply(input)
    expect(encoded.length).toBeLessThan(2_000)
    expect(encoded).not.toContain('life-source-context')
    expect(loadPendingSourceApply(encoded)?.start.prompt).toBe(input.request)
    // Old or manually written entries are normalized too, so repairs never resend stale code.
    expect(parsePendingSourceApply(input).start.prompt).toBe(input.request)
  })

  it('supports long user requests and omits unset optional start fields', () => {
    const input = pending()
    input.request = 'Implement this change. '.repeat(10_000)
    input.start.remoteId = undefined
    input.start.providerOptions = undefined
    expect(input.request.length).toBeGreaterThan(20_000)
    const decoded = loadPendingSourceApply(encodePendingSourceApply(input))!
    expect(decoded.request).toBe(input.request.trim())
    expect(decoded.start.prompt).toBe(input.request.trim())
    expect(decoded.start).not.toHaveProperty('remoteId')
    expect(decoded.start).not.toHaveProperty('providerOptions')
  })

  it('accepts empty paths and read-only native source context', () => {
    const input = pending()
    input.paths = []
    expect(parsePendingSourceApply(input).paths).toEqual([])
    input.paths = [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/bootstrap.ts',
      'package.json',
    ]
    expect(parsePendingSourceApply(input).paths).toEqual(input.paths)
  })

  it('caps source reads, repairs, requests, and paths while rejecting traversal and duplicates', () => {
    for (const patch of [
      { reads: -1 },
      { reads: 7 },
      { reads: 1.5 },
      { repairs: -1 },
      { repairs: 3 },
      { repairs: 0.5 },
      { turn: -1 },
      { turn: Number.MAX_SAFE_INTEGER + 1 },
      { turn: 1.5 },
      { request: ' ' },
      { request: 'x'.repeat(900_001) },
      { paths: Array.from({ length: 31 }, (_, index) => `src/renderer/file-${index}.ts`) },
      { paths: ['src/renderer/App.tsx', 'src/renderer/app.tsx'] },
      { paths: ['src/renderer/../main/index.ts'] },
      { paths: ['src\\renderer\\App.tsx'] },
      { paths: ['/etc/passwd'] },
    ])
      expect(() => parsePendingSourceApply({ ...pending(), ...patch })).toThrow()
    const limits = { ...pending(), reads: 6, repairs: 2, turn: Number.MAX_SAFE_INTEGER }
    expect(parsePendingSourceApply(limits)).toMatchObject({ reads: 6, repairs: 2 })
  })

  it('rejects invalid identities or start inputs instead of adopting another conversation', () => {
    for (const patch of [
      { id: '' },
      { id: 'thread\nother' },
      { profileId: '' },
      { profileId: 'profile id with spaces' },
      { unknown: true },
      { start: { ...pending().start, sessionId: 'different-thread' } },
      { start: { ...pending().start, provider: 'unknown' } },
      { start: { ...pending().start, mode: 'unsafe' } },
      { start: { ...pending().start, workspace: '/home/research\ncommand' } },
      { start: { ...pending().start, extra: 'unsupported' } },
      { start: { ...pending().start, providerOptions: { turn: { cwd: '/other-project' } } } },
    ])
      expect(() => parsePendingSourceApply({ ...pending(), ...patch })).toThrow()
  })

  it('rejects executable or cyclic metadata without invoking getters or toJSON', () => {
    let invoked = false
    const withGetter = pending()
    Object.defineProperty(withGetter.start, 'model', {
      get: () => {
        invoked = true
        return 'model'
      },
    })
    expect(() => parsePendingSourceApply(withGetter)).toThrow('getters')
    expect(invoked).toBe(false)
    expect(() => parsePendingSourceApply({ ...pending(), toJSON: () => pending() })).toThrow(
      'unsupported key',
    )
    const cyclic: Record<string, unknown> = pending().start.providerOptions!.thread!
    cyclic.self = cyclic
    const input = pending()
    input.start.providerOptions = { thread: cyclic }
    expect(() => parsePendingSourceApply(input)).toThrow('circular')
    const sparse = pending()
    sparse.paths = new Array(2)
    sparse.paths[1] = 'src/renderer/App.tsx'
    expect(() => parsePendingSourceApply(sparse)).toThrow('empty entries')
  })

  it('treats malformed, primitive, or oversized saved entries as absent during startup', () => {
    for (const source of [
      null,
      undefined,
      '',
      '{invalid JSON}',
      'null',
      '[]',
      '{}',
      JSON.stringify({ ...pending(), repairs: 3 }),
      JSON.stringify({ ...pending(), start: null }),
      ' '.repeat(2_000_001),
    ])
      expect(loadPendingSourceApply(source)).toBeNull()
  })

  it('bounds the encoded storage size when escaping expands a large original request', () => {
    const input = pending()
    input.request = 'x\n'.repeat(440_000)
    expect(input.request.length).toBeLessThan(900_000)
    expect(() => encodePendingSourceApply(input)).toThrow('smaller than 2 MB')
  })
})
