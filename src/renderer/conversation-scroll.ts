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

interface AnchorGroup {
  element: HTMLElement
  messages: HTMLElement[]
}

/** Index DOM membership separately from geometry: streaming text does not change either index. */
export class ConversationAnchorIndex {
  private groups: AnchorGroup[] = []
  private messages = new Map<string, HTMLElement>()
  private dirty = true

  constructor(private viewport: HTMLElement) {}

  invalidate(): void {
    this.dirty = true
  }

  private refresh(): void {
    if (!this.dirty) return
    this.dirty = false
    this.groups = []
    this.messages.clear()
    const turnsByParent = new Map<Element, HTMLElement | null>()
    let lastGroup: AnchorGroup | undefined
    for (const message of this.viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = message.getAttribute?.('data-message-id') ?? message.dataset.messageId
      if (id !== undefined && !this.messages.has(id)) this.messages.set(id, message)
      // Reading a descendant's rect materializes an offscreen content-visibility
      // subtree. Search turn wrappers first, then read only the intersecting turn.
      const parent = message.parentElement
      let turn: HTMLElement | null | undefined
      if (parent) {
        if (!turnsByParent.has(parent)) {
          turnsByParent.set(parent, parent.closest<HTMLElement>('.thread-timeline-turn'))
        }
        turn = turnsByParent.get(parent)
      } else {
        turn = message.closest?.<HTMLElement>('.thread-timeline-turn')
      }
      const element = turn && this.viewport.contains(turn) ? turn : message
      if (lastGroup?.element !== element) {
        lastGroup = { element, messages: [] }
        this.groups.push(lastGroup)
      }
      lastGroup.messages.push(message)
    }
  }

  find(id: string): HTMLElement | undefined {
    this.refresh()
    return this.messages.get(id)
  }

  capture(bounds: DOMRect): { anchorId?: string; anchorOffset?: number } {
    this.refresh()
    // Turn wrappers and flat message rows are ordered in the document's block flow.
    // Ignore zero-sized hidden rows while bisecting so collapsed activity cannot
    // hide the visible row on either side of it.
    let low = 0
    let high = this.groups.length
    while (low < high) {
      const middle = (low + high) >>> 1
      let candidate = middle
      let rect = this.groups[candidate].element.getBoundingClientRect()
      if (rect.height <= 0) {
        let distance = 1
        let found = false
        while (middle - distance >= low || middle + distance < high) {
          for (const index of [middle - distance, middle + distance]) {
            if (index < low || index >= high) continue
            const visibleRect = this.groups[index].element.getBoundingClientRect()
            if (visibleRect.height > 0) {
              candidate = index
              rect = visibleRect
              found = true
              break
            }
          }
          if (found) break
          distance++
        }
        if (!found) {
          low = high
          break
        }
      }
      if (rect.bottom <= bounds.top) low = candidate + 1
      else high = candidate
    }
    for (let index = low; index < this.groups.length; index++) {
      const group = this.groups[index]
      const groupRect = group.element.getBoundingClientRect()
      if (groupRect.height <= 0 || groupRect.bottom <= bounds.top) continue
      if (groupRect.top >= bounds.bottom) break
      for (const message of group.messages) {
        const rect = message === group.element ? groupRect : message.getBoundingClientRect()
        if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
          return { anchorId: message.dataset.messageId, anchorOffset: rect.top - bounds.top }
        }
      }
    }
    return {}
  }
}

export function captureConversationPosition(
  viewport: HTMLElement,
  following: boolean,
  anchors = new ConversationAnchorIndex(viewport),
): ConversationScrollPosition {
  const position: ConversationScrollPosition = { top: viewport.scrollTop, following }
  if (following) return position
  return { ...position, ...anchors.capture(viewport.getBoundingClientRect()) }
}

