import type { RelayAPI } from '../shared/types'
declare global {
  interface Window {
    relay?: RelayAPI
  }
}
export const api = window.relay
export const desktop = Boolean(api)
export const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  )
