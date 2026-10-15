import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { createMarkdownBlockCompiler } from './markdown-block-cache'

const extensions = [gfm()]
const htmlExtensions = [gfmHtml()]
const compileMarkdown = createMarkdownBlockCompiler({ extensions, htmlExtensions })

// These use the same Lucide paths as the React copy controls. Only a clicked
// control's icon changes; the message DOM, focus and selection remain intact.
const iconAttributes =
  'xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
export const markdownCopyIcon = `<svg ${iconAttributes} class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`
export const markdownCopiedIcon = `<svg ${iconAttributes} class="lucide lucide-check"><path d="M20 6 9 17l-5-5"></path></svg>`

/** Compile completed history without allocating a React element for each token. */
export function renderSettledMarkdown(text: string): { __html: string } | undefined {
  // HTML parsing normalizes CRLF text nodes, while the established React path
  // retains them in ordinary prose. Preserve those exact selection/copy bytes.
  // Detect fallback syntax before compiling so those histories are parsed once.
  if (text.includes('\r') || text.includes('![') || text.includes('[^') || /\[[ xX]\]/.test(text))
    return undefined
  // Raw HTML remains escaped and unsafe URL schemes remain disabled. The
  // replacements below see compiler-generated tags only, never provider HTML.
  const compiled = compileMarkdown(text)
  // These generated structures differ from react-markdown's current image URL
  // transform, task-list classes or footnote attributes. Keep its exact renderer
  // for those messages rather than changing their established behavior.
  // A decoded CR reference also needs React text nodes to retain exact bytes.
  if (
    compiled.includes('\r') ||
    compiled.includes('<img ') ||
    compiled.includes('type="checkbox"') ||
    compiled.includes('data-footnotes=')
  )
    return undefined
  const html = compiled
    .replace(/\n+$/, '')
    .replace(
      /<table>([\s\S]*?)<\/table>/g,
      (_, table: string) =>
        `<table>${table.replace(/^\n|\n$/g, '').replace(/>\n(?=<)/g, '>')}</table>`,
    )
    .replace(
      /<a href="([^"]*)"[^>]*>/g,
      (_, href: string) => `<a href="${href}" target="_blank" rel="noreferrer" title="${href}">`,
    )
    .replace(/ align="(left|center|right)"/g, ' style="text-align:$1"')
    .replace(
      /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
      (_, language: string | undefined, code: string) => {
        // The established hast code handler keeps the first decoded language.
        // HTML character references can introduce whitespace into fence info.
        const firstLanguage = language?.split(/\s+/)[0]
        // mdast's empty code value stays empty; the HTML compiler emits one LF
        // for a fence containing a single blank line. Keep copy bytes identical.
        const exactCode = code === '\n' ? '' : code
        return `<div class="thread-code-block"><div class="thread-code-heading"><span>${firstLanguage || 'Code'}</span><button type="button" class="icon-button" aria-label="Copy code" data-markdown-copy>${markdownCopyIcon}</button></div><pre tabindex="0"><code${language !== undefined ? ` class="language-${firstLanguage}"` : ''}>${exactCode}</code></pre></div>`
      },
    )
  return { __html: html }
}
