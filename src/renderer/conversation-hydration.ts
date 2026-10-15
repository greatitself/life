import type { ConversationHistorySnapshot } from '../shared/conversations'

function cancelled() {
  return new DOMException('Conversation history loading was cancelled.', 'AbortError')
}

interface NativeRead {
  controller: AbortController
  promise: Promise<ConversationHistorySnapshot | null>
  waiters: number
  complete: boolean
}

/** React owns retry timers; StrictMode replays share the already requested native read. */
export class ConversationHistoryHydration {
  private pending?: NativeRead

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<ConversationHistorySnapshot | null>,
    private readonly retryDelays: readonly number[] = [250, 1000],
  ) {}

  async load(signal: AbortSignal): Promise<ConversationHistorySnapshot | null> {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw cancelled()
      try {
        return await this.active(this.request(), signal)
      } catch (error) {
        if (signal.aborted || attempt >= this.retryDelays.length) throw error
        await this.pause(this.retryDelays[attempt], signal)
      }
    }
  }

  private request() {
    if (this.pending && !this.pending.controller.signal.aborted) return this.pending
    const request: NativeRead = {
      controller: new AbortController(),
      promise: undefined!,
      waiters: 0,
      complete: false,
    }
    request.promise = Promise.resolve()
      .then(() => this.read(request.controller.signal))
      .finally(() => {
        request.complete = true
        if (this.pending === request) this.pending = undefined
      })
    this.pending = request
    return request
  }

  private active(
    request: NativeRead,
    signal: AbortSignal,
  ): Promise<ConversationHistorySnapshot | null> {
    return new Promise((resolve, reject) => {
      request.waiters++
      let settled = false
      const detach = () => {
        if (settled) return false
        settled = true
        signal.removeEventListener('abort', abort)
        request.waiters--
        // StrictMode's synchronous replay can take ownership before cleanup.
        queueMicrotask(() => {
          if (!request.waiters && !request.complete) request.controller.abort()
        })
        return true
      }
      const abort = () => {
        if (detach()) reject(cancelled())
      }
      signal.addEventListener('abort', abort, { once: true })
      request.promise.then(
        (value) => {
          if (detach()) resolve(value)
        },
        (error) => {
          if (detach()) reject(error)
        },
      )
      if (signal.aborted) abort()
    })
  }

  private pause(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, delay)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(cancelled())
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
