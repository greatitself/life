const { build } = require('esbuild')

build({
  entryPoints: ['src/web/server.ts'],
  outfile: 'out/web/server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
}).catch(() => {
  process.exitCode = 1
})
