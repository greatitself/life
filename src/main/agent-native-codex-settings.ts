import type { AgentEvent, AgentSettingsInput, PermissionMode, StartInput } from '../shared/types'

type Wire = Record<string, unknown>
type Settings = Pick<AgentSettingsInput, 'model' | 'reasoningEffort' | 'serviceTier' | 'mode'>

export interface NativeCodexSettingsSession {
  input: Pick<StartInput, 'model' | 'reasoningEffort' | 'serviceTier' | 'mode'>
  appliedModel?: string
  appliedReasoningEffort?: string
}

export interface NativeCodexSettingsDetails {
  /** Exact UI choices, including empty defaults and legacy permission aliases. */
  requestedSettings?: unknown
  /** The original native patch, after resolving advertised default choices. */
  nativeSettings?: unknown
  /** Captured before the thread acknowledgment changes the saved preferences. */
  permissionBoundaryChanged?: boolean
}

export interface NativeCodexSettingsResult {
  settingsEvent?: Omit<AgentEvent, 'sessionId'>
}

const codexModes = new Set<PermissionMode>([
  'review',
  'edit',
  'plan',
  'ask-for-approval',
  'read-only',
  'full-access',
  'auto-review',
])

function object(value: unknown): Wire | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : undefined
}

function ownValue(wire: Wire, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(wire, key)
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined
}

/** Malformed known fields invalidate the choice set; unrelated metadata grants no settings. */
function requestedSettings(value: unknown): Settings | undefined {
  const wire = object(value)
  if (!wire) return undefined
  const selected: Settings = {}
  for (const key of ['model', 'reasoningEffort', 'serviceTier'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(wire, key)
    if (!descriptor) continue
    if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string')
      return undefined
    selected[key] = descriptor.value
  }
  const mode = Object.getOwnPropertyDescriptor(wire, 'mode')
  if (mode) {
    if (
      !mode.enumerable ||
      !('value' in mode) ||
      typeof mode.value !== 'string' ||
      !codexModes.has(mode.value as PermissionMode)
    )
      return undefined
    selected.mode = mode.value as PermissionMode
  }
  return Object.keys(selected).length ? selected : undefined
}

/**
 * Fold settings acknowledgments at their original native wire ordinal, before
 * Promise continuations. Outbound admission alone does not apply preferences.
 */
export function applyNativeCodexSettings({
  session,
  method,
  details,
  result,
  success,
}: {
  session: NativeCodexSettingsSession
  method: string
  details?: NativeCodexSettingsDetails
  result: Wire
  success: boolean
}): NativeCodexSettingsResult {
  if (success !== true || !object(result)) return {}
  if (method !== 'thread/settings/update' && method !== 'turn/settings/update') return {}
  const metadata = object(details)
  const boundary =
    metadata && Object.getOwnPropertyDescriptor(metadata, 'permissionBoundaryChanged')
  if (
    boundary &&
    (!boundary.enumerable || !('value' in boundary) || typeof boundary.value !== 'boolean')
  )
    return {}
  const selected = metadata && requestedSettings(ownValue(metadata, 'requestedSettings'))
  if (!selected) return {}

  if (method === 'turn/settings/update' && ownValue(result, 'status') !== 'applied')
    return ownValue(result, 'status') === 'targetUnavailable'
      ? {
          settingsEvent: {
            type: 'settings',
            status: 'next-request',
            details: { applied: 'next-request' },
          },
        }
      : {}

  if (method === 'thread/settings/update') session.input = { ...session.input, ...selected }
  else {
    const native = object(ownValue(metadata!, 'nativeSettings'))
    if (native) {
      const model = ownValue(native, 'model')
      const effort = ownValue(native, 'effort')
      if (Object.hasOwn(selected, 'model') && typeof model === 'string')
        session.appliedModel = model
      if (Object.hasOwn(selected, 'reasoningEffort') && typeof effort === 'string')
        session.appliedReasoningEffort = effort
    }
  }
  const applied =
    method === 'thread/settings/update' || ownValue(metadata!, 'permissionBoundaryChanged') === true
      ? 'next-request'
      : 'live'
  return {
    settingsEvent: { type: 'settings', status: applied, details: { ...selected, applied } },
  }
}
