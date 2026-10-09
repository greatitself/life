import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: 'src/renderer',
  publicDir: 'web-public',
  base: process.env.LIFE_WEB_BASE || '/life/',
  define: { 'import.meta.env.VITE_LIFE_WEB_PREVIEW': JSON.stringify('true') },
  plugins: [
    react(),
    {
      name: 'life-browser-document-policy',
      transformIndexHtml(html) {
        return html.replace('Life — Remote agent workspace', 'Life — Browser preview')
      },
    },
  ],
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../dist-web', emptyOutDir: true },
})