export function restoredConversationTop(
  viewport: HTMLElement,
  position: ConversationScrollPosition,
  anchors = new ConversationAnchorIndex(viewport),
): number {
  let top = position.following ? viewport.scrollHeight : position.top
  if (!position.following && position.anchorId && position.anchorOffset !== undefined) {
    const anchor = anchors.find(position.anchorId)
    const rect = anchor?.getBoundingClientRect()
    if (rect && rect.height > 0) {
      top =
        viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - position.anchorOffset
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
  private lastHeight = 0
  private lastClientHeight = 0
  private userScrollUntil = 0
  private selectedPosition?: ConversationScrollPosition
  private selectionStableFrames = 0
  private revealedTurn?: { element: HTMLElement; visibility: string }
  private expectedTop?: number
  private frame?: number
  private observer?: ResizeObserver
  private mutations?: MutationObserver
  private anchors?: ConversationAnchorIndex
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
    this.lastHeight = viewport.scrollHeight
    this.lastClientHeight = viewport.clientHeight
    this.anchors = new ConversationAnchorIndex(viewport)
    viewport.addEventListener('scroll', this.onScroll, { passive: true })
    viewport.addEventListener('wheel', this.onUserScrollInput, { passive: true })
    viewport.addEventListener('touchmove', this.onUserScrollInput, { passive: true })
    viewport.addEventListener('pointerdown', this.onUserScrollInput, { passive: true })
    viewport.addEventListener('keydown', this.onKeyDown)
    viewport.ownerDocument.addEventListener('selectionchange', this.onSelectionChange)
    this.observer = new ResizeObserver(() => this.scheduleLayout())
    this.observer.observe(viewport)
    this.mutations = new MutationObserver((records) => {
      this.invalidateAnchors(records)
      this.scheduleLayout()
    })
    this.mutations.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-message-id'],
    })
    this.contentChanged()
  }

  detach(): void {
    this.viewport?.removeEventListener('scroll', this.onScroll)
    this.viewport?.removeEventListener('wheel', this.onUserScrollInput)
    this.viewport?.removeEventListener('touchmove', this.onUserScrollInput)
    this.viewport?.removeEventListener('pointerdown', this.onUserScrollInput)
    this.viewport?.removeEventListener('keydown', this.onKeyDown)
    this.viewport?.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange)
    this.observer?.disconnect()
    this.observer = undefined
    this.mutations?.disconnect()
    this.mutations = undefined
    this.anchors = undefined
    this.observedChildren.clear()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.viewport = undefined
    this.key = undefined
    this.expectedTop = undefined
    this.userScrollUntil = 0
    this.clearSelectionPosition()
  }

  setFollowing = (following: boolean): void => {
    this.clearSelectionPosition()
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
    this.invalidateAnchors(this.mutations?.takeRecords() || [])
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
    const position =
      this.selectedPosition ||
      (this.following ? { top: viewport.scrollHeight, following: true } : this.position)
    if (!position) return
    this.invalidateAnchors(this.mutations?.takeRecords() || [])
    const top = restoredConversationTop(viewport, position, this.anchors)
    const moved = Math.abs(viewport.scrollTop - top) > 0.5
    if (moved) {
      this.expectedTop = top
      viewport.scrollTop = top
    }
    this.lastTop = viewport.scrollTop
    this.lastHeight = viewport.scrollHeight
    this.lastClientHeight = viewport.clientHeight
    if (this.selectedPosition) {
      if (moved) this.selectionStableFrames = 0
      else this.selectionStableFrames++
      if (this.selectionStableFrames >= 2) {
        if (this.revealedTurn) {
          this.revealedTurn.element.style.contentVisibility = this.revealedTurn.visibility
          this.revealedTurn = undefined
          this.selectionStableFrames = 0
          this.scheduleLayout()
        } else {
          this.selectedPosition = undefined
          this.remember()
        }
      } else this.scheduleLayout()
    } else if (this.following) this.remember()
  }

  private remember(): void {
    if (!this.viewport || !this.key) return
    this.invalidateAnchors(this.mutations?.takeRecords() || [])
    this.position = captureConversationPosition(this.viewport, this.following, this.anchors)
    this.cache.set(this.key, this.position)
  }

  private invalidateAnchors(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'attributes') {
        this.anchors?.invalidate()
        return
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (
          node instanceof Element &&
          (node.matches('[data-message-id], .thread-timeline-turn') ||
            node.querySelector('[data-message-id]'))
        ) {
          this.anchors?.invalidate()
          return
        }
      }
    }
  }

  private onUserScrollInput = (): void => {
    this.clearSelectionPosition()
    this.userScrollUntil = performance.now() + 500
  }

  private clearSelectionPosition(): void {
    this.selectedPosition = undefined
    if (this.revealedTurn) {
      this.revealedTurn.element.style.contentVisibility = this.revealedTurn.visibility
      this.revealedTurn = undefined
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      this.onUserScrollInput()
    }
  }

  private onSelectionChange = (): void => {
    const viewport = this.viewport
    const selection = viewport?.ownerDocument.getSelection()
    // Native find and text selection can trigger layout before their scroll event.
    // Preserve that reading intent while skipped turn content becomes visible.
    if (
      viewport &&
      selection &&
      !selection.isCollapsed &&
      viewport.contains(selection.anchorNode) &&
      viewport.contains(selection.focusNode)
    ) {
      this.setFollowing(false)
      const range = selection.getRangeAt(0).getBoundingClientRect()
      const bounds = viewport.getBoundingClientRect()
      if (range.bottom <= bounds.top || range.top >= bounds.bottom) {
        const focus = selection.focusNode
        const element = focus instanceof Element ? focus : focus?.parentElement
        const turn = element?.closest<HTMLElement>('.thread-timeline-turn')
        // A skipped turn's placeholder height can otherwise displace the match
        // after the browser scrolls it into view. Lay out this one selected turn.
        if (turn) {
          this.revealedTurn = { element: turn, visibility: turn.style.contentVisibility }
          turn.style.contentVisibility = 'visible'
        }
        const anchor = element?.closest<HTMLElement>('[data-message-id]')
        if (anchor?.dataset.messageId) {
          const anchorRect = anchor.getBoundingClientRect()
          const selectedRect = selection.getRangeAt(0).getBoundingClientRect()
          this.selectedPosition = {
            top: viewport.scrollTop,
            following: false,
            anchorId: anchor.dataset.messageId,
            anchorOffset:
              Math.max(0, (viewport.clientHeight - selectedRect.height) / 2) -
              (selectedRect.top - anchorRect.top),
          }
          this.selectionStableFrames = 0
          this.layout()
        } else {
          element?.scrollIntoView({ block: 'center' })
          this.lastTop = viewport.scrollTop
          this.remember()
          this.clearSelectionPosition()
        }
      }
    }
  }

  private onScroll = (): void => {
    const viewport = this.viewport
    if (!viewport) return
    const top = viewport.scrollTop
    const height = viewport.scrollHeight
    const clientHeight = viewport.clientHeight
    if (this.selectedPosition) {
      this.scheduleLayout()
      return
    }
    if (this.expectedTop !== undefined && Math.abs(top - this.expectedTop) <= 1) {
      this.expectedTop = undefined
      this.lastTop = top
      this.lastHeight = height
      this.lastClientHeight = clientHeight
      this.remember()
      return
    }
    this.expectedTop = undefined
    const atEnd = isConversationAtEnd(viewport)
    // Content growth can emit a scroll event without a scroll gesture. Keep following
    // until the reader moves away, including when an image finishes loading later.
    const resized = height !== this.lastHeight || clientHeight !== this.lastClientHeight
    const automaticGrowth =
      resized && top >= this.lastTop - 0.5 && performance.now() > this.userScrollUntil
    if (this.following && !atEnd && (Math.abs(top - this.lastTop) <= 0.5 || automaticGrowth)) {
      this.scheduleLayout()
      return
    }
    this.lastTop = top
    this.lastHeight = height
    this.lastClientHeight = clientHeight
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
