import { z } from 'zod'

/** Instructions and app-owned context are files, never hidden additions to a user message. */
export const lifeStudioContextSchema = z
  .object({
    instructions: z.string().min(1).max(100_000),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^\.life\/[a-z][a-z0-9-]*\.json$/),
            content: z.string().max(2_000_000),
          })
          .strict(),
      )
      .max(30),
    revision: z.number().int().min(0),
    phase: z.enum(['request', 'source-read', 'repair']),
  })
  .strict()
  .refine(
    (context) => new Set(context.files.map((file) => file.path)).size === context.files.length,
    'Studio context files must have unique names',
  )
  .refine(
    (context) =>
      new TextEncoder().encode(
        context.instructions + context.files.map((file) => file.content).join(''),
      ).byteLength <= 3_000_000,
    'Studio instruction context must be smaller than 3 MB',
  )

export type LifeStudioContext = z.infer<typeof lifeStudioContextSchema>
