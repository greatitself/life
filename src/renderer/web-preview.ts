import { createWebPreviewAPI } from './web-preview-adapter'
import { exportWebResearchFiles, initializeWebResearchExample } from './web-research'
import { LIFE_VERSION } from '../shared/version'
import './web-preview.css'

/** Install the browser bridge before importing React so its module-level API reference is correct. */
export async function bootWebPreview() {
  initializeWebResearchExample()
  window.relay = createWebPreviewAPI()
  document.documentElement.classList.add('life-browser-preview')
  const banner = document.createElement('aside')
  banner.className = 'life-browser-banner'
  banner.setAttribute('aria-label', 'Browser preview information')
  const label = document.createElement('strong')
  label.textContent = 'Life browser preview'
  const explanation = document.createElement('span')
  explanation.textContent =
    'Editable Research and preferences stay in this browser. SSH, agents, and source builds require desktop.'
  const feedback = document.createElement('a')
  feedback.href =
    'https://github.com/greatitself/life/issues/new?' +
    new URLSearchParams({
      title: 'Life web preview feedback',
      body: `Life ${LIFE_VERSION} web preview\n\nView or component:\n\nRequested change:\n\n`,
    })
  feedback.target = '_blank'
  feedback.rel = 'noopener noreferrer'
  feedback.textContent = 'Give feedback'
  const exportButton = document.createElement('button')
  exportButton.textContent = 'Export Research'
  exportButton.type = 'button'
  exportButton.addEventListener('click', () => {
    const data = JSON.stringify(
      {
        format: 'life-web-research',
        version: 1,
        exportedAt: new Date().toISOString(),
        files: exportWebResearchFiles(),
      },
      null,
      2,
    )
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const download = document.createElement('a')
    download.href = url
    download.download = 'life-web-research.json'
    download.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const desktop = document.createElement('a')
  desktop.href = 'https://github.com/greatitself/life/releases/latest'
  desktop.target = '_blank'
  desktop.rel = 'noopener noreferrer'
  desktop.textContent = 'Get desktop'
  banner.append(label, explanation, feedback, exportButton, desktop)
  document.body.prepend(banner)
  await import('./main')
}
