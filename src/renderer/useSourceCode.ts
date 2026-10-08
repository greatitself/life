import { useCallback, useEffect, useRef, useState } from 'react'
import type { LifeSourceSnapshot } from '../shared/source-code'
import { api, errorText } from './api'

const initialSource: LifeSourceSnapshot = {
  revision: 0,
  enabled: false,
  canRollback: false,
  path: '',
  recovered: false,
  extensions: [],
}

export function useSourceCode(): LifeSourceSnapshot {
  const [state, setState] = useState(initialSource)
  const current = useRef(state)
  const accept = useCallback((next: LifeSourceSnapshot) => {
    if (next.revision < current.current.revision) return
    current.current = next
    setState(next)
  }, [])
  useEffect(() => {
    if (!api) return
    let disposed = false
    const update = (next: LifeSourceSnapshot) => {
      if (!disposed) accept(next)
    }
    const unsubscribe = api.sourceCode.onState(update)
    void api.sourceCode
      .get()
      .then(update)
      .catch((error) => {
        if (!disposed) setState((previous) => ({ ...previous, error: errorText(error) }))
      })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [accept])
  return state
}
