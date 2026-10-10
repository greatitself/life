import type { RelayAPI } from '../shared/types'
declare global {
  interface Window {
    relay?: RelayAPI
  }
}
export const api = typeof window === 'undefined' ? undefined : window.relay
export const desktop = Boolean(api)
// Keep the streamlined workspace enabled for all desktop views.
export const streamlinedWorkspace = true
export const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  )
