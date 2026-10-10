/** This loader stays bundled so editable React code cannot remove Life's recovery route. */
async function boot() {
  if (import.meta.env?.VITE_LIFE_WEB_APP === 'true') {
    const { createWebApplicationAPI } = await import('./web-app-adapter')
    window.relay = await createWebApplicationAPI()
    document.documentElement.classList.add('life-browser-preview')
    await import('./web-preview.css')
  }
  if (import.meta.env?.VITE_LIFE_WEB_PREVIEW === 'true') {
    const { bootWebPreview } = await import('./web-preview')
    await bootWebPreview()
    return
  }
  const { api } = await import('./api')
  const state = await api?.sourceCode?.get()
  if (!state?.enabled || !state.active) {
    await import('./main')
    return
  }
  const { revision, js, css } = state.active
  let ready = false
  let restoring = false
  const restore = async (error: unknown) => {
    if (restoring) return
    restoring = true
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 10000)
    // This window may be finishing an old render while another source revision
    // has already been installed. The native host also checks this revision.
    const current = await api!.sourceCode.get().catch(() => undefined)
    if (current && (!current.enabled || current.active?.revision !== revision)) return
    await api!.sourceCode.reportError(revision, message).catch(() => {})
  }
  const onError = (event: ErrorEvent) => {
    if (!ready) void restore(event.error || event.message)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!ready) void restore(event.reason)
  }
  const onRendererError = (event: Event) => {
    const message = (event as CustomEvent<unknown>).detail
    void restore(
      typeof message === 'string' ? message : 'The customized workspace could not render.',
    )
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  // React error boundaries handle their errors without dispatching a global
  // error. Keep this listener after startup for later fatal render failures.
  window.addEventListener('life:renderer-error', onRendererError)
  try {
    if (css) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = css
      const loaded = new Promise<void>((resolve, reject) => {
        link.onload = () => resolve()
        link.onerror = () => reject(new Error('The customized stylesheet could not be loaded.'))
      })
      document.head.append(link)
      await loaded
    }
    await import(/* @vite-ignore */ js)
    // React's initial render is scheduled. A committed root confirms that the
    // generated entry loaded and mounted before the native watchdog is cleared.
    await new Promise<void>((resolve) => {
      if (document.getElementById('root')?.childElementCount) return resolve()
      const observer = new MutationObserver(() => {
        if (!document.getElementById('root')?.childElementCount) return
        observer.disconnect()
        resolve()
      })
      observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    if (restoring) return
    const failedRoot = document.getElementById('root')?.querySelector('[data-life-renderer-error]')
    if (failedRoot) {
      await restore(
        failedRoot.getAttribute('data-life-renderer-error') ||
          'The customized workspace could not render.',
      )
      return
    }
    await api!.sourceCode.ready(revision)
    localStorage.removeItem('life.pendingSourceApply')
    ready = true
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  } catch (error) {
    await restore(error)
  }
}

void boot().catch(async (error) => {
  // A broken state lookup must also leave the built-in workspace available.
  console.error('Life could not load its customized interface:', error)
  if (import.meta.env?.VITE_LIFE_WEB_APP === 'true' && !window.relay) {
    const root = document.getElementById('root')!
    root.textContent =
      'Life could not connect to its web server. Start npm run dev:web, then refresh this page.'
    return
  }
  await import('./main')
})
