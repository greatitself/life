import { z } from 'zod'

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, numbers, underscores or hyphens for IDs')
const provider = z.enum(['codex', 'claude'])
const mode = z.enum(['review', 'edit', 'plan'])

export const lifeCommandSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(20000),
    provider: provider.optional(),
    mode: mode.optional(),
  })
  .strict()

export const lifeWidgetSchema = z
  .object({
    id: identifier,
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['markdown', 'mermaid']),
    content: z.string().max(50000),
    placement: z.enum(['research', 'workspace', 'both']),
  })
  .strict()

export const lifeLabelsSchema = z
  .object({
    researchTitle: z.string().trim().min(1).max(120),
    workspaceTitle: z.string().trim().min(1).max(120),
    welcomeTitle: z.string().trim().min(1).max(120),
    welcomeSubtitle: z.string().trim().max(280),
  })
  .strict()

function uniqueIds(items: { id: string }[]) {
  return new Set(items.map((item) => item.id)).size === items.length
}

export const lifeConfigSchema = z
  .object({
    version: z.literal(1),
    theme: z.enum(['dark', 'light']),
    startView: z.enum(['research', 'workspace']),
    density: z.enum(['comfortable', 'compact']),
    fontSize: z.number().int().min(12).max(20),
    sidebarWidth: z.number().int().min(220).max(420),
    workspacePanelWidth: z.number().int().min(260).max(520),
    workspacePanel: z.boolean(),
    autoPortForward: z.boolean(),
    defaultProvider: provider,
    defaultMode: mode,
    defaultModel: z.string().max(200),
    labels: lifeLabelsSchema,
    commands: z.array(lifeCommandSchema).max(32).refine(uniqueIds, 'Command IDs must be unique'),
    widgets: z.array(lifeWidgetSchema).max(12).refine(uniqueIds, 'Widget IDs must be unique'),
  })
  .strict()

export const configPatchSchema = lifeConfigSchema.partial().extend({
  labels: lifeLabelsSchema.partial().optional(),
})

export type LifeCommand = z.infer<typeof lifeCommandSchema>
export type LifeWidget = z.infer<typeof lifeWidgetSchema>
export type LifeConfig = z.infer<typeof lifeConfigSchema>
export type LifeConfigPatch = z.infer<typeof configPatchSchema>

export interface LifeConfigSnapshot {
  config: LifeConfig
  revision: number
  canUndo: boolean
  path: string
  error?: string
}

export type LifeConfigState = LifeConfigSnapshot

export const defaultLifeConfig: LifeConfig = {
  version: 1,
  theme: 'dark',
  startView: 'workspace',
  density: 'comfortable',
  fontSize: 14,
  sidebarWidth: 260,
  workspacePanelWidth: 320,
  workspacePanel: true,
  autoPortForward: true,
  defaultProvider: 'codex',
  defaultMode: 'review',
  defaultModel: '',
  labels: {
    researchTitle: 'Research map',
    workspaceTitle: 'Agent workspace',
    welcomeTitle: 'Give your next idea a place to grow.',
    welcomeSubtitle: 'Connect a machine and investigate with Codex or Claude Code.',
  },
  commands: [],
  widgets: [],
}

// IPC inputs and hand-edited config files must contain data, never executable objects.
// Check before spreading or serializing so special keys and toJSON cannot affect the app.
function assertPlainJson(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 20) throw new Error('Life configuration is nested too deeply')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new Error('Life configuration must contain JSON data')
  if (seen.has(value)) throw new Error('Life configuration cannot contain circular references')
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error('Life configuration must contain plain objects')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('Life configuration cannot contain symbol keys')
    if (['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key))
      throw new Error(`Life configuration contains an unsupported key: ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set)
      throw new Error('Life configuration cannot contain getters or setters')
    if (Array.isArray(value) && key === 'length') continue
    assertPlainJson(descriptor?.value, seen, depth + 1)
  }
  seen.delete(value)
}

export function parseLifeConfig(value: unknown): LifeConfig {
  assertPlainJson(value)
  // Existing version-1 files predate forwarding. Default full configurations,
  // rather than patches, so an empty agent response cannot enable a feature.
  const compatible =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'autoPortForward')
      ? { ...value, autoPortForward: true }
      : value
  const config = lifeConfigSchema.parse(compatible)
  if (JSON.stringify(config).length > 300000)
    throw new Error('Life configuration must be smaller than 300,000 characters')
  return config
}

export function parseLifeConfigPatch(value: unknown): LifeConfigPatch {
  assertPlainJson(value)
  const patch = configPatchSchema.parse(value)
  if (Object.keys(patch).length === 0)
    throw new Error('A customization must change at least one setting')
  return patch
}

export function mergeLifeConfig(config: LifeConfig, value: unknown): LifeConfig {
  const patch = parseLifeConfigPatch(value)
  return parseLifeConfig({
    ...config,
    ...patch,
    labels: { ...config.labels, ...patch.labels },
  })
}
