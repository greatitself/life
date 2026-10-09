import { describe, expect, it } from 'vitest'
import { ResearchDocuments } from '../src/main/research-documents'
import { RendererDocumentAdmission } from '../src/main/renderer-recovery'
import { isTrustedRendererSender } from '../src/main/renderer-ipc'
import {
  researchDocumentByteLimit,
  researchDocumentCSP,
  researchDocumentHTMLSchema,
} from '../src/shared/research-document'

const html =
  "<button onclick=\"parent.postMessage({type:'life-research-select',problemId:'p1'},'*')\">Open problem</button><script>document.body.dataset.loaded=\"yes\"</script>"

describe('independent Research HTML documents', () => {
  it('serves unchanged interactive HTML with an independent sandbox policy and no injected bridge', async () => {
    const store = new ResearchDocuments()
    const first = store.register(html)
    const second = store.register(html)
    expect(first.id).not.toBe(second.id)
    expect(new URL(first.url).hostname).toBe('research')
    const response = store.respond({ url: first.url, method: 'GET' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(html)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('Content-Security-Policy')).toBe(researchDocumentCSP)
    const directives = researchDocumentCSP.split('; ').map((item) => item.split(' '))
    expect(directives.find((item) => item[0] === 'sandbox')).toEqual(['sandbox', 'allow-scripts'])
    expect(directives.find((item) => item[0] === 'script-src')).toEqual([
      'script-src',
      "'unsafe-inline'",
      'https:',
    ])
    expect(researchDocumentCSP).not.toContain('allow-same-origin')
    expect(researchDocumentCSP).not.toContain('allow-top-navigation')
    expect(researchDocumentCSP).not.toContain('allow-popups')
    expect(researchDocumentCSP).not.toContain('life-code:')
    expect(researchDocumentCSP).not.toContain('life-extension:')
    expect(researchDocumentCSP).not.toContain("'unsafe-eval'")
  })

  it('rejects malformed and oversized UTF-8 registrations without consuming capacity', () => {
    const store = new ResearchDocuments(1)
    for (const input of [null, {}, 1, '', 'x'.repeat(researchDocumentByteLimit + 1)])
      expect(() => store.register(input)).toThrow()
    expect(() =>
      store.register('💡'.repeat(Math.floor(researchDocumentByteLimit / 4) + 1)),
    ).toThrow()
    expect(researchDocumentHTMLSchema.parse('x'.repeat(researchDocumentByteLimit))).toHaveLength(
      researchDocumentByteLimit,
    )
    expect(store.register(html).id).toBeTruthy()
  })

  it('bounds simultaneous documents and releases capacity only for a revoked document', () => {
    const store = new ResearchDocuments(2)
    const first = store.register(html)
    const second = store.register('<h1>Second map</h1>')
    expect(() => store.register('third')).toThrow('Too many Research HTML maps')
    expect(() => store.revoke('../outside')).toThrow()
    expect(store.respond({ url: first.url, method: 'GET' }).status).toBe(200)
    store.revoke(first.id)
    store.revoke(first.id)
    expect(store.respond({ url: first.url, method: 'GET' }).status).toBe(404)
    expect(store.respond({ url: second.url, method: 'GET' }).status).toBe(200)
    expect(store.register('third').id).toBeTruthy()
  })

  it('invalidates every old renderer document during recovery', () => {
    const store = new ResearchDocuments()
    const first = store.register(html)
    const second = store.register(html)
    store.clear()
    for (const document of [first, second])
      expect(store.respond({ url: document.url, method: 'GET' }).status).toBe(404)
    expect(store.register(html).id).not.toBe(first.id)
  })

  it('cannot route a token into extension, source, file, query or traversal paths', () => {
    const store = new ResearchDocuments()
    const document = store.register(html)
    for (const url of [
      `life-extension://runtime/${document.id}`,
      `life-extension://research/view/${document.id}`,
      `life-extension://research/%2e%2e/${document.id}`,
      `life-extension://research/%2f${document.id}`,
      `life-extension://research/${document.id}?token=other`,
      `life-extension://research/${document.id}#other`,
      `life-extension://user@research/${document.id}`,
      `life-extension://research:80/${document.id}`,
      `life-code://research/${document.id}`,
      `https://research/${document.id}`,
      `file://research/${document.id}`,
    ])
      expect(store.respond({ url, method: 'GET' }).status, url).toBe(404)
    expect(store.respond({ url: 'invalid', method: 'GET' }).status).toBe(400)
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const response = store.respond({ url: document.url, method })
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
    }
  })
})

describe('Research document IPC admission', () => {
  it('only admits capabilities from the current main frame, never a child or old window', () => {
    const mainFrame = {}
    const childFrame = {}
    const owner = { webContents: { mainFrame } }
    const previous = { webContents: { mainFrame: {} } }
    expect(
      isTrustedRendererSender(owner, { sender: owner.webContents, senderFrame: mainFrame }),
    ).toBe(true)
    expect(
      isTrustedRendererSender(owner, { sender: owner.webContents, senderFrame: childFrame }),
    ).toBe(false)
    expect(
      isTrustedRendererSender(owner, {
        sender: previous.webContents,
        senderFrame: previous.webContents.mainFrame,
      }),
    ).toBe(false)
    expect(
      isTrustedRendererSender(owner, { sender: previous.webContents, senderFrame: mainFrame }),
    ).toBe(false)
    expect(
      isTrustedRendererSender(null, { sender: owner.webContents, senderFrame: mainFrame }),
    ).toBe(false)
    expect(
      isTrustedRendererSender(owner, { sender: owner.webContents, senderFrame: undefined }),
    ).toBe(false)
  })

  it('preserves recovery admission: embedded-map registration cannot race interface replacement', () => {
    const admission = new RendererDocumentAdmission()
    for (const channel of ['research-documents:register', 'research-documents:revoke']) {
      expect(admission.allows(channel)).toBe(false)
      admission.commitMainDocument()
      expect(admission.allows(channel)).toBe(true)
      admission.suspend()
      expect(admission.allows(channel)).toBe(false)
    }
  })
})
