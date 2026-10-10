import { describe, expect, it } from 'vitest'
import {
  captureConversationPosition,
  ConversationPositionCache,
  isConversationAtEnd,
  restoredConversationTop,
} from '../src/renderer/conversation-scroll'

function viewport(
  options: {
    top?: number
    height?: number
    contentHeight?: number
    anchors?: { id: string; top: number; height: number }[]
  } = {},
): HTMLElement {
  const height = options.height ?? 200
  return {
    scrollTop: options.top ?? 0,
    clientHeight: height,
    scrollHeight: options.contentHeight ?? 1000,
    getBoundingClientRect: () => ({ top: 20, bottom: 20 + height, height }),
    querySelectorAll: () =>
      (options.anchors || []).map((anchor) => ({
        dataset: { messageId: anchor.id },
        getBoundingClientRect: () => ({
          top: 20 + anchor.top,
          bottom: 20 + anchor.top + anchor.height,
          height: anchor.height,
        }),
      })),
  } as unknown as HTMLElement
}

describe('conversation reading positions', () => {
  it('remembers the first visible message and its exact viewport offset', () => {
    expect(
      captureConversationPosition(
        viewport({
          top: 400,
          anchors: [
            { id: 'hidden', top: -20, height: 0 },
            { id: 'above', top: -100, height: 60 },
            { id: 'reading', top: -30, height: 80 },
            { id: 'later', top: 50, height: 80 },
          ],
        }),
        false,
      ),
    ).toEqual({ top: 400, following: false, anchorId: 'reading', anchorOffset: -30 })
  })

  it('restores the same message after history or media grows above it without selector interpolation', () => {
    const position = { top: 400, following: false, anchorId: 'id"]unsafe', anchorOffset: -30 }
    expect(
      restoredConversationTop(
        viewport({ top: 400, anchors: [{ id: 'id"]unsafe', top: 170, height: 80 }] }),
        position,
      ),
    ).toBe(600)
  })

  it('uses the last absolute position if an anchor disappears and clamps after shorter content', () => {
    const position = { top: 400, following: false, anchorId: 'removed', anchorOffset: -30 }
    expect(restoredConversationTop(viewport({}), position)).toBe(400)
    expect(restoredConversationTop(viewport({ contentHeight: 300 }), position)).toBe(100)
    expect(restoredConversationTop(viewport({ contentHeight: 50 }), position)).toBe(0)
  })

  it('follows content at the bottom and treats small rounding gaps as the live edge', () => {
    const root = viewport({ top: 780 })
    expect(isConversationAtEnd(root)).toBe(true)
    expect(isConversationAtEnd(viewport({ top: 600 }))).toBe(false)
    expect(restoredConversationTop(root, { top: 0, following: true })).toBe(800)
    expect(captureConversationPosition(root, true)).toEqual({ top: 780, following: true })
  })

  it('keeps surfaces independent and evicts older positions while protecting recent reads', () => {
    const cache = new ConversationPositionCache(2)
    const agents = { top: 400, following: false }
    const research = { top: 200, following: false }
    cache.set('agents:thread-a', agents)
    cache.set('research:thread-a', research)
    expect(cache.get('agents:thread-a')).toBe(agents)
    cache.set('agents:thread-b', { top: 800, following: true })
    expect(cache.get('research:thread-a')).toBeUndefined()
    expect(cache.get('agents:thread-a')).toBe(agents)
  })
})
