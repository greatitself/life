/* Browser preview only. Isolated HTML maps, with no cache or network interception for app assets. */
const documents = new Map()
const base = new URL('./', self.location.href).pathname
const prefix = base + 'research-documents/'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const policy =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https: http:; font-src data: https:; media-src data: blob: https: http:; connect-src https: http:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  const message = event.data
  const reply = event.ports[0]
  if (!reply || !event.source || !message || !uuid.test(message.id || '')) return
  const source = new URL(event.source.url)
  if (
    source.origin !== self.location.origin ||
    !source.pathname.startsWith(base) ||
    source.pathname.startsWith(prefix)
  )
    return
  if (
    message.type === 'register' &&
    typeof message.html === 'string' &&
    new TextEncoder().encode(message.html).length <= 4065536
  ) {
    documents.set(message.id, { html: message.html, owner: event.source.id })
    reply.postMessage({ ok: true })
  } else if (message.type === 'revoke') {
    if (documents.get(message.id)?.owner === event.source.id) documents.delete(message.id)
    reply.postMessage({ ok: true })
  } else reply.postMessage({ error: 'Invalid browser Research document.' })
})
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return
  const id = url.pathname.slice(prefix.length)
  const entry = uuid.test(id) ? documents.get(id) : undefined
  event.respondWith(
    Promise.resolve(
      new Response(entry?.html || '<p>This preview map expired. Refresh the Research panel.</p>', {
        status: entry ? 200 : 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': policy,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      }),
    ),
  )
})
