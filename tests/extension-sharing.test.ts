import { describe, expect, it, vi } from 'vitest'
import { ExtensionSharing } from '../src/main/extension-sharing'
import {
  PORTABLE_EXTENSION_FILENAME,
  buildRuntimePortableExtension,
  buildSourcePortableExtension,
  parsePortableExtension,
  serializePortableExtension,
} from '../src/shared/extension-sharing'
import type { LifeExtensionManifest } from '../src/shared/extensions'
import type { SourceExtensionBundle } from '../src/shared/source-extensions'

const gistId = '7c1be913f2d94841990b0743c82ce8aa'
const gistUrl = `https://gist.github.com/researcher/${gistId}`
const canonicalGistUrl = `https://gist.github.com/${gistId}`
const token = 'github_pat_abcABC123abcABC123abcABC123abcABC123'

function manifest(): LifeExtensionManifest {
  return {
    id: 'research-notes',
    name: 'Research notes',
    description: 'A portable experiment notebook',
    version: '1.0.0',
    renderer: {
      html: '<h2>Research notes</h2>',
      css: 'h2 { color: inherit; }',
      js: 'window.notes = [];',
      placement: 'panel',
    },
    main: "life.handle('ping', async () => 'ready');",
    enabled: true,
  }
}

function portable() {
  return buildRuntimePortableExtension(manifest())
}

function sourceExtension(): SourceExtensionBundle {
  return {
    format: 'life-source-extension',
    formatVersion: 1,
    id: 'hypothesis-backlog',
    name: 'Hypothesis backlog',
    description: 'A live React workspace component',
    version: '1.0.0',
    createdAt: '2026-10-08T02:00:00.000Z',
    updatedAt: '2026-10-08T02:00:00.000Z',
    files: [
      {
        path: 'src/renderer/components/HypothesisBacklog.tsx',
        kind: 'create',
        content: 'export const HypothesisBacklog = () => <section>Hypotheses</section>;',
      },
    ],
    dependencies: { clsx: '2.1.1' },
  }
}

