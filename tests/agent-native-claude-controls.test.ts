import { describe, expect, it } from 'vitest'
import {
  applyNativeClaudeControl,
  type NativeClaudeControlDetails,
  type NativeClaudeControlSession,
} from '../src/main/agent-native-claude-controls'

type Wire = Record<string, unknown>

function session(): NativeClaudeControlSession {
  return {
    input: {
      model: 'original-model',
      reasoningEffort: 'low',
      serviceTier: 'default',
      mode: 'review',
    },
    appliedModel: 'original-model',
    appliedReasoningEffort: 'low',
  }
}

function apply(
  target: NativeClaudeControlSession,
  request: Wire,
  payload: Wire = {},
  details?: NativeClaudeControlDetails,
  success = true,
) {
  return applyNativeClaudeControl({ session: target, request, payload, details, success })
}

describe('native Claude control replay', () => {
  it('folds initialization before inherited permission requests and the waiting caller', () => {
    const target = session()
    const observed: unknown[] = []
    const result = apply(
      target,
      { subtype: 'initialize', hooks: null, forwardSubagentText: true },
      {
        session_state: 'requires_action',
        fast_mode_state: 'off',
        fast_mode_disabled_reason: 'sdk_opt_in_required',
        current_permission_mode: 'plan',
        claude_code_version: '2.native',
        account: {
          email: ' researcher@example.test ',
          subscriptionType: 'max',
          authMethod: 'oauth',
          token: 'private-native-field',
        },
        applied: { model: 'actual-model', effort: 'high', futureAppliedField: ['opaque'] },
      },
    )
    if (result.settingsEvent) observed.push(result.settingsEvent)
    // The wire callback forwards pending requests only after the fold and event.
    observed.push({ permission: true, state: target.claudeState, model: target.appliedModel })
    observed.push({ caller: true, optIn: target.claudeFastModeNeedsOptIn })
    expect(observed).toEqual([
      {
        type: 'settings',
        details: {
          fastModeState: 'off',
          fastModeDisabledReason: 'sdk_opt_in_required',
          currentPermissionMode: 'plan',
        },
      },
      { permission: true, state: 'requires_action', model: 'actual-model' },
      { caller: true, optIn: true },
    ])
    expect(target).toMatchObject({
      claudeAccount: { email: 'researcher@example.test', authMethod: 'oauth' },
      claudeSubscriptionType: 'max',
      claudeCodeVersion: '2.native',
      claudeStateAware: true,
      appliedReasoningEffort: 'high',
    })
    expect(JSON.stringify(result)).not.toContain('private-native-field')
    expect(target.input).toEqual(session().input)
  })

  it('leaves opaque native payloads and exact request values unchanged', () => {
    const target = session()
    const request = {
      subtype: 'apply_flag_settings',
      settings: { effortLevel: 'high', fastMode: true, futureFlag: { nested: [null, '\r\n'] } },
      futureRequest: ['opaque'],
    }
    const payload = {
      applied: { model: 'native-resolved', effort: 'high' },
      futureResult: { unknown: [null, 42, '雪\ud800'] },
    }
    const requestJson = JSON.stringify(request)
    const payloadJson = JSON.stringify(payload)
    apply(target, request, payload)
    expect(JSON.stringify(request)).toBe(requestJson)
    expect(JSON.stringify(payload)).toBe(payloadJson)
    expect(target.input).toMatchObject({ reasoningEffort: 'high', serviceTier: 'fast' })
    expect(target.appliedModel).toBe('native-resolved')
  })

  it.each(['idle', 'running', 'requires_action'] as const)(
    'restores the exact authoritative native state %s',
    (state) => {
      const target = session()
      apply(target, { subtype: 'initialize' }, { session_state: state })
      expect(target.claudeState).toBe(state)
      expect(target.claudeStateAware).toBe(true)
    },
  )

  it.each([undefined, null, 'unknown', ['idle'], { toString: 'idle' }, 1])(
    'does not infer native state from malformed or future values %j',
    (state) => {
      const target = { ...session(), claudeState: 'running' as const, claudeStateAware: true }
      apply(target, { subtype: 'initialize' }, { session_state: state })
      expect(target.claudeState).toBe('running')
      expect(target.claudeStateAware).toBe(true)
    },
  )

  it('uses the connected version fallback and clears stale opt-in metadata on fresh initialization', () => {
    const target = { ...session(), claudeFastModeNeedsOptIn: true }
    applyNativeClaudeControl({
      session: target,
      request: { subtype: 'initialize' },
      payload: { fast_mode_disabled_reason: null, claude_code_version: '' },
      success: true,
      fallbackCodeVersion: '2.connected',
    })
    expect(target.claudeFastModeNeedsOptIn).toBe(false)
    expect(target.claudeCodeVersion).toBe('2.connected')
  })

  it.each([
    ['review', 'default'],
    ['ask-for-approval', 'default'],
    ['edit', 'acceptEdits'],
    ['plan', 'plan'],
    ['full-access', 'bypassPermissions'],
    ['auto', 'auto'],
    ['dontAsk', 'dontAsk'],
  ] as const)('retains original %s choices after its exact %s acknowledgment', (mode, native) => {
    const target = session()
    const result = apply(
      target,
      { subtype: 'set_permission_mode', mode: native },
      {},
      {
        requestedSettings: {
          mode,
          model: 'unacknowledged-model',
          reasoningEffort: 'unacknowledged-effort',
          serviceTier: 'fast',
        },
      },
    )
    expect(target.input).toEqual({ ...session().input, mode })
    expect(target.appliedModel).toBe('original-model')
    expect(result.settingsEvent?.details).toEqual({ mode, applied: 'live' })
  })

  it('uses acknowledged permission aliases without original UI details', () => {
    const target = session()
    apply(target, { subtype: 'set_permission_mode', mode: 'acceptEdits' })
    expect(target.input.mode).toBe('edit')
  })

  it.each(['unknown', 'constructor', '__proto__', ['default'], null])(
    'does not invent permission authority for %j',
    (mode) => {
      const target = session()
      expect(apply(target, { subtype: 'set_permission_mode', mode })).toEqual({})
      expect(target).toEqual(session())
    },
  )

  it.each([
    ['specific-model', 'specific-model'],
    ['', 'default'],
  ])('retains requested model %j through native model %j', (requested, native) => {
    const target = session()
    apply(
      target,
      { subtype: 'set_model', model: native },
      {},
      { requestedSettings: { model: requested, mode: 'edit', reasoningEffort: 'high' } },
    )
    expect(target.input).toEqual({ ...session().input, model: requested })
    expect(target.appliedModel).toBe('original-model')
  })

  it('does not replace an acknowledged model with unrelated requested details', () => {
    const target = session()
    apply(
      target,
      { subtype: 'set_model', model: 'actual-request' },
      {},
      { requestedSettings: { model: 'different-intent' } },
    )
    expect(target.input.model).toBe('actual-request')
  })

  it.each([null, undefined])(
    'restores the native default model for an acknowledged %j reset',
    (model) => {
      const target = session()
      apply(target, { subtype: 'set_model', ...(model === undefined ? {} : { model }) })
      expect(target.input.model).toBe('')
      expect(target.appliedModel).toBe('original-model')
    },
  )

  it('keeps requested model separate from the resolved native applied model', () => {
    const target = session()
    apply(
      target,
      { subtype: 'set_model', model: 'opus' },
      { applied: { model: 'claude-opus-native', effort: 'xhigh' } },
      { requestedSettings: { model: 'opus' } },
    )
    expect(target.input.model).toBe('opus')
    expect(target.appliedModel).toBe('claude-opus-native')
    expect(target.input.reasoningEffort).toBe('low')
    expect(target.appliedReasoningEffort).toBe('xhigh')
  })

  it('does not claim a requested model alias or opaque effort is actually applied from a bare ACK', () => {
    const target = session()
    apply(target, { subtype: 'set_model', model: 'opus' })
    apply(target, { subtype: 'apply_flag_settings', settings: { effortLevel: 'future-effort' } })
    expect(target.input).toMatchObject({ model: 'opus', reasoningEffort: 'future-effort' })
    expect(target.appliedModel).toBe('original-model')
    expect(target.appliedReasoningEffort).toBe('low')
    apply(
      target,
      { subtype: 'get_settings' },
      { applied: { model: 'provider-substitution', effort: null } },
    )
    expect(target.input).toMatchObject({ model: 'opus', reasoningEffort: 'future-effort' })
    expect(target.appliedModel).toBe('provider-substitution')
    expect(target.appliedReasoningEffort).toBeUndefined()
  })

  it('retains the native owner and exact prompt when replacing the preference projection', () => {
    const originalInput = {
      ...session().input,
      sessionId: 'local-owner',
      provider: 'claude' as const,
      remoteId: 'native-session',
      prompt: '  exact prompt\r\n雪\ud800 ',
      workspace: '/project/exact-owner',
      attachments: [{ remotePath: '/project/data', name: 'data', mimeType: 'text/plain' }],
      clientRecovery: { privateOwner: ['future', null] },
    }
    const target = { ...session(), input: originalInput }
    apply(target, { subtype: 'set_model', model: 'opus' })
    expect(target.input).toEqual({ ...originalInput, model: 'opus' })
    expect(originalInput.model).toBe('original-model')
    expect(target.input.clientRecovery).toBe(originalInput.clientRecovery)
    expect(target.input.attachments).toBe(originalInput.attachments)
  })

  it.each([
    ['high', 'high'],
    ['', null],
  ] as const)('retains exact requested effort %j after native %j', (requested, native) => {
    const target = session()
    apply(
      target,
      { subtype: 'apply_flag_settings', settings: { effortLevel: native } },
      {},
      { requestedSettings: { reasoningEffort: requested, serviceTier: 'fast', model: 'opus' } },
    )
    expect(target.input).toEqual({ ...session().input, reasoningEffort: requested })
    expect(target.appliedReasoningEffort).toBe('low')
  })

  it.each([
    ['fast', true],
    ['default', false],
    ['', null],
  ] as const)('retains exact requested tier %j after native %j', (requested, native) => {
    const target = { ...session(), claudeRestartForSettings: true }
    apply(
      target,
      { subtype: 'apply_flag_settings', settings: { fastMode: native } },
      {},
      { requestedSettings: { serviceTier: requested, reasoningEffort: 'unacknowledged' } },
    )
    expect(target.input).toEqual({ ...session().input, serviceTier: requested })
    expect(target.claudeRestartForSettings).toBe(native === true)
  })

  it('keeps the durable Fast opt-in intent separate from an unrelated acknowledged effort', () => {
    const target = session()
    apply(
      target,
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
      {},
      {
        requestedSettings: { reasoningEffort: 'high', serviceTier: 'fast' },
        claudeRestartForSettings: true,
      },
    )
    expect(target.claudeRestartForSettings).toBe(true)
    expect(target.input.serviceTier).toBe('default')
    apply(target, { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } })
    expect(target.claudeRestartForSettings).toBe(true)
  })

  it.each([
    ['default', false],
    ['', null],
  ] as const)(
    'cancels the pending Fast restart after %j even when recorded details still request one',
    (requested, native) => {
      const target = { ...session(), claudeRestartForSettings: true }
      apply(
        target,
        { subtype: 'apply_flag_settings', settings: { fastMode: native } },
        {},
        {
          requestedSettings: { serviceTier: requested },
          claudeRestartForSettings: true,
        },
      )
      expect(target.input.serviceTier).toBe(requested)
      expect(target.claudeRestartForSettings).toBe(false)
      apply(target, { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
      expect(target.claudeRestartForSettings).toBe(false)
    },
  )

  it('restores actual applied settings from get_settings without changing user preferences', () => {
    const target = session()
    expect(
      apply(
        target,
        { subtype: 'get_settings' },
        {
          effective: { model: 'unrelated-effective', effortLevel: 'medium' },
          sources: { future: ['opaque'] },
          applied: { model: 'native-actual', effort: null },
        },
      ),
    ).toEqual({})
    expect(target.input).toEqual(session().input)
    expect(target.appliedModel).toBe('native-actual')
    expect(target.appliedReasoningEffort).toBeUndefined()
  })

  it.each([
    'initialize',
    'set_permission_mode',
    'set_model',
    'apply_flag_settings',
    'get_settings',
  ])('does not apply failed %s responses, including deferred Fast intents', (subtype) => {
    const target = session()
    expect(
      apply(
        target,
        { subtype, mode: 'plan', model: 'opus', settings: { effortLevel: 'high', fastMode: true } },
        { applied: { model: 'unexpected', effort: 'high' }, session_state: 'running' },
        {
          requestedSettings: {
            model: 'opus',
            mode: 'plan',
            reasoningEffort: 'high',
            serviceTier: 'fast',
          },
          claudeRestartForSettings: true,
        },
        false,
      ),
    ).toEqual({})
    expect(target).toEqual(session())
  })

  it('does not derive settings authority from unrelated controls or opaque flag names', () => {
    const target = session()
    expect(apply(target, { subtype: 'interrupt' }, { applied: { model: 'wrong' } })).toEqual({})
    expect(
      apply(target, { subtype: 'future-control' }, {}, { requestedSettings: { model: 'wrong' } }),
    ).toEqual({})
    expect(
      apply(target, { subtype: 'apply_flag_settings', settings: { futureFlag: true } }),
    ).toEqual({})
    expect(target).toEqual(session())
  })

  it('reconstructs the same settings and event ordering from the original durable wire sequence', () => {
    const sequence = [
      {
        request: { subtype: 'initialize' },
        payload: { session_state: 'idle', fast_mode_disabled_reason: 'sdk_opt_in_required' },
      },
      {
        request: { subtype: 'set_permission_mode', mode: 'plan' },
        payload: {},
        details: {
          requestedSettings: { mode: 'plan' as const, model: 'opus', reasoningEffort: 'high' },
        },
      },
      {
        request: { subtype: 'set_model', model: 'opus' },
        payload: { applied: { model: 'resolved-opus' } },
        details: {
          requestedSettings: { mode: 'plan' as const, model: 'opus', reasoningEffort: 'high' },
        },
      },
      {
        request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
        payload: {},
        details: {
          requestedSettings: { reasoningEffort: 'high', serviceTier: 'fast' },
          claudeRestartForSettings: true,
        },
      },
      { request: { subtype: 'set_model', model: 'failed-model' }, payload: {}, success: false },
    ]
    const fold = (wire: typeof sequence) => {
      const target = session()
      const events = wire.flatMap((control) => {
        const result = apply(
          target,
          control.request,
          control.payload,
          control.details,
          control.success ?? true,
        )
        return result.settingsEvent ? [result.settingsEvent] : []
      })
      return { target, events }
    }
    const live = fold(sequence)
    const replay = fold(JSON.parse(JSON.stringify(sequence)) as typeof sequence)
    expect(replay).toEqual(live)
    expect(replay.target.input).toEqual({
      model: 'opus',
      mode: 'plan',
      reasoningEffort: 'high',
      serviceTier: 'default',
    })
    expect(replay.target.appliedModel).toBe('resolved-opus')
    expect(replay.target.claudeRestartForSettings).toBe(true)
    expect(replay.events).toHaveLength(4)
  })
})
