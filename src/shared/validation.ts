import { z } from 'zod'
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
export const startSchema = z.object({
  sessionId: z.string().min(1).max(100),
  provider: z.enum(['codex', 'claude']),
  remoteId: z.string().max(200).optional(),
  prompt: z.string().trim().min(1).max(1000000),
  model: z.string().max(200).optional(),
  mode: z.enum(['review', 'edit', 'plan']),
  workspace: remoteDirectorySchema.optional(),
})
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
