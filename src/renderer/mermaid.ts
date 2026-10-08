// Mermaid uses global configuration. Serialize all panels and maps through one queue.
let queue: Promise<unknown> = Promise.resolve()
export function queueMermaidRender<T>(render: () => Promise<T>): Promise<T> {
  const result = queue.then(render, render)
  queue = result.catch(() => undefined)
  return result
}
