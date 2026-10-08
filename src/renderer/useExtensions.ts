import { useCallback, useEffect, useRef, useState } from 'react'
import type { LifeExtensionsSnapshot } from '../shared/extensions'
import { api } from './api'

const empty: LifeExtensionsSnapshot = {
  extensions: [],
  revision: 0,
  path: '',
  errors: {},
  canRollback: [],
  recovered: false,
}
export function useExtensions() {
  const [state, setState] = useState(empty)
  const revision = useRef(0)
  const accept = useCallback((next: LifeExtensionsSnapshot) => {
    if (next.revision < revision.current) return
    revision.current = next.revision
    setState(next)
  }, [])
  useEffect(() => {
    if (!api) return
    let valid = true
    const update = (next: LifeExtensionsSnapshot) => {
      if (valid) accept(next)
    }
    const off = api.extensions.onState(update)
    void api.extensions
      .get()
      .then(update)
      .catch(() => {})
    return () => {
      valid = false
      off()
    }
  }, [accept])
  return state
}