function gist(overrides: Record<string, unknown> = {}) {
  return {
    id: gistId,
    html_url: gistUrl,
    public: true,
    files: {
      [PORTABLE_EXTENSION_FILENAME]: {
        filename: PORTABLE_EXTENSION_FILENAME,
        truncated: false,
        content: serializePortableExtension(portable()),
      },
    },
    ...overrides,
  }
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockSharing(
  response: Response | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
  timeoutMs = 1000,
) {
  const fetchMock = vi.fn(typeof response === 'function' ? response : async () => response)
  return {
    sharing: new ExtensionSharing({ fetch: fetchMock as typeof fetch, timeoutMs }),
    fetchMock,
  }
}

describe('portable Life extension envelopes', () => {
  it('round trips only extension code and metadata through a versioned portable file', () => {
    const bundle = portable()
    expect(PORTABLE_EXTENSION_FILENAME).toBe('extension.life-extension.json')
    expect(bundle).toEqual({
      format: 'life-extension',
      formatVersion: 1,
      kind: 'runtime',
      extension: manifest(),
    })
    expect(parsePortableExtension(JSON.parse(serializePortableExtension(bundle)))).toEqual(bundle)
    expect(serializePortableExtension(bundle)).not.toContain('accessToken')
    expect(serializePortableExtension(bundle)).not.toContain('connectionProfiles')
  })

  it('rejects extra application data, unsupported envelope versions and malformed manifests', () => {
    for (const invalid of [
      { ...portable(), format: 'other-app' },
      { ...portable(), formatVersion: 2 },
      { ...portable(), kind: 'native-binary' },
      { ...portable(), sessions: [{ prompt: 'private research' }] },
      { ...portable(), extension: { ...manifest(), id: '../escape' } },
      { ...portable(), extension: { ...manifest(), accessToken: token } },
    ]) {
      expect(() => parsePortableExtension(invalid)).toThrow()
    }
  })

  it('rejects executable objects without invoking getters or serialization hooks', () => {
    const getter = vi.fn(() => portable())
    const unsafe = Object.defineProperty({}, 'extension', {
      enumerable: true,
      get: getter,
    })
    expect(() => parsePortableExtension(unsafe)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    const toJSON = vi.fn(() => portable())
    expect(() => serializePortableExtension({ ...portable(), toJSON } as never)).toThrow()
    expect(toJSON).not.toHaveBeenCalled()
    expect(() => parsePortableExtension(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow()
    expect(() => parsePortableExtension({ ...portable(), extension: new Map() })).toThrow()
  })

  it('enforces the runtime code limit before sharing or importing', () => {
    expect(() =>
      buildRuntimePortableExtension({
        ...manifest(),
        renderer: { ...manifest().renderer, js: 'λ'.repeat(300_000) },
      }),
    ).toThrow()
  })

  it('round trips genuine source extension files and npm dependencies without application state', () => {
    const bundle = buildSourcePortableExtension(sourceExtension())
    expect(bundle).toEqual({
      format: 'life-extension',
      formatVersion: 1,
      kind: 'source',
      extension: sourceExtension(),
    })
    expect(parsePortableExtension(JSON.parse(serializePortableExtension(bundle)))).toEqual(bundle)
  })

  it('rejects native source, recovery loaders, package URLs and leaked state in shared source bundles', () => {
    const extension = sourceExtension()
    for (const invalid of [
      { ...extension, workspace: '/private/research' },
      { ...extension, accessToken: token },
      { ...extension, files: [{ ...extension.files[0], path: 'src/main/index.ts' }] },
      { ...extension, files: [{ ...extension.files[0], path: 'src/renderer/bootstrap.ts' }] },
      { ...extension, files: [{ ...extension.files[0], path: 'src/renderer/../secrets.ts' }] },
      { ...extension, dependencies: { clsx: 'file:/private/local-package' } },
      { ...extension, files: [extension.files[0], extension.files[0]] },
    ]) {
      expect(() => buildSourcePortableExtension(invalid as SourceExtensionBundle)).toThrow()
    }
  })

  it('limits the combined source bundle size before publication or parsing', () => {
    const oversized = {
      ...sourceExtension(),
      files: Array.from({ length: 10 }, (_, index) => ({
        path: `src/renderer/component-${index}.ts`,
        kind: 'create' as const,
        content: 'x'.repeat(900_000),
      })),
    }
    expect(() => buildSourcePortableExtension(oversized)).toThrow(/large|MB|size/i)
  })
})

describe('explicit public GitHub Gist sharing', () => {
  it('publishes a public portable file and README using authentication only in the request header', async () => {
    const { sharing, fetchMock } = mockSharing(jsonResponse(gist(), 201))
    const result = await sharing.publish({
      bundle: portable(),
      token,
      description: 'A research notebook for Life',
    })
    expect(result).toEqual({
      id: gistId,
      url: canonicalGistUrl,
      filename: PORTABLE_EXTENSION_FILENAME,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.github.com/gists')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toMatch(
      new RegExp(`^(?:Bearer|token) ${token}$`),
    )
    const body = JSON.parse(String(init?.body))
    expect(body.public).toBe(true)
    expect(body.description).toBe('A research notebook for Life')
    expect(Object.keys(body.files).sort()).toEqual(
      ['README.md', PORTABLE_EXTENSION_FILENAME].sort(),
    )
    expect(
      parsePortableExtension(JSON.parse(body.files[PORTABLE_EXTENSION_FILENAME].content)),
    ).toEqual(portable())
    expect(body.files['README.md'].content).toMatch(/Life/)
    expect(String(init?.body)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('requires a token and validates the bundle before making any network request', async () => {
    const { sharing, fetchMock } = mockSharing(jsonResponse(gist(), 201))
    await expect(sharing.publish({ bundle: portable(), token: '   ' })).rejects.toThrow(/token/i)
    await expect(sharing.publish({ bundle: portable(), token: 'invalid-token' })).rejects.toThrow(
      /token/i,
    )
    await expect(
      sharing.publish({ bundle: { ...portable(), privateThreads: [] } as never, token }),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to upload the active credential embedded in public code or descriptions', async () => {
    const { sharing, fetchMock } = mockSharing(jsonResponse(gist(), 201))
    const runtime = buildRuntimePortableExtension({
      ...manifest(),
      renderer: { ...manifest().renderer, js: `window.accidentallyCopiedToken = '${token}';` },
    })
    const source = buildSourcePortableExtension({
      ...sourceExtension(),
      files: [{ ...sourceExtension().files[0], content: `export const token = '${token}';` }],
    })
    for (const input of [
      { bundle: runtime, token },
      { bundle: source, token },
      { bundle: portable(), token, description: `My copied credential: ${token}` },
    ]) {
      let error: unknown
      try {
        await sharing.publish(input)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(token)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, /token|authenticat|sign.?in/i],
    [403, /permission|scope|limit|GitHub/i],
    [422, /invalid|validat|publish|GitHub/i],
    [429, /rate|limit|later|GitHub/i],
  ])('reports a useful GitHub %i error without including credentials', async (status, message) => {
    const { sharing } = mockSharing(
      jsonResponse({ message: `Rejected credential ${token}` }, status),
    )
    let error: unknown
    try {
      await sharing.publish({ bundle: portable(), token })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(message)
    expect(String(error)).not.toContain(token)
  })

  it('redacts credentials even when the transport fails with a token in its diagnostic', async () => {
    const { sharing } = mockSharing(async () => {
      throw new Error(`Network rejected Authorization: Bearer ${token}`)
    })
    await expect(sharing.publish({ bundle: portable(), token })).rejects.not.toThrow(token)
  })

  it('redacts credentials from a failed response stream after successful headers arrive', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`Response body rejected Bearer ${token}`))
      },
    })
    const { sharing } = mockSharing(new Response(body, { status: 201 }))
    let error: unknown
    try {
      await sharing.publish({ bundle: portable(), token })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(token)
    expect(String(error)).toMatch(/GitHub|network|connection/i)
  })

  it('rejects a successful response pointing to a different gist or a private publication', async () => {
    for (const response of [
      gist({ html_url: 'https://gist.github.com/researcher/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      gist({ public: false }),
    ]) {
      const { sharing } = mockSharing(jsonResponse(response, 201))
      await expect(sharing.publish({ bundle: portable(), token })).rejects.toThrow()
    }
  })

  it('does not report a published extension when GitHub omitted its portable file', async () => {
    const { sharing } = mockSharing(jsonResponse(gist({ files: {} }), 201))
    await expect(sharing.publish({ bundle: portable(), token })).rejects.toThrow(/file|extension/i)
  })
})

describe('public Life extension inspection', () => {
  it('reads the exact public extension file anonymously through the fixed GitHub API', async () => {
    const { sharing, fetchMock } = mockSharing(
      jsonResponse(
        gist({
          files: {
            ...gist().files,
            'private-notes.json': { content: '{"secret":"not an extension"}' },
          },
        }),
      ),
    )
    const result = await sharing.inspectPublic(gistUrl)
    expect(result).toEqual({ id: gistId, url: canonicalGistUrl, bundle: portable() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://api.github.com/gists/${gistId}`)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(init?.redirect).toBe('error')
    expect(init?.body).toBeUndefined()
  })

  it.each([gistId, `https://gist.github.com/${gistId}`, `https://api.github.com/gists/${gistId}`])(
    'normalizes supported gist locations to the same anonymous API request: %s',
    async (link) => {
      const { sharing, fetchMock } = mockSharing(jsonResponse(gist()))
      expect((await sharing.inspectPublic(link)).id).toBe(gistId)
      expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.github.com/gists/${gistId}`)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    `http://gist.github.com/researcher/${gistId}`,
    `https://gist.github.com.evil.example/researcher/${gistId}`,
    `https://github.com/gists/${gistId}`,
    `https://gist.github.com:8443/researcher/${gistId}`,
    `https://gist.github.com:443/researcher/${gistId}`,
    `https://secret@gist.github.com/researcher/${gistId}`,
    `https://gist.github.com/researcher/../${gistId}`,
    `https://api.github.com/gists/../gists/${gistId}`,
    `${gistUrl}?token=private`,
    `${gistUrl}#extension`,
    `${gistUrl}/raw`,
    `https://gist.github.com/researcher/%2e%2e/${gistId}`,
    `https://gist.github.com/researcher/not-a-gist`,
    'file:///etc/passwd',
  ])('rejects an unsupported import location without fetching: %s', async (url) => {
    const { sharing, fetchMock } = mockSharing(jsonResponse(gist()))
    await expect(sharing.inspectPublic(url)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects private gists and refuses files with unrelated names', async () => {
    const privateGist = mockSharing(jsonResponse(gist({ public: false })))
    await expect(privateGist.sharing.inspectPublic(gistUrl)).rejects.toThrow(/public|private/i)
    const wrongFile = mockSharing(
      jsonResponse(gist({ files: { 'manifest.json': gist().files[PORTABLE_EXTENSION_FILENAME] } })),
    )
    await expect(wrongFile.sharing.inspectPublic(gistUrl)).rejects.toThrow(/file|extension/i)
  })

  it('rejects a public response with a mismatched identity or an off-site link', async () => {
    for (const response of [
      gist({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      gist({ html_url: `https://evil.example/${gistId}` }),
    ]) {
      const { sharing } = mockSharing(jsonResponse(response))
      await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow()
    }
  })

  it('rejects invalid portable JSON instead of treating imported data as installed code', async () => {
    const { sharing } = mockSharing(
      jsonResponse(
        gist({
          files: {
            [PORTABLE_EXTENSION_FILENAME]: {
              filename: PORTABLE_EXTENSION_FILENAME,
              content: JSON.stringify({
                ...portable(),
                extension: { ...manifest(), id: '../escape' },
              }),
              truncated: false,
            },
          },
        }),
      ),
    )
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow()
  })

  it('reads truncated gist content only from its matching anonymous GitHub raw file', async () => {
    const rawUrl = `https://gist.githubusercontent.com/researcher/${gistId}/raw/abcdef0123456789/${PORTABLE_EXTENSION_FILENAME}`
    const { sharing, fetchMock } = mockSharing(async (url) => {
      if (String(url) === `https://api.github.com/gists/${gistId}`) {
        return jsonResponse(
          gist({
            files: {
              [PORTABLE_EXTENSION_FILENAME]: {
                filename: PORTABLE_EXTENSION_FILENAME,
                truncated: true,
                content: '{"truncated":',
                raw_url: rawUrl,
              },
            },
          }),
        )
      }
      expect(String(url)).toBe(rawUrl)
      return new Response(serializePortableExtension(portable()), {
        headers: { 'content-type': 'text/plain' },
      })
    })
    expect((await sharing.inspectPublic(gistUrl)).bundle).toEqual(portable())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(init?.redirect).toBe('error')
    }
  })

  it.each([
    `https://evil.example/${PORTABLE_EXTENSION_FILENAME}`,
    `https://gist.githubusercontent.com/researcher/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/raw/${PORTABLE_EXTENSION_FILENAME}`,
    `https://gist.githubusercontent.com/researcher/${gistId}/raw/private-notes.json`,
    `https://gist.githubusercontent.com/researcher/${gistId}/raw/${PORTABLE_EXTENSION_FILENAME}?token=private`,
    `http://gist.githubusercontent.com/researcher/${gistId}/raw/${PORTABLE_EXTENSION_FILENAME}`,
    `https://gist.githubusercontent.com:443/researcher/${gistId}/raw/${PORTABLE_EXTENSION_FILENAME}`,
    `https://gist.githubusercontent.com/researcher/${gistId}/raw/./${PORTABLE_EXTENSION_FILENAME}`,
    `https://gist.githubusercontent.com/researcher/${gistId}/other/../raw/${PORTABLE_EXTENSION_FILENAME}`,
  ])('rejects an unsafe raw fallback without requesting it: %s', async (rawUrl) => {
    const { sharing, fetchMock } = mockSharing(
      jsonResponse(
        gist({
          files: {
            [PORTABLE_EXTENSION_FILENAME]: {
              filename: PORTABLE_EXTENSION_FILENAME,
              truncated: true,
              raw_url: rawUrl,
            },
          },
        }),
      ),
    )
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized API responses before parsing', async () => {
    const { sharing } = mockSharing(
      jsonResponse(gist(), 200, { 'content-length': String(32 * 1024 * 1024) }),
    )
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow(/large|size|limit/i)
  })

  it('bounds streamed response bytes even when Content-Length is absent', async () => {
    let chunks = 0
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(256 * 1024))
        if (++chunks === 100) controller.close()
      },
      cancel: cancelled,
    })
    const { sharing } = mockSharing(new Response(body))
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow(/large|size|limit/i)
    expect(cancelled).toHaveBeenCalled()
    expect(chunks).toBeLessThan(100)
  })

  it('cancels a stalled request within the configured deadline', async () => {
    let signal: AbortSignal | null | undefined
    const { sharing } = mockSharing(async (_url, init) => {
      signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    }, 30)
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow(/time|cancel|abort/i)
    expect(signal?.aborted).toBe(true)
  })

  it('also bounds response-body streaming after headers arrive', async () => {
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"files":'))
      },
      cancel: cancelled,
    })
    const { sharing } = mockSharing(new Response(body), 30)
    await expect(sharing.inspectPublic(gistUrl)).rejects.toThrow(/time|cancel|abort/i)
    expect(cancelled).toHaveBeenCalled()
  })
})
