import { z } from 'zod'

/** A research map can contain 4 MB of source, plus its themed document wrapper. */
export const researchDocumentByteLimit = 4_000_000 + 65_536
export const researchDocumentHTMLSchema = z
  .string()
  .min(1)
  .max(researchDocumentByteLimit)
  .refine(
    (value) =>
      value.length <= researchDocumentByteLimit &&
      new TextEncoder().encode(value).byteLength <= researchDocumentByteLimit,
    'Research HTML documents must not exceed 4 MB plus their presentation wrapper.',
  )

export const researchDocumentIdSchema = z.string().uuid()

export interface ResearchDocumentReference {
  id: string
  url: string
}

export interface ResearchDocumentsAPI {
  register(html: string): Promise<ResearchDocumentReference>
  revoke(id: string): Promise<void>
}

/** A separate document may run map scripts without acquiring renderer privileges. */
export const researchDocumentCSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https: http:',
  'font-src data: https:',
  'media-src data: blob: https: http:',
  'connect-src https: http:',
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')
