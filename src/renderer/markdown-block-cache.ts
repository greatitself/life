import { micromark } from 'micromark'
import type { Options } from 'micromark-util-types'
import { MarkdownRenderCache } from './markdown-render-cache'

/**
 * Reuse independent blocks across replies, rather than just identical replies.
 * Definitions, containers, indented code and HTML can connect across blank
 * lines, so those documents retain the compiler's whole-document path.
 */
export function createMarkdownBlockCompiler(options: Options): (text: string) => string {
  const blocks = new MarkdownRenderCache<{ seen: boolean; html?: string }>()
  return (text) => {
    const fragments: string[] = []
    let start = 0
    let offset = 0
    let fence: { character: string; length: number } | undefined
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const end = offset + line.length + (index < lines.length - 1 ? 1 : 0)
      if (fence) {
        const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
        if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length)
          fence = undefined
      } else {
        const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
        if (opening) {
          if (opening[1][0] === '`' && opening[2].includes('`')) return micromark(text, options)
          fence = { character: opening[1][0], length: opening[1].length }
        } else if (
          (/^(?: {4}| {0,3}\t)/.test(line) && /\S/.test(line)) ||
          /^ {0,3}(?:>|\[|[+*-](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/.test(line) ||
          line.includes('<')
        ) {
          return micromark(text, options)
        } else if (/^[ \t]*$/.test(line)) {
          // Keep the separator with its preceding block. The compiler emits
          // its ordinary inter-block newline, including around fenced code.
          if (end > start) fragments.push(text.slice(start, end))
          start = end
        }
      }
      offset = end
    }
    if (start < text.length) fragments.push(text.slice(start))
    if (fragments.length < 2) return micromark(text, options)
    let reusableCharacters = 0
    const entries = fragments.map((fragment) => {
      const entry = blocks.render(fragment, () => ({ seen: false }))
      if (entry.seen) reusableCharacters += fragment.length
      entry.seen = true
      return { fragment, entry }
    })
    // Creating a parser for every distinct paragraph costs more than one
    // document parser. Use the block path only when repetition can pay for it.
    if (reusableCharacters < text.length / 2) return micromark(text, options)
    return entries
      .map(({ fragment, entry }) => (entry.html ??= micromark(fragment, options)))
      .join('')
  }
}
