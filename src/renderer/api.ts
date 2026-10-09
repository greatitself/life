import type { RelayAPI } from '../shared/types'
declare global {
  interface Window {
    relay?: RelayAPI
  }
}
export const api = typeof window === 'undefined' ? undefined : window.relay
export const desktop = Boolean(api)
// Life 0.8 shares the streamlined workspace across desktop and browser builds.
export const streamlinedWorkspace = true
export const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  )
