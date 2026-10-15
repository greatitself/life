import { resolve } from 'node:path'
import type { BuildOptions, Plugin } from 'esbuild'

/** Match Vite's inline worker import in editable source builds and test fixtures. */
export function inlineWorkerPlugin(
  compiler: Pick<typeof import('esbuild'), 'build'>,
  options: Pick<BuildOptions, 'nodePaths' | 'define' | 'target'> = {},
): Plugin {
  return {
    name: 'life-inline-worker',
    setup(build) {
      build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?worker&inline$/, '')),
        namespace: 'life-inline-worker',
      }))
      build.onLoad({ filter: /.*/, namespace: 'life-inline-worker' }, async (args) => {
        const result = await compiler.build({
          ...options,
          entryPoints: [args.path],
          bundle: true,
          write: false,
          platform: 'browser',
          format: 'iife',
          minify: true,
          logLevel: 'silent',
        })
        const script = result.outputFiles?.[0]?.text
        if (!script) throw new Error('The history worker build produced no script.')
        return {
          loader: 'js',
          contents: `export default function InlineWorker() {
            const url = URL.createObjectURL(new Blob([${JSON.stringify(script)}], { type: 'text/javascript' }));
            let worker;
            try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
            const revoke = () => {
              URL.revokeObjectURL(url);
              worker.removeEventListener('message', revoke);
              worker.removeEventListener('error', revoke);
            };
            worker.addEventListener('message', revoke, { once: true });
            worker.addEventListener('error', revoke, { once: true });
            const terminate = worker.terminate.bind(worker);
            worker.terminate = () => { revoke(); terminate(); };
            return worker;
          }`,
        }
      })
    },
  }
}
