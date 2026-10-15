import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  NativeDocumentReadiness,
  NativeDocumentReadinessError,
} from '../src/main/native-document-readiness'

describe('native source document proof', () => {
  it('requires a new native document and exact source revision', async () => {
    const documents = new NativeDocumentReadiness()
    const window = {}
    documents.commit(window)
    const original = documents.capture()
    let settled = false
    const ready = documents.wait(original.documentId, 7).then(() => {
      settled = true
    })
    documents.ready(window, 7)
    await Effect.runPromise(Effect.sleep('1 millis'))
    expect(settled).toBe(false)
    documents.commit(window)
    documents.ready(window, 6)
    documents.ready({}, 7)
    await Effect.runPromise(Effect.sleep('1 millis'))
    expect(settled).toBe(false)
    documents.ready(window, 7)
    await ready
    expect(documents.matches(original.documentId, 7)).toBe(true)
    documents.close()
  })

  it('can prove the authorized revision after a cold replacement without scheduling reload', async () => {
    const documents = new NativeDocumentReadiness()
    const oldWindow = {}
    documents.commit(oldWindow)
    const original = documents.capture()
    const newWindow = {}
    documents.commit(newWindow)
    documents.invalidate(oldWindow)
    documents.ready(oldWindow, 8)
    expect(documents.matches(original.documentId, 8)).toBe(false)
    documents.ready(newWindow, 8)
    await documents.wait(original.documentId, 8)
    expect(documents.matches(original.documentId, 9)).toBe(false)
    documents.close()
  })

  it('releases a cancelled waiter while later authorized readiness remains usable', async () => {
    const documents = new NativeDocumentReadiness()
    const window = {}
    documents.commit(window)
    const original = documents.capture()
    const abort = new AbortController()
    const cancelled = documents.wait(original.documentId, 3, abort.signal)
    const outcome = cancelled.catch((cause: unknown) => cause)
    abort.abort()
    expect(await outcome).toBeInstanceOf(Error)
    documents.commit(window)
    documents.ready(window, 3)
    await documents.wait(original.documentId, 3)
    documents.close()
  })

  it('retains an unproved reload outcome when the document cannot become ready', async () => {
    const documents = new NativeDocumentReadiness()
    const window = {}
    documents.commit(window)
    const original = documents.capture()
    const deadline = Effect.runPromise(documents.waitEffect(original.documentId, 2, 5))
    await expect(deadline).rejects.toBeInstanceOf(NativeDocumentReadinessError)
    const closing = documents.wait(original.documentId, 2)
    const rejected = expect(closing).rejects.toBeInstanceOf(NativeDocumentReadinessError)
    documents.invalidate(window)
    await rejected
    documents.close()
  })
})
