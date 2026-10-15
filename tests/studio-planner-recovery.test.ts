import { describe, expect, it, vi } from 'vitest'
import type { LifeSourceContext } from '../src/shared/source-code'
import type { NativeRecoveryOwnerState } from '../src/shared/types'
import {
  acceptStudioPlannerActionResult,
  advanceStudioPlannerActionReceipt,
  encodeStudioPlannerRecovery,
  getStudioPlannerRecoveryStep,
  parseStudioPlannerRecovery,
  readStudioPlannerRecovery,
  restoreStudioPlannerRecovery,
  settleStudioPlannerAction,
  startStudioPlannerAction,
  STUDIO_PLANNER_RECOVERY_FORMAT,
  type StudioPlannerAction,
  type StudioPlannerRecovery,
  type StudioPlannerNativeActionResult,
} from '../src/renderer/studio-planner-recovery'

const source = (): LifeSourceContext => ({
  extensions: [],
  revision: 7,
  paths: ['src/renderer/App.tsx', 'src/shared/types.ts', 'src/main/agents.ts'],
  files: [{ path: 'src/renderer/App.tsx', content: 'export const App = () => "界🧑🏽‍💻"\r\n' }],
  dependencies: { react: '^19.1.0' },
  snapshot: {
    extensions: [],
    revision: 7,
    enabled: true,
    canRollback: true,
    recovered: false,
    path: '/private/local source',
    active: { revision: 7, js: 'life-source://7/main.js', css: 'life-source://7/main.css' },
  },
  baselineFiles: [{ path: 'src/renderer/App.tsx', content: 'export const App = () => null\n' }],
})
const planner = (): StudioPlannerRecovery => {
  const request = ' \nMake Life work exactly like this.\t界🧑🏽‍💻\r\n\ud800  '
  return {
    format: STUDIO_PLANNER_RECOVERY_FORMAT,
    formatVersion: 1,
    sessionId: 'life-studio:one',
    profileId: 'saved machine',
    provider: 'codex',
    request,
    input: {
      sessionId: 'life-studio:one',
      provider: 'codex',
      remoteId: 'native-conversation',
      prompt: request,
      model: 'gpt-example',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      mode: 'plan',
      scope: 'life-customization',
      studioContext: {
        instructions: 'Exact original instruction\r\n',
        files: [{ path: '.life/source-context.json', content: '{"exact":"界"}' }],
        revision: 7,
        phase: 'source-read',
      },
    },
    source: source(),
    nativeIteration: 4,
    reads: 3,
    repairs: 1,
    parts: [
      { itemId: 'response:one', text: 'first\r\n\ud800' },
      { itemId: 'response:two', text: '<life-source>{"partial":"界' },
    ],
    finishing: false,
    autoApply: true,
    phase: 'planning',
    continuation: { sourceRead: { paths: ['src/renderer/App.tsx'] } },
  }
}
const owner = (value = planner()): NativeRecoveryOwnerState => ({
  sessionId: value.sessionId,
  transportId: 'transport:one',
  ownerGeneration: 2,
  status: 'running',
  clientRecovery: value,
})
const binding = () => ({
  sessionId: 'life-studio:one',
  profileId: 'saved machine',
  provider: 'codex' as const,
})
const nativeReceipt = (actionId = 'action:one') => ({
  actionId,
  transportId: 'transport:one',
  ownerGeneration: 2,
})
const appliedSnapshot = () => ({
  ...source().snapshot,
  revision: 8,
  active: { revision: 8, js: 'life-source://8/main.js', css: 'life-source://8/main.css' },
})
const readAction = (): Extract<StudioPlannerAction, { kind: 'read-source' }> => ({
  id: 'action:one',
  iteration: 4,
  status: 'intended',
  kind: 'read-source',
  intent: { purpose: 'source-read', read: { paths: ['src/renderer/App.tsx'] } },
})
const applyAction = (): Extract<StudioPlannerAction, { kind: 'apply-source' }> => ({
  id: 'action:one',
  iteration: 4,
  status: 'intended',
  kind: 'apply-source',
  intent: {
    patch: {
      baseRevision: 7,
      summary: 'Make Life work',
      files: [{ path: 'src/renderer/App.tsx', content: 'export const App = () => "exact"\r\n' }],
    },
  },
})

