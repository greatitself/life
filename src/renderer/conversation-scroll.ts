import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface ConversationScrollPosition {
  top: number
  following: boolean
  anchorId?: string
  anchorOffset?: number
}

/** Session positions stay scoped to the conversation surface and bounded in memory. */
export class ConversationPositionCache {
  private positions = new Map<string, ConversationScrollPosition>()

  constructor(private limit = 100) {}

  get(key: string): ConversationScrollPosition | undefined {
    const position = this.positions.get(key)
    if (position) {
      this.positions.delete(key)
      this.positions.set(key, position)
    }
    return position
  }

  set(key: string, position: ConversationScrollPosition): void {
    this.positions.delete(key)
    this.positions.set(key, position)
    if (this.positions.size > this.limit) {
      const oldest = this.positions.keys().next().value
      if (oldest !== undefined) this.positions.delete(oldest)
    }
  }
}

export function isConversationAtEnd(viewport: HTMLElement, threshold = 40): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold
}

export function captureConversationPosition(
  viewport: HTMLElement,
  following: boolean,
): ConversationScrollPosition {
  const position: ConversationScrollPosition = { top: viewport.scrollTop, following }
  if (following) return position
  const bounds = viewport.getBoundingClientRect()
  for (const message of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = message.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      position.anchorId = message.dataset.messageId
      position.anchorOffset = rect.top - bounds.top
      break
    }
  }
  return position
}

export function restoredConversationTop(
  viewport: HTMLElement,
  position: ConversationScrollPosition,
): number {
  let top = position.following ? viewport.scrollHeight : position.top
  if (!position.following && position.anchorId && position.anchorOffset !== undefined) {
    const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (message) => message.dataset.messageId === position.anchorId,
    )
    if (anchor && anchor.getBoundingClientRect().height > 0) {
      top =
        viewport.scrollTop +
        anchor.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        position.anchorOffset
    }
  }
  return Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight))
}

class ConversationScrollController {
  private viewport?: HTMLDivElement
  private key?: string
  private following = true
  private position?: ConversationScrollPosition
  private lastTop = 0
  private expectedTop?: number
  private frame?: number
  private observer?: ResizeObserver
  private observedChildren = new Set<Element>()
  private cache = new ConversationPositionCache()

  constructor(private onFollowingChange: (following: boolean) => void) {}

  attach(viewport: HTMLDivElement | null, key: string): void {
    if (viewport === this.viewport && key === this.key) return
    this.detach()
    if (!viewport) return
    this.viewport = viewport
    this.key = key
    this.position = this.cache.get(key)
    this.following = this.position?.following ?? true
    this.onFollowingChange(this.following)
    this.lastTop = viewport.scrollTop
    viewport.addEventListener('scroll', this.onScroll, { passive: true })
    this.observer = new ResizeObserver(() => this.scheduleLayout())
    this.observer.observe(viewport)
    this.contentChanged()
  }

  detach(): void {
    this.viewport?.removeEventListener('scroll', this.onScroll)
    this.observer?.disconnect()
    this.observer = undefined
    this.observedChildren.clear()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.viewport = undefined
    this.key = undefined
    this.expectedTop = undefined
  }

  setFollowing = (following: boolean): void => {
    this.following = following
    this.onFollowingChange(following)
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    if (following) this.scheduleLayout()
    else this.remember()
  }

  contentChanged(): void {
    const viewport = this.viewport
    if (!viewport) return
    const children = new Set(Array.from(viewport.children))
    for (const child of this.observedChildren) {
      if (!children.has(child)) this.observer?.unobserve(child)
    }
    for (const child of children) {
      if (!this.observedChildren.has(child)) this.observer?.observe(child)
    }
    this.observedChildren = children
    this.layout()
  }

  private scheduleLayout(): void {
    if (this.frame !== undefined || !this.viewport) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.layout()
    })
  }

  private layout(): void {
    const viewport = this.viewport
    if (!viewport) return
    const position = this.following
      ? { top: viewport.scrollHeight, following: true }
      : this.position
    if (!position) return
    const top = restoredConversationTop(viewport, position)
    if (Math.abs(viewport.scrollTop - top) > 0.5) {
      this.expectedTop = top
      viewport.scrollTop = top
    }
    this.lastTop = viewport.scrollTop
    if (this.following) this.remember()
  }

  private remember(): void {
    if (!this.viewport || !this.key) return
    this.position = captureConversationPosition(this.viewport, this.following)
    this.cache.set(this.key, this.position)
  }

  private onScroll = (): void => {
    const viewport = this.viewport
    if (!viewport) return
    const top = viewport.scrollTop
    if (this.expectedTop !== undefined && Math.abs(top - this.expectedTop) <= 1) {
      this.expectedTop = undefined
      this.lastTop = top
      this.remember()
      return
    }
    this.expectedTop = undefined
    const atEnd = isConversationAtEnd(viewport)
    // Content growth can emit a scroll event without a scroll gesture. Keep following
    // until the reader moves away, including when an image finishes loading later.
    if (this.following && !atEnd && Math.abs(top - this.lastTop) <= 0.5) {
      this.scheduleLayout()
      return
    }
    this.lastTop = top
    if (atEnd !== this.following) {
      this.following = atEnd
      this.onFollowingChange(atEnd)
    }
    this.remember()
  }
}

export function useConversationScroll(
  key: string,
  content: { messages?: unknown; pending?: unknown; queue?: unknown },
) {
  const conversation = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [stickToBottom, setStickToBottomState] = useState(true)
  const controller = useMemo(() => new ConversationScrollController(setStickToBottomState), [])
  const viewportRef = useCallback((element: HTMLDivElement | null) => {
    conversation.current = element
    setViewport(element)
  }, [])
  useLayoutEffect(() => {
    controller.attach(viewport, key)
    controller.contentChanged()
  }, [controller, viewport, key, content.messages, content.pending, content.queue])
  useLayoutEffect(() => () => controller.detach(), [controller])
  return { conversation, viewportRef, stickToBottom, setStickToBottom: controller.setFollowing }
}
