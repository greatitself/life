export const workspaceSurfaces = [
  'browser',
  'terminal',
  'files',
  'diff',
  'pull-request',
  'linked-pull-requests',
  'agents',
  'device',
  'git',
] as const

export type WorkspaceSurface = (typeof workspaceSurfaces)[number]
export interface RightPanelState {
  tabs: WorkspaceSurface[]
  selected?: WorkspaceSurface
}
export type RightPanelStates = Record<string, RightPanelState>
export const emptyRightPanel: RightPanelState = { tabs: [] }
const storageKey = 'life.workspace.surface-tabs.v2'
const scopeLimit = 64

/** These are presentation choices only; provider and terminal ownership live elsewhere. */
export function readRightPanelStates(): RightPanelStates {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const states: RightPanelStates = Object.create(null)
    for (const [key, entry] of Object.entries(value).slice(-scopeLimit)) {
      if (!key || key.length > 12000 || !entry || typeof entry !== 'object') continue
      const candidate = entry as { tabs?: unknown; selected?: unknown }
      if (!Array.isArray(candidate.tabs)) continue
      const savedTabs = candidate.tabs
      const tabs = workspaceSurfaces.filter((id) => savedTabs.includes(id))
      // Retain the user's order rather than the launcher's order.
      tabs.sort((a, b) => savedTabs.indexOf(a) - savedTabs.indexOf(b))
      const selected = tabs.find((id) => id === candidate.selected) || tabs[0]
      states[key] = { tabs, selected }
    }
    return states
  } catch {
    return {}
  }
}

export function writeRightPanelStates(states: RightPanelStates): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(states))
  } catch {
    // A disabled/full local store must not prevent opening a panel.
  }
}

export function setRightPanelState(
  states: RightPanelStates,
  key: string,
  state: RightPanelState,
): RightPanelStates {
  return Object.fromEntries(
    [...Object.entries(states).filter(([id]) => id !== key), [key, state]].slice(-scopeLimit),
  )
}

export function openRightPanelSurface(
  state: RightPanelState,
  surface: WorkspaceSurface,
): RightPanelState {
  return {
    tabs: state.tabs.includes(surface) ? state.tabs : [...state.tabs, surface],
    selected: surface,
  }
}

export function closeRightPanelSurfaces(
  state: RightPanelState,
  removed: readonly WorkspaceSurface[],
): RightPanelState {
  const tabs = state.tabs.filter((id) => !removed.includes(id))
  if (state.selected && tabs.includes(state.selected)) return { tabs, selected: state.selected }
  const index = state.selected ? state.tabs.indexOf(state.selected) : 0
  const selected = state.tabs.slice(index + 1).find((id) => tabs.includes(id)) || tabs.at(-1)
  return { tabs, selected }
}
