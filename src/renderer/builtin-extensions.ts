import { useSyncExternalStore } from 'react'
import type { RelayAPI } from '../shared/types'
import type { LifeSourceSnapshot } from '../shared/source-code'
import {
  builtinFeatureEnabled,
  builtinFeatureKeys,
  type BuiltinFeatureKey,
} from '../shared/builtin-extensions'
import { api } from './api'
import './builtin-feature-appearance.css'

type SourceBridge = RelayAPI['sourceCode']
type FeaturesState = { ready: boolean; snapshot?: LifeSourceSnapshot }
let state: FeaturesState = { ready: !api }
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let generation = 0

function update(snapshot: LifeSourceSnapshot) {
  // A delayed initial read must not overwrite a newer native feature update.
  if ((snapshot.builtInRevision || 0) < (state.snapshot?.builtInRevision || 0)) return
  state = { ready: true, snapshot }
  if (typeof document !== 'undefined') {
    for (const feature of builtinFeatureKeys)
      document.documentElement.classList.toggle(
        `life-builtin-off-${feature}`,
        !builtinFeatureEnabled(snapshot.extensions, feature),
      )
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (api && !unsubscribe) {
    const currentGeneration = ++generation
    unsubscribe = api.sourceCode.onState(update)
    void api.sourceCode
      .get()
      .then((snapshot) => {
        if (generation === currentGeneration) update(snapshot)
      })
      .catch(() => {
        // Optional operations stay paused if native feature choices cannot be read.
        // Core threads and recovery remain available.
      })
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && unsubscribe) {
      generation++
      unsubscribe()
      unsubscribe = undefined
    }
  }
}

const getSnapshot = () => state

/** Every component shares one native subscription; disabled features never start their lifecycle. */
export function useBuiltinFeatures() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    ready: current.ready,
    enabled: (feature: BuiltinFeatureKey) =>
      current.ready && builtinFeatureEnabled(current.snapshot?.extensions || [], feature),
  }
}

export function useBuiltinFeature(feature: BuiltinFeatureKey) {
  return useBuiltinFeatures().enabled(feature)
}

export function setBuiltinEnabled(
  bridge: SourceBridge,
  id: string,
  enabled: boolean,
): Promise<LifeSourceSnapshot> {
  return bridge.setExtensionEnabled(id.startsWith('builtin-') ? id : `builtin-${id}`, enabled)
}

export function deleteBuiltinExtension(
  bridge: SourceBridge,
  id: string,
): Promise<LifeSourceSnapshot> {
  return bridge.removeExtension(id.startsWith('builtin-') ? id : `builtin-${id}`)
}
