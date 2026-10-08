import { z } from 'zod'
import {
  PORTABLE_EXTENSION_FILENAME,
  PORTABLE_EXTENSION_MAX_BYTES,
  canonicalPublicGistURL,
  parsePortableExtension,
  publicGistId,
  serializePortableExtension,
  type LifePortableExtension,
  type LifePublishedExtension,
  type LifePublicExtensionPreview,
} from '../shared/extension-sharing'
import { assertExtensionJson } from '../shared/extensions'

interface ExtensionSharingOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

const GITHUB_API = 'https://api.github.com/gists'
const API_RESPONSE_MAX_BYTES = 18 * 1024 * 1024

/** Only these errors may cross the response-stream boundary verbatim. */
class SharingRequestError extends Error {}
const gistResponseSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16,64}$/i),
  html_url: z.string().max(300),
  public: z.boolean(),
  truncated: z.boolean().optional(),
  files: z.record(
    z.string(),
    z.object({
      filename: z.string().optional(),
      content: z.string().optional(),
      raw_url: z.string().optional(),
      size: z.number().int().min(0).optional(),
      truncated: z.boolean().optional(),
    }),
  ),
})

function tokenValid(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    (/^[a-f0-9]{40}$/i.test(token) ||
      /^gh[pousr]_[a-z0-9]{20,255}$/i.test(token) ||
      /^github_pat_[a-z0-9_]{20,255}$/i.test(token))
  )
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function markdownText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}[\]()#+.!<>|]/g, '\\$&')
}

function readme(bundle: LifePortableExtension): string {
  const extension = bundle.extension
  const details =
    bundle.kind === 'source'
      ? `Source extension: ${bundle.extension.files.length} file changes and ${Object.keys(bundle.extension.dependencies).length} npm dependencies.`
      : 'Runtime extension: an isolated interface and optional Node worker.'
  return `# ${markdownText(extension.name)}\n\n${markdownText(extension.description)}\n\nVersion: ${markdownText(extension.version)}\n\n${details}\n\nThis Gist contains one portable Life extension. Its JSON file contains the code to review before installation.\n\nTo install, open **Extensions** in Life, choose **Import public link**, and paste this Gist URL. Review the extension, then choose **Install**.\n\nSource extensions change Life’s interface. Runtime extensions can execute Node code when enabled.\n`
}

function httpError(status: number, importing: boolean, rateLimited: boolean): Error {
  if (rateLimited || status === 429)
    return new Error('GitHub’s request limit has been reached. Try again later.')
  if (status === 401)
    return new Error(
      'GitHub rejected this token. Use a valid token with permission to write Gists.',
    )
  if (status === 403)
    return new Error(
      importing
        ? 'GitHub did not allow this public Gist to be read. Try again later.'
        : 'GitHub denied publication. The token needs the gist scope or Gists write permission.',
    )
  if (status === 404)
    return new Error(
      importing
        ? 'This public GitHub Gist was not found. Check its link and visibility.'
        : 'GitHub could not create the Gist. Check your token’s Gists permission.',
    )
  if (status === 422)
    return new Error('GitHub could not publish this extension. Check its size and try again.')
  if (status >= 300 && status < 400)
    return new Error('GitHub returned a redirect. Use the original public Gist link.')
  if (status >= 500) return new Error('GitHub is unavailable. Try again later.')
  return new Error(`GitHub could not ${importing ? 'read' : 'publish'} the extension (${status}).`)
}

async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit)
    throw new SharingRequestError('The public extension response is too large.')
  if (!response.body) throw new SharingRequestError('GitHub returned an empty extension response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted)
        throw new SharingRequestError('GitHub’s extension request timed out. Try again.')
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new SharingRequestError('The public extension response is too large.')
      }
      chunks.push(chunk.value)
    }
    const content = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      content.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new Error('GitHub returned invalid extension JSON.')
  }
}

/** The raw endpoint is used only for a verified file GitHub marked as truncated. */
function verifiedRawURL(value: string, gistId: string): string {
  if (
    !/^https:\/\/gist\.githubusercontent\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-f0-9]{16,64}\/raw\/(?:[a-f0-9]{16,64}\/)?extension\.life-extension\.json$/i.test(
      value,
    )
  )
    throw new Error('GitHub returned an invalid extension download link.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('GitHub returned an invalid extension download link.')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'gist.githubusercontent.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[%\\\u0000-\u0020\u007f]/.test(value) ||
    url.pathname.includes('//') ||
    ![4, 5].includes(parts.length) ||
    !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0]) ||
    parts[1].toLowerCase() !== gistId ||
    parts[2] !== 'raw' ||
    parts.at(-1) !== PORTABLE_EXTENSION_FILENAME ||
    (parts.length === 5 && !/^[a-f0-9]{16,64}$/i.test(parts[3]))
  )
    throw new Error('GitHub returned an invalid extension download link.')
  return url.href
}

/** Publishes only after the app's explicit review-and-publish action. No credentials are saved. */
export class ExtensionSharing {
  private readonly fetch?: typeof fetch
  private readonly timeoutMs: number

  constructor(options: ExtensionSharingOptions = {}) {
    this.fetch = options.fetch
    this.timeoutMs = Math.max(1, Math.min(120_000, options.timeoutMs ?? 30_000))
  }

