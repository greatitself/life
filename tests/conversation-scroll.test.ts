import { describe, expect, it } from 'vitest'
import {
  captureConversationPosition,
  ConversationAnchorIndex,
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

  it('captures late history without reading thousands of earlier message rectangles', () => {
    let reads = 0
    let queries = 0
    const root = viewport({ top: 480_040, contentHeight: 500_000 })
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      dataset: { messageId: String(index) },
      getBoundingClientRect: () => {
        reads++
        return {
          top: 20 + index * 50 - root.scrollTop,
          bottom: 70 + index * 50 - root.scrollTop,
          height: 50,
        }
      },
    }))
    root.querySelectorAll = (() => {
      queries++
      return messages
    }) as unknown as HTMLElement['querySelectorAll']
    const index = new ConversationAnchorIndex(root)
    expect(captureConversationPosition(root, false, index)).toEqual({
      top: 480_040,
      following: false,
      anchorId: '9600',
      anchorOffset: -40,
    })
    expect(reads).toBeLessThan(32)
    reads = 0
    root.scrollTop += 50
    const position = captureConversationPosition(root, false, index)
    expect(position.anchorId).toBe('9601')
    expect(restoredConversationTop(root, position, index)).toBe(root.scrollTop)
    expect(queries).toBe(1)
    expect(reads).toBeLessThan(32)
  })

  it('reads only the visible turn descendants so skipped historical turns keep their containment', () => {
    const descendantReads: number[] = []
    const root = viewport({ top: 90_040, contentHeight: 100_000 })
    const turns = Array.from({ length: 1000 }, (_, index) => ({
      getBoundingClientRect: () => ({
        top: 20 + index * 100 - root.scrollTop,
        bottom: 120 + index * 100 - root.scrollTop,
        height: 100,
      }),
    }))
    root.contains = () => true
    root.querySelectorAll = (() =>
      turns.flatMap((turn, turnIndex) =>
        [0, 1].map((messageIndex) => ({
          dataset: { messageId: `${turnIndex}:${messageIndex}` },
          closest: () => turn,
          getBoundingClientRect: () => {
            descendantReads.push(turnIndex)
            const top = turn.getBoundingClientRect().top + messageIndex * 50
            return { top, bottom: top + 50, height: 50 }
          },
        })),
      )) as unknown as HTMLElement['querySelectorAll']
    expect(captureConversationPosition(root, false).anchorId).toBe('900:0')
    expect(descendantReads).toEqual([900])
  })

  it('does not lose visible anchors next to collapsed zero-size rows', () => {
    for (let firstVisible = 0; firstVisible < 12; firstVisible++) {
      const anchors = Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        top: index === firstVisible ? -30 : 0,
        height: index === firstVisible ? 80 : 0,
      }))
      expect(captureConversationPosition(viewport({ anchors }), false).anchorId).toBe(
        String(firstVisible),
      )
    }
  })

  it('updates anchor membership after inserted or removed history', () => {
    const root = viewport({ top: 400 })
    let messages = [
      {
        dataset: { messageId: 'first' },
        getBoundingClientRect: () => ({ top: 20, bottom: 100, height: 80 }),
      },
    ]
    root.querySelectorAll = (() => messages) as unknown as HTMLElement['querySelectorAll']
    const index = new ConversationAnchorIndex(root)
    expect(captureConversationPosition(root, false, index).anchorId).toBe('first')
    messages = [
      {
        dataset: { messageId: 'replacement' },
        getBoundingClientRect: () => ({ top: 20, bottom: 100, height: 80 }),
      },
    ]
    index.invalidate()
    expect(index.find('first')).toBeUndefined()
    expect(captureConversationPosition(root, false, index).anchorId).toBe('replacement')
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