describe('durable Studio planner context', () => {
  it('retains the exact request, native identity, context, counters and ordered partial parts', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const original = planner()
      original.provider = provider
      original.input.provider = provider
      const restored = readStudioPlannerRecovery(encodeStudioPlannerRecovery(original))
      expect(restored).toEqual(original)
      expect(restored?.request).toBe(original.request)
      expect(restored?.input.prompt).toBe(original.request)
      expect(restored?.source?.baselineFiles).toEqual(original.source?.baselineFiles)
      expect(restored?.parts.map((part) => part.itemId)).toEqual(['response:one', 'response:two'])
      expect(restored).not.toBe(original)
      expect(restored?.source).not.toBe(original.source)
    }
  })

  it('keeps provider options and actual native context without substituting hidden prompts', () => {
    const original = planner()
    original.input.providerOptions = {
      thread: { futureThreadOption: [true, 'native', 42, null] },
      turn: { futureTurnOption: { exact: 'yes' } },
      settings: { futureSetting: false },
      args: ['--future-native-option', 'value'],
    }
    expect(readStudioPlannerRecovery(encodeStudioPlannerRecovery(original))?.input).toEqual(
      original.input,
    )
    const wrong = { ...original, input: { ...original.input, prompt: 'modified wrapper' } }
    expect(() => parseStudioPlannerRecovery(wrong)).toThrow('exact native request')
  })

  it.each(
    [
      { sessionId: 'other' },
      { profileId: '' },
      { provider: 'different' },
      { formatVersion: 2 },
      { request: ' \r\n\t' },
      { request: 'x'.repeat(1_000_001) },
      { reads: 7 },
      { reads: -1 },
      { reads: '1' },
      { repairs: 3 },
      { repairs: 1.5 },
      { nativeIteration: 10 },
      { nativeIteration: 6 },
      { autoApply: 'yes' },
      { phase: 'unbounded' },
      { extraArchivalField: true },
    ].map((patch, index) => ({ caseName: `case ${index + 1} (${Object.keys(patch)[0]})`, patch })),
  )('rejects unsupported or inconsistent planner data: $caseName', ({ patch }) => {
    expect(
      readStudioPlannerRecovery(JSON.stringify({ ...planner(), ...patch })) === undefined,
    ).toBe(true)
  })

  it('refuses project/research scopes, another provider/session, and non-plan native starts', () => {
    for (const patch of [
      { scope: 'research' },
      { scope: undefined },
      { mode: 'unsafe' },
      { mode: 'default' },
      { sessionId: 'another-conversation' },
      { provider: 'claude' },
      { clientRecovery: { autoApply: true } },
      { workspace: '/wrong\nworkspace' },
    ])
      expect(() =>
        parseStudioPlannerRecovery({ ...planner(), input: { ...planner().input, ...patch } }),
      ).toThrow()
  })

  it('retains exact workspace spelling accepted by the native schema and refuses a different start scope', () => {
    const admitted = {
      ...planner(),
      input: { ...planner().input, workspace: '/native/studio folder' },
    }
    expect(readStudioPlannerRecovery(encodeStudioPlannerRecovery(admitted))?.input.workspace).toBe(
      '/native/studio folder',
    )
    for (const workspace of [' /native/studio', '/native/studio ', '/native/studio folder ']) {
      const value = { ...admitted, input: { ...admitted.input, workspace } }
      const stored = readStudioPlannerRecovery(encodeStudioPlannerRecovery(value))!
      expect(stored.input.workspace).toBe(workspace)
      const restored = restoreStudioPlannerRecovery(owner(stored), binding())!
      expect(restored.planner.input.workspace).toBe(workspace)
      const action = {
        ...readAction(),
        kind: 'start-provider' as const,
        intent: { input: value.input },
      }
      expect(parseStudioPlannerRecovery({ ...value, action }).action?.intent).toEqual(action.intent)
    }
    expect(() =>
      parseStudioPlannerRecovery({
        ...admitted,
        input: { ...admitted.input, workspace: '\t/native/studio\t' },
      }),
    ).toThrow('valid remote path')
    const changed = {
      ...admitted,
      action: {
        ...readAction(),
        kind: 'start-provider' as const,
        intent: { input: { ...admitted.input, workspace: ' /native/studio folder' } },
      },
    }
    expect(() => parseStudioPlannerRecovery(changed)).toThrow('exact native input and owner')
  })

  it('rejects malformed JSON, sparse/named arrays, duplicate parts and unsupported source ownership', () => {
    for (const serialized of [null, undefined, '', '{broken', 'null', '[]', '{}'])
      expect(readStudioPlannerRecovery(serialized)).toBeUndefined()
    for (const patch of [
      {
        parts: [
          { itemId: 'same', text: 'A' },
          { itemId: 'same', text: 'B' },
        ],
      },
      { parts: [undefined] },
      { source: { ...source(), revision: 8 } },
      {
        source: {
          ...source(),
          files: [{ path: 'src/renderer/Other.tsx', content: 'not indexed' }],
        },
      },
      { source: { ...source(), paths: ['src/renderer/../main/agents.ts'] } },
      { source: { ...source(), paths: ['src/renderer/App.tsx', 'src/renderer/App.tsx'] } },
    ])
      expect(() => parseStudioPlannerRecovery({ ...planner(), ...patch })).toThrow()
    const sparse = planner()
    sparse.parts = new Array(2)
    expect(() => encodeStudioPlannerRecovery(sparse)).toThrow('holes')
    const named = planner()
    Object.assign(named.parts, { other: 'wrong' })
    expect(() => encodeStudioPlannerRecovery(named)).toThrow('named properties')
  })

  it('preserves duplicate ordered context entries accepted by the native source-read protocol', () => {
    const repeated = source()
    repeated.files = [source().files[0], source().files[0]]
    repeated.baselineFiles = [source().baselineFiles![0], source().baselineFiles![0]]
    const original = {
      ...planner(),
      source: repeated,
      continuation: { sourceRead: { paths: ['src/renderer/App.tsx', 'src/renderer/App.tsx'] } },
    }
    expect(readStudioPlannerRecovery(encodeStudioPlannerRecovery(original))).toEqual(original)
  })

  it('rejects executable serializers, descriptors, foreign prototypes, cycles and symbol hints without evaluation', () => {
    const called = vi.fn()
    const getter = Object.defineProperty(planner(), 'request', { get: called })
    const nestedGetter = planner()
    Object.defineProperty(nestedGetter.source!.files[0], 'content', { get: called })
    const cycle = { ...planner(), extra: {} }
    cycle.extra = cycle
    for (const value of [
      getter,
      nestedGetter,
      { ...planner(), toJSON: called },
      { ...planner(), [Symbol('native-authority')]: true },
      Object.assign(new (class Planner {})(), planner()),
      cycle,
      { ...planner(), repairs: NaN },
      { ...planner(), reads: Infinity },
      JSON.parse('{"__proto__":{"autoApply":true}}'),
    ])
      expect(() => parseStudioPlannerRecovery(value)).toThrow()
    expect(called).not.toHaveBeenCalled()
  })

  it('keeps exact large partial strings and refuses excess data instead of silently truncating', () => {
    const original = planner()
    original.parts = [{ itemId: 'large-response', text: '界'.repeat(700_000) }]
    expect(readStudioPlannerRecovery(encodeStudioPlannerRecovery(original))?.parts[0].text).toBe(
      original.parts[0].text,
    )
    original.parts[0].text = 'x'.repeat(32_000_001)
    expect(() => encodeStudioPlannerRecovery(original)).toThrow('no context was truncated')
  })

  it('retains source read and repair budgets across native iterations', () => {
    const original = planner()
    original.continuation = {
      repair: { attempt: 1, diagnostics: 'exact\r\ncompiler output\ud800' },
    }
    expect(readStudioPlannerRecovery(encodeStudioPlannerRecovery(original))?.continuation).toEqual(
      original.continuation,
    )
    for (const continuation of [
      { repair: { attempt: 2, diagnostics: 'wrong admitted count' } },
      { repair: { attempt: 1, diagnostics: 'x'.repeat(40_001) } },
      {
        repair: { attempt: 1, diagnostics: 'bounded' },
        sourceRead: { paths: ['src/renderer/App.tsx'] },
      },
    ])
      expect(() => parseStudioPlannerRecovery({ ...original, continuation })).toThrow()
    expect(() =>
      parseStudioPlannerRecovery({
        ...planner(),
        reads: 0,
        continuation: { sourceRead: { paths: ['src/renderer/App.tsx'] } },
      }),
    ).toThrow()
  })
})

