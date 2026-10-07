import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../dist-web' },
})
