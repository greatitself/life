import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebApplicationAPI } from '../src/renderer/web-app-adapter'

function storage(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  }
}

function browser(savedCursor = '900') {
  const session = storage({ 'life.web.events.cursor': savedCursor })
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('localStorage', storage({ 'relay.threads.v1': '[]' }))
  vi.stubGlobal('window', {})
  vi.stubEnv('BASE_URL', '/life/')
  const streams: { url: string; onmessage?: (event: MessageEvent<string>) => void }[] = []
  vi.stubGlobal(
    'EventSource',
    class {
      onmessage?: (event: MessageEvent<string>) => void
      constructor(readonly url: string) {
        streams.push(this)
      }
    },
  )
  const requests: { method: string; args: unknown[] }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/session')) return Response.json({ token: 'session-token', cursor: 6 })
      requests.push(JSON.parse(String(options?.body)))
      return Response.json({ value: null })
    }),
  )
  return { session, streams, requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('web app event cursor recovery', () => {
  it('resets an old browser cursor before the first history save after a server restart', async () => {
    const { session, streams, requests } = browser()
    const api = await createWebApplicationAPI()
    expect(streams[0].url).toBe('/life/api/events?after=6')
    await api.conversations!.save([])
    expect(requests.at(-1)).toEqual({ method: 'conversations.save', args: [[], 6] })
    expect(session.getItem('life.web.events.cursor')).toBe('6')
  })

  it('saves the current received cursor, even when storage contains a stale value', async () => {
    const { session, streams, requests } = browser('4')
    const api = await createWebApplicationAPI()
    api.onConnection(() => {
      void api.conversations!.save([])
    })
    streams[0].onmessage!({
      lastEventId: '7',
      data: JSON.stringify({ channel: 'connection', data: { status: 'connected' } }),
    } as MessageEvent<string>)
    expect(requests.at(-1)).toEqual({ method: 'conversations.save', args: [[], 7] })
    session.setItem('life.web.events.cursor', '900')
    await api.conversations!.save([])
    expect(requests.at(-1)).toEqual({ method: 'conversations.save', args: [[], 7] })
  })
})