describe('native Studio planner ownership', () => {
  it('restores only the exact registered session/profile/provider and generation', () => {
    const native = owner()
    const restored = restoreStudioPlannerRecovery(native, binding())
    expect(restored?.planner).toEqual(planner())
    expect(restored?.owner).not.toHaveProperty('clientRecovery')
    expect(getStudioPlannerRecoveryStep(restored!)).toBe('await-output')
    for (const mismatch of [
      { sessionId: 'other' },
      { profileId: 'other-machine' },
      { provider: 'claude' as const },
    ])
      expect(restoreStudioPlannerRecovery(native, { ...binding(), ...mismatch })).toBeUndefined()
    for (const patch of [
      { sessionId: 'other' },
      { transportId: '' },
      { ownerGeneration: undefined },
      { ownerGeneration: -1 },
      { ownerGeneration: 1.5 },
      { status: 'unowned' },
      { clientRecovery: undefined },
    ])
      expect(
        restoreStudioPlannerRecovery(
          { ...native, ...patch } as NativeRecoveryOwnerState,
          binding(),
        ),
      ).toBeUndefined()
  })

  it('waits while native ownership is unknown or recovering and rejects copied archival authorization', () => {
    for (const status of ['recovering', 'unknown'] as const) {
      const restored = restoreStudioPlannerRecovery({ ...owner(), status }, binding())
      expect(restored).toBeDefined()
      expect(getStudioPlannerRecoveryStep(restored!)).toBe('wait-owner')
    }
    expect(getStudioPlannerRecoveryStep({ planner: planner(), owner: owner() })).toBe('wait-owner')
    const restored = restoreStudioPlannerRecovery(owner(), binding())!
    expect(getStudioPlannerRecoveryStep(JSON.parse(JSON.stringify(restored)))).toBe('wait-owner')
  })

  it('cannot change recovered action authorization by mutating an admitted object', () => {
    const original = { ...planner(), phase: 'review' as const, autoApply: false }
    const restored = restoreStudioPlannerRecovery(owner(original), binding())!
    expect(Object.isFrozen(restored)).toBe(true)
    expect(Object.isFrozen(restored.planner)).toBe(true)
    expect(Object.isFrozen(restored.planner.input.studioContext!.files)).toBe(true)
    expect(() => {
      restored.planner.autoApply = true
    }).toThrow()
    expect(() => {
      restored.planner.phase = 'completing'
    }).toThrow()
    original.autoApply = true
    expect(restored.planner.autoApply).toBe(false)
    expect(getStudioPlannerRecoveryStep(restored)).toBe('review')
  })

  it('uses a receipt only if its action, transport, and owner generation match', () => {
    const value = {
      ...planner(),
      phase: 'applying' as const,
      action: {
        ...applyAction(),
        status: 'succeeded' as const,
        receipt: { native: nativeReceipt(), snapshot: appliedSnapshot() },
      },
    }
    const restored = restoreStudioPlannerRecovery(owner(value), binding())
    expect(getStudioPlannerRecoveryStep(restored!)).toBe('use-receipt')
    for (const native of [
      nativeReceipt('other-action'),
      { ...nativeReceipt(), transportId: 'other-transport' },
      { ...nativeReceipt(), ownerGeneration: 1 },
    ])
      expect(
        restoreStudioPlannerRecovery(
          owner({
            ...value,
            action: { ...value.action, receipt: { ...value.action.receipt, native } },
          }),
          binding(),
        ),
      ).toBeUndefined()
  })

  it('correlates response parts with their exact applied native output revision', () => {
    const value = {
      ...planner(),
      applied: { transportId: 'transport:one', throughEventRevision: 41 },
    }
    const restored = restoreStudioPlannerRecovery(
      { ...owner(value), throughEventRevision: 44 },
      binding(),
    )
    expect(restored?.planner.applied).toEqual(value.applied)
    expect(restored?.planner.parts).toEqual(value.parts)
    expect(
      restoreStudioPlannerRecovery({ ...owner(value), throughEventRevision: 40 }, binding()),
    ).toBeUndefined()
    expect(restoreStudioPlannerRecovery(owner(value), binding())).toBeUndefined()
    expect(
      restoreStudioPlannerRecovery(
        { ...owner(value), throughEventRevision: '44' } as unknown as NativeRecoveryOwnerState,
        binding(),
      ),
    ).toBeUndefined()
    expect(
      restoreStudioPlannerRecovery(
        owner({ ...value, applied: { ...value.applied, transportId: 'other-transport' } }),
        binding(),
      ),
    ).toBeUndefined()
    expect(() =>
      parseStudioPlannerRecovery({
        ...value,
        applied: { ...value.applied, throughEventRevision: -1 },
      }),
    ).toThrow()
  })
})

