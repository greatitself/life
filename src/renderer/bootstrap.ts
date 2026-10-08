/** This loader stays bundled so editable React code cannot remove Life's recovery route. */
import { api } from './api'

async function boot() {
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
    const message = error instanceof Error ? error.message : String(error)
    await api!.sourceCode.reportError(revision, message).catch(() => {})
  }
  const onError = (event: ErrorEvent) => {
    if (!ready) void restore(event.error || event.message)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!ready) void restore(event.reason)
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
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
  await import('./main')
})
