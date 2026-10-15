# Life development

Life is an Electron application for Codex and Claude Code over SSH. Preserve exact user prompts, provider session identity, workspace ownership, recoverable history, and native permission responses when changing services.

Use Effect for asynchronous domain logic, typed failures, resource ownership, concurrency, and application services. Keep Promise adapters at Electron, SSH library, and React integration boundaries. Keep pure rendering and projections lightweight. Do not replace the providers' native protocols with another inference API.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Verification

Run `npm run typecheck`, relevant unit/integration tests, and `npm run build`. Verify changed user workflows in the running application using the existing browser and Electron smoke fixtures. Measure performance with the same fixture before and after a change; distinguish fixture checks from authenticated upstream provider use.
