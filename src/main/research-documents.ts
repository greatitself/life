import { randomUUID } from 'node:crypto'
import {
  researchDocumentCSP,
  researchDocumentHTMLSchema,
  researchDocumentIdSchema,
  type ResearchDocumentReference,
} from '../shared/research-document'

/** Renderer-owned, in-memory documents. No research or source files are modified. */
export class ResearchDocuments {
  private readonly documents = new Map<string, string>()

  constructor(private readonly maximumDocuments = 8) {}

  register(input: unknown): ResearchDocumentReference {
    const html = researchDocumentHTMLSchema.parse(input)
    if (this.documents.size >= this.maximumDocuments)
      throw new Error('Too many Research HTML maps are open. Close a map before opening another.')
    const id = randomUUID()
    this.documents.set(id, html)
    return { id, url: `life-extension://research/${id}` }
  }

  revoke(input: unknown): void {
    this.documents.delete(researchDocumentIdSchema.parse(input))
  }

  clear(): void {
    this.documents.clear()
  }

  respond(request: { url: string; method: string }): Response {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Invalid Research document request', { status: 400 })
    }
    if (
      url.protocol !== 'life-extension:' ||
      url.hostname !== 'research' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return new Response('Research document not found', { status: 404 })
    if (request.method !== 'GET')
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
    const parsed = researchDocumentIdSchema.safeParse(url.pathname.slice(1))
    const html =
      parsed.success && request.url === `life-extension://research/${parsed.data}`
        ? this.documents.get(parsed.data)
        : undefined
    if (html === undefined) return new Response('Research document not found', { status: 404 })
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': researchDocumentCSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    })
  }
}
