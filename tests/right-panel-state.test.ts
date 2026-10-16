import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeRightPanelSurfaces,
  emptyRightPanel,
  openRightPanelSurface,
  readRightPanelStates,
  setRightPanelState,
  writeRightPanelStates,
  type RightPanelState,
  type RightPanelStates,
} from '../src/renderer/components/right-panel-state'

const storageKey = 'life.workspace.surface-tabs.v2'

afterEach(() => vi.unstubAllGlobals())

function storage(raw?: string) {
  const values = new Map<string, string>()
  if (raw !== undefined) values.set(storageKey, raw)
  const adapter = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  }
  vi.stubGlobal('localStorage', adapter)
  return adapter
}

describe('right-panel tab selection', () => {
  it('opens a new tab at the end and selects existing tabs without duplicating or reordering them', () => {
    const first = openRightPanelSurface(emptyRightPanel, 'files')
    const second = openRightPanelSurface(first, 'terminal')
    const selected = openRightPanelSurface(second, 'files')
    expect(first).toEqual({ tabs: ['files'], selected: 'files' })
    expect(second).toEqual({ tabs: ['files', 'terminal'], selected: 'terminal' })
    expect(selected).toEqual({ tabs: ['files', 'terminal'], selected: 'files' })
    expect(second.selected).toBe('terminal')
    expect(emptyRightPanel).toEqual({ tabs: [] })
  })

  it('selects the nearest remaining tab on the right, then the previous tab when closing the active tab', () => {
    const state: RightPanelState = {
      tabs: ['terminal', 'files', 'browser', 'diff'],
      selected: 'files',
    }
    expect(closeRightPanelSurfaces(state, ['files'])).toEqual({
      tabs: ['terminal', 'browser', 'diff'],
      selected: 'browser',
    })
    expect(closeRightPanelSurfaces(state, ['files', 'browser'])).toEqual({
      tabs: ['terminal', 'diff'],
      selected: 'diff',
    })
    expect(closeRightPanelSurfaces({ ...state, selected: 'diff' }, ['diff'])).toEqual({
      tabs: ['terminal', 'files', 'browser'],
      selected: 'browser',
    })
    expect(state.tabs).toEqual(['terminal', 'files', 'browser', 'diff'])
    expect(state.selected).toBe('files')
  })

  it('retains the active selection when closing an inactive tab', () => {
    const state: RightPanelState = {
      tabs: ['terminal', 'files', 'browser'],
      selected: 'files',
    }
    expect(closeRightPanelSurfaces(state, ['terminal', 'browser'])).toEqual({
      tabs: ['files'],
      selected: 'files',
    })
    expect(closeRightPanelSurfaces(state, ['diff'])).toEqual(state)
  })

  it('supports Close others, Close tabs to the right, and Close all without leaving a stale selection', () => {
    const state: RightPanelState = {
      tabs: ['terminal', 'files', 'browser', 'diff'],
      selected: 'files',
    }
    expect(
      closeRightPanelSurfaces(
        state,
        state.tabs.filter((id) => id !== state.selected),
      ),
    ).toEqual({ tabs: ['files'], selected: 'files' })
    const selectedIndex = state.tabs.indexOf(state.selected!)
    expect(closeRightPanelSurfaces(state, state.tabs.slice(selectedIndex + 1))).toEqual({
      tabs: ['terminal', 'files'],
      selected: 'files',
    })
    const closed = closeRightPanelSurfaces(state, state.tabs)
    expect(closed).toEqual({ tabs: [], selected: undefined })
    expect(openRightPanelSurface(closed, 'browser')).toEqual({
      tabs: ['browser'],
      selected: 'browser',
    })
  })
})

