import { describe, expect, it } from 'vitest'
import { defaultLifeConfig } from '../src/shared/customization'
import { lifeStudioContextSchema, type LifeStudioContext } from '../src/shared/life-studio'
import type { LifeSourceContext } from '../src/shared/source-code'
import { startSchema } from '../src/shared/validation'
import {
  buildStudioInstructions,
  type StudioInstructionInput,
} from '../src/renderer/studio-instructions'

function sourceContext(): LifeSourceContext {
  return {
    extensions: [],
    revision: 7,
    paths: ['src/renderer/App.tsx', 'src/renderer/style.css', 'src/main/index.ts'],
    files: [
      { path: 'src/renderer/App.tsx', content: 'export default function App() { return "Life" }' },
    ],
    dependencies: { react: '^19.1.0' },
    snapshot: {
      extensions: [],
      revision: 7,
      enabled: false,
      canRollback: true,
      path: 'C:\\Users\\PrivatePerson\\AppData\\Roaming\\Life\\source-snapshots',
      recovered: false,
    },
    baselineFiles: [
      {
        path: 'src/renderer/App.tsx',
        content: 'export default function App() { return "Installed Life" }',
      },
    ],
  }
}

function input(): StudioInstructionInput {
  return {
    config: structuredClone(defaultLifeConfig),
    extensions: [
      {
        id: 'research-summary',
        name: 'Research summary',
        description: 'An existing runtime extension',
        version: '1',
        enabled: true,
        renderer: {
          html: '<p>Summary</p>',
          css: 'p { color: inherit }',
          js: '',
          placement: 'panel',
        },
      },
    ],
    capabilities: ['agent.start', 'forwarding.get', 'connection.state'],
    source: sourceContext(),
  }
}

