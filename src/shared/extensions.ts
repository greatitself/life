import { z } from 'zod'

export const extensionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Extension IDs must be lowercase slugs, up to 64 characters')
  .refine(
    (id) => !['constructor', 'prototype', 'runtime'].includes(id),
    'This extension ID is reserved',
  )

export const extensionMethodSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/, 'Extension methods must have a valid name')

export const extensionSchema = z
  .object({
    id: extensionIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000),
    version: z.string().trim().min(1).max(64),
    renderer: z
      .object({
        html: z.string().max(500000),
        css: z.string().max(500000),
        js: z.string().max(500000),
        placement: z.enum(['panel', 'view', 'replace']),
      })
      .strict(),
    main: z.string().max(500000).optional(),
    hostCSS: z.string().max(200000).optional(),
    enabled: z.boolean().default(true),
  })
  .strict()

export type LifeExtensionManifest = z.infer<typeof extensionSchema>

export interface LifeExtensionsSnapshot {
  extensions: LifeExtensionManifest[]
  revision: number
  path: string
  errors: Record<string, string>
  canRollback: string[]
  recovered: boolean
}

/** Values cross worker, iframe and IPC boundaries as data, rather than executable objects. */
export function assertExtensionJson(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 32) throw new Error('Extension data is nested too deeply')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new Error('Extension data must contain JSON values')
  if (seen.has(value)) throw new Error('Extension data cannot contain circular references')
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error('Extension data must contain plain objects')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('Extension data cannot contain symbol keys')
    if (['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key))
      throw new Error(`Extension data contains an unsupported key: ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set)
      throw new Error('Extension data cannot contain getters or setters')
    if (Array.isArray(value) && key === 'length') continue
    assertExtensionJson(descriptor?.value, seen, depth + 1)
  }
  seen.delete(value)
}

export function parseExtensionManifest(value: unknown): LifeExtensionManifest {
  assertExtensionJson(value)
  const manifest = extensionSchema.parse(value)
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 500 * 1024)
    throw new Error('An extension must be smaller than 500 KB')
  return manifest
}

export function parseExtensionPayload(value: unknown): unknown {
  assertExtensionJson(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
    throw new Error('Extension messages must be smaller than 1 MB')
  return value
}
