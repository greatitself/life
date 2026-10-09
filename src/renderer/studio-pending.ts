import { z } from 'zod'
import { lifeSourcePathSchema } from '../shared/source-code'
import type { StartInput } from '../shared/types'
import { startSchema } from '../shared/validation'

export const STUDIO_PENDING_KEY = 'life.studio.pending-source.v1'

export interface StudioPending {
  id: string
  request: string
  profileId: string
  input: StartInput
  reads: number
  repairs: number
  paths?: string[]
}

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Use a valid Studio or profile identifier')
const pendingSchema = z
  .object({
    id: identifier,
    request: z
      .string()
      .max(1_000_000)
      .refine((request) => request.trim().length > 0, 'Enter a request'),
    profileId: identifier,
    input: startSchema
      .strict()
      .refine(
        (input) => input.scope === undefined || input.scope === 'life-customization',
        'Pending customization work belongs only to Life Studio',
      ),
    reads: z.number().int().min(0).max(6),
    repairs: z.number().int().min(0).max(2),
    paths: z
      .array(lifeSourcePathSchema)
      .max(30)
      .refine(
        (paths) => new Set(paths.map((path) => path.toLowerCase())).size === paths.length,
        'Pending Studio source paths must be unique',
      )
      .optional(),
  })
  .strict()
  .refine((pending) => pending.id === pending.input.sessionId, {
    path: ['input', 'sessionId'],
    message: 'A Studio repair must retain its original conversation ID',
  })

const maximumStoredBytes = 2_000_000
const bytes = (value: string) => new TextEncoder().encode(value).byteLength

function parsePending(value: unknown): StudioPending {
  const copied = copyJsonData(value)
  if (!copied || typeof copied !== 'object' || Array.isArray(copied))
    throw new Error('Pending Studio context must be an object')
  const input = copied as Record<string, unknown>
  if (input.input && typeof input.input === 'object' && !Array.isArray(input.input))
    input.input = { ...input.input, prompt: input.request }
  return pendingSchema.parse(input)
}

/** Persist only the original request, replacing any stale generated prompt before validation. */
export function encodeStudioPending(pending: StudioPending): string {
  const serialized = JSON.stringify(parsePending(pending))
  if (bytes(serialized) > maximumStoredBytes)
    throw new Error('Pending Studio context must be smaller than 2 MB')
  return serialized
}

/** Invalid persisted work can never start an unbounded repair or adopt another session. */
export function readStudioPending(
  serialized: string | null | undefined,
): StudioPending | undefined {
  if (
    typeof serialized !== 'string' ||
    !serialized ||
    serialized.length > maximumStoredBytes ||
    bytes(serialized) > maximumStoredBytes
  )
    return
  try {
    return parsePending(JSON.parse(serialized))
  } catch {
    return
  }
}

function copyJsonData(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 20_000 || depth > 32)
    throw new Error('Pending Studio context is too deeply nested or too large')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object')
    throw new Error('Pending Studio context must contain JSON data')
  if (seen.has(value)) throw new Error('Pending Studio context cannot contain circular references')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null)
    throw new Error('Pending Studio context must contain plain objects')
  seen.add(value)
  const result: unknown[] | Record<string, unknown> = array ? [] : {}
  let entries = 0
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
    )
      throw new Error('Pending Studio context contains an unsupported key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (descriptor.get || descriptor.set)
      throw new Error('Pending Studio context cannot contain getters or setters')
    if (array) {
      if (key === 'length') continue
      if (!/^(?:0|[1-9][0-9]*)$/.test(key))
        throw new Error('Pending Studio arrays cannot contain named properties')
      entries++
      ;(result as unknown[])[Number(key)] = copyJsonData(descriptor.value, seen, depth + 1, budget)
    } else if (descriptor.value !== undefined)
      (result as Record<string, unknown>)[key] = copyJsonData(
        descriptor.value,
        seen,
        depth + 1,
        budget,
      )
  }
  if (array && entries !== value.length)
    throw new Error('Pending Studio arrays cannot contain empty entries')
  seen.delete(value)
  return result
}
