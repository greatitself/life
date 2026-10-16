import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

const storageKey = 'life.workspace.surface-visibility.v1'
const limit = 64

function readChoices(): Map<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return new Map()
    return new Map(
      Object.entries(saved)
        .filter(
          ([key, value]) => key.length > 0 && key.length <= 12000 && typeof value === 'boolean',
        )
        .slice(-limit) as [string, boolean][],
    )
  } catch {
    return new Map()
  }
}

/** Keep panel visibility with its conversation without owning any workspace resource. */
export function useWorkspacePanelVisibility(
  scopeKey: string,
  initialOpen: boolean,
  configuredOpen: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [choices, setChoices] = useState(readChoices)
  const currentKey = useRef(scopeKey)
  currentKey.current = scopeKey
  const fallback = useRef(initialOpen)
  const previousPreference = useRef(configuredOpen)
  if (previousPreference.current !== configuredOpen) {
    previousPreference.current = configuredOpen
    fallback.current = configuredOpen
  }
  const setOpen: Dispatch<SetStateAction<boolean>> = useCallback((value) => {
    const key = currentKey.current
    setChoices((previous) => {
      const current = previous.get(key) ?? fallback.current
      const next = typeof value === 'function' ? value(current) : value
      if (previous.has(key) && current === next) return previous
      const entries = [...previous.entries()].filter(([id]) => id !== key)
      entries.push([key, next])
      return new Map(entries.slice(-limit))
    })
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(choices)))
    } catch {
      // The current session still retains its choices when storage is unavailable.
    }
  }, [choices])
  return [choices.get(scopeKey) ?? fallback.current, setOpen]
}
