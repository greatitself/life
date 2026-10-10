import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createWebApplication } from './src/web/application'
const staticPreview = process.env.LIFE_WEB_STATIC === 'true'
const base = process.env.LIFE_WEB_BASE || '/life/'
export default defineConfig({
  root: 'src/renderer',
  publicDir: 'web-public',
  base,
  define: {
    'import.meta.env.VITE_LIFE_WEB_PREVIEW': JSON.stringify(String(staticPreview)),
    'import.meta.env.VITE_LIFE_WEB_APP': JSON.stringify(String(!staticPreview)),
  },
  plugins: [
    react(),
    {
      name: 'life-web-application',
      async configureServer(server) {
        if (staticPreview) return
        const application = await createWebApplication(process.cwd(), base)
        server.httpServer?.once('close', () => {
          void application.close()
        })
        server.middlewares.use((request, response, next) => {
          void application
            .handle(request, response)
            .then((handled) => {
              if (!handled) next()
            })
            .catch(next)
        })
      },
    },
    {
      name: 'life-browser-document-policy',
      transformIndexHtml(html) {
        return html.replace(
          'Life — Remote agent workspace',
          staticPreview ? 'Life — Browser preview' : 'Life — Web app',
        )
      },
    },
  ],
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../dist-web', emptyOutDir: true },
})