  async publish(input: unknown): Promise<LifePublishedExtension> {
    assertExtensionJson(input)
    const parsed = z
      .object({ bundle: z.unknown(), token: z.unknown(), description: z.unknown().optional() })
      .strict()
      .safeParse(input)
    if (!parsed.success) throw new Error('Publish one reviewed portable Life extension.')
    const proposal = parsed.data
    if (!tokenValid(proposal.token))
      throw new Error('Enter a GitHub token with the gist scope or Gists write permission.')
    const bundle = parsePortableExtension(proposal.bundle)
    const description = proposal.description ?? `${bundle.extension.name} — Life extension`
    if (typeof description !== 'string' || description.length > 1000)
      throw new Error('Use a public description of at most 1,000 characters.')
    const body = JSON.stringify({
      description,
      public: true,
      files: {
        [PORTABLE_EXTENSION_FILENAME]: { content: serializePortableExtension(bundle) },
        'README.md': { content: readme(bundle) },
      },
    })
    if (body.includes(proposal.token))
      throw new Error('Remove the publication token from the extension or public description.')
    // Never interpolate the token into a request URL, portable JSON, README, errors, or results.
    const response = await this.request(
      GITHUB_API,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${proposal.token}` },
        body,
      },
      201,
      API_RESPONSE_MAX_BYTES,
      false,
    )
    const gist = this.parseGist(parseJson(response))
    const file = gist.files[PORTABLE_EXTENSION_FILENAME]
    if (!file || (file.filename && file.filename !== PORTABLE_EXTENSION_FILENAME))
      throw new Error('GitHub did not confirm the published portable extension file.')
    return {
      id: gist.id,
      url: canonicalPublicGistURL(gist.html_url),
      filename: PORTABLE_EXTENSION_FILENAME,
    }
  }

  async inspectPublic(link: string): Promise<LifePublicExtensionPreview> {
    const id = publicGistId(link)
    const response = await this.request(
      `${GITHUB_API}/${id}`,
      { method: 'GET' },
      200,
      API_RESPONSE_MAX_BYTES,
      true,
    )
    const gist = this.parseGist(parseJson(response), id)
    const file = gist.files[PORTABLE_EXTENSION_FILENAME]
    if (!file || (file.filename && file.filename !== PORTABLE_EXTENSION_FILENAME))
      throw new Error(`This Gist does not contain ${PORTABLE_EXTENSION_FILENAME}.`)
    if (file.size !== undefined && file.size > PORTABLE_EXTENSION_MAX_BYTES)
      throw new Error('A portable Life extension must be smaller than 8 MB.')
    let content = file.content
    if (file.truncated || content === undefined) {
      if (!file.raw_url) throw new Error('GitHub did not provide the complete extension file.')
      content = await this.request(
        verifiedRawURL(file.raw_url, id),
        { method: 'GET' },
        200,
        PORTABLE_EXTENSION_MAX_BYTES,
        true,
      )
    }
    if (textBytes(content) > PORTABLE_EXTENSION_MAX_BYTES)
      throw new Error('A portable Life extension must be smaller than 8 MB.')
    const bundle = parsePortableExtension(parseJson(content))
    return { id, url: canonicalPublicGistURL(gist.html_url), bundle }
  }

  private parseGist(value: unknown, expectedId?: string) {
    let gist: z.infer<typeof gistResponseSchema>
    try {
      gist = gistResponseSchema.parse(value)
    } catch {
      throw new Error('GitHub returned an invalid public extension response.')
    }
    gist.id = gist.id.toLowerCase()
    if (!gist.public) throw new Error('Only public GitHub Gists can be shared or imported.')
    if (gist.truncated) throw new Error('GitHub returned an incomplete Gist file listing.')
    if (publicGistId(gist.html_url) !== gist.id || (expectedId && gist.id !== expectedId))
      throw new Error('GitHub returned a different extension than the requested Gist.')
    return gist
  }

  private async request(
    url: string,
    init: RequestInit,
    expectedStatus: number,
    maxBytes: number,
    importing: boolean,
  ): Promise<string> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error('GitHub’s extension request timed out. Try again.'))
      }, this.timeoutMs)
    })
    const execute = async () => {
      let response: Response
      try {
        response = await (this.fetch ?? globalThis.fetch)(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'Life-extension-sharing',
            ...init.headers,
          },
        })
      } catch {
        throw new Error(
          timedOut
            ? 'GitHub’s extension request timed out. Try again.'
            : 'Cannot reach GitHub. Check your connection and try again.',
        )
      }
      if (response.redirected) throw new Error('GitHub returned an unexpected redirect.')
      if (response.status !== expectedStatus)
        throw httpError(
          response.status,
          importing,
          response.headers.get('x-ratelimit-remaining') === '0',
        )
      try {
        return await readBoundedText(response, maxBytes, controller.signal)
      } catch (error) {
        if (error instanceof SharingRequestError) throw error
        throw new Error(
          timedOut
            ? 'GitHub’s extension request timed out. Try again.'
            : 'GitHub returned an unreadable extension response. Try again.',
        )
      }
    }
    try {
      return await Promise.race([execute(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }
}
