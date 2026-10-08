import { describe, expect, it } from 'vitest'
import {
  buildLifeThreadPrompt,
  detectLifeIntent,
  extractLifeThreadResponse,
  stripLifeIntent,
} from '../src/renderer/life-thread'
import { defaultLifeConfig } from '../src/shared/customization'
import type { LifeExtensionManifest } from '../src/shared/extensions'
import type { LifeSourceContext, LifeSourcePatch } from '../src/shared/source-code'

const settings = (source: string) => `<life-customization>${source}</life-customization>`
const extension = (source: string) => `<life-extension>${source}</life-extension>`
const sourceProposal = (source: string) => `<life-source>${source}</life-source>`
const sourceRead = (source: string) => `<life-source-read>${source}</life-source-read>`
const sourceContext = (): LifeSourceContext => ({
  revision: 3,
  paths: ['src/renderer/App.tsx', 'src/main/agents.ts'],
  files: [
    { path: 'src/renderer/App.tsx', content: 'export function App() { return <main>Life</main> }' },
  ],
  dependencies: { react: '19.3.0' },
  snapshot: {
    revision: 3,
    enabled: true,
    canRollback: true,
    path: '/tmp/life-source',
    recovered: false,
  },
})
const sourcePatch = (): LifeSourcePatch => ({
  summary: 'Add a real React research view',
  baseRevision: 3,
  files: [
    {
      path: 'src/renderer/App.tsx',
      edits: [{ find: '<main>Life</main>', replace: '<main>Research</main>' }],
    },
  ],
  dependencies: { '@radix-ui/react-select': '^2.2.6' },
})
const manifest = (): LifeExtensionManifest => ({
  id: 'research-counter',
  name: 'Research counter',
  description: 'Count experiments',
  version: '1.0.0',
  renderer: {
    html: '<button id="increment">Count</button>',
    css: 'button { color: currentColor; }',
    js: 'document.querySelector("button").onclick = () => life.call("increment", null);',
    placement: 'view',
  },
  main: 'let count = 0; life.handle("increment", () => ++count);',
  enabled: true,
})

describe('Life intent in ordinary threads', () => {
  it('recognizes explicit routing and natural requests about the running Life interface', () => {
    for (const prompt of [
      '/life Make the text bigger',
      '@Life: switch to light',
      'Life, add a research counter',
      'Hey Life: make the theme dark',
      'Please customize Life',
      'Make Life compact',
      'Make Life auto port forward off',
      "Please turn on Life's automatic port forwarding",
      'Please replace Life’s select components with shadcn',
      'What settings can Life itself change?',
      'Change the research label in Life',
      "Make this app's sidebar narrower",
    ])
      expect(detectLifeIntent(prompt), prompt).toBe(true)
    expect(stripLifeIntent('@Life: switch to light')).toBe('switch to light')
    expect(stripLifeIntent(' /life\nMake the text bigger')).toBe('Make the text bigger')
    expect(stripLifeIntent('Hey Life: add a panel')).toBe('add a panel')
    expect(stripLifeIntent('Replace Life’s selects')).toBe('Replace Life’s selects')
  })

  it('leaves project prompts and the ordinary word life unclassified', () => {
    for (const prompt of [
      'Replace select components in this React project with shadcn',
      'Explain the life cycle of a React component',
      'Make life easier by refactoring the test suite',
      'Add a sidebar to the app in this repository',
      'Fix lifetime management in the worker',
      '/lifecycle explain this process',
      '@lifeline fix the dashboard',
    ])
      expect(detectLifeIntent(prompt), prompt).toBe(false)
  })
})

