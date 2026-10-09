import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/dm-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { api } from './api'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary recoveryApi={api}>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
)
