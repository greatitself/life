import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { lifeRendererReloadPlugin } from './scripts/vite-renderer-reload'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['effect'] }),
      {
        name: 'life-editable-source-manifest',
        closeBundle() {
          const directory = resolve('out/source')
          mkdirSync(directory, { recursive: true })
          copyFileSync(resolve('package.json'), resolve(directory, 'package.json'))
          buildSync({
            entryPoints: [resolve('src/main/conversation-checkpoint-worker.ts')],
            outfile: resolve('out/main/conversation-checkpoint-worker.js'),
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node22',
          })
          buildSync({
            entryPoints: [resolve('tests/source-runtime-smoke.ts')],
            outfile: resolve(directory, 'runtime-smoke.cjs'),
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node22',
          })
        },
      },
    ],
    build: { rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [lifeRendererReloadPlugin(), react()],
    build: { minify: true, rollupOptions: { input: 'src/renderer/index.html' } },
  },
})
