import type { Provider } from '../shared/types'

/** Radix's hidden form control can emit an empty value while mounting or resetting. */
export function parseModelSelection(value: string): [Provider, string] | undefined {
  if (!value || value.length > 1000) return
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      (parsed[0] !== 'codex' && parsed[0] !== 'claude') ||
      typeof parsed[1] !== 'string' ||
      parsed[1].length > 500
    )
      return
    return [parsed[0], parsed[1]]
  } catch {
    return
  }
}

export function parsePrefixedSelection(value: string): string | undefined {
  return value.startsWith('choice:') ? value.slice(7) : undefined
}
