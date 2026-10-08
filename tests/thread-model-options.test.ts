import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelChoices, readThreads, type Thread } from '../src/renderer/state'
import { fallbackModelCatalog, withProviderDefault } from '../src/renderer/model-catalog'
import type { ModelOption } from '../src/shared/types'

const savedThread: Thread = {
  id: 'thread',
  profileId: 'machine',
  workspace: '/srv/research',
  provider: 'codex',
  title: 'Research project',
  remoteId: 'conversation',
  messages: [],
  busy: false,
  model: 'research-model',
  mode: 'review',
  updatedAt: 1,
  turn: 0,
  pending: [],
  lifeScope: true,
}

const supportedModel: ModelOption = {
  id: 'research-model',
  name: 'Research model',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  serviceTiers: [{ id: 'fast', name: 'Fast' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('saved thread model choices', () => {
  it('restores legacy threads without inventing explicit reasoning or service choices', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([savedThread]) })
    const restored = readThreads()[0]
    expect(restored.reasoningEffort ?? '').toBe('')
    expect(restored.serviceTier ?? '').toBe('')
    expect(restored.workspace).toBe('/srv/research')
    expect(restored.lifeScope).toBe(true)
    expect(restored.remoteId).toBe('conversation')
  })

  it('restores valid choices and keeps the unresolved legacy project guard', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify([
          {
            ...savedThread,
            workspace: undefined,
            workspaceUnknown: true,
            reasoningEffort: 'high',
            serviceTier: 'fast',
          },
        ]),
    })
    const restored = readThreads()[0]
    expect(restored.reasoningEffort).toBe('high')
    expect(restored.serviceTier).toBe('fast')
    expect(restored.workspaceUnknown).toBe(true)
    expect(restored.workspace).toBeUndefined()
  })

  it.each([
    ['control character', 'high\n', 'fa\x00st'],
    ['overlong value', 'x'.repeat(101), 'x'.repeat(101)],
    ['non-string value', 42, { id: 'fast' }],
    ['delete and C1 control characters', 'high\x7f', 'fast\x85'],
  ])(
    'falls back to provider defaults for persisted %s choices',
    (_, reasoningEffort, serviceTier) => {
      vi.stubGlobal('localStorage', {
        getItem: () => JSON.stringify([{ ...savedThread, reasoningEffort, serviceTier }]),
      })
      expect(readThreads()[0]).toMatchObject({ reasoningEffort: '', serviceTier: '' })
    },
  )
})

describe('model capability changes', () => {
  it('retains choices supported by the selected model', () => {
    expect(
      normalizeModelChoices(supportedModel, { reasoningEffort: 'high', serviceTier: 'fast' }),
    ).toEqual({ reasoningEffort: 'high', serviceTier: 'fast' })
  })

  it('clears unsupported choices on model changes without selecting an offered paid tier', () => {
    expect(
      normalizeModelChoices(supportedModel, { reasoningEffort: 'xhigh', serviceTier: 'priority' }),
    ).toEqual({ reasoningEffort: '', serviceTier: '' })
  })

  it('preserves the provider default even when capability lists have options', () => {
    expect(normalizeModelChoices(supportedModel, {})).toEqual({
      reasoningEffort: '',
      serviceTier: '',
    })
  })

  it('clears explicit choices when the model explicitly supports no options', () => {
    expect(
      normalizeModelChoices(
        { id: 'plain-model', name: 'Plain model', supportedReasoningEfforts: [], serviceTiers: [] },
        { reasoningEffort: 'high', serviceTier: 'fast' },
      ),
    ).toEqual({ reasoningEffort: '', serviceTier: '' })
  })

  it('retains known choices while the model catalog or capability metadata is unavailable', () => {
    const choices = { reasoningEffort: 'high', serviceTier: 'fast' }
    expect(normalizeModelChoices(undefined, choices)).toEqual(choices)
    expect(normalizeModelChoices({ id: 'loading-model', name: 'Loading model' }, choices)).toEqual(
      choices,
    )
    expect(
      normalizeModelChoices(
        { id: 'partial-model', name: 'Partial model', supportedReasoningEfforts: [] },
        choices,
      ),
    ).toEqual({ reasoningEffort: '', serviceTier: 'fast' })
  })

  it('never preserves malformed choices while capability metadata is still loading', () => {
    expect(
      normalizeModelChoices(undefined, { reasoningEffort: 'high\n', serviceTier: 'x'.repeat(101) }),
    ).toEqual({ reasoningEffort: '', serviceTier: '' })
  })
})

describe('provider default model metadata', () => {
  it('copies capabilities and advertised defaults from the actual provider default', () => {
    const advertisedDefault: ModelOption = {
      ...supportedModel,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      defaultServiceTier: 'standard',
    }
    const catalog = withProviderDefault('codex', [advertisedDefault])
    expect(catalog.find((model) => model.id === '')).toMatchObject({
      supportedReasoningEfforts: advertisedDefault.supportedReasoningEfforts,
      defaultReasoningEffort: 'medium',
      serviceTiers: advertisedDefault.serviceTiers,
      defaultServiceTier: 'standard',
    })
    expect(catalog.find((model) => model.id === advertisedDefault.id)).toEqual(advertisedDefault)
  })

  it('retains supplied empty-id default metadata without borrowing from another model', () => {
    const providerDefault: ModelOption = {
      id: '',
      name: 'Provider default',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      defaultReasoningEffort: 'low',
      serviceTiers: [],
    }
    const catalog = withProviderDefault('claude', [
      providerDefault,
      { ...supportedModel, isDefault: true, defaultServiceTier: 'fast' },
    ])
    const defaults = catalog.filter((model) => model.id === '')
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toMatchObject(providerDefault)
    expect(defaults[0].defaultServiceTier).toBeUndefined()
  })

  it('does not infer default capabilities from an available nondefault model', () => {
    const providerDefault = withProviderDefault('codex', [supportedModel]).find(
      (model) => model.id === '',
    )
    expect(providerDefault).toBeDefined()
    expect(providerDefault?.supportedReasoningEfforts).toBeUndefined()
    expect(providerDefault?.defaultReasoningEffort).toBeUndefined()
    expect(providerDefault?.serviceTiers).toBeUndefined()
    expect(providerDefault?.defaultServiceTier).toBeUndefined()
  })

  it.each(['codex', 'claude'] as const)(
    'keeps the %s fallback provider default without invented reasoning or Fast capabilities',
    (provider) => {
      const catalog = fallbackModelCatalog(provider)
      const defaults = catalog.filter((model) => model.id === '')
      expect(defaults).toHaveLength(1)
      for (const model of catalog) {
        expect(model.supportedReasoningEfforts).toBeUndefined()
        expect(model.defaultReasoningEffort).toBeUndefined()
        expect(model.serviceTiers).toBeUndefined()
        expect(model.defaultServiceTier).toBeUndefined()
      }
      expect(normalizeModelChoices(defaults[0], {})).toEqual({
        reasoningEffort: '',
        serviceTier: '',
      })
    },
  )
})
