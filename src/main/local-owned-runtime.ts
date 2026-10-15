import { shellQuote } from '../shared/validation'

/** Life-owned scripts use Electron's bundled Node without changing the user's shell environment. */
export function localOwnedNodeCommand(program: string): string {
  return `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} -e ${shellQuote(program)}`
}
