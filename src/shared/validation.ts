import { z } from 'zod'
import { lifeStudioContextSchema } from './life-studio'
export const sshConfigAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/, 'Enter a concrete SSH config host alias')
export const sshConfigPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\x00-\x1f]/.test(value), 'Enter a valid SSH config path')
export const remoteDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\x00-\x1f]/.test(value), 'Enter a valid remote path')
export const profileSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.:[\]_-]+$/, 'Enter a hostname or IP address'),
  port: z.number().int().min(1).max(65535),
  username: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/),
  auth: z.enum(['agent', 'key', 'password']),
  privateKeyPath: z.string().max(4096),
  workspace: remoteDirectorySchema.default('~'),
  sshConfig: z.object({ alias: sshConfigAliasSchema, path: sshConfigPathSchema }).optional(),
})
export const connectSchema = profileSchema.extend({
  password: z.string().max(4096).optional(),
  passphrase: z.string().max(4096).optional(),
})
export const connectionExecutionSchema = z
  .object({
    scope: z.enum(['project', 'machine']).optional(),
    command: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => value.trim().length > 0, 'Enter a remote command')
      .refine((value) => !value.includes('\0'), 'Enter a valid remote command')
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 100000,
        'Remote commands must not exceed 100 KB',
      ),
    workspace: remoteDirectorySchema.optional(),
    timeoutMs: z.number().int().min(1).max(120000).default(30000),
  })
  .strict()
const optionNameSchema = z
  .string()
  .max(200)
  .refine((value) => !/[\x00-\x1f]/.test(value), 'Enter a valid provider option')
const jsonValueSchema = z.custom<unknown>((value) => {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const next = pending.pop()!
    if (++nodes > 10000 || next.depth > 20) return false
    if (next.value === null || ['string', 'boolean'].includes(typeof next.value)) continue
    if (typeof next.value === 'number' && Number.isFinite(next.value)) continue
    if (typeof next.value !== 'object' || !next.value) return false
    if (!Array.isArray(next.value) && Object.getPrototypeOf(next.value) !== Object.prototype)
      return false
    for (const item of Object.values(next.value))
      pending.push({ value: item, depth: next.depth + 1 })
  }
  return true
}, 'Provider options must be bounded JSON values')
const providerRecordSchema = z.record(
  z
    .string()
    .min(1)
    .max(200)
    .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key)),
  jsonValueSchema,
)
const reservedProtocolFields = new Set([
  'threadId',
  'input',
  'cwd',
  'approvalPolicy',
  'sandbox',
  'sandboxPolicy',
  'baseInstructions',
  'developerInstructions',
  'instructions',
])
const reservedClaudeArguments = new Set([
  '-p',
  '--print',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--session-id',
  '--input-format',
  '--output-format',
  '--permission-prompt-tool',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--model',
  '--effort',
  '--settings',
  '--cwd',
  '--help',
  '-h',
  '--version',
  '-v',
  '--no-session-persistence',
  '--fork-session',
  '--',
  '--system-prompt',
  '--append-system-prompt',
])
export const agentProviderOptionsSchema = z
  .object({
    thread: providerRecordSchema.optional(),
    turn: providerRecordSchema.optional(),
    settings: providerRecordSchema.optional(),
    args: z
      .array(
        z
          .string()
          .max(20000)
          .refine((value) => !value.includes('\0')),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      if (JSON.stringify(value).length > 128000)
        context.addIssue({ code: 'custom', message: 'Provider options exceed 128 KB' })
    } catch {
      context.addIssue({ code: 'custom', message: 'Provider options must be JSON values' })
    }
    for (const scope of ['thread', 'turn'] as const)
      for (const key of Object.keys(value[scope] || {}))
        if (reservedProtocolFields.has(key))
          context.addIssue({
            code: 'custom',
            path: [scope, key],
            message: `${key} is managed by Life; use the corresponding agent.start field`,
          })
    for (const [index, argument] of (value.args || []).entries())
      if (reservedClaudeArguments.has(argument.split('=')[0]) || /^-[prcvh][^-]/.test(argument))
        context.addIssue({
          code: 'custom',
          path: ['args', index],
          message: `${argument.split('=')[0]} is managed by Life; use the corresponding agent.start field`,
        })
  })
export const agentAttachmentsSchema = z
  .array(
    z
      .object({
        remotePath: remoteDirectorySchema,
        name: z.string().min(1).max(1024),
        mimeType: z.string().max(200),
      })
      .strict(),
  )
  .max(20)
export const startSchema = z
  .object({
    sessionId: z.string().min(1).max(100),
    provider: z.enum(['codex', 'claude']),
    remoteId: z.string().max(200).optional(),
    prompt: z.string().max(1000000),
    model: z.string().max(200).optional(),
    reasoningEffort: optionNameSchema.optional(),
    serviceTier: optionNameSchema.optional(),
    providerOptions: agentProviderOptionsSchema.optional(),
    mode: z.enum(['review', 'edit', 'plan']),
    workspace: remoteDirectorySchema.optional(),
    scope: z.enum(['life-customization', 'research']).optional(),
    studioContext: lifeStudioContextSchema.optional(),
    attachments: agentAttachmentsSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.prompt.trim() && !value.attachments?.length)
      context.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'Enter a message or attach a file.',
      })
    if (value.studioContext && value.scope !== 'life-customization')
      context.addIssue({
        code: 'custom',
        path: ['studioContext'],
        message: 'App instructions are available only in Life Studio.',
      })
  })
export const agentSettingsSchema = z
  .object({
    sessionId: z.string().min(1).max(100),
    model: optionNameSchema.optional(),
    reasoningEffort: optionNameSchema.optional(),
    serviceTier: optionNameSchema.optional(),
    mode: z.enum(['review', 'edit', 'plan']).optional(),
  })
  .strict()
export const agentSteerSchema = z
  .object({
    sessionId: z.string().min(1).max(100),
    prompt: z.string().max(1000000),
    attachments: agentAttachmentsSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.prompt.trim() || value.attachments?.length),
    'Enter a message or attach a file.',
  )
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
