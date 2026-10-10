import { createWebPreviewAPI } from './web-preview-adapter'
import { initializeWebResearchExample } from './web-research'
import './web-preview.css'

/** Install the browser bridge before importing React so its module-level API reference is correct. */
export async function bootWebPreview() {
  initializeWebResearchExample()
  window.relay = createWebPreviewAPI()
  document.documentElement.classList.add('life-browser-preview')
  await import('./main')
}
