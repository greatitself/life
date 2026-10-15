import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { renderSettledMarkdown } from '../src/renderer/settled-markdown'
import { MessageView } from '../src/renderer/components/MessageView'

const examples = [
  '',
  'Exact ordinary text.\n',
  '## Heading\n\nA **strong**, _emphasized_ and ~~deleted~~ reply with `inline <code>`.',
  'First paragraph\n\nSecond paragraph\n\n---\n',
  '> A quote\n>\n> - first\n> - **second**\n',
  '3. third\n4. fourth\n\n- one\n- two\n',
  '[Source](https://example.com/a?q=%22x%22 "Provider title") and <https://example.com> and a@example.com',
  '[Later reference][source]\n\n[source]: /exact/path?q=1&v=2 "Title"\n',
  '[Relative](../path#anchor), [email](mailto:a@example.com), [IRC](irc://example.com), [blocked](javascript:alert%281%29)',
  '[Encoded dangerous URL](javascript&#58;alert%281%29) and [data](data:text/html,a)',
  '| Left | Right |\n| :--- | ---: |\n| **one** | `two` |\n',
  '```ts\nconst exact = "<tag>&\\\"";\n```\n',
  '```\n</code></pre><script>alert("literal")</script>\n```',
  '```a&quot;b metadata\nquoted language\n```',
  '```a&#32;b\nhello <exact>\n```',
  '```a&#9;b\nhello <exact>\n```',
  '```a&#10;b\nhello <exact>\n```',
  '```a&#x09;b\nhello <exact>\n```',
  '```a&#160;b\nhello <exact>\n```',
  '```a&ensp;b\nhello <exact>\n```',
  '```&#32;a\nhello <exact>\n```',
  '```ts\n\n```',
  '~~~ts\n\n~~~',
  '```ts\n\n',
  '```\n\n```',
  '```ts\n\n\n```',
  '    indented code\n    <literal>\n',
  '> ```ts\n> nested code\n> ```\n',
  '```ts\nUnclosed code with no terminal newline',
  '<div onclick="alert(1)">Literal HTML & text</div>\n',
  '<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>',
  'Literal <b>inline HTML</b> and <!-- comment -->.\n',
  'Line with a hard break.  \nNext line.\n',
  'Line with an escaped break.\\\nNext line.\n',
  '&copy; &amp; &#x1F642; \\*literal\\*\n',
  '## First complete result\n\nRepeated **body**.\n\n```ts\nexact code\n\n// Exact blank line\n```\n\nLast paragraph.',
  '## Second complete result\n\nRepeated **body**.\n\n```ts\nexact code\n\n// Exact blank line\n```\n\nLast paragraph.',
  '# [Heading reference][source]\n\n[source]: /exact/path\n\n[Body reference][source]',
  '- First item\n\n  continued text\n\n  ```ts\n  nested code\n\n  ```\n\n- Second item',
  'Heading\n=======\n\n---\n\nLast paragraph.',
]

function previousMarkdown(text: string): string {
  return renderToStaticMarkup(
    ReactMarkdown({
      children: text,
      remarkPlugins: [remarkGfm],
      components: {
        a: ({ children, href }: { children?: ReactNode; href?: string }) =>
          createElement('a', { href, target: '_blank', rel: 'noreferrer', title: href }, children),
        pre: ({ children }: { children?: ReactNode }) =>
          createElement('pre', { tabIndex: 0 }, children),
      },
    }),
  )
}

function undecorated(html: string): string {
  return html
    .replace(
      /<div class="thread-code-block"><div class="thread-code-heading">[\s\S]*?<\/button><\/div>(<pre[\s\S]*?<\/pre>)<\/div>/g,
      '$1',
    )
    .replace(/ ?\/>/g, '>')
}

describe('settled Markdown semantic compatibility', () => {
  it.each(examples)('matches the established renderer for %j', (text) => {
    const rendered = renderSettledMarkdown(text)
    expect(rendered).toBeDefined()
    expect(undecorated(rendered!.__html)).toBe(undecorated(previousMarkdown(text)))
  })

  it.each([
    'First line\r\nsecond line\r\n',
    '```ts\r\nconst exact = "<tag>&";\r\n```\r\n',
    'Encoded carriage return a&#13;b.',
    'Encoded carriage return a&#xD;b.',
    '```a&#13;b\nhello <exact>\n```',
    '```a&#xD;b\nhello <exact>\n```',
    '![Exact alternative text](https://example.com/image.png "Exact title")',
    '![Existing image protocol](mailto:a@example.com)',
    '- [x] completed\n- [ ] pending',
    'First reference[^note].\n\n[^note]: Exact footnote.',
  ])('retains the established structured renderer for %j', (text) => {
    expect(renderSettledMarkdown(text)).toBeUndefined()
    const message = { id: 'exact', role: 'assistant' as const, text, turn: 1 }
    const previous = renderToStaticMarkup(
      createElement(MessageView, { message, provider: 'codex' }),
    )
    const settled = renderToStaticMarkup(
      createElement(MessageView, { message, provider: 'codex', settled: true }),
    )
    expect(settled).toBe(previous)
  })

  it('decorates compiler-generated code only and keeps raw HTML inert', () => {
    const html = renderSettledMarkdown(
      '<button data-markdown-copy>Provider HTML</button>\n\n```ts\n<button data-markdown-copy>Exact code</button>\n```',
    )!.__html
    expect(html.match(/data-markdown-copy>/g)).toHaveLength(1)
    expect(html).toContain('&lt;button data-markdown-copy&gt;Provider HTML&lt;/button&gt;')
    expect(html).toContain('&lt;button data-markdown-copy&gt;Exact code&lt;/button&gt;')
    expect(html).not.toContain('<script')
  })

  it.each([
    ['a&#32;b', 'a'],
    ['a&#9;b', 'a'],
    ['a&#10;b', 'a'],
    ['a&#160;b', 'a'],
    ['a&ensp;b', 'a'],
    ['&#32;a', 'Code'],
  ])('keeps the established code heading for decoded fence info %j', (info, heading) => {
    const text = '```' + info + '\nhello <exact>\n```'
    const html = renderSettledMarkdown(text)!.__html
    expect(html).toContain(`<div class="thread-code-heading"><span>${heading}</span>`)
    expect(html).toContain(
      '<code class="language-' +
        (heading === 'Code' ? '' : heading) +
        '">hello &lt;exact&gt;\n</code>',
    )
  })
})
