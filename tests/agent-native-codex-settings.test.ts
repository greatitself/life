import { describe, expect, it, vi } from 'vitest'
import {
  applyNativeCodexSettings,
  type NativeCodexSettingsDetails,
  type NativeCodexSettingsSession,
} from '../src/main/agent-native-codex-settings'

type Wire = Record<string, unknown>

function session(): NativeCodexSettingsSession {
  return {
    input: { model: 'old-model', reasoningEffort: 'low', serviceTier: 'default', mode: 'review' },
    appliedModel: 'old-native-model',
    appliedReasoningEffort: 'low',
  }
}

function apply(
  target: NativeCodexSettingsSession,
  method: string,
  details: NativeCodexSettingsDetails,
  result: Wire = {},
  success = true,
) {
  return applyNativeCodexSettings({ session: target, method, details, result, success })
}

describe('native Codex settings acknowledgments', () => {
  it('records exact choices after the thread ACK without claiming current-turn publication', () => {
    const target = session()
    const choices = {
      model: 'new-model',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      mode: 'edit',
    }
    const result = apply(target, 'thread/settings/update', { requestedSettings: choices })
    expect(target.input).toEqual(choices)
    expect(target.appliedModel).toBe('old-native-model')
    expect(target.appliedReasoningEffort).toBe('low')
    expect(result).toEqual({
      settingsEvent: {
        type: 'settings',
        status: 'next-request',
        details: { ...choices, applied: 'next-request' },
      },
    })
  })

  it.each([
    'review',
    'edit',
    'plan',
    'ask-for-approval',
    'read-only',
    'full-access',
    'auto-review',
  ])('preserves exact legacy/current mode %s and explicitly empty defaults', (mode) => {
    const target = session()
    const choices = { model: '', reasoningEffort: '', serviceTier: '', mode }
    apply(target, 'thread/settings/update', { requestedSettings: choices })
    expect(target.input).toEqual(choices)
  })

  it('keeps exact model text and own field presence instead of filling absent settings', () => {
    const target = session()
    const result = apply(target, 'thread/settings/update', {
      requestedSettings: { model: '  model\r\n雪\ud800 ', futureField: { ignored: true } },
    })
    expect(target.input).toEqual({ ...session().input, model: '  model\r\n雪\ud800 ' })
    expect(result.settingsEvent?.details).toEqual({
      model: '  model\r\n雪\ud800 ',
      applied: 'next-request',
    })
  })

  it('does not overwrite native ownership, exact prompts or unrelated input data', () => {
    const input = {
      ...session().input,
      sessionId: 'owned-local',
      provider: 'codex' as const,
      remoteId: 'native-thread',
      prompt: '  unchanged prompt\r\n雪\ud800 ',
      workspace: '/project/original',
      attachments: [{ remotePath: '/project/file', name: 'file', mimeType: 'text/plain' }],
    }
    const target = { ...session(), input }
    const controls = {
      requestedSettings: {
        model: 'new-model',
        sessionId: 'wrong-local',
        remoteId: 'wrong-native',
        provider: 'claude',
        prompt: 'replacement',
        workspace: '/wrong',
      },
      nativeSettings: { model: 'resolved-native', future: [null, { opaque: '雪\ud800' }] },
    }
    const bytes = JSON.stringify(controls)
    apply(target, 'thread/settings/update', controls)
    expect(target.input).toEqual({ ...input, model: 'new-model' })
    expect(target.input.attachments).toBe(input.attachments)
    expect(JSON.stringify(controls)).toBe(bytes)
  })

  it('restores resolved native publication fields while retaining exact requested default choices', () => {
    const target = session()
    const details = {
      requestedSettings: { model: '', reasoningEffort: '', serviceTier: '' },
      nativeSettings: { model: 'advertised-default-model', effort: 'medium', serviceTier: null },
    }
    apply(target, 'thread/settings/update', details)
    const published = apply(target, 'turn/settings/update', details, { status: 'applied' })
    expect(target.input).toEqual({
      ...session().input,
      model: '',
      reasoningEffort: '',
      serviceTier: '',
    })
    expect(target.appliedModel).toBe('advertised-default-model')
    expect(target.appliedReasoningEffort).toBe('medium')
    expect(published.settingsEvent).toEqual({
      type: 'settings',
      status: 'live',
      details: { model: '', reasoningEffort: '', serviceTier: '', applied: 'live' },
    })
  })

  it('leaves sandbox choices at the next request while publishing supported model/effort changes', () => {
    const target = session()
    const details = {
      requestedSettings: { model: 'new-model', reasoningEffort: 'high', mode: 'full-access' },
      nativeSettings: { model: 'resolved-model', effort: 'high', approvalsReviewer: 'user' },
      permissionBoundaryChanged: true,
    }
    apply(target, 'thread/settings/update', details)
    const published = apply(target, 'turn/settings/update', details, { status: 'applied' })
    expect(target.input.mode).toBe('full-access')
    expect(target.appliedModel).toBe('resolved-model')
    expect(target.appliedReasoningEffort).toBe('high')
    expect(published.settingsEvent?.status).toBe('next-request')
    expect(published.settingsEvent?.details).toEqual({
      ...details.requestedSettings,
      applied: 'next-request',
    })
  })

  it('does not invent an applied model or effort from requested choices alone', () => {
    const target = session()
    apply(
      target,
      'turn/settings/update',
      {
        requestedSettings: { model: '', reasoningEffort: '' },
      },
      { status: 'applied' },
    )
    expect(target.input).toEqual(session().input)
    expect(target.appliedModel).toBe('old-native-model')
    expect(target.appliedReasoningEffort).toBe('low')
  })

  it('only updates publication fields included in this acknowledged choice set', () => {
    const target = session()
    apply(
      target,
      'turn/settings/update',
      {
        requestedSettings: { reasoningEffort: 'high' },
        nativeSettings: { model: 'unrelated-model', effort: 'high' },
      },
      { status: 'applied' },
    )
    expect(target.appliedModel).toBe('old-native-model')
    expect(target.appliedReasoningEffort).toBe('high')
  })

  it('does not roll back newer thread preferences when an older turn publication ACK arrives late', () => {
    const target = session()
    const original = {
      requestedSettings: {
        model: 'model-A',
        reasoningEffort: 'high',
        serviceTier: 'fast',
        mode: 'edit',
      },
      nativeSettings: { model: 'resolved-A', effort: 'high', serviceTier: 'fast' },
    }
    const newer = {
      requestedSettings: {
        model: 'model-B',
        reasoningEffort: 'medium',
        serviceTier: 'default',
        mode: 'plan',
      },
      nativeSettings: { model: 'resolved-B', effort: 'medium', serviceTier: 'default' },
    }
    apply(target, 'thread/settings/update', original)
    apply(target, 'thread/settings/update', newer)
    const publication = apply(target, 'turn/settings/update', original, { status: 'applied' })
    expect(target.input).toEqual(newer.requestedSettings)
    expect(target.appliedModel).toBe('resolved-A')
    expect(target.appliedReasoningEffort).toBe('high')
    expect(publication.settingsEvent?.details).toEqual({
      ...original.requestedSettings,
      applied: 'live',
    })
  })

  it('retains the already saved thread choices when the live task is unavailable', () => {
    const target = session()
    const details = {
      requestedSettings: { model: '', reasoningEffort: '', mode: 'plan' },
      nativeSettings: { model: 'resolved-default', effort: 'medium' },
    }
    apply(target, 'thread/settings/update', details)
    const beforeTurn = structuredClone(target)
    const result = apply(target, 'turn/settings/update', details, { status: 'targetUnavailable' })
    expect(target).toEqual(beforeTurn)
    expect(result).toEqual({
      settingsEvent: {
        type: 'settings',
        status: 'next-request',
        details: { applied: 'next-request' },
      },
    })
  })

  it('does not infer saved preferences from an unavailable turn alone', () => {
    const target = session()
    apply(
      target,
      'turn/settings/update',
      {
        requestedSettings: { model: 'unconfirmed-model', mode: 'full-access' },
        nativeSettings: { model: 'unconfirmed-model' },
      },
      { status: 'targetUnavailable' },
    )
    expect(target).toEqual(session())
  })

  it.each(['thread/settings/update', 'turn/settings/update'])(
    'does not apply failed %s requests',
    (method) => {
      const target = session()
      expect(
        apply(
          target,
          method,
          {
            requestedSettings: { model: '', reasoningEffort: '', serviceTier: '', mode: 'plan' },
            nativeSettings: { model: 'resolved-default', effort: 'high' },
          },
          { status: 'applied' },
          false,
        ),
      ).toEqual({})
      expect(target).toEqual(session())
    },
  )

  it.each([undefined, null, 'unknown', ['applied'], { toString: 'applied' }, false])(
    'does not publish settings for an unrecognized turn status %j',
    (status) => {
      const target = session()
      expect(
        apply(
          target,
          'turn/settings/update',
          {
            requestedSettings: { model: 'new-model' },
            nativeSettings: { model: 'new-model' },
          },
          { status },
        ),
      ).toEqual({})
      expect(target).toEqual(session())
    },
  )

  it.each([
    null,
    [],
    'settings',
    {},
    { future: true },
    { model: undefined },
    { model: null },
    { model: ['new-model'] },
    { reasoningEffort: 1 },
    { serviceTier: true },
    { mode: 'unknown' },
    { mode: 'auto' },
    { mode: 'dontAsk' },
    { model: 'new-model', mode: 1 },
  ])('does not admit malformed/foreign requested settings %j', (requestedSettings) => {
    const target = session()
    expect(apply(target, 'thread/settings/update', { requestedSettings })).toEqual({})
    expect(target).toEqual(session())
  })

  it('does not evaluate known-field getters or use inherited choices as authority', () => {
    const target = session()
    const getter = vi.fn(() => 'unexpected-model')
    const requestedSettings = Object.defineProperty({ mode: 'plan' }, 'model', {
      enumerable: true,
      get: getter,
    })
    expect(apply(target, 'thread/settings/update', { requestedSettings })).toEqual({})
    expect(getter).not.toHaveBeenCalled()
    expect(target).toEqual(session())
    apply(target, 'thread/settings/update', {
      requestedSettings: Object.assign(Object.create({ model: 'inherited-model' }), {
        mode: 'plan',
      }),
    })
    expect(target.input).toEqual({ ...session().input, mode: 'plan' })
  })

  it('does not grant live publication when the captured permission boundary is malformed', () => {
    const target = session()
    expect(
      apply(
        target,
        'turn/settings/update',
        {
          requestedSettings: { mode: 'full-access' },
          permissionBoundaryChanged: 'true',
        } as unknown as NativeCodexSettingsDetails,
        { status: 'applied' },
      ),
    ).toEqual({})
    expect(target).toEqual(session())
  })

  it('keeps local metadata out of unrelated native responses', () => {
    const target = session()
    expect(apply(target, 'thread/start', { requestedSettings: { model: 'new-model' } })).toEqual({})
    expect(target).toEqual(session())
  })

  it('reconstructs identical preferences and events from JSON-persisted original ACK semantics', () => {
    const details = {
      requestedSettings: {
        model: '',
        reasoningEffort: '',
        serviceTier: 'fast',
        mode: 'auto-review',
      },
      nativeSettings: { model: 'native-default', effort: 'high', serviceTier: 'fast' },
      permissionBoundaryChanged: false,
    }
    const fold = (original: NativeCodexSettingsDetails) => {
      const target = session()
      const events = [
        apply(target, 'thread/settings/update', original),
        apply(target, 'turn/settings/update', original, { status: 'applied' }),
      ]
      return { target, events }
    }
    const live = fold(details)
    const replay = fold(JSON.parse(JSON.stringify(details)) as NativeCodexSettingsDetails)
    expect(replay).toEqual(live)
    expect(replay.target.input).toEqual(details.requestedSettings)
    expect(replay.target.appliedModel).toBe('native-default')
    expect(replay.events.map((event) => event.settingsEvent?.status)).toEqual([
      'next-request',
      'live',
    ])
  })
})
