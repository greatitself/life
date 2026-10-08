import { z } from 'zod'
import { parseLifeSourceRead } from '../shared/source-code'
import type { StartInput } from '../shared/types'
import { startSchema } from '../shared/validation'

export const pendingSourceApplyKey = 'life.pendingSourceApply'

/** Enough context to repair an activated renderer in its original provider conversation. */
export interface PendingSourceApply {
  id: string
  turn: number
  request: string
  profileId: string
  reads: number
  repairs: number
  start: StartInput
  paths: string[]
}

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Use a valid thread or profile identifier')
const pendingSchema = z
  .object({
    id: identifier,
    turn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    request: z.string().trim().min(1).max(900_000),
    profileId: identifier,
    reads: z.number().int().min(0).max(6),
    repairs: z.number().int().min(0).max(2),
    start: startSchema.strict(),
    paths: z
      .array(z.string())
      .max(30)
      .refine(
        (paths) => new Set(paths.map((path) => path.toLowerCase())).size === paths.length,
        'Source paths must be unique',
      ),
  })
  .strict()
  .refine((pending) => pending.start.sessionId === pending.id, {
    path: ['start', 'sessionId'],
    message: 'A source repair must use its original thread session',
  })

const maximumStoredLength = 2_000_000

/** Validate storage or in-memory data without retaining a generated code/context prompt. */
export function parsePendingSourceApply(value: unknown): PendingSourceApply {
  const json = copyJsonData(value)
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new Error('Pending source context must be an object')
  const input = json as Record<string, unknown>
  if (input.start && typeof input.start === 'object' && !Array.isArray(input.start))
    input.start = { ...input.start, prompt: input.request }
  const pending = pendingSchema.parse(input)
  pending.start.mode = 'plan'
  if (pending.paths.length) pending.paths = parseLifeSourceRead({ paths: pending.paths }).paths
  if (JSON.stringify(pending).length > maximumStoredLength)
    throw new Error('Pending source context must be smaller than 2 MB')
  return pending
}

export function encodePendingSourceApply(metadata: PendingSourceApply): string {
  return JSON.stringify(parsePendingSourceApply(metadata))
}

/** Corrupt, obsolete, or oversized entries are ignored; startup recovery must remain usable. */
export function loadPendingSourceApply(
  serialized: string | null | undefined,
): PendingSourceApply | null {
  if (!serialized || serialized.length > maximumStoredLength) return null
  try {
    return parsePendingSourceApply(JSON.parse(serialized))
  } catch {
    return null
  }
}

// Optional StartInput fields are commonly present as undefined in memory. Omit those
// object properties just as JSON.stringify does, while rejecting executable data before
// reading getters or calling toJSON. Array entries must always be actual JSON values.
function copyJsonData(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 20_000 || depth > 32)
    throw new Error('Pending source context is too deeply nested or too large')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error('Pending source context must contain JSON data')
  if (seen.has(value)) throw new Error('Pending source context cannot contain circular references')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error('Pending source context must contain plain objects')
  seen.add(value)
  const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
  let arrayEntries = 0
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
    )
      throw new Error('Pending source context contains an unsupported key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (descriptor.get || descriptor.set)
      throw new Error('Pending source context cannot contain getters or setters')
    if (Array.isArray(value)) {
      if (key === 'length') continue
      if (!/^(?:0|[1-9][0-9]*)$/.test(key))
        throw new Error('Pending source arrays cannot contain named properties')
      arrayEntries++
      ;(result as unknown[])[Number(key)] = copyJsonData(descriptor.value, seen, depth + 1, budget)
    } else if (descriptor.value !== undefined)
      (result as Record<string, unknown>)[key] = copyJsonData(
        descriptor.value,
        seen,
        depth + 1,
        budget,
      )
  }
  if (Array.isArray(value) && arrayEntries !== value.length)
    throw new Error('Pending source arrays cannot contain empty entries')
  seen.delete(value)
  return result
}
