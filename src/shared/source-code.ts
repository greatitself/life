import { z } from 'zod'
import { assertExtensionJson } from './extensions'

export const lifeSourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      /^(?:src\/(?:renderer|shared|main|preload)\/[^\\\0]+|package\.json)$/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part !== '.' &&
            part !== '..' &&
            part !== '' &&
            !/[<>:"|?*]/.test(part) &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    'Use a source path from Life’s source index, without traversal or backslashes',
  )

const fileChangeSchema = z
  .object({
    path: lifeSourcePathSchema.refine(
      (path) =>
        (path.startsWith('src/renderer/') || path.startsWith('src/shared/')) &&
        !['src/renderer/bootstrap.ts', 'src/renderer/index.html'].includes(path.toLowerCase()),
      'Only renderer and shared source can be edited; native host source is read-only',
    ),
    content: z.string().max(1_000_000).nullable().optional(),
    edits: z
      .array(
        z
          .object({ find: z.string().min(1).max(500_000), replace: z.string().max(500_000) })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .refine(
    (file) => (file.content !== undefined) !== (file.edits !== undefined),
    'A file change must have either content or edits, but not both',
  )

const dependencyName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const dependencyVersion = /^(?:\^|~)?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i

export const lifeSourcePatchSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    baseRevision: z.number().int().min(0),
    files: z.array(fileChangeSchema).max(100),
    dependencies: z
      .record(
        z.string().regex(dependencyName, 'Use an npm package name'),
        z
          .string()
          .regex(dependencyVersion, 'Use an explicit npm semver version, optionally ^ or ~'),
      )
      .optional(),
  })
  .strict()
  .refine(
    (patch) => patch.files.length > 0 || Object.keys(patch.dependencies || {}).length > 0,
    'A source proposal must change files or dependencies',
  )
  .refine(
    (patch) =>
      new Set(patch.files.map((file) => file.path.toLowerCase())).size === patch.files.length,
    'Each source path may occur once per proposal',
  )

export const lifeSourceReadSchema = z
  .object({ paths: z.array(lifeSourcePathSchema).min(1).max(30) })
  .strict()

export type LifeSourcePatch = z.infer<typeof lifeSourcePatchSchema>
export type LifeSourceRead = z.infer<typeof lifeSourceReadSchema>

export interface LifeSourceAsset {
  revision: number
  /** Stable custom-protocol URLs. The native host serves only committed build assets. */
  js: string
  css?: string
}

export interface LifeSourceSnapshot {
  revision: number
  enabled: boolean
  active?: LifeSourceAsset
  canRollback: boolean
  path: string
  error?: string
  recovered: boolean
  summary?: string
  /** A newer installed renderer is available; preserved edits should be rebased before activation. */
  baseChanged?: boolean
}

export interface LifeSourceContext {
  revision: number
  paths: string[]
  files: Array<{ path: string; content: string }>
  dependencies: Record<string, string>
  snapshot: LifeSourceSnapshot
  /** New installed originals for requested files when a Life update changed the base source. */
  baselineFiles?: Array<{ path: string; content: string }>
}

export function parseLifeSourcePatch(value: unknown): LifeSourcePatch {
  assertExtensionJson(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_000_000)
    throw new Error('A Life source proposal must be smaller than 2 MB')
  return lifeSourcePatchSchema.parse(value)
}

export function parseLifeSourceRead(value: unknown): LifeSourceRead {
  assertExtensionJson(value)
  return lifeSourceReadSchema.parse(value)
}