describe('Life conversation response protocol', () => {
  it('displays normal answers and clarification without claiming or requiring a change', () => {
    const answer =
      'Actual shadcn source replacement needs a rebuild. Shall I propose a live alternative?'
    expect(extractLifeThreadResponse(answer)).toEqual({ kind: 'message', message: answer })
    expect(extractLifeThreadResponse('')).toEqual({
      kind: 'message',
      message: 'No changes were proposed.',
    })
    expect(extractLifeThreadResponse(`Your theme is already dark.\n${settings('{}')}`)).toEqual({
      kind: 'message',
      message: 'Your theme is already dark.',
      noChange: true,
    })
  })

  it('extracts validated settings or executable code while preserving readable explanations', () => {
    expect(
      extractLifeThreadResponse(`I can change the theme.\n${settings('{"theme":"light"}')}`),
    ).toEqual({ kind: 'settings', patch: { theme: 'light' }, message: 'I can change the theme.' })
    const code = manifest()
    expect(
      extractLifeThreadResponse(
        `Here is a working counter.\n${extension(JSON.stringify(code))}\nIt runs locally.`,
      ),
    ).toEqual({
      kind: 'extension',
      manifest: code,
      message: 'Here is a working counter.\n\nIt runs locally.',
    })
  })

  it('never applies even valid markers outside a Life customization context', () => {
    const source = settings('{"theme":"light"}')
    expect(extractLifeThreadResponse(source, false)).toEqual({ kind: 'message', message: source })
    expect(extractLifeThreadResponse(extension(JSON.stringify(manifest())), false).kind).toBe(
      'message',
    )
    expect(
      extractLifeThreadResponse(sourceProposal(JSON.stringify(sourcePatch())), false).kind,
    ).toBe('message')
  })

  it('extracts actual source edits and local source reads without confusing their marker names', () => {
    const patch = sourcePatch()
    expect(
      extractLifeThreadResponse(
        `I will update the real component.\n${sourceProposal(JSON.stringify(patch))}`,
      ),
    ).toEqual({
      kind: 'source',
      patch,
      message: 'I will update the real component.',
    })
    expect(
      extractLifeThreadResponse(
        sourceRead('{"paths":["src/main/agents.ts","src/renderer/App.tsx"]}'),
      ),
    ).toEqual({
      kind: 'source-read',
      read: { paths: ['src/main/agents.ts', 'src/renderer/App.tsx'] },
      message: '',
    })
  })

  it('rejects ambiguous source edits, native-host mutations, duplicate keys and multiple proposals', () => {
    for (const value of [
      { ...sourcePatch(), files: [{ path: 'src/main/agents.ts', content: 'host mutation' }] },
      { ...sourcePatch(), files: [{ path: '../App.tsx', content: 'traversal' }] },
      {
        ...sourcePatch(),
        files: [
          {
            path: 'src/renderer/App.tsx',
            content: 'one',
            edits: [{ find: 'one', replace: 'two' }],
          },
        ],
      },
      {
        ...sourcePatch(),
        files: [
          { path: 'src/renderer/App.tsx', content: 'one' },
          { path: 'src/renderer/App.tsx', content: 'two' },
        ],
      },
      { ...sourcePatch(), dependencies: { react: 'https://malformed.example/pkg.tgz' } },
    ])
      expect(extractLifeThreadResponse(sourceProposal(JSON.stringify(value))).kind).toBe('error')
    expect(
      extractLifeThreadResponse(
        sourceProposal(JSON.stringify(sourcePatch())) +
          sourceRead('{"paths":["src/renderer/App.tsx"]}'),
      ).kind,
    ).toBe('error')
    expect(
      extractLifeThreadResponse(
        sourceProposal('{"summary":"one","summary":"two","baseRevision":3,"files":[]}'),
      ),
    ).toMatchObject({ kind: 'error', error: expect.stringContaining('repeats') })
    expect(
      extractLifeThreadResponse(sourceRead('{"paths":["src/renderer/App.tsx"],"\\u0070aths":[]}')),
    ).toMatchObject({ kind: 'error', error: expect.stringContaining('repeats') })
    expect(extractLifeThreadResponse(sourceRead('{"paths":[]}')).kind).toBe('error')
    expect(extractLifeThreadResponse('<life-source>{}').kind).toBe('error')
    expect(
      extractLifeThreadResponse(
        sourceProposal(JSON.stringify(sourcePatch())) +
          sourceProposal(JSON.stringify(sourcePatch())),
      ).kind,
    ).toBe('error')
  })

  it('rejects competing or repeated proposals instead of applying them partly', () => {
    expect(
      extractLifeThreadResponse(
        settings('{"theme":"light"}') + extension(JSON.stringify(manifest())),
      ),
    ).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('multiple proposal kinds'),
    })
    expect(extractLifeThreadResponse(settings('{"theme":"light"}') + settings('{}'))).toMatchObject(
      {
        kind: 'error',
        error: expect.stringContaining('Expected one'),
      },
    )
    expect(
      extractLifeThreadResponse(
        extension(JSON.stringify(manifest())) + extension(JSON.stringify(manifest())),
      ),
    ).toMatchObject({ kind: 'error', error: expect.stringContaining('Expected one') })
  })

  it('keeps malformed and invalid nonempty changes as errors', () => {
    for (const source of [
      settings('{"theme":"purple"}'),
      settings('{"selectLibrary":"shadcn"}'),
      settings('null'),
      settings('[]'),
      settings('{"theme":"dark","theme":"light"}'),
      settings('{bad JSON}'),
      '<life-customization>{"theme":"light"}',
      '<life-customization extra="true">{}</life-customization>',
      extension('{}'),
      '<life-extension>{}',
    ])
      expect(extractLifeThreadResponse(source), source).toMatchObject({ kind: 'error' })
    expect(extractLifeThreadResponse('x'.repeat(2_000_001))).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('too large'),
    })
  })
})