describe('Studio action recovery without duplicate work', () => {
  const step = (value: StudioPlannerRecovery) =>
    getStudioPlannerRecoveryStep(restoreStudioPlannerRecovery(owner(value), binding())!)

  it('continues an unstarted read, reconciles any started action, and consumes saved exact read receipts', () => {
    const value = { ...planner(), phase: 'reading' as const, action: readAction() }
    expect(step(value)).toBe('continue-action')
    const started = startStudioPlannerAction(value, 'action:one')
    expect(step(started)).toBe('reconcile-action')
    const settled = settleStudioPlannerAction(started, 'action:one', {
      receipt: { native: nativeReceipt(), source: source() },
    })
    expect(step(settled)).toBe('use-receipt')
    expect(settled.action?.receipt).toEqual({ native: nativeReceipt(), source: source() })
    expect(
      settleStudioPlannerAction(settled, 'action:one', {
        receipt: { native: nativeReceipt(), source: source() },
      }),
    ).toBe(settled)
    expect(value.action.status).toBe('intended')
  })

  it('never automatically repeats source, settings, runtime apply, provider start or reload after an IPC gap', () => {
    const actions: StudioPlannerAction[] = [
      applyAction(),
      { ...readAction(), kind: 'apply-settings', intent: { patch: { theme: 'light' } } },
      {
        ...readAction(),
        kind: 'apply-extension',
        intent: {
          manifest: {
            id: 'new-feature',
            name: 'Feature',
            description: '',
            version: '1.0.0',
            enabled: true,
            renderer: { html: '<main>Feature</main>', css: '', js: '', placement: 'panel' },
          },
        },
      },
      { ...readAction(), kind: 'start-provider', intent: { input: planner().input } },
      {
        ...readAction(),
        kind: 'reload-source',
        intent: { appliedActionId: 'previous-action', revision: 8 },
      },
    ]
    for (const action of actions) {
      const value = { ...planner(), action }
      expect(step(value)).toBe('reconcile-action')
      expect(step(startStudioPlannerAction(value, 'action:one'))).toBe('reconcile-action')
    }
  })

  it('cannot associate another iteration, another request, or a malformed native source patch', () => {
    for (const action of [
      { ...readAction(), iteration: 3 },
      { ...readAction(), kind: 'read-source', intent: { purpose: 'source-read' } },
      {
        ...readAction(),
        kind: 'read-source',
        intent: { purpose: 'initial', read: { paths: ['src/renderer/App.tsx'] } },
      },
      {
        ...readAction(),
        kind: 'start-provider',
        intent: { input: { ...planner().input, sessionId: 'other' } },
      },
      {
        ...readAction(),
        kind: 'start-provider',
        intent: { input: { ...planner().input, prompt: 'different prompt' } },
      },
      { ...readAction(), kind: 'apply-settings', intent: { patch: {} } },
      {
        ...applyAction(),
        intent: {
          patch: {
            baseRevision: 7,
            summary: 'Wrong host edit',
            files: [{ path: 'src/main/agents.ts', content: 'native change' }],
          },
        },
      },
      {
        ...applyAction(),
        intent: {
          patch: {
            baseRevision: 7,
            summary: 'Too large',
            files: [{ path: 'src/renderer/App.tsx', content: '界'.repeat(700_000) }],
          },
        },
      },
    ])
      expect(() => parseStudioPlannerRecovery({ ...planner(), action })).toThrow()
  })

  it('retains the exact provider start workspace, native session, model, options and instructions', () => {
    for (const changed of [
      { workspace: '/another-project' },
      { remoteId: 'other-native-conversation' },
      { model: 'other-model' },
      { reasoningEffort: 'low' },
      { providerOptions: { turn: { futureOption: true } } },
      { studioContext: { ...planner().input.studioContext!, instructions: 'other instructions' } },
    ]) {
      const action = {
        ...readAction(),
        kind: 'start-provider' as const,
        intent: { input: { ...planner().input, ...changed } },
      }
      expect(() => parseStudioPlannerRecovery({ ...planner(), action })).toThrow(
        'exact native input',
      )
    }
    const fresh = planner()
    delete fresh.input.remoteId
    const action: Extract<StudioPlannerAction, { kind: 'start-provider' }> = {
      ...readAction(),
      kind: 'start-provider',
      intent: { input: { ...fresh.input } },
    }
    const started = startStudioPlannerAction({ ...fresh, action }, action.id)
    expect(() =>
      parseStudioPlannerRecovery({
        ...started,
        input: { ...started.input, remoteId: 'new-native-id' },
      }),
    ).toThrow()
    const completed = settleStudioPlannerAction(started, action.id, {
      receipt: { native: nativeReceipt(), remoteId: 'new-native-id' },
    })
    expect(
      parseStudioPlannerRecovery({
        ...completed,
        input: { ...completed.input, remoteId: 'new-native-id' },
      }).input.remoteId,
    ).toBe('new-native-id')
    expect(() =>
      parseStudioPlannerRecovery({
        ...completed,
        input: { ...completed.input, remoteId: 'different-native-id' },
      }),
    ).toThrow()
    const owned = { ...planner(), action: { ...action, intent: { input: planner().input } } }
    expect(() =>
      settleStudioPlannerAction(startStudioPlannerAction(owned, action.id), action.id, {
        receipt: { native: nativeReceipt(), remoteId: 'different-native-id' },
      }),
    ).toThrow('exact native input')
  })

  it('requires exact started actions, distinguishes failed receipts, and refuses conflicting completion', () => {
    const value = { ...planner(), action: readAction() }
    expect(() => startStudioPlannerAction(value, 'other')).toThrow('exact intended')
    expect(() =>
      settleStudioPlannerAction(value, 'action:one', {
        receipt: { native: nativeReceipt(), source: source() },
      }),
    ).toThrow('not started')
    const started = startStudioPlannerAction(value, 'action:one')
    expect(() => startStudioPlannerAction(started, 'action:one')).toThrow('exact intended')
    expect(() => settleStudioPlannerAction(started, 'other', { error: 'failed' })).toThrow(
      'another action',
    )
    const failed = settleStudioPlannerAction(started, 'action:one', {
      error: 'Exact compiler failure\r\n',
    })
    expect(step(failed)).toBe('use-receipt')
    expect(failed.action?.error).toBe('Exact compiler failure\r\n')
    expect(failed.action).not.toHaveProperty('receipt')
    expect(
      settleStudioPlannerAction(failed, 'action:one', { error: 'Exact compiler failure\r\n' }),
    ).toBe(failed)
    expect(() =>
      settleStudioPlannerAction(failed, 'action:one', {
        receipt: { native: nativeReceipt(), source: source() },
      }),
    ).toThrow('different durable receipt')
    expect(() =>
      parseStudioPlannerRecovery({ ...value, action: { ...readAction(), status: 'succeeded' } }),
    ).toThrow('receipts')
    expect(() =>
      parseStudioPlannerRecovery({ ...value, action: { ...readAction(), error: 'not failed' } }),
    ).toThrow('failure receipts')
  })

  it('does not evaluate executable action or completion getters at transition boundaries', () => {
    const called = vi.fn()
    const forged = Object.defineProperty(planner(), 'action', { get: called })
    expect(() => startStudioPlannerAction(forged, 'action:one')).toThrow('getters')
    expect(() => settleStudioPlannerAction(forged, 'action:one', { error: 'failure' })).toThrow(
      'getters',
    )
    const started = startStudioPlannerAction({ ...planner(), action: readAction() }, 'action:one')
    const forgedReceipt = Object.defineProperty({}, 'receipt', { get: called })
    expect(() =>
      settleStudioPlannerAction(started, 'action:one', forgedReceipt as { receipt: never }),
    ).toThrow('getters')
    expect(called).not.toHaveBeenCalled()
  })

  it('distinguishes completed responses, existing review and finished planners without reapplying', () => {
    expect(step({ ...planner(), phase: 'completing', finishing: true })).toBe('finish-response')
    expect(step({ ...planner(), phase: 'review', finishing: false, autoApply: false })).toBe(
      'review',
    )
    expect(
      step({ ...planner(), phase: 'finished', finishing: true, terminal: { stage: 'complete' } }),
    ).toBe('finished')
    expect(step({ ...planner(), phase: 'finished', finishing: true })).toBe('reconcile-action')
    const restoredIdle = restoreStudioPlannerRecovery({ ...owner(), status: 'idle' }, binding())!
    expect(getStudioPlannerRecoveryStep(restoredIdle)).toBe('reconcile-action')
  })
})

