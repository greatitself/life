import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { MessageChannel } from 'node:worker_threads'
import { SourceCodeStore } from '../src/main/source-code'

const directories: string[] = []
const stores: SourceCodeStore[] = []
const originalEntry = `
import React from 'react'
import './styles.css'
import { greeting } from '../shared/greeting'
;(globalThis as any).__life_source_test_control = React.createElement('button', { id: 'base-control' }, greeting)
`

async function createStore(extraFiles: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'life-source-test-'))
  directories.push(directory)
  const sourceDir = join(directory, 'app-source')
  await mkdir(join(sourceDir, 'src', 'renderer'), { recursive: true })
  await mkdir(join(sourceDir, 'src', 'shared'), { recursive: true })
  await writeFile(join(sourceDir, 'src', 'renderer', 'main.tsx'), originalEntry)
  await writeFile(
    join(sourceDir, 'src', 'renderer', 'styles.css'),
    '.workspace { color: #151515; }',
  )
  await writeFile(
    join(sourceDir, 'src', 'shared', 'greeting.ts'),
    "export const greeting: string = 'Original workspace'\n",
  )
  await writeFile(
    join(sourceDir, 'package.json'),
    JSON.stringify({
      name: 'life-source-test',
      version: '1.0.0',
      private: true,
      dependencies: { react: '^19.1.0' },
    }),
  )
  for (const [path, content] of Object.entries(extraFiles)) {
    const file = join(sourceDir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const onUpdate = vi.fn()
  const options = {
    sourceDir,
    nodeModulesDir: resolve('node_modules'),
    directory: join(directory, 'customizations'),
    onUpdate,
    compilerTimeoutMs: 10_000,
    installTimeoutMs: 20_000,
  }
  const store = new SourceCodeStore(options)
  stores.push(store)
  await store.init()
  return { store, directory, options, onUpdate }
}

async function patchedControl(store: SourceCodeStore, label: string) {
  const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
  return store.apply({
    summary: `Add the ${label} workspace control`,
    baseRevision: context.revision,
    files: [
      {
        path: 'src/renderer/ResearchControl.tsx',
        content: `import React from 'react'\nexport function ResearchControl() { return <button id="research-control" data-effort="high">${label}</button> }\n`,
      },
      {
        path: 'src/renderer/main.tsx',
        content: `import './styles.css'\nimport { ResearchControl } from './ResearchControl'\n;(globalThis as any).__life_source_test_control = ResearchControl()\n`,
      },
    ],
  })
}

async function executeControl(store: SourceCodeStore) {
  const snapshot = store.get()
  expect(snapshot.active).toBeTruthy()
  const js = snapshot.active!.js
  const asset = store.assetPath(js)
  expect(asset).toBeTruthy()
  const scope: Record<string, unknown> = {}
  const channels: MessageChannel[] = []
  class TestMessageChannel extends MessageChannel {
    constructor() {
      super()
      channels.push(this)
    }
  }
  try {
    runInNewContext(await readFile(asset!, 'utf8'), {
      globalThis: scope,
      console,
      TextEncoder,
      TextDecoder,
      MessageChannel: TestMessageChannel,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      performance,
    })
  } finally {
    for (const channel of channels) {
      channel.port1.close()
      channel.port2.close()
    }
  }
  return scope.__life_source_test_control as {
    type: string
    props: { children: string; id: string; 'data-effort'?: string }
  }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('installed Life source customization', () => {
  it('provides the actual editable renderer and shared source with a revision for edits', async () => {
    const { store } = await createStore()
    const context = await store.getContext({
      paths: ['src/renderer/main.tsx', 'src/shared/greeting.ts'],
    })
    expect(context.revision).toBeGreaterThanOrEqual(0)
    expect(context.paths).toContain('src/renderer/main.tsx')
    expect(context.paths).toContain('src/renderer/styles.css')
    expect(context.paths).toContain('src/shared/greeting.ts')
    expect(context.files).toEqual(
      expect.arrayContaining([
        { path: 'src/renderer/main.tsx', content: originalEntry },
        {
          path: 'src/shared/greeting.ts',
          content: "export const greeting: string = 'Original workspace'\n",
        },
      ]),
    )
  })

  it('compiles and executes new arbitrary TSX controls with installed React and local styles', async () => {
    const { store, onUpdate } = await createStore()
    const snapshot = await patchedControl(store, 'Reasoning effort')
    expect(snapshot.active).toBeTruthy()
    expect(snapshot.canRollback).toBe(true)
    expect(snapshot.active!.css).toBeTruthy()
    const cssAsset = store.assetPath(snapshot.active!.css!)
    expect(await readFile(cssAsset!, 'utf8')).toContain('#151515')
    expect(await executeControl(store)).toMatchObject({
      type: 'button',
      props: { id: 'research-control', children: 'Reasoning effort', 'data-effort': 'high' },
    })
    expect(onUpdate).toHaveBeenCalled()
    expect(
      (await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })).files[0].content,
    ).toContain('Reasoning effort')
  })

  it('compiles the complete installed Life renderer with its real fonts, icons, and shared package version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-source-full-renderer-'))
    directories.push(directory)
    const store = new SourceCodeStore({
      sourceDir: resolve('.'),
      nodeModulesDir: resolve('node_modules'),
      directory,
      compilerTimeoutMs: 40_000,
    })
    stores.push(store)
    await store.init()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const snapshot = await store.apply({
      summary: 'Compile the complete Life workspace with an innocuous source marker',
      baseRevision: context.revision,
      files: [
        {
          path: 'src/renderer/main.tsx',
          content:
            context.files[0].content +
            '\n;(globalThis as any).__life_full_renderer_compile_test = true\n',
        },
      ],
    })
    expect(snapshot.active?.css).toBeTruthy()
    const jsAsset = store.assetPath(snapshot.active!.js)
    expect(jsAsset).toBeTruthy()
    expect(await readFile(jsAsset!, 'utf8')).toContain('__life_full_renderer_compile_test')
    expect((await stat(store.assetPath(snapshot.active!.css!)!)).size).toBeGreaterThan(1000)
    const files = (await readdir(dirname(jsAsset!), { recursive: true })).map((file) =>
      file.split('\\').join('/'),
    )
    const icons = files.filter((file) => /\.svg$/.test(file))
    const fonts = files.filter((file) => /\.woff2?$/.test(file))
    expect(icons.length).toBeGreaterThanOrEqual(2)
    expect(fonts.length).toBeGreaterThan(0)
    for (const file of [...icons, ...fonts]) {
      const asset = store.assetPath(new URL(file, snapshot.active!.js).toString())
      expect(asset).toBeTruthy()
      expect((await stat(asset!)).size).toBeGreaterThan(0)
    }
    expect(store.assetPath(new URL('../package.json', snapshot.active!.js).toString())).toBeNull()
    expect(
      store.assetPath(new URL('src/renderer/App.tsx', snapshot.active!.js).toString()),
    ).toBeNull()
  }, 45_000)

  it('processes optional Tailwind v4 classes and directives in the full installed renderer while retaining a working build on CSS errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'life-source-tailwind-renderer-'))
    directories.push(directory)
    const store = new SourceCodeStore({
      sourceDir: resolve('.'),
      nodeModulesDir: resolve('node_modules'),
      directory,
      compilerTimeoutMs: 35_000,
      installTimeoutMs: 40_000,
    })
    stores.push(store)
    await store.init()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const tailwindCss = `@import "tailwindcss";
@theme { --color-life-accent: #123456; }
.custom-apply { @apply p-7; }
`
    const snapshot = await store.apply({
      summary: 'Enable optional Tailwind v4 for a newly added React component',
      baseRevision: context.revision,
      dependencies: {
        tailwindcss: '4.3.3',
        '@tailwindcss/postcss': '4.3.3',
        postcss: '8.5.29',
      },
      files: [
        {
          path: 'src/renderer/TailwindSourceProof.tsx',
          content: `export function TailwindSourceProof() {
  return <div className="p-7 font-bold underline bg-life-accent custom-apply">Optional Tailwind package proof</div>
}
`,
        },
        { path: 'src/renderer/tailwind-entry.css', content: tailwindCss },
        {
          path: 'src/renderer/main.tsx',
          content:
            context.files[0].content +
            `
import './tailwind-entry.css'
import { TailwindSourceProof } from './TailwindSourceProof'
;(globalThis as any).__life_tailwind_compile_probe = React.createElement(TailwindSourceProof)
`,
        },
      ],
    })
    expect(snapshot.active?.css).toBeTruthy()
    const cssAsset = store.assetPath(snapshot.active!.css!)
    expect(cssAsset).toBeTruthy()
    const generatedCss = await readFile(cssAsset!, 'utf8')
    for (const className of ['.p-7', '.font-bold', '.underline', '.bg-life-accent']) {
      expect(generatedCss).toContain(className)
    }
    expect(generatedCss).toContain('#123456')
    expect(generatedCss).toMatch(/\.custom-apply[^}]*padding:/)
    expect(generatedCss).not.toMatch(/@apply|@theme|@import\s*["']tailwindcss["']/)
    const working = store.get()
    const accepted = await store.getContext({ paths: ['src/renderer/tailwind-entry.css'] })
    await expect(
      store.apply({
        summary: 'Reject a CSS edit referencing a nonexistent Tailwind utility',
        baseRevision: accepted.revision,
        files: [
          {
            path: 'src/renderer/tailwind-entry.css',
            content: tailwindCss + '\n.broken-proof { @apply life-nonexistent-padding; }\n',
          },
        ],
      }),
    ).rejects.toThrow(/life-nonexistent-padding|unknown utility/i)
    expect(store.get().active).toEqual(working.active)
    const retained = await store.getContext({ paths: ['src/renderer/tailwind-entry.css'] })
    expect(retained.revision).toBe(accepted.revision)
    expect(retained.files[0].content).toBe(tailwindCss)
    expect(await readFile(store.assetPath(working.active!.css!)!, 'utf8')).toBe(generatedCss)
  }, 60_000)

  it('requires explicitly installed Tailwind dependencies instead of shipping raw utility directives', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Working plain CSS application')
    const before = store.get()
    const context = await store.getContext({ paths: ['src/renderer/styles.css'] })
    await expect(
      store.apply({
        summary: 'Try Tailwind directives without their compiler dependencies',
        baseRevision: context.revision,
        files: [
          {
            path: 'src/renderer/styles.css',
            content: '@theme { --color-life-accent: #123456; } .custom-apply { @apply p-7; }',
          },
        ],
      }),
    ).rejects.toThrow(/Add tailwindcss, @tailwindcss\/postcss, and postcss/)
    expect(store.get().active).toEqual(before.active)
    expect((await store.getContext({ paths: ['src/renderer/styles.css'] })).files).toEqual(
      context.files,
    )
  })

  it('installs a real npm dependency with the bundled installer and executes the bundled package', async () => {
    const { store } = await createStore()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await store.apply({
      summary: 'Add a real pure JavaScript package to the customized renderer',
      baseRevision: context.revision,
      dependencies: { 'is-number': '7.0.0' },
      files: [
        {
          path: 'src/renderer/main.tsx',
          content:
            "import React from 'react'\nimport isNumber from 'is-number'\n;(globalThis as any).__life_source_test_control = React.createElement('output', { id: 'npm-package-control' }, isNumber(4.2) && !isNumber('research') ? 'Dependency executed' : 'Dependency failed')\n",
        },
      ],
    })
    expect(await executeControl(store)).toMatchObject({
      type: 'output',
      props: { id: 'npm-package-control', children: 'Dependency executed' },
    })
    expect(
      (await store.getContext({ paths: ['src/renderer/main.tsx'] })).dependencies['is-number'],
    ).toBe('7.0.0')
  }, 30_000)

  it('bundles a real newly installed Radix component with one React runtime and renders its hooks successfully', async () => {
    const { store } = await createStore()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await store.apply({
      summary: 'Verify newly installed React component packages use the canonical React runtime',
      baseRevision: context.revision,
      dependencies: { '@radix-ui/react-select': '2.2.6' },
      files: [
        {
          path: 'src/renderer/main.tsx',
          content: `import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import * as Select from '@radix-ui/react-select'
const rendered = renderToStaticMarkup(<Select.Root defaultValue="high"><Select.Trigger id="radix-proof">High reasoning effort</Select.Trigger></Select.Root>)
;(globalThis as any).__life_source_test_control = { type: 'output', props: { id: 'radix-package-control', children: rendered } }
`,
        },
      ],
    })
    const control = await executeControl(store)
    expect(control.props.children).toContain('role="combobox"')
    expect(control.props.children).toContain('High reasoning effort')
    expect(control.props.children).toContain('id="radix-proof"')
  }, 30_000)

  it('reports compiler diagnostics without replacing working source or its active build', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Working research controls')
    const before = store.get()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await expect(
      store.apply({
        summary: 'Attempt an invalid JSX edit',
        baseRevision: context.revision,
        files: [
          { path: 'src/renderer/main.tsx', content: 'export function Broken( { return <button>' },
        ],
      }),
    ).rejects.toThrow(/renderer\/main\.tsx|compile|syntax|expected/i)
    expect(store.get().active).toEqual(before.active)
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).revision).toBe(
      context.revision,
    )
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).files).toEqual(
      context.files,
    )
    expect((await executeControl(store)).props.children).toBe('Working research controls')
  })

  it('clears stale compile diagnostics on manual disable while preserving the previously accepted source and build', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Accepted workspace before manual stop')
    const before = store.get()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await expect(
      store.apply({
        summary: 'Try a source edit that does not compile',
        baseRevision: context.revision,
        files: [{ path: 'src/renderer/main.tsx', content: 'export function Broken( {' }],
      }),
    ).rejects.toThrow(/build|compile|expected/i)
    expect(store.get().error).toBeTruthy()
    const disabled = await store.disable()
    expect(disabled.enabled).toBe(false)
    expect(disabled.active).toBeUndefined()
    expect(disabled.error).toBeUndefined()
    expect(disabled.summary).toBe(before.summary)
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).files).toEqual(
      context.files,
    )
    expect(store.assetPath(before.active!.js)).toBeTruthy()
  })

  it('rejects unresolved imports with a useful filename and keeps the previous working build', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Keep this control')
    const before = store.get()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await expect(
      store.apply({
        summary: 'Import a missing source module',
        baseRevision: context.revision,
        files: [{ path: 'src/renderer/main.tsx', content: "import './NotThere'\n" }],
      }),
    ).rejects.toThrow(/NotThere|resolve|not found/i)
    expect(store.get().active).toEqual(before.active)
  })

  it('applies an exact source edit and recompiles the real imported module', async () => {
    const { store } = await createStore()
    const context = await store.getContext({ paths: ['src/shared/greeting.ts'] })
    await store.apply({
      summary: 'Change a source module with a focused edit',
      baseRevision: context.revision,
      files: [
        {
          path: 'src/shared/greeting.ts',
          edits: [{ find: 'Original workspace', replace: 'Custom research workspace' }],
        },
      ],
    })
    expect((await executeControl(store)).props.children).toBe('Custom research workspace')
    expect(
      (await store.getContext({ paths: ['src/shared/greeting.ts'] })).files[0].content,
    ).toContain('Custom research workspace')
  })

  it('rejects missing and ambiguous edit targets without replacing working code', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Keep working control')
    const context = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    const before = store.get()
    for (const find of ['this source text is absent', 'button']) {
      await expect(
        store.apply({
          summary: 'Try a source edit that cannot be applied uniquely',
          baseRevision: context.revision,
          files: [{ path: 'src/renderer/ResearchControl.tsx', edits: [{ find, replace: 'span' }] }],
        }),
      ).rejects.toThrow(/find|match|missing|occur|unique|ambiguous/i)
      expect(store.get().active).toEqual(before.active)
    }
    expect((await executeControl(store)).props.children).toBe('Keep working control')
  })

  it('creates and removes unused source files while preserving the active workspace', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Workspace retained')
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await store.apply({
      summary: 'Add a helper module',
      baseRevision: context.revision,
      files: [{ path: 'src/shared/temporary-helper.ts', content: 'export const temporary = 1\n' }],
    })
    const created = await store.getContext({ paths: ['src/shared/temporary-helper.ts'] })
    expect(created.files[0].content).toContain('temporary = 1')
    await store.apply({
      summary: 'Remove an unused helper module',
      baseRevision: created.revision,
      files: [{ path: 'src/shared/temporary-helper.ts', content: null }],
    })
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).paths).not.toContain(
      'src/shared/temporary-helper.ts',
    )
    expect((await executeControl(store)).props.children).toBe('Workspace retained')
  })

  it('rejects stale edits instead of overwriting newer user customizations', async () => {
    const { store } = await createStore()
    const stale = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await patchedControl(store, 'Latest user customization')
    await expect(
      store.apply({
        summary: 'Apply a response from an old conversation',
        baseRevision: stale.revision,
        files: [{ path: 'src/renderer/main.tsx', content: originalEntry }],
      }),
    ).rejects.toThrow(/revision|stale|changed|latest/i)
    expect((await executeControl(store)).props.children).toBe('Latest user customization')
  })

  it('serializes concurrent proposals so only one response can commit a shared revision', async () => {
    const { store } = await createStore()
    const context = await store.getContext({ paths: ['src/shared/greeting.ts'] })
    const results = await Promise.allSettled(
      ['Concurrent version A', 'Concurrent version B'].map((label) =>
        store.apply({
          summary: label,
          baseRevision: context.revision,
          files: [
            { path: 'src/shared/greeting.ts', content: `export const greeting = '${label}'\n` },
          ],
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(/revision|stale|changed|latest/i)
    const acceptedIndex = results.findIndex((result) => result.status === 'fulfilled')
    expect((await executeControl(store)).props.children).toBe(
      ['Concurrent version A', 'Concurrent version B'][acceptedIndex],
    )
  })

  it.each([
    '../escape.ts',
    '/tmp/life-escape.ts',
    'src/renderer/../../escape.ts',
    'C:\\life-escape.ts',
    'renderer\\..\\..\\escape.ts',
  ])('rejects an edit escaping source boundaries: %s', async (path) => {
    const { store } = await createStore()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    await expect(
      store.apply({
        summary: 'Write outside the application source',
        baseRevision: context.revision,
        files: [{ path, content: 'export const escaped = true\n' }],
      }),
    ).rejects.toThrow(/path|relative|outside|invalid|traversal/i)
    expect((await store.getContext({ paths: ['src/renderer/main.tsx'] })).revision).toBe(
      context.revision,
    )
  })

  it('gives an actionable error for a requested source file that does not exist', async () => {
    const { store } = await createStore()
    await expect(store.getContext({ paths: ['src/renderer/unknown.tsx'] })).rejects.toThrow(
      /unknown\.tsx|not found|does not exist/i,
    )
    await expect(store.getContext({ paths: ['../outside.ts'] })).rejects.toThrow(
      /path|relative|outside|invalid|traversal/i,
    )
  })

  it('persists accepted source and its compiled build across app restarts', async () => {
    const { store, options } = await createStore()
    await patchedControl(store, 'Persistent workspace control')
    const before = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    await store.close()
    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    await restarted.init()
    const after = await restarted.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    expect(after.revision).toBe(before.revision)
    expect(after.files).toEqual(before.files)
    expect((await executeControl(restarted)).props.children).toBe('Persistent workspace control')
  })

  it('restores the built-in interface when a compiled asset is missing without losing accepted source', async () => {
    const { store, options } = await createStore()
    await patchedControl(store, 'Preserve this accepted source')
    const before = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    const compiledEntry = store.assetPath(store.get().active!.js)
    expect(compiledEntry).toBeTruthy()
    await store.close()
    await rm(compiledEntry!)
    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    await restarted.init()
    expect(restarted.get().enabled).toBe(false)
    expect(restarted.get().active).toBeUndefined()
    expect(restarted.get().error).toMatch(/missing|build|restor/i)
    expect(
      (await restarted.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })).files,
    ).toEqual(before.files)
    await patchedControl(restarted, 'Recompiled after missing asset')
    expect((await executeControl(restarted)).props.children).toBe('Recompiled after missing asset')
  })

  it('uses the updated built-in interface after an app source update while preserving user changes for migration', async () => {
    const { store, options } = await createStore()
    await patchedControl(store, 'Custom control from the previous app version')
    const before = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    await store.close()
    await writeFile(
      join(options.sourceDir, 'src', 'shared', 'greeting.ts'),
      "export const greeting: string = 'Updated Life workspace'\n",
    )
    const updated = new SourceCodeStore(options)
    stores.push(updated)
    await updated.init()
    expect(updated.get().enabled).toBe(false)
    expect(updated.get().active).toBeUndefined()
    expect(updated.get().error).toMatch(/updat|base|new|chang/i)
    expect(
      (await updated.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })).files,
    ).toEqual(before.files)
    expect(updated.get().baseChanged).toBe(true)
    const changedBase = await updated.getContext({ paths: ['src/shared/greeting.ts'] })
    expect(changedBase.files[0].content).toContain('Original workspace')
    expect(changedBase.baselineFiles).toEqual([
      {
        path: 'src/shared/greeting.ts',
        content: "export const greeting: string = 'Updated Life workspace'\n",
      },
    ])
    await patchedControl(updated, 'Migrated workspace control')
    expect(updated.get().baseChanged).toBeFalsy()
    expect(
      (await updated.getContext({ paths: ['src/shared/greeting.ts'] })).files[0].content,
    ).toContain('Updated Life workspace')
    await updated.close()
    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    await restarted.init()
    expect(restarted.get().enabled).toBe(true)
    expect(restarted.get().baseChanged).toBeFalsy()
    expect((await executeControl(restarted)).props.children).toBe('Migrated workspace control')
  })

  it('refreshes unchanged and newly shipped source during an upgrade while retaining user modifications and deletions', async () => {
    const { store, options } = await createStore({
      'src/shared/user-note.ts': "export const note = 'Default note'\n",
      'src/shared/removed-by-user.ts': "export const obsolete = 'Old default'\n",
    })
    const context = await store.getContext({ paths: ['src/shared/user-note.ts'] })
    await store.apply({
      summary: 'Keep a personal research note and remove an unused module',
      baseRevision: context.revision,
      files: [
        { path: 'src/shared/user-note.ts', content: "export const note = 'My research note'\n" },
        { path: 'src/shared/removed-by-user.ts', content: null },
      ],
    })
    await store.close()
    for (const [path, content] of Object.entries({
      'src/shared/greeting.ts': "export const greeting = 'Updated shipped greeting'\n",
      'src/shared/user-note.ts': "export const note = 'Updated default note'\n",
      'src/shared/removed-by-user.ts': "export const obsolete = 'Updated default'\n",
      'src/shared/new-in-update.ts': "export const added = 'New shipped module'\n",
    })) {
      await writeFile(join(options.sourceDir, path), content)
    }
    const updated = new SourceCodeStore(options)
    stores.push(updated)
    await updated.init()
    const preserved = await updated.getContext({ paths: ['src/shared/user-note.ts'] })
    await updated.apply({
      summary: 'Migrate source customizations onto the latest installed app',
      baseRevision: preserved.revision,
      files: [
        { path: 'src/shared/user-note.ts', content: preserved.files[0].content },
        { path: 'src/shared/removed-by-user.ts', content: null },
      ],
    })
    const merged = await updated.getContext({
      paths: ['src/shared/greeting.ts', 'src/shared/user-note.ts', 'src/shared/new-in-update.ts'],
    })
    expect(merged.files).toEqual([
      {
        path: 'src/shared/greeting.ts',
        content: "export const greeting = 'Updated shipped greeting'\n",
      },
      { path: 'src/shared/user-note.ts', content: "export const note = 'My research note'\n" },
      {
        path: 'src/shared/new-in-update.ts',
        content: "export const added = 'New shipped module'\n",
      },
    ])
    expect(merged.paths).not.toContain('src/shared/removed-by-user.ts')
    expect((await executeControl(updated)).props.children).toBe('Updated shipped greeting')
  })

  it('detects a manifest-only app version update and rebuilds package version imports from the new installation', async () => {
    const { store, options } = await createStore()
    const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
    const entry = `import React from 'react'
import { version } from '../../package.json'
;(globalThis as any).__life_source_test_control = React.createElement('output', { id: 'version-control' }, version)
`
    await store.apply({
      summary: 'Read the installed Life version in customized UI',
      baseRevision: context.revision,
      files: [{ path: 'src/renderer/main.tsx', content: entry }],
    })
    expect((await executeControl(store)).props.children).toBe('1.0.0')
    await store.close()
    const packagePath = join(options.sourceDir, 'package.json')
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    await writeFile(packagePath, JSON.stringify({ ...manifest, version: '2.0.0' }))
    const updated = new SourceCodeStore(options)
    stores.push(updated)
    await updated.init()
    expect(updated.get()).toMatchObject({ enabled: false, baseChanged: true })
    const preserved = await updated.getContext({ paths: ['src/renderer/main.tsx'] })
    expect(preserved.files[0].content).toBe(entry)
    await updated.apply({
      summary: 'Rebuild the customized interface for the updated Life installation',
      baseRevision: preserved.revision,
      files: [{ path: 'src/renderer/main.tsx', content: entry }],
    })
    expect((await executeControl(updated)).props.children).toBe('2.0.0')
    expect(updated.get().baseChanged).toBeFalsy()
  })

  it('skips a known runtime failure when rolling back a repaired source build', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Working version A')
    await patchedControl(store, 'Failed startup version B')
    await store.disable('Runtime startup failed in version B')
    expect(store.get().enabled).toBe(false)
    await patchedControl(store, 'Repaired version C')
    expect((await executeControl(store)).props.children).toBe('Repaired version C')
    await store.rollback()
    expect((await executeControl(store)).props.children).toBe('Working version A')
  })

  it('restores the built-in UI after an unclean shutdown while preserving editable customized source', async () => {
    const { store, options } = await createStore()
    await patchedControl(store, 'Recoverable source changes')
    const before = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    await store.close()
    await writeFile(join(options.directory, '.running'), 'interrupted app process')
    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    await restarted.init()
    expect(restarted.get()).toMatchObject({ enabled: false, recovered: true })
    expect(restarted.get().active).toBeUndefined()
    expect(restarted.get().error).toMatch(/recover|restor|close cleanly/i)
    const recovered = await restarted.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
    expect(recovered.files).toEqual(before.files)
    expect(recovered.revision).toBeGreaterThan(before.revision)
    await patchedControl(restarted, 'Repaired after recovery')
    expect((await executeControl(restarted)).props.children).toBe('Repaired after recovery')
  })

  it('rolls back a newer build and source together and supports disabling customized UI', async () => {
    const { store, options } = await createStore()
    await patchedControl(store, 'First workspace version')
    await patchedControl(store, 'Second workspace version')
    expect((await executeControl(store)).props.children).toBe('Second workspace version')
    await store.rollback()
    expect((await executeControl(store)).props.children).toBe('First workspace version')
    expect(
      (await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })).files[0].content,
    ).toContain('First workspace version')
    await store.disable()
    expect(store.get().active).toBeFalsy()
    await store.close()
    const restarted = new SourceCodeStore(options)
    stores.push(restarted)
    await restarted.init()
    expect(restarted.get().active).toBeFalsy()
  })

  it.each([
    { react: 'file:../../outside' },
    { react: 'git+https://example.com/repository.git' },
    { 'bad package name': '^1.0.0' },
    { react: 'https://example.com/install.tgz' },
  ])(
    'rejects unsafe or unsupported dependency specifications before touching a working build: %j',
    async (dependencies) => {
      const { store } = await createStore()
      await patchedControl(store, 'Stable installed dependencies')
      const before = store.get()
      const context = await store.getContext({ paths: ['src/renderer/main.tsx'] })
      await expect(
        store.apply({
          summary: 'Use an invalid dependency source',
          baseRevision: context.revision,
          files: [{ path: 'src/renderer/main.tsx', content: originalEntry }],
          dependencies,
        }),
      ).rejects.toThrow(/dependency|package|version|registry|invalid/i)
      expect(store.get().active).toEqual(before.active)
    },
  )

  it.each(['close', 'disable'] as const)(
    'cancels a running package installer promptly when %s is requested',
    async (action) => {
      const { store, directory, options } = await createStore()
      await patchedControl(store, 'Keep accepted source before cancellation')
      const before = await store.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })
      await store.close()
      const modules = join(directory, 'hanging-installer-modules')
      const started = join(directory, 'package-install-started')
      await mkdir(join(modules, 'npm', 'bin'), { recursive: true })
      await writeFile(
        join(modules, 'npm', 'bin', 'npm-cli.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); setInterval(() => {}, 1000);\n`,
      )
      const cancellable = new SourceCodeStore({
        ...options,
        nodeModulesDir: modules,
        installTimeoutMs: 30_000,
      })
      stores.push(cancellable)
      await cancellable.init()
      const context = await cancellable.getContext({ paths: ['src/renderer/main.tsx'] })
      const pending = cancellable
        .apply({
          summary: 'Start an installer that must be cancelled',
          baseRevision: context.revision,
          dependencies: { 'is-number': '7.0.0' },
          files: [{ path: 'src/renderer/main.tsx', content: context.files[0].content }],
        })
        .then(
          () => ({ accepted: true as const }),
          (error: unknown) => ({ error }),
        )
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), {
        timeout: 2000,
        interval: 10,
      })
      const startedCancellation = Date.now()
      await cancellable[action]()
      const result = await pending
      expect(Date.now() - startedCancellation).toBeLessThan(3000)
      expect(result).toHaveProperty('error')
      expect(String((result as { error: unknown }).error)).toMatch(/abort|cancel|closed|stop/i)
      expect(
        (await cancellable.getContext({ paths: ['src/renderer/ResearchControl.tsx'] })).files,
      ).toEqual(before.files)
      if (action === 'disable') expect(cancellable.get().active).toBeUndefined()
    },
    6000,
  )

  it('serves only assets belonging to a compiled customization', async () => {
    const { store } = await createStore()
    await patchedControl(store, 'Asset boundary')
    expect(store.assetPath(store.get().active!.js)).toBeTruthy()
    expect(store.assetPath('../outside.js')).toBeFalsy()
    expect(store.assetPath('/etc/passwd')).toBeFalsy()
    expect(store.assetPath('package.json')).toBeFalsy()
  })
})