describe('Life conversation instructions', () => {
  it('implements real React changes using current source and dependencies without mutating the remote repository', () => {
    const request = 'Please make Life’s select components use shadcn'
    const prompt = buildLifeThreadPrompt(
      request,
      structuredClone(defaultLifeConfig),
      [manifest()],
      ['connection.state', 'ui.navigate'],
      { source: sourceContext() },
    )
    expect(prompt).toContain('Choose exactly one response form')
    expect(prompt).toContain('Answers and clarification questions need no block')
    expect(prompt).toContain('Do not use tools, run commands')
    expect(prompt).toContain(
      'Implement requested shadcn/Radix components as actual source and dependencies',
    )
    expect(prompt).toContain('without requiring a new installer')
    expect(prompt).toContain('include tailwindcss, @tailwindcss/postcss, and postcss dependencies')
    expect(prompt).toContain('Life processes @theme and @apply and scans staged source classes')
    expect(prompt).toContain('<life-source>')
    expect(prompt).toContain('<life-source-read>')
    expect(prompt).toContain(
      'Current Life source context JSON:\n' + JSON.stringify(sourceContext()),
    )
    expect(prompt).toContain('no pre-existing setting represents it')
    expect(prompt).not.toContain(
      'Actual shadcn/Radix component replacement requires source/dependency changes',
    )
    expect(prompt).toContain('"sidebarWidth"')
    expect(prompt).toContain('"research-counter"')
    expect(prompt).toContain('"connection.state"')
    expect(prompt).toContain(JSON.stringify(request))
    expect(prompt).not.toContain('Return exactly one <life-extension>')
  })

  it('continues reads and repairs in the same request with exact context and bounded diagnostics', () => {
    const request = 'Add a hypothesis backlog'
    const context = sourceContext()
    const read = buildLifeThreadPrompt(request, defaultLifeConfig, [], [], {
      source: context,
      sourceRead: { paths: ['src/renderer/App.tsx'] },
    })
    expect(read).toContain('Life source read results:\n{"paths":["src/renderer/App.tsx"]}')
    expect(read).toContain('Continue the original request')
    const repaired = buildLifeThreadPrompt(request, defaultLifeConfig, [], [], {
      source: context,
      repair: { attempt: 1, diagnostics: 'App.tsx: expected closing JSX tag' },
    })
    expect(repaired).toContain(
      'Life repair diagnostics:\n{"attempt":1,"diagnostics":"App.tsx: expected closing JSX tag"}',
    )
    expect(repaired).toContain('Your previous proposal was not activated successfully')
    expect(repaired.endsWith('User customization request:\n' + JSON.stringify(request))).toBe(true)
    expect(() =>
      buildLifeThreadPrompt(request, defaultLifeConfig, [], [], {
        source: {
          ...context,
          files: [{ path: 'src/renderer/App.tsx', content: 'x'.repeat(950_000) }],
        },
      }),
    ).toThrow('too large')
  })
})
