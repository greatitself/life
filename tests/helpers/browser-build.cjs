const esbuild = require('esbuild')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

let plugin
async function loadPlugin() {
  plugin ||= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-inline-worker-plugin-'))
    try {
      const outfile = join(directory, 'plugin.cjs')
      await esbuild.build({
        entryPoints: [resolve(__dirname, '../../src/main/inline-worker-plugin.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent',
      })
      return require(outfile).inlineWorkerPlugin
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })()
  return plugin
}

exports.build = async (options) => {
  const inlineWorkerPlugin = await loadPlugin()
  return esbuild.build({
    ...options,
    plugins: [
      inlineWorkerPlugin(esbuild, {
        nodePaths: options.nodePaths,
        define: options.define,
        target: options.target,
      }),
      ...(options.plugins || []),
    ],
  })
}