describe('authoritative native Studio action results', () => {
  const readBound = () =>
    restoreStudioPlannerRecovery(
      owner({ ...planner(), phase: 'reading', action: readAction() }),
      binding(),
    )!
  const result = (): StudioPlannerNativeActionResult => ({
    status: 'succeeded',
    native: nativeReceipt(),
    receipt: { native: nativeReceipt(), source: source() },
  })

  it('reconciles a receipt committed before renderer acknowledgment without repeating the action', () => {
    const restored = readBound()
    const settled = acceptStudioPlannerActionResult(restored, result())
    expect(settled.action?.status).toBe('succeeded')
    expect(settled.action?.receipt).toEqual(result().receipt)
    const advanced = advanceStudioPlannerActionReceipt(settled)
    expect(advanced.source).toEqual(source())
    expect(advanced.phase).toBe('preparing')
    expect(advanced.continuation).toEqual({ sourceRead: { paths: ['src/renderer/App.tsx'] } })
    expect(advanced.action?.id).toBe('action:one')
    expect(advanced.action?.receipt).toEqual(result().receipt)
    expect(advanced.reads).toBe(3)
    expect(advanced.nativeIteration).toBe(4)
    expect(restored.planner.action?.status).toBe('intended')
  })

  it('recovers a committed read if Life closes before the next native continuation is admitted', () => {
    const settled = acceptStudioPlannerActionResult(readBound(), result())
    const preparing = advanceStudioPlannerActionReceipt(settled)
    const persisted = readStudioPlannerRecovery(encodeStudioPlannerRecovery(preparing))!
    const recovered = restoreStudioPlannerRecovery(
      { ...owner(persisted), status: 'idle' },
      binding(),
    )!
    expect(getStudioPlannerRecoveryStep(recovered)).toBe('use-receipt')
    expect(recovered.planner.action?.receipt).toEqual(result().receipt)
    expect(recovered.planner.source).toEqual(source())
    expect(recovered.planner.request).toBe(planner().request)
    expect(recovered.planner.reads).toBe(3)
    expect(recovered.planner.nativeIteration).toBe(4)
    const admittedNext = {
      ...preparing,
      phase: 'planning' as const,
      finishing: false,
      nativeIteration: preparing.nativeIteration + 1,
      parts: [],
      action: undefined,
    }
    expect(
      getStudioPlannerRecoveryStep(restoreStudioPlannerRecovery(owner(admittedNext), binding())!),
    ).toBe('await-output')
    expect(admittedNext.request).toBe(persisted.request)
    expect(admittedNext.reads).toBe(persisted.reads)
  })

  it('retains uncertain admission as started and never downgrades it to an executable intent', () => {
    const restored = readBound()
    const uncertain = acceptStudioPlannerActionResult(restored, {
      status: 'unknown',
      native: nativeReceipt(),
      error: 'Owner unavailable',
    })
    expect(uncertain.action?.status).toBe('started')
    const next = restoreStudioPlannerRecovery(owner(uncertain), binding())!
    expect(getStudioPlannerRecoveryStep(next)).toBe('reconcile-action')
    expect(
      acceptStudioPlannerActionResult(next, { status: 'intended', native: nativeReceipt() }).action
        ?.status,
    ).toBe('started')
    expect(() => advanceStudioPlannerActionReceipt(uncertain)).toThrow('no successful')
    const failed = acceptStudioPlannerActionResult(restored, {
      status: 'failed',
      native: nativeReceipt(),
      error: 'Exact recorded read failure\r\n',
    })
    expect(failed.action?.error).toBe('Exact recorded read failure\r\n')
    expect(advanceStudioPlannerActionReceipt(failed).action).toEqual(failed.action)
  })

  it('rejects mismatched native identity, receipts, copied authority and executable response getters', () => {
    const restored = readBound()
    for (const changed of [
      { ...result(), native: nativeReceipt('other') },
      { ...result(), native: { ...nativeReceipt(), transportId: 'other' } },
      { ...result(), native: { ...nativeReceipt(), ownerGeneration: 1 } },
      {
        ...result(),
        receipt: { native: { ...nativeReceipt(), ownerGeneration: 1 }, source: source() },
      },
      { ...result(), receipt: undefined },
      { ...result(), error: 'not failed' },
      { status: 'failed', native: nativeReceipt() },
      { status: 'unknown', native: nativeReceipt(), receipt: result().receipt },
    ])
      expect(() =>
        acceptStudioPlannerActionResult(restored, changed as StudioPlannerNativeActionResult),
      ).toThrow()
    expect(() => acceptStudioPlannerActionResult({ ...restored }, result())).toThrow('ownership')
    const called = vi.fn()
    const executable = Object.defineProperty(result(), 'receipt', { get: called })
    expect(() => acceptStudioPlannerActionResult(restored, executable)).toThrow('getters')
    expect(called).not.toHaveBeenCalled()
  })

  it('preserves prior repair source while keeping the newly read index for a durable file selection', () => {
    const value: StudioPlannerRecovery = {
      ...planner(),
      phase: 'repairing',
      continuation: { repair: { attempt: 1, diagnostics: 'Exact compiler error' } },
      action: { ...readAction(), intent: { purpose: 'repair-index' } },
    }
    const index = {
      ...source(),
      files: [{ path: 'src/shared/types.ts', content: 'new index context' }],
    }
    const restored = restoreStudioPlannerRecovery(owner(value), binding())!
    const settled = acceptStudioPlannerActionResult(restored, {
      ...result(),
      receipt: { native: nativeReceipt(), source: index },
    })
    const advanced = advanceStudioPlannerActionReceipt(settled)
    expect(advanced.source).toEqual(value.source)
    expect(advanced.action?.receipt).toEqual({ native: nativeReceipt(), source: index })
    expect(advanced.repairs).toBe(1)
    expect(advanced.continuation).toEqual(value.continuation)
  })

  it('preserves already streamed parts when a provider-start receipt arrives later', () => {
    const value: StudioPlannerRecovery = {
      ...planner(),
      action: { ...readAction(), kind: 'start-provider', intent: { input: planner().input } },
    }
    const restored = restoreStudioPlannerRecovery(owner(value), binding())!
    const settled = acceptStudioPlannerActionResult(restored, {
      ...result(),
      receipt: { native: nativeReceipt(), remoteId: 'native-conversation' },
    })
    const advanced = advanceStudioPlannerActionReceipt(settled)
    expect(advanced.parts).toEqual(value.parts)
    expect(advanced.phase).toBe('planning')
    expect(advanced.finishing).toBe(false)
    expect(advanced.action).toBeUndefined()
  })

  it('retains proven source apply snapshots for exact reload correlation and finishes other applied actions', () => {
    const value = { ...planner(), phase: 'applying' as const, action: applyAction() }
    const restored = restoreStudioPlannerRecovery(owner(value), binding())!
    const settled = acceptStudioPlannerActionResult(restored, {
      ...result(),
      receipt: { native: nativeReceipt(), snapshot: appliedSnapshot() },
    })
    const advanced = advanceStudioPlannerActionReceipt(settled)
    expect(advanced.phase).toBe('reloading')
    expect(advanced.action?.id).toBe('action:one')
    expect(advanced.action?.receipt).toEqual(settled.action?.receipt)
    for (const action of [
      {
        ...readAction(),
        kind: 'apply-settings' as const,
        intent: { patch: { theme: 'light' as const } },
      },
      {
        ...readAction(),
        kind: 'reload-source' as const,
        intent: { appliedActionId: 'source-apply-action', revision: 8 },
      },
    ]) {
      const bound = restoreStudioPlannerRecovery(owner({ ...planner(), action }), binding())!
      const complete = advanceStudioPlannerActionReceipt(
        acceptStudioPlannerActionResult(bound, {
          ...result(),
          receipt: { native: nativeReceipt() },
        }),
      )
      expect(complete.phase).toBe('finished')
      expect(complete.action).toBeUndefined()
    }
  })

  it('rejects claimed source success with failed, disabled or unrelated build generations', () => {
    const bound = restoreStudioPlannerRecovery(
      owner({ ...planner(), action: applyAction() }),
      binding(),
    )!
    for (const snapshot of [
      { ...appliedSnapshot(), error: 'compile failed' },
      { ...appliedSnapshot(), enabled: false },
      { ...appliedSnapshot(), active: undefined },
      { ...appliedSnapshot(), active: { revision: 7, js: 'life-source://7/main.js' } },
      source().snapshot,
    ])
      expect(() =>
        acceptStudioPlannerActionResult(bound, {
          ...result(),
          receipt: { native: nativeReceipt(), snapshot },
        }),
      ).toThrow('activated committed generation')
  })

  it('reconciles unresolved actions even if a terminal phase was saved', () => {
    const value = {
      ...planner(),
      phase: 'finished' as const,
      action: { ...applyAction(), status: 'started' as const },
    }
    const recovered = restoreStudioPlannerRecovery(owner(value), binding())!
    expect(getStudioPlannerRecoveryStep(recovered)).toBe('reconcile-action')
  })

  it('retains an exact native-owned original user message if the renderer history write lagged', () => {
    const value = {
      ...planner(),
      input: { ...planner().input, localTurn: 3 },
      userMessage: {
        id: 'original-user-message',
        role: 'user' as const,
        text: planner().request,
        turn: 3,
        createdAt: 42,
      },
    }
    const restored = restoreStudioPlannerRecovery(
      owner(readStudioPlannerRecovery(encodeStudioPlannerRecovery(value))!),
      binding(),
    )!
    expect(restored.planner.userMessage).toEqual(value.userMessage)
    expect(restored.planner.userMessage?.text).toBe(value.request)
    for (const userMessage of [
      { ...value.userMessage, text: 'altered user request' },
      { ...value.userMessage, turn: 4 },
      { ...value.userMessage, role: 'assistant' },
    ])
      expect(() => parseStudioPlannerRecovery({ ...value, userMessage })).toThrow()
    expect(() => parseStudioPlannerRecovery({ ...value, input: planner().input })).toThrow(
      'local turn',
    )
  })

  it('preserves an owned first-session seed and imported metadata while the browser history lags', () => {
    const metadata = JSON.parse(
      '{"futureNative":{"sessionTreeId":"tree-one","opaque":[null,{"toJSON":"data","constructor":42,"__proto__":{"autoApply":true}}]},"autoApply":true,"nativeRecoveryStatus":"running"}',
    )
    const value: StudioPlannerRecovery = {
      ...planner(),
      input: { ...planner().input, localTurn: 1 },
      userMessage: {
        id: 'first-user-message',
        role: 'user',
        text: planner().request,
        turn: 1,
        createdAt: 12,
      },
      sessionSeed: {
        id: planner().sessionId,
        createdAt: 10,
        updatedAt: 12,
        thread: {
          id: planner().sessionId,
          profileId: planner().profileId,
          provider: planner().provider,
          title: 'Exact imported Studio title',
          model: 'gpt-example',
          mode: 'plan',
          purpose: 'customization',
          updatedAt: 12,
          turn: 0,
          messages: [],
          busy: false,
          pending: [],
          metadata,
        },
      },
    }
    const restored = restoreStudioPlannerRecovery(
      owner(readStudioPlannerRecovery(encodeStudioPlannerRecovery(value))!),
      binding(),
    )!
    expect(restored.planner.sessionSeed).toEqual(value.sessionSeed)
    expect(restored.planner.userMessage).toEqual(value.userMessage)
    expect(restored.planner.sessionSeed?.thread.metadata).toEqual(metadata)
    expect(restored.planner.sessionSeed?.thread).not.toHaveProperty('autoApply')
    expect(restored.planner.sessionSeed?.thread).not.toHaveProperty('nativeRecoveryStatus')
    expect((Object.prototype as { autoApply?: unknown }).autoApply).toBeUndefined()
    expect(getStudioPlannerRecoveryStep(restored)).toBe('await-output')
    for (const patch of [
      { id: 'other-session' },
      { profileId: 'other-machine' },
      { provider: 'claude' },
      { purpose: 'research' },
      { mode: 'default' },
      { busy: true },
      { turn: 2 },
      { messages: [value.userMessage] },
      { pending: [{ id: 'archival-approval' }] },
      { remoteId: 'other-native-thread' },
      { extraNativeAuthority: true },
    ])
      expect(() =>
        parseStudioPlannerRecovery({
          ...value,
          sessionSeed: { ...value.sessionSeed, thread: { ...value.sessionSeed!.thread, ...patch } },
        }),
      ).toThrow()
    expect(() => parseStudioPlannerRecovery({ ...value, userMessage: undefined })).toThrow(
      'original user turn',
    )
    expect(() =>
      parseStudioPlannerRecovery({
        ...value,
        sessionSeed: { ...value.sessionSeed, id: 'other-session' },
      }),
    ).toThrow('original user turn')
  })

  it('refuses executable seed metadata despite preserving opaque plain JSON keys', () => {
    const called = vi.fn()
    const metadata = Object.defineProperty({}, 'toJSON', { get: called })
    const seed = {
      id: planner().sessionId,
      createdAt: 1,
      updatedAt: 1,
      thread: {
        id: planner().sessionId,
        profileId: planner().profileId,
        provider: planner().provider,
        title: '',
        model: '',
        mode: 'plan',
        purpose: 'customization',
        updatedAt: 1,
        turn: 0,
        messages: [],
        busy: false,
        pending: [],
        metadata,
      },
    }
    const value = {
      ...planner(),
      input: { ...planner().input, localTurn: 1 },
      userMessage: { id: 'user:one', role: 'user', text: planner().request, turn: 1, createdAt: 1 },
      sessionSeed: seed,
    }
    expect(() => parseStudioPlannerRecovery(value)).toThrow('getters')
    expect(() =>
      parseStudioPlannerRecovery({
        ...value,
        sessionSeed: { ...seed, thread: { ...seed.thread, metadata: { toJSON: called } } },
      }),
    ).toThrow('JSON data')
    expect(called).not.toHaveBeenCalled()
    const reserved = JSON.parse('{"constructor":42,"__proto__":{"forged":true},"toJSON":"data"}')
    const lookalike = {
      ...planner(),
      input: {
        ...planner().input,
        providerOptions: {
          turn: { futureOption: { sessionSeed: { thread: { metadata: reserved } } } },
        },
      },
    }
    expect(() => parseStudioPlannerRecovery(lookalike)).toThrow('unsupported property')
    expect(restoreStudioPlannerRecovery(owner(lookalike), binding())).toBeUndefined()
  })

  it('preserves failed/interrupted/discarded terminal outcomes and refuses to invent old completion', () => {
    for (const terminal of [
      { stage: 'failed' as const, error: 'Exact provider failure\r\n\ud800' },
      { stage: 'interrupted' as const },
      { stage: 'complete' as const, discarded: true as const },
    ]) {
      const value = { ...planner(), phase: 'finished' as const, finishing: true, terminal }
      const restored = restoreStudioPlannerRecovery(
        owner(readStudioPlannerRecovery(encodeStudioPlannerRecovery(value))!),
        binding(),
      )!
      expect(restored.planner.terminal).toEqual(terminal)
      expect(getStudioPlannerRecoveryStep(restored)).toBe('finished')
    }
    expect(() =>
      parseStudioPlannerRecovery({ ...planner(), terminal: { stage: 'complete' } }),
    ).toThrow('terminal outcome')
    expect(() =>
      parseStudioPlannerRecovery({
        ...planner(),
        phase: 'finished',
        terminal: { stage: 'failed', discarded: false },
      }),
    ).toThrow()
    const old = restoreStudioPlannerRecovery(owner({ ...planner(), phase: 'finished' }), binding())!
    expect(getStudioPlannerRecoveryStep(old)).toBe('reconcile-action')
  })

  it.each([
    {
      terminal: { stage: 'complete' as const },
      action: {
        ...readAction(),
        kind: 'apply-settings' as const,
        status: 'succeeded' as const,
        intent: { patch: { theme: 'light' as const } },
        receipt: { native: nativeReceipt() },
      },
    },
    {
      terminal: { stage: 'failed' as const, error: 'Exact compilation failure\r\n\ud800' },
      action: {
        ...applyAction(),
        status: 'failed' as const,
        error: 'Exact compilation failure\r\n\ud800',
      },
    },
    {
      terminal: { stage: 'interrupted' as const },
      action: {
        ...readAction(),
        status: 'succeeded' as const,
        receipt: { native: nativeReceipt(), source: source() },
      },
    },
  ])(
    'keeps a recorded terminal outcome ahead of settled receipts: $terminal.stage',
    ({ terminal, action }) => {
      const value = { ...planner(), phase: 'finished' as const, finishing: true, terminal, action }
      const stored = readStudioPlannerRecovery(encodeStudioPlannerRecovery(value))!
      const restored = restoreStudioPlannerRecovery(owner(stored), binding())!
      expect(getStudioPlannerRecoveryStep(restored)).toBe('finished')
      expect(restored.planner.terminal).toEqual(terminal)
      expect(restored.planner.action).toEqual(action)
    },
  )

  it('reconciles unresolved terminal actions without starting an interrupted intended read', () => {
    for (const status of ['intended', 'started'] as const) {
      const value = {
        ...planner(),
        phase: 'finished' as const,
        finishing: true,
        terminal: { stage: 'interrupted' as const },
        action: { ...readAction(), status },
      }
      expect(
        getStudioPlannerRecoveryStep(restoreStudioPlannerRecovery(owner(value), binding())!),
      ).toBe('reconcile-action')
    }
  })

  it('preserves the original terminal error identity and timestamp across repeated cold recovery', () => {
    const terminal = {
      stage: 'failed' as const,
      error: 'Exact original error\r\n\ud800',
      finishedAt: 1_777_777_777_777,
      errorMessageId: `studio:${'original-user-message-'.repeat(20)}:4:error`,
    }
    expect(terminal.errorMessageId.length).toBeGreaterThan(200)
    let stored = encodeStudioPlannerRecovery({
      ...planner(),
      phase: 'finished',
      finishing: true,
      terminal,
    })
    for (let reopen = 0; reopen < 3; reopen++) {
      const restored = restoreStudioPlannerRecovery(
        owner(readStudioPlannerRecovery(stored)!),
        binding(),
      )!
      expect(getStudioPlannerRecoveryStep(restored)).toBe('finished')
      expect(restored.planner.terminal).toEqual(terminal)
      stored = encodeStudioPlannerRecovery(restored.planner)
    }
  })

  it('rejects invalid terminal timing and error identity without inventing a replacement', () => {
    const value = {
      ...planner(),
      phase: 'finished' as const,
      terminal: { stage: 'failed' as const, error: 'exact failure' },
    }
    for (const finishedAt of [-1, 0.5, '123', null, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
      expect(() =>
        parseStudioPlannerRecovery({ ...value, terminal: { ...value.terminal, finishedAt } }),
      ).toThrow()
    for (const errorMessageId of ['', 'x'.repeat(1001), 'wrong\nid', 'wrong\u007fid', null])
      expect(() =>
        parseStudioPlannerRecovery({ ...value, terminal: { ...value.terminal, errorMessageId } }),
      ).toThrow()
    expect(() =>
      parseStudioPlannerRecovery({
        ...value,
        terminal: { stage: 'failed', errorMessageId: 'error:one' },
      }),
    ).toThrow('requires its exact error')
    expect(
      parseStudioPlannerRecovery({
        ...value,
        terminal: { ...value.terminal, finishedAt: 0, errorMessageId: 'error:one' },
      }).terminal,
    ).toEqual({ ...value.terminal, finishedAt: 0, errorMessageId: 'error:one' })
    expect(parseStudioPlannerRecovery(value).terminal).toEqual(value.terminal)
  })

  it('retains the exact prepared cache proof before a Studio storage write and later native acknowledgment', () => {
    const preparedCache = {
      snapshotId: 'cache-snapshot:one',
      hash: 'ab'.repeat(32),
      throughEventRevision: 41,
      transportId: 'transport:one',
      snapshotToken: 'original-native-cache-token',
      ownerGeneration: 2,
    }
    const value = { ...planner(), preparedCache }
    const serialized = encodeStudioPlannerRecovery(value)
    const copied = readStudioPlannerRecovery(serialized)!
    expect(copied.preparedCache).toEqual(preparedCache)
    const restored = restoreStudioPlannerRecovery(owner(copied), binding())!
    expect(restored.planner.preparedCache).toEqual(preparedCache)
    expect(Object.isFrozen(restored.planner.preparedCache)).toBe(true)
    expect(() => {
      restored.planner.preparedCache!.hash = 'cd'.repeat(32)
    }).toThrow()
    expect(() => {
      restored.planner.preparedCache!.ownerGeneration = 3
    }).toThrow()
    preparedCache.hash = 'ef'.repeat(32)
    expect(restored.planner.preparedCache!.hash).toBe('ab'.repeat(32))
    expect(encodeStudioPlannerRecovery(restored.planner)).toBe(serialized)
    expect(
      parseStudioPlannerRecovery({
        ...value,
        preparedCache: { ...preparedCache, throughEventRevision: 0, ownerGeneration: 0 },
      }).preparedCache,
    ).toMatchObject({ throughEventRevision: 0, ownerGeneration: 0 })
  })

  it('refuses malformed prepared cache hashes and unsafe or inexact ownership tuples', () => {
    const preparedCache = {
      snapshotId: 'cache-snapshot:one',
      hash: 'ab'.repeat(32),
      throughEventRevision: 41,
      transportId: 'transport:one',
      snapshotToken: 'native-token',
      ownerGeneration: 2,
    }
    for (const patch of [
      ...[
        '',
        'AB'.repeat(32),
        'a'.repeat(63),
        'a'.repeat(65),
        'g'.repeat(64),
        `${'a'.repeat(63)} `,
        null,
      ].map((hash) => ({ hash })),
      ...[-1, 1.5, '41', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (throughEventRevision) => ({ throughEventRevision }),
      ),
      ...[-1, 1.5, '2', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (ownerGeneration) => ({ ownerGeneration }),
      ),
      { snapshotId: '' },
      { snapshotId: 'wrong\nid' },
      { snapshotId: null },
      { snapshotToken: '' },
      { snapshotToken: 'wrong\u007ftoken' },
      { snapshotToken: null },
      { transportId: '' },
      { transportId: 'wrong\ntransport' },
      { transportId: null },
      { extraScope: 'unowned' },
    ])
      expect(() =>
        parseStudioPlannerRecovery({ ...planner(), preparedCache: { ...preparedCache, ...patch } }),
      ).toThrow()
    const called = vi.fn()
    const getter = Object.defineProperty({ ...preparedCache }, 'hash', { get: called })
    expect(() => parseStudioPlannerRecovery({ ...planner(), preparedCache: getter })).toThrow(
      'getters',
    )
    expect(() =>
      parseStudioPlannerRecovery({
        ...planner(),
        preparedCache: { ...preparedCache, toJSON: called },
      }),
    ).toThrow()
    expect(called).not.toHaveBeenCalled()
    expect(parseStudioPlannerRecovery(planner()).preparedCache).toBeUndefined()
  })
})
