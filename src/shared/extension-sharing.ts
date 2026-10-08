import { z } from 'zod'
import {
  assertExtensionJson,
  parseExtensionManifest,
  type LifeExtensionManifest,
} from './extensions'
import { parseSourceExtensionBundle, type SourceExtensionBundle } from './source-extensions'

/** A portable file contains one reviewed extension, without Life's local settings or history. */
export type LifePortableExtension =
  | {
      format: 'life-extension'
      formatVersion: 1
      kind: 'runtime'
      extension: LifeExtensionManifest
    }
  | {
      format: 'life-extension'
      formatVersion: 1
      kind: 'source'
      extension: SourceExtensionBundle
    }

export const PORTABLE_EXTENSION_FILENAME = 'extension.life-extension.json'
export const PORTABLE_EXTENSION_MAX_BYTES = 8 * 1024 * 1024

export interface LifePublishExtensionInput {
  bundle: LifePortableExtension
  /** Used for this publication only. It is never included in the portable file or stored. */
  token: string
  description?: string
}

export interface LifePublishedExtension {
  id: string
  url: string
  filename: string
}

export interface LifePublicExtensionPreview {
  id: string
  url: string
  bundle: LifePortableExtension
}

const portableSchema = z
  .object({
    format: z.literal('life-extension'),
    formatVersion: z.literal(1),
    kind: z.enum(['runtime', 'source']),
    extension: z.unknown(),
  })
  .strict()

export function parsePortableExtension(value: unknown): LifePortableExtension {
  assertExtensionJson(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PORTABLE_EXTENSION_MAX_BYTES)
    throw new Error('A portable Life extension must be smaller than 8 MB.')
  const envelope = portableSchema.parse(value)
  if (envelope.kind === 'runtime') {
    return { ...envelope, kind: 'runtime', extension: parseExtensionManifest(envelope.extension) }
  }
  return { ...envelope, kind: 'source', extension: parseSourceExtensionBundle(envelope.extension) }
}

export function buildRuntimePortableExtension(manifest: unknown): LifePortableExtension {
  return parsePortableExtension({
    format: 'life-extension',
    formatVersion: 1,
    kind: 'runtime',
    extension: parseExtensionManifest(manifest),
  })
}

export function buildSourcePortableExtension(bundle: unknown): LifePortableExtension {
  return parsePortableExtension({
    format: 'life-extension',
    formatVersion: 1,
    kind: 'source',
    extension: parseSourceExtensionBundle(bundle),
  })
}

export function serializePortableExtension(value: unknown): string {
  const serialized = `${JSON.stringify(parsePortableExtension(value), null, 2)}\n`
  if (new TextEncoder().encode(serialized).byteLength > PORTABLE_EXTENSION_MAX_BYTES)
    throw new Error('A portable Life extension must be smaller than 8 MB.')
  return serialized
}

const gistIdPattern = /^[a-f0-9]{16,64}$/i
const gistOwnerPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i

/** Links are identifiers only; network requests always use our fixed GitHub API endpoint. */
export function publicGistId(value: string): string {
  if (typeof value !== 'string' || value.length > 300)
    throw new Error('Use a public GitHub Gist link or Gist ID.')
  const input = value.trim()
  if (gistIdPattern.test(input)) return input.toLowerCase()
  if (
    !/^https:\/\/(?:gist\.github\.com\/(?:[a-z0-9][a-z0-9-]{0,38}\/)?[a-f0-9]{16,64}|api\.github\.com\/gists\/[a-f0-9]{16,64})\/?$/i.test(
      input,
    )
  )
    throw new Error('Use a public GitHub Gist link or Gist ID.')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Use a public GitHub Gist link or Gist ID.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    /[%\\]/.test(input) ||
    /[\u0000-\u0020\u007f]/.test(input)
  )
    throw new Error('Use a public GitHub Gist link without credentials, a query, or a fragment.')
  const parts = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (url.hostname === 'gist.github.com') {
    if (parts.length === 1) id = parts[0]
    if (parts.length === 2 && gistOwnerPattern.test(parts[0])) id = parts[1]
  } else if (url.hostname === 'api.github.com' && parts.length === 2 && parts[0] === 'gists') {
    id = parts[1]
  }
  if (!id || !gistIdPattern.test(id) || url.pathname.includes('//'))
    throw new Error('Use a public GitHub Gist link or Gist ID.')
  return id.toLowerCase()
}

export function canonicalPublicGistURL(value: string): string {
  return `https://gist.github.com/${publicGistId(value)}`
}
