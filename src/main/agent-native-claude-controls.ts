import type { AgentEvent, AgentSettingsInput, PermissionMode, StartInput } from '../shared/types'
import type { ProviderUsageSnapshot } from '../shared/usage'
import { claudeAccountInfo } from './claude-usage'

type Wire = Record<string, unknown>
type Settings = Pick<AgentSettingsInput, 'model' | 'reasoningEffort' | 'serviceTier' | 'mode'>

/** Only structured native state is shared with this reducer; it owns no live resources. */
export interface NativeClaudeControlSession {
  input: Pick<StartInput, 'model' | 'reasoningEffort' | 'serviceTier' | 'mode'>
  appliedModel?: string
  appliedReasoningEffort?: string
  claudeStateAware?: boolean
  claudeState?: 'idle' | 'running' | 'requires_action'
  claudeFastModeNeedsOptIn?: boolean
  claudeRestartForSettings?: boolean
  claudeCodeVersion?: string
  claudeAccount?: ProviderUsageSnapshot['account']
  claudeSubscriptionType?: string
}

export interface NativeClaudeControlDetails {
  /** Original UI choices, before aliases such as empty model -> native default. */
  requestedSettings?: Settings
  /** An explicitly recorded next-request decision, separate from native Fast acceptance. */
  claudeRestartForSettings?: boolean
}

export interface NativeClaudeControlResult {
  settingsEvent?: Omit<AgentEvent, 'sessionId'>
}

function object(value: unknown): Wire {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
}

const nativePermissionModes: Partial<Record<PermissionMode, string>> = {
  review: 'default',
  'ask-for-approval': 'default',
  edit: 'acceptEdits',
  plan: 'plan',
  'full-access': 'bypassPermissions',
  auto: 'auto',
  dontAsk: 'dontAsk',
}

const uiPermissionModes: Record<string, PermissionMode> = {
  default: 'review',
  acceptEdits: 'edit',
  plan: 'plan',
  bypassPermissions: 'full-access',
  auto: 'auto',
  dontAsk: 'dontAsk',
}

function modelChoice(native: unknown, requested: unknown): string | undefined {
  if (typeof requested === 'string' && native === (requested || 'default')) return requested
  if (native === null || native === undefined) return ''
  if (typeof native === 'string') return native === 'default' ? '' : native
  return undefined
}

function effortChoice(native: unknown, requested: unknown): string | undefined {
  if (typeof requested === 'string' && native === (requested || null)) return requested
  return native === null ? '' : typeof native === 'string' ? native : undefined
}

function tierChoice(native: unknown, requested: unknown): string | undefined {
  if (
    typeof requested === 'string' &&
    ['', 'fast', 'default'].includes(requested) &&
    native === (requested ? requested === 'fast' : null)
  )
    return requested
  return native === true ? 'fast' : native === false ? 'default' : native === null ? '' : undefined
}

function appliedSettings(session: NativeClaudeControlSession, payload: Wire) {
  // get_settings exposes applied model/effort separately from effective/source preferences.
  // A bare settings ACK may accept an alias or opaque flag without applying that
  // exact value. Retain the last native evidence until a response supplies it.
  const applied = object(payload.applied)
  if (typeof applied.model === 'string') session.appliedModel = applied.model
  if (typeof applied.effort === 'string') session.appliedReasoningEffort = applied.effort
  else if (applied.effort === null) session.appliedReasoningEffort = undefined
}

/**
 * Fold the original control request and its native acknowledgment before delivering
 * pending requests or resolving a caller. The same fold is used during raw replay.
 * Opaque response fields remain untouched in the caller's original wire ledger.
 */
export function applyNativeClaudeControl({
  session,
  request,
  payload,
  success,
  details,
  fallbackCodeVersion,
}: {
  session: NativeClaudeControlSession
  request: Wire
  payload: Wire
  success: boolean
  details?: NativeClaudeControlDetails
  fallbackCodeVersion?: string
}): NativeClaudeControlResult {
  if (!success) return {}
  if (request.subtype === 'initialize') {
    session.claudeAccount = claudeAccountInfo(payload.account)
    const account = object(payload.account)
    session.claudeSubscriptionType =
      typeof account.subscriptionType === 'string' && account.subscriptionType
        ? account.subscriptionType
        : undefined
    session.claudeFastModeNeedsOptIn = payload.fast_mode_disabled_reason === 'sdk_opt_in_required'
    session.claudeCodeVersion =
      (typeof payload.claude_code_version === 'string' && payload.claude_code_version) ||
      fallbackCodeVersion
    if (
      payload.session_state === 'idle' ||
      payload.session_state === 'running' ||
      payload.session_state === 'requires_action'
    ) {
      session.claudeStateAware = true
      session.claudeState = payload.session_state
    }
    appliedSettings(session, payload)
    return {
      settingsEvent: {
        type: 'settings',
        details: {
          ...(typeof payload.fast_mode_state === 'string'
            ? { fastModeState: payload.fast_mode_state }
            : {}),
          ...(typeof payload.fast_mode_disabled_reason === 'string'
            ? { fastModeDisabledReason: payload.fast_mode_disabled_reason }
            : {}),
          ...(typeof payload.current_permission_mode === 'string'
            ? { currentPermissionMode: payload.current_permission_mode }
            : {}),
        },
      },
    }
  }

  if (request.subtype === 'get_settings') {
    appliedSettings(session, payload)
    return {}
  }

  const requested = details?.requestedSettings
  const changed: Settings = {}
  if (request.subtype === 'set_permission_mode' && typeof request.mode === 'string') {
    const original = requested?.mode
    const mode =
      original !== undefined && nativePermissionModes[original] === request.mode
        ? original
        : Object.hasOwn(uiPermissionModes, request.mode)
          ? uiPermissionModes[request.mode]
          : undefined
    if (mode !== undefined) changed.mode = mode
  } else if (request.subtype === 'set_model') {
    const model = modelChoice(request.model, requested?.model)
    if (model !== undefined) changed.model = model
  } else if (request.subtype === 'apply_flag_settings') {
    const settings = object(request.settings)
    if (Object.hasOwn(settings, 'effortLevel')) {
      const effort = effortChoice(settings.effortLevel, requested?.reasoningEffort)
      if (effort !== undefined) changed.reasoningEffort = effort
    }
    if (Object.hasOwn(settings, 'fastMode')) {
      const tier = tierChoice(settings.fastMode, requested?.serviceTier)
      if (tier !== undefined) changed.serviceTier = tier
    }
  } else return {}

  if (!Object.keys(changed).length) return {}
  session.input = { ...session.input, ...changed }
  // An acknowledged disable/reset cancels the prior opt-in restart decision,
  // including stale details captured before this native control completed.
  if (changed.serviceTier !== undefined && changed.serviceTier !== 'fast')
    session.claudeRestartForSettings = false
  else if (typeof details?.claudeRestartForSettings === 'boolean')
    session.claudeRestartForSettings = details.claudeRestartForSettings
  appliedSettings(session, payload)
  const applied =
    changed.serviceTier !== undefined || details?.claudeRestartForSettings === true
      ? 'next-request'
      : 'live'
  return {
    settingsEvent: { type: 'settings', status: applied, details: { ...changed, applied } },
  }
}
