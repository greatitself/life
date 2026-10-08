import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  defaultLifeConfig,
  mergeLifeConfig,
  parseLifeConfig,
  type LifeConfigPatch,
  type LifeConfigState,
  type LifeConfig,
} from '../shared/customization'
import { api } from './api'

const storageKey = 'life.config.v1'
function initial(): LifeConfigState {
  let config = structuredClone(defaultLifeConfig)
  try {
    config = parseLifeConfig(JSON.parse(localStorage.getItem(storageKey) || 'null'))
  } catch {
    /* Start with defaults when no valid cache exists. */
  }
  return { config, revision: 0, canUndo: false, path: '' }
}

export function useLifeConfig() {
  const [state, setState] = useState<LifeConfigState>(initial)
  const current = useRef(state)
  current.current = state
  const history = useRef<LifeConfig[]>([])
  const accept = useCallback((next: LifeConfigState) => {
    if (next.revision < current.current.revision) return
    current.current = next
    setState(next)
  }, [])
  useEffect(() => {
    if (!api) return
    let valid = true
    const update = (next: LifeConfigState) => {
      if (valid) accept(next)
    }
    const unsubscribe = api.customization.onChange(update)
    void api.customization
      .get()
      .then(update)
      .catch((error) => setState((previous) => ({ ...previous, error: String(error) })))
    return () => {
      valid = false
      unsubscribe()
    }
  }, [accept])
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = state.config.theme
    root.dataset.density = state.config.density
    root.style.setProperty('--life-sidebar-width', `${state.config.sidebarWidth}px`)
    root.style.setProperty('--life-panel-width', `${state.config.workspacePanelWidth}px`)
    root.style.setProperty('--life-font-size', `${state.config.fontSize}px`)
    try {
      localStorage.setItem(storageKey, JSON.stringify(state.config))
    } catch {
      /* Main-process configuration remains authoritative. */
    }
  }, [state.config])
  const apply = useCallback(
    async (patch: LifeConfigPatch) => {
      if (api) {
        accept(await api.customization.apply(patch))
        return
      }
      const previous = current.current
      const config = mergeLifeConfig(previous.config, patch)
      history.current.push(previous.config)
      const next = { config, revision: previous.revision + 1, canUndo: true, path: '' }
      current.current = next
      setState(next)
    },
    [accept],
  )
  const undo = useCallback(async () => {
    if (api) {
      accept(await api.customization.undo())
      return
    }
    const config = history.current.pop()
    if (config) {
      const next = {
        config,
        revision: current.current.revision + 1,
        canUndo: history.current.length > 0,
        path: '',
      }
      current.current = next
      setState(next)
    }
  }, [accept])
  const reset = useCallback(async () => {
    if (api) accept(await api.customization.reset())
    else await apply(structuredClone(defaultLifeConfig))
  }, [apply, accept])
  const reload = useCallback(async () => {
    if (api) accept(await api.customization.reload())
    else
      setState((previous) => ({
        ...initial(),
        revision: previous.revision + 1,
        canUndo: history.current.length > 0,
      }))
  }, [accept])
  return { state, config: state.config, apply, undo, reset, reload }
}
