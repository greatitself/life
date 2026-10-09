import type { ResearchDocumentsAPI } from '../shared/research-document'
import { researchDocumentHTMLSchema } from '../shared/research-document'

let workerReady: Promise<ServiceWorker> | undefined
const browserBase = import.meta.env?.BASE_URL || '/life/'
async function worker(): Promise<ServiceWorker> {
  if (!navigator.serviceWorker)
    throw new Error(
      'Interactive HTML preview maps require HTTPS. Use the desktop app or the published Life preview.',
    )
  if (!workerReady)
    workerReady = (async () => {
      await navigator.serviceWorker.register(browserBase + 'research-document-sw.js', {
        scope: browserBase,
      })
      const registration = await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            navigator.serviceWorker.removeEventListener('controllerchange', ready)
            reject(
              new Error(
                'The browser Research document worker did not activate. Refresh the page to retry.',
              ),
            )
          }, 10000)
          const ready = () => {
            clearTimeout(timeout)
            navigator.serviceWorker.removeEventListener('controllerchange', ready)
            resolve()
          }
          navigator.serviceWorker.addEventListener('controllerchange', ready)
          if (navigator.serviceWorker.controller) ready()
        })
      return navigator.serviceWorker.controller || registration.active!
    })().catch((error) => {
      workerReady = undefined
      throw error
    })
  return workerReady
}
async function send(message: { type: 'register' | 'revoke'; id: string; html?: string }) {
  const target = await worker()
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => {
      channel.port1.close()
      reject(new Error('The browser Research document worker did not respond.'))
    }, 10000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout)
      channel.port1.close()
      event.data?.ok
        ? resolve()
        : reject(
            new Error(
              event.data?.error || 'The browser Research document could not be registered.',
            ),
          )
    }
    target.postMessage(message, [channel.port2])
  })
}
export const webResearchDocuments: ResearchDocumentsAPI = {
  register: async (html) => {
    const id = crypto.randomUUID()
    await send({ type: 'register', id, html: researchDocumentHTMLSchema.parse(html) })
    return {
      id,
      url: new URL(browserBase + 'research-documents/' + id, location.origin).href,
    }
  },
  revoke: async (id) => {
    await send({ type: 'revoke', id })
  },
}
