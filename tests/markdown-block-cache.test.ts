import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { describe, expect, it } from 'vitest'
import { createMarkdownBlockCompiler } from '../src/renderer/markdown-block-cache'

const options = { extensions: [gfm()], htmlExtensions: [gfmHtml()] }
const compile = createMarkdownBlockCompiler(options)
const blocks = [
  '# A heading',
  'A **formatted** paragraph with [a source](https://example.com).',
  'A hard break.  \nThe next line.',
  'An escaped break.\\\nThe next line.',
  'Heading\n=======',
  '---',
  '| Check | Result |\n| --- | --- |\n| Exact | **Preserved** |',
  '```ts\nconst exact = "<angle>&";\n\n// Blank lines stay inside code.\n```',
  '~~~~\n```\n\n~~~\n~~~~',
  '   ```ts\n  exact indentation\n\n   ```   ',
  '```\n\n```',
  '~~~\n\n~~~',
  '- First item\n\n- Second item',
  '> A quote\n>\n> Another paragraph',
  '    Indented code\n\n    Another exact line',
  '<div>\nLiteral HTML\n\nStill inside HTML\n</div>',
  '[Exact reference][source]\n\n[source]: /exact/path "Exact title"',
]

describe('independent Markdown block compilation', () => {
  it('resolves late definitions even when an unresolved paragraph was previously cached', () => {
    const paragraph = 'A repeated reference [exact][source].\n\n'
    const unresolved = '# Earlier reply\n\n' + paragraph.repeat(3)
    expect(compile(unresolved)).toBe(micromark(unresolved, options))
    const resolved =
      '# Later reply\n\n' + paragraph.repeat(3) + '[source]: /now-defined "Exact title"\n'
    const html = compile(resolved)
    expect(html).toBe(micromark(resolved, options))
    expect(html.match(/href="\/now-defined"/g)).toHaveLength(3)
  })

  it('matches whole-document compilation across block boundaries and repeated bodies', () => {
    for (const first of blocks)
      for (const second of blocks)
        for (const separator of ['\n\n', '\n \t\n', '\n\n\n']) {
          const text = first + separator + second
          expect(compile(text), JSON.stringify(text)).toBe(micromark(text, options))
          expect(compile(text), 'cached ' + JSON.stringify(text)).toBe(micromark(text, options))
        }
  })

  it.each([
    '\n\n# Heading\n\nParagraph\n\n\n',
    '[A later definition][source]\n\n[source]:\n /exact/path\n "Title"',
    '[source]: /first\n\n[source]: /second\n\n[source]',
    '# [A heading reference][source]\n\n[source]: /exact/path',
    '- First\n\n  continued\n\n  ```ts\n  exact\n\n  ```',
    '> First\n\n> Second\n\nLazy continuation',
    '    First\n\n    Second\n\nParagraph',
    ' \tFirst\n\n \tSecond\n\nParagraph',
    '  \tFirst\n\n  \tSecond\n\nParagraph',
    '<script>\n\nLiteral script text\n\n</script>\n\nParagraph',
    '<!-- Open comment\n\nexact text\n\n-->\n\nParagraph',
    '<a title="\n\nExact title\n\n">literal</a>\n\nParagraph',
    '```ts\n\nUnclosed code\n\nwith blank lines',
    '```ts\n\n~~~\n\n# Still code\n\n```\n\nParagraph',
    '````ts\n\n```\n\n# Still code\n\n````\n\nParagraph',
    '```a`b\n\nThis is not a fence.\n\nParagraph',
    'Text\n```ts\n\nExact code\n\n```\nText\n\nParagraph',
    '| One | Two |\n| --- | --- |\n| a | b |\n\n| c | d |',
    'Setext text\n\n---\n\nMore text',
    '- [x] Done\n\n- [ ] Pending',
    'A footnote[^exact].\n\n[^exact]: First\n\n    More exact text.',
    '`First\n\nsecond`\n\nParagraph',
    '[Title](https://example.com "First\n\nsecond")\n\nParagraph',
    'First\n\t\nSecond',
    '',
    '\n\n\n',
  ])('preserves context and whitespace for %j', (text) => {
    expect(compile(text)).toBe(micromark(text, options))
  })
})