function jsonFile(context: LifeStudioContext, path: string): Record<string, any> {
  const file = context.files.find((file) => file.path === path)
  expect(file, path).toBeDefined()
  return JSON.parse(file!.content)
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

describe('Life Studio file-based instructions', () => {
  it('provides app instructions and structured context without copying the user request', () => {
    const request = '  ONLY-USER-REQUEST-6d15e29e\nChange the sidebar without changing this text.  '
    const incoming = { ...input(), request, prompt: request }
    const context = buildStudioInstructions(incoming)
    const encoded = JSON.stringify(context)
    expect(encoded).not.toContain('ONLY-USER-REQUEST-6d15e29e')
    expect(encoded).not.toContain('Change the sidebar without changing this text.')
    expect(context.instructions).toContain('The provider receives the exact user message.')
    expect(context.instructions).toContain('never appended to or substituted for that message')
    expect(context.instructions).toContain('separate from project chats and the Research notebook')
    expect(context.phase).toBe('request')
    expect(context.revision).toBe(7)
    expect(lifeStudioContextSchema.parse(context)).toEqual(context)
    expect(context.files).toHaveLength(9)
    expect(new Set(context.files.map((file) => file.path)).size).toBe(9)
  })

  it('includes the complete supplied source, settings, capabilities and existing runtime code', () => {
    const incoming = input()
    const context = buildStudioInstructions(incoming)
    expect(jsonFile(context, '.life/configuration.json')).toEqual(incoming.config)
    expect(jsonFile(context, '.life/extensions.json')).toEqual(incoming.extensions)
    const bridge = jsonFile(context, '.life/bridge.json')
    expect(bridge).toMatchObject({ capabilities: incoming.capabilities })
    expect(bridge.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'agent.start', signature: '(StartInput)' }),
        expect.objectContaining({ method: 'forwarding.get', signature: '()', args: null }),
      ]),
    )
    expect(
      bridge.methods.every((method: { method: string }) =>
        incoming.capabilities.includes(method.method),
      ),
    ).toBe(true)
    expect(
      bridge.methods.some((method: { method: string }) => method.method === 'connection.execute'),
    ).toBe(false)
    expect(bridge.runtime.renderer.invoke).toContain('life.invoke(method, args)')
    expect(bridge.runtime.worker.handle).toContain('life.handle(method')
    expect(bridge.runtime.worker.cleanup).toContain('life.onDispose')
    const source = jsonFile(context, '.life/source-context.json')
    expect(source.files).toEqual(incoming.source!.files)
    expect(source.paths).toEqual(incoming.source!.paths)
    expect(source.baselineFiles).toEqual(incoming.source!.baselineFiles)
    expect(source.dependencies).toEqual(incoming.source!.dependencies)
    expect(source.revision).toBe(7)
    expect(context.instructions).toContain(
      'Native main/preload source and package.json are context only',
    )
    expect(context.instructions).toContain(
      'Every successful source proposal becomes a separately managed source extension',
    )
  })

  it('redacts the private native snapshot directory and leaves every input immutable', () => {
    const incoming = freeze(input())
    const before = JSON.stringify(incoming)
    const context = buildStudioInstructions(incoming)
    expect(jsonFile(context, '.life/source-context.json').snapshot.path).toBe('')
    expect(JSON.stringify(context)).not.toContain('PrivatePerson')
    expect(JSON.stringify(context)).not.toContain('AppData')
    expect(JSON.stringify(incoming)).toBe(before)
    expect(incoming.source!.snapshot.path).toContain('PrivatePerson')
    expect(incoming.config.theme).toBe('dark')
  })

  it('publishes the actual settings, source, read and runtime schemas', () => {
    const context = buildStudioInstructions(input())
    const settings = jsonFile(context, '.life/settings-schema.json')
    expect(settings.properties.theme.enum).toEqual(['dark', 'light'])
    expect(settings.properties.autoPortForward.type).toBe('boolean')
    expect(settings.properties.commands.type).toBe('array')
    expect(settings.additionalProperties).toBe(false)
    const source = jsonFile(context, '.life/source-schema.json')
    expect(source.required).toEqual(expect.arrayContaining(['summary', 'baseRevision', 'files']))
    expect(source.properties.baseRevision.minimum).toBe(0)
    expect(source.properties.files.maxItems).toBe(100)
    expect(source.properties.files.items.properties.path.maxLength).toBe(240)
    expect(source.properties.files.items.properties.edits.items.required).toEqual([
      'find',
      'replace',
    ])
    expect(source.properties.dependencies.type).toBe('object')
    const read = jsonFile(context, '.life/source-read-schema.json')
    expect(read.required).toContain('paths')
    expect(read.properties.paths.minItems).toBe(1)
    expect(read.properties.paths.maxItems).toBe(30)
    const runtime = jsonFile(context, '.life/extension-schema.json')
    expect(runtime.properties.renderer.properties.placement.enum).toEqual([
      'panel',
      'view',
      'replace',
    ])
    expect(runtime.properties.renderer.properties.html.maxLength).toBe(500_000)
    expect(runtime.properties.main.maxLength).toBe(500_000)
    expect(runtime.additionalProperties).toBe(false)
  })

  it('records source-read and repair continuations as diagnostics rather than hidden user text', () => {
    const incoming = input()
    const sourceRead = { paths: ['src/renderer/style.css'] }
    const readContext = buildStudioInstructions({ ...incoming, sourceRead })
    expect(readContext.phase).toBe('source-read')
    expect(jsonFile(readContext, '.life/diagnostics.json')).toEqual({ sourceRead, repair: null })
    const repair = {
      attempt: 2,
      diagnostics: 'src/renderer/App.tsx:10:5: Expected a closing tag\nActual compiler output.',
    }
    const repairContext = buildStudioInstructions({ ...incoming, sourceRead, repair })
    expect(repairContext.phase).toBe('repair')
    expect(jsonFile(repairContext, '.life/diagnostics.json')).toEqual({ sourceRead, repair })
    expect(repairContext.instructions).toContain(
      'bounded repair attempt is an internal continuation',
    )
    expect(repairContext.instructions).not.toContain(repair.diagnostics)
    expect(jsonFile(buildStudioInstructions(incoming), '.life/diagnostics.json')).toEqual({
      sourceRead: null,
      repair: null,
    })
  })

  it('supports a missing source context without inventing source content or a revision', () => {
    const incoming = input()
    const context = buildStudioInstructions({ ...incoming, source: undefined })
    expect(context.revision).toBe(0)
    expect(jsonFile(context, '.life/source-context.json')).toBeNull()
    expect(context.phase).toBe('request')
  })

  it('rejects oversized app context without silently truncating any source or output', () => {
    const incoming = input()
    incoming.source!.files = [{ path: 'src/renderer/App.tsx', content: '完整源码'.repeat(300_000) }]
    const before = incoming.source!.files[0].content
    expect(() => buildStudioInstructions(incoming)).toThrow('too large')
    expect(incoming.source!.files[0].content).toBe(before)
  })
})

