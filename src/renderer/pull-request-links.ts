import type { Message } from './state'

type LinkMessage = Pick<Message, 'text'>

/** Project immutable transcript snapshots without rescanning settled message text. */
export function createPullRequestLinksProjector(): (
  messages: readonly LinkMessage[] | undefined,
  active: boolean,
) => string[] {
  const messageLinks = new WeakMap<LinkMessage, string[]>()
  let previousLinks: string[] = []

  return (messages, active) => {
    if (!active) return previousLinks

    const links = new Set<string>()
    for (const message of messages ?? []) {
      let cached = messageLinks.get(message)
      if (!cached) {
        cached = Array.from(
          message.text.matchAll(
            /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/\d+/g,
          ),
          (match) => match[0],
        )
        messageLinks.set(message, cached)
      }
      for (const link of cached) links.add(link)
    }

    const nextLinks = [...links]
    if (
      nextLinks.length !== previousLinks.length ||
      nextLinks.some((link, index) => link !== previousLinks[index])
    ) {
      previousLinks = nextLinks
    }
    return previousLinks
  }
}
