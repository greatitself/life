import { describe, expect, it, vi } from 'vitest'
import {
  STUDIO_PENDING_KEY,
  encodeStudioPending,
  readStudioPending,
  type StudioPending,
} from '../src/renderer/studio-pending'

const pending = (): StudioPending => ({
  id: 'life-studio:session-one',
  request: ' \nMake Life easier to read.\tKeep my wording exactly.  ',
  profileId: 'saved-machine',
  input: {
    sessionId: 'life-studio:session-one',
    provider: 'codex',
    remoteId: 'previous-provider-conversation',
    prompt: 'An obsolete hidden prompt with source context',
    mode: 'plan',
    model: 'gpt-example',
    reasoningEffort: 'high',
    serviceTier: 'fast',
  },
  reads: 3,
  repairs: 1,
  paths: ['src/renderer/App.tsx', 'src/shared/types.ts'],
})

const raw = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...pending(), ...patch })

describe('validated pending Studio recovery', () => {
  it('uses the dedicated key and retains provider identity, exact request and continuation counters', () => {
    expect(STUDIO_PENDING_KEY).toBe('life.studio.pending-source.v1')
    for (const provider of ['codex', 'claude'] as const) {
      const original = pending()
      original.input.provider = provider
      const encoded = encodeStudioPending(original)
      const restored = readStudioPending(encoded)
      expect(restored).toEqual({
        ...original,
        input: { ...original.input, prompt: original.request },
      })
      expect(restored?.request).toBe(original.request)
      expect(restored?.input.prompt).toBe(original.request)
      expect(original.input.prompt).toBe('An obsolete hidden prompt with source context')
      expect(encoded).not.toContain('obsolete hidden prompt')
    }
  })

  it('normalizes old generated wrappers without retaining them or mutating caller-owned objects', () => {
    const original = pending()
    original.input.prompt = '<life-source-context>' + 'private source'.repeat(180_000)
    const encoded = encodeStudioPending(original)
    expect(encoded.length).toBeLessThan(1500)
    expect(encoded).not.toContain('life-source-context')
    const restored = readStudioPending(raw())
    expect(restored?.input.prompt).toBe(pending().request)
    expect(original.input.prompt).toContain('private source')
  })

  it('supports omitted optional fields, empty paths and read-only source paths', () => {
    const original = pending()
    original.paths = undefined
    original.input.remoteId = undefined
    original.input.model = undefined
    expect(readStudioPending(encodeStudioPending(original))?.input).not.toHaveProperty('remoteId')
    expect(readStudioPending(encodeStudioPending(original))).not.toHaveProperty('paths')
    original.paths = []
    expect(readStudioPending(encodeStudioPending(original))?.paths).toEqual([])
    original.paths = [
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/bootstrap.ts',
      'package.json',
    ]
    expect(readStudioPending(encodeStudioPending(original))?.paths).toEqual(original.paths)
    original.input.scope = 'life-customization'
    expect(readStudioPending(encodeStudioPending(original))?.input.scope).toBe('life-customization')
  })

  it('rejects malformed, oversized and hostile serialized roots', () => {
    for (const serialized of [
      null,
      undefined,
      '',
      '{broken',
      'null',
      '[]',
      '{}',
      'x'.repeat(2_000_001),
      JSON.stringify({ ...pending(), request: '界'.repeat(700_000) }),
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{}}',
    ])
      expect(readStudioPending(serialized) === undefined).toBe(true)
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('enforces finite bounded counters, nonempty exact requests and safe identifiers', () => {
    for (const patch of [
      { reads: -1 },
      { reads: 7 },
      { reads: 1.5 },
      { reads: '1' },
      { reads: null },
      { repairs: -1 },
      { repairs: 3 },
      { repairs: 0.5 },
      { repairs: '0' },
      { request: ' \n\t' },
      { request: 'x'.repeat(1_000_001) },
      { id: '' },
      { id: '../another-session' },
      { profileId: '' },
      { profileId: 'machine with spaces' },
      { profileId: 'machine\ncommand' },
      { unknown: true },
    ])
      expect(readStudioPending(raw(patch))).toBeUndefined()
    expect(readStudioPending(raw({ reads: 6, repairs: 2 }))).toMatchObject({ reads: 6, repairs: 2 })
    for (const reads of [NaN, Infinity])
      expect(() => encodeStudioPending({ ...pending(), reads })).toThrow('JSON data')
  })

  it('rejects another conversation, research scope, hidden protocol overrides and invalid provider options', () => {
    for (const input of [
      { ...pending().input, sessionId: 'other-session' },
      { ...pending().input, scope: 'research' },
      { ...pending().input, scope: 'project' },
      { ...pending().input, provider: 'unknown' },
      { ...pending().input, mode: 'unsafe' },
      { ...pending().input, workspace: '/root/project\ncommand' },
      { ...pending().input, extra: 'unsupported field' },
      { ...pending().input, providerOptions: { turn: { instructions: 'A hidden system prompt' } } },
      { ...pending().input, providerOptions: { args: ['--append-system-prompt', 'Extra words'] } },
    ])
      expect(readStudioPending(raw({ input }))).toBeUndefined()
  })

  it('preserves valid generic provider options as data without changing the user message', () => {
    const original = pending()
    original.input.providerOptions = {
      thread: { customOption: { nested: [true, 42, 'data', null] } },
      turn: { futureProtocolOption: false },
      settings: { futureClaudeOption: 'supported-value' },
      args: ['--future-argument', 'value'],
    }
    expect(readStudioPending(encodeStudioPending(original))?.input.providerOptions).toEqual(
      original.input.providerOptions,
    )
    expect(readStudioPending(encodeStudioPending(original))?.input.prompt).toBe(original.request)
  })

  it('requires safe unique context paths and at most 30 selected files', () => {
    for (const paths of [
      ['src/renderer/App.tsx', 'src/renderer/app.tsx'],
      ['src/renderer/App.tsx', 'src/renderer/App.tsx'],
      ['src/renderer/../main/index.ts'],
      ['src\\renderer\\App.tsx'],
      ['/root/.ssh/id_rsa'],
      ['../package.json'],
      ['src/renderer/CON.ts'],
      Array.from({ length: 31 }, (_, index) => `src/renderer/file-${index}.tsx`),
    ])
      expect(readStudioPending(raw({ paths }))).toBeUndefined()
    const paths = Array.from({ length: 30 }, (_, index) => `src/renderer/file-${index}.tsx`)
    expect(readStudioPending(raw({ paths }))?.paths).toEqual(paths)
  })

  it('rejects getters, serializers, circular references and nonplain objects without executing them', () => {
    const called = vi.fn()
    const getter = Object.defineProperty(pending(), 'request', { get: called })
    const serializer = { ...pending(), toJSON: called }
    const circular = pending() as StudioPending & { self?: unknown }
    circular.self = circular
    const classInstance = Object.assign(new (class Pending {})(), pending())
    for (const hostile of [getter, serializer, circular, classInstance])
      expect(() => encodeStudioPending(hostile)).toThrow()
    expect(called).not.toHaveBeenCalled()
    const nested = pending()
    nested.input = Object.defineProperty({ ...nested.input }, 'prompt', { get: called })
    expect(() => encodeStudioPending(nested)).toThrow('getters')
    expect(called).not.toHaveBeenCalled()
  })

  it('rejects sparse arrays and excessive structural nesting before schema traversal', () => {
    const sparse = pending()
    sparse.paths = new Array(1)
    expect(() => encodeStudioPending(sparse)).toThrow('empty entries')
    const nested = pending()
    let deep: unknown = null
    for (let index = 0; index < 40; index++) deep = { next: deep }
    nested.input.providerOptions = { thread: { deep } }
    expect(() => encodeStudioPending(nested)).toThrow('nested')
  })

  it('enforces encoded UTF-8 size while preserving long valid requests instead of trimming them', () => {
    const original = pending()
    original.request = '  ' + 'a'.repeat(900_000) + '\n '
    const encoded = encodeStudioPending(original)
    expect(readStudioPending(encoded)?.request).toBe(original.request)
    original.request = 'a'.repeat(1_000_000)
    expect(() => encodeStudioPending(original)).toThrow('2 MB')
    original.request = '界'.repeat(400_000)
    expect(() => encodeStudioPending(original)).toThrow('2 MB')
  })
})