describe('Life Studio context admission', () => {
  const valid = (): LifeStudioContext => ({
    instructions: 'Dedicated application instructions.',
    files: [{ path: '.life/configuration.json', content: '{}' }],
    revision: 2,
    phase: 'request',
  })

  it.each([
    '../configuration.json',
    '.life/../configuration.json',
    '.life/nested/configuration.json',
    '/root/.life/configuration.json',
    'C:\\Life\\configuration.json',
    '.life\\configuration.json',
    '.life/AGENTS.md',
    '.life/Configuration.json',
    '.life/configuration.json\0',
    '.life/configuration.json/../../AGENTS.md',
  ])('rejects unsafe context path %s', (path) => {
    expect(
      lifeStudioContextSchema.safeParse({ ...valid(), files: [{ path, content: '{}' }] }).success,
    ).toBe(false)
  })

  it('requires unique names, bounded counts, valid phases and a nonnegative integral revision', () => {
    const context = valid()
    expect(
      lifeStudioContextSchema.safeParse({ ...context, files: [context.files[0], context.files[0]] })
        .success,
    ).toBe(false)
    expect(
      lifeStudioContextSchema.safeParse({
        ...context,
        files: Array.from({ length: 31 }, (_, index) => ({
          path: `.life/context-${index}.json`,
          content: '{}',
        })),
      }).success,
    ).toBe(false)
    for (const revision of [-1, 1.5, NaN, Infinity])
      expect(lifeStudioContextSchema.safeParse({ ...context, revision }).success).toBe(false)
    expect(lifeStudioContextSchema.safeParse({ ...context, phase: 'run-shell' }).success).toBe(
      false,
    )
    expect(
      lifeStudioContextSchema.safeParse({ ...context, prompt: 'Hidden message' }).success,
    ).toBe(false)
    expect(
      lifeStudioContextSchema.safeParse({
        ...context,
        files: [{ ...context.files[0], mode: 'executable' }],
      }).success,
    ).toBe(false)
  })

  it('enforces individual and aggregate byte limits including multibyte source', () => {
    const context = valid()
    expect(
      lifeStudioContextSchema.safeParse({ ...context, instructions: 'i'.repeat(100_001) }).success,
    ).toBe(false)
    expect(
      lifeStudioContextSchema.safeParse({
        ...context,
        files: [{ path: '.life/source.json', content: 'x'.repeat(2_000_001) }],
      }).success,
    ).toBe(false)
    const aggregate = {
      ...context,
      files: [
        { path: '.life/source-one.json', content: 'x'.repeat(1_500_000) },
        { path: '.life/source-two.json', content: 'x'.repeat(1_500_000) },
      ],
    }
    expect(lifeStudioContextSchema.safeParse(aggregate).success).toBe(false)
    expect(
      lifeStudioContextSchema.safeParse({
        ...context,
        files: [{ path: '.life/source.json', content: '界'.repeat(1_000_001) }],
      }).success,
    ).toBe(false)
    const exact = {
      ...context,
      files: [
        { path: '.life/source-one.json', content: 'x'.repeat(1_500_000) },
        {
          path: '.life/source-two.json',
          content: 'x'.repeat(1_500_000 - context.instructions.length),
        },
      ],
    }
    expect(lifeStudioContextSchema.parse(exact)).toEqual(exact)
    expect(
      lifeStudioContextSchema.safeParse({ ...exact, instructions: exact.instructions + 'x' })
        .success,
    ).toBe(false)
    const within = {
      ...context,
      files: [{ path: '.life/source.json', content: '界'.repeat(900_000) }],
    }
    expect(lifeStudioContextSchema.parse(within)).toEqual(within)
  })

  it('admits instruction files only for dedicated customization starts while preserving the literal prompt', () => {
    const prompt = ' \nOriginal user text, punctuation and whitespace.  '
    const incoming = {
      sessionId: 'studio-session',
      provider: 'codex',
      prompt,
      mode: 'plan',
      studioContext: valid(),
    }
    expect(startSchema.safeParse(incoming).success).toBe(false)
    expect(startSchema.safeParse({ ...incoming, scope: 'project' }).success).toBe(false)
    const parsed = startSchema.parse({ ...incoming, scope: 'life-customization' })
    expect(parsed.prompt).toBe(prompt)
    expect(parsed.studioContext).toEqual(valid())
  })
})