describe('right-panel persisted presentation state', () => {
  it('round-trips independent workspace scopes and their tab order', () => {
    const adapter = storage()
    const states: RightPanelStates = {
      'machine-a:/first': { tabs: ['files', 'terminal'], selected: 'terminal' },
      'machine-a:/second': { tabs: ['diff', 'browser'], selected: 'diff' },
      'machine-b:/first': { tabs: [] },
    }
    writeRightPanelStates(states)
    expect(adapter.setItem).toHaveBeenCalledWith(storageKey, JSON.stringify(states))
    expect(readRightPanelStates()).toEqual({
      ...states,
      'machine-b:/first': { tabs: [], selected: undefined },
    })
    expect(adapter.getItem).toHaveBeenCalledWith(storageKey)
  })

  it.each(['broken JSON', 'null', '[]', 'true', '7', '"not a state map"'])(
    'ignores malformed persisted root %s',
    (raw) => {
      storage(raw)
      expect(readRightPanelStates()).toEqual({})
    },
  )

  it('validates entries, removes unknown and duplicate surfaces, and retains first-occurrence order', () => {
    storage(
      JSON.stringify({
        valid: {
          tabs: ['files', 'unknown', 'terminal', 'files', 7, 'browser', 'terminal'],
          selected: 'browser',
        },
        invalidSelection: { tabs: ['diff', 'files'], selected: 'not-a-surface' },
        missingSelection: { tabs: ['terminal', 'browser'] },
        empty: { tabs: ['unknown'], selected: 'unknown' },
        '': { tabs: ['files'] },
        ['x'.repeat(12001)]: { tabs: ['files'] },
        nullEntry: null,
        missingTabs: { selected: 'files' },
        invalidTabs: { tabs: 'files' },
        arrayEntry: ['files'],
      }),
    )
    expect(readRightPanelStates()).toEqual({
      valid: { tabs: ['files', 'terminal', 'browser'], selected: 'browser' },
      invalidSelection: { tabs: ['diff', 'files'], selected: 'diff' },
      missingSelection: { tabs: ['terminal', 'browser'], selected: 'terminal' },
      empty: { tabs: [], selected: undefined },
    })
  })

  it('bounds restored scopes to the last 64 entries', () => {
    const entries = Array.from({ length: 70 }, (_, index) => [
      `scope-${String(index).padStart(2, '0')}`,
      { tabs: ['files'], selected: 'files' },
    ])
    storage(JSON.stringify(Object.fromEntries(entries)))
    expect(Object.keys(readRightPanelStates())).toEqual(entries.slice(-64).map(([key]) => key))
  })

  it('refreshes a saved scope’s recency before evicting the oldest scope at the 64-entry limit', () => {
    const initial: RightPanelStates = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `scope-${index}`,
        { tabs: ['files'], selected: 'files' },
      ]),
    )
    const updated = setRightPanelState(initial, 'scope-0', {
      tabs: ['terminal', 'files'],
      selected: 'terminal',
    })
    const withNewScope = setRightPanelState(updated, 'scope-64', {
      tabs: ['browser'],
      selected: 'browser',
    })
    expect(Object.keys(updated)).toHaveLength(64)
    expect(Object.keys(updated).at(-1)).toBe('scope-0')
    expect(Object.keys(withNewScope)).toHaveLength(64)
    expect(Object.keys(withNewScope).slice(-2)).toEqual(['scope-0', 'scope-64'])
    expect(Object.hasOwn(withNewScope, 'scope-1')).toBe(false)
    expect(withNewScope['scope-0']).toEqual({
      tabs: ['terminal', 'files'],
      selected: 'terminal',
    })
    expect(initial['scope-0']).toEqual({ tabs: ['files'], selected: 'files' })
    expect(Object.hasOwn(initial, 'scope-1')).toBe(true)
  })

  it('preserves prototype-shaped scope IDs as own data without changing the object prototype', () => {
    storage()
    let states: RightPanelStates = {}
    const state: RightPanelState = { tabs: ['files', 'terminal'], selected: 'terminal' }
    for (const key of ['__proto__', 'constructor', 'toString'])
      states = setRightPanelState(states, key, state)
    writeRightPanelStates(states)
    const restored = readRightPanelStates()
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(Object.hasOwn(states, key)).toBe(true)
      expect(Object.hasOwn(restored, key)).toBe(true)
      expect(restored[key]).toEqual(state)
      expect(Object.getOwnPropertyDescriptor(restored, key)?.value).toEqual(state)
    }
    expect([null, Object.prototype]).toContain(Object.getPrototypeOf(restored))
    expect(Object.hasOwn(Object.prototype, 'tabs')).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'selected')).toBe(false)
  })

  it('keeps panel actions usable when storage is disabled or full', () => {
    const adapter = {
      getItem: vi.fn(() => {
        throw new Error('Storage disabled')
      }),
      setItem: vi.fn(() => {
        throw new Error('Storage quota exceeded')
      }),
    }
    vi.stubGlobal('localStorage', adapter)
    expect(readRightPanelStates()).toEqual({})
    const open = openRightPanelSurface(emptyRightPanel, 'terminal')
    const states = setRightPanelState({}, 'workspace', open)
    expect(() => writeRightPanelStates(states)).not.toThrow()
    expect(states.workspace).toEqual({ tabs: ['terminal'], selected: 'terminal' })
    expect(closeRightPanelSurfaces(open, ['terminal'])).toEqual({
      tabs: [],
      selected: undefined,
    })
    vi.stubGlobal('localStorage', undefined)
    expect(readRightPanelStates()).toEqual({})
    expect(() => writeRightPanelStates(states)).not.toThrow()
  })
})
