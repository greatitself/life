import { z } from 'zod'
import { assertExtensionJson, extensionIdSchema } from './extensions'
import { lifeSourcePathSchema, sourceDependencyName, sourceDependencyVersion } from './source-code'

export const sourceExtensionPathSchema = lifeSourcePathSchema.refine(
  (path) =>
    (path.startsWith('src/renderer/') || path.startsWith('src/shared/')) &&
    !['src/renderer/bootstrap.ts', 'src/renderer/index.html'].includes(path.toLowerCase()),
  'Source extensions can change renderer and shared files; the native host and recovery loader are read-only',
)

const sourceExtensionFileSchema = z.discriminatedUnion('kind', [
  z
    .object({
      path: sourceExtensionPathSchema,
      kind: z.literal('patch'),
      baseHash: z.string().regex(/^[a-f0-9]{64}$/),
      preimage: z.string().max(1_000_000),
      content: z.string().max(1_000_000),
      patch: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      path: sourceExtensionPathSchema,
      kind: z.literal('create'),
      content: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      path: sourceExtensionPathSchema,
      kind: z.literal('delete'),
      baseHash: z.string().regex(/^[a-f0-9]{64}$/),
      preimage: z.string().max(1_000_000),
    })
    .strict(),
])

export const sourceExtensionBundleSchema = z
  .object({
    format: z.literal('life-source-extension'),
    formatVersion: z.literal(1),
    id: extensionIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    files: z.array(sourceExtensionFileSchema).max(100),
    dependencies: z
      .record(
        z.string().regex(sourceDependencyName, 'Use an npm package name'),
        z
          .string()
          .regex(sourceDependencyVersion, 'Use an explicit npm semver version, optionally ^ or ~'),
      )
      .refine(
        (dependencies) => Object.keys(dependencies).length <= 100,
        'A source extension can declare up to 100 dependencies',
      ),
  })
  .strict()
  .refine(
    (bundle) =>
      new Set(bundle.files.map((file) => file.path.toLowerCase())).size === bundle.files.length,
    'Each source file may occur once per extension',
  )
  .refine(
    (bundle) => bundle.files.length > 0 || Object.keys(bundle.dependencies).length > 0,
    'A source extension must change files or dependencies',
  )

export type SourceExtensionBundle = z.infer<typeof sourceExtensionBundleSchema>
export type SourceExtensionFile = SourceExtensionBundle['files'][number]

export interface SourceExtensionSummary {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  /** Trusted optional feature shipped with Life; controlled without compiling archived code. */
  builtIn?: true
  /** Deleted built-ins stay disabled and remain available only in the recovery list. */
  deleted?: true
  originalId?: string
  features?: readonly string[]
  effect?: string
  /** Original portable bundle retained for export after its changes became built-in. */
  incorporated?: true
  files: string[]
  dependencies: Record<string, string>
  createdAt: string
  updatedAt: string
  error?: string
}

export function parseSourceExtensionBundle(value: unknown): SourceExtensionBundle {
  assertExtensionJson(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8_000_000)
    throw new Error('A source extension must be smaller than 8 MB')
  return sourceExtensionBundleSchema.parse(value)
}
