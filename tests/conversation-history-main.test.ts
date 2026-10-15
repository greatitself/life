import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Effect } from 'effect'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ConversationHistoryLifecycle,
  finishNativeShutdownEffect,
} from '../src/main/conversation-history-lifecycle'
import { runEffect } from '../src/main/effect-runtime'
import { PersistenceError } from '../src/main/persistence-effects'
import { RendererDocumentAdmission } from '../src/main/renderer-recovery'

const productionPath = resolve(import.meta.dirname, '../src/main/index.ts')
const productionSource = readFileSync(productionPath, 'utf8')
const sourceFile = ts.createSourceFile(
  productionPath,
  productionSource,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TS,
)

function uniqueSource(description: string, matches: (node: ts.Node) => boolean): string {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (matches(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (found.length !== 1)
    throw new Error(`Expected one production ${description}; found ${found.length}`)
  return found[0].getText(sourceFile)
}

function declaration(name: string): string {
  return uniqueSource(
    `${name} declaration`,
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
      ),
  )
}

function namedFunction(name: string): string {
  return uniqueSource(
    `${name} function`,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
}

const beforeQuit = uniqueSource(
  'before-quit listener',
  (node) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === 'app' &&
    node.expression.expression.name.text === 'on' &&
    ts.isStringLiteral(node.expression.arguments[0]) &&
    node.expression.arguments[0].text === 'before-quit',
)

// Execute the actual initialization fence and native quit coordinator. Browser,
// filesystem startup, provider cleanup and Electron event dispatch are boundaries.
const extractedSource = [
  namedFunction('assertStartupActive'),
  namedFunction('captureHistoryDocument'),
  declaration('reportShutdownFailure'),
  namedFunction('init'),
  beforeQuit,
  'globalThis.coordinator = { init };',
].join('\n')
const executable = ts.transpileModule(extractedSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const recordings: { name: string; events: string[] }[] = []

function held() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function fixture(name: string) {
  const events: string[] = []
  const initialStore = held()
  const appQuit = held()
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
  const context = {
    Effect,
    runEffect,
    finishNativeShutdownEffect,
    historyLifecycle: new ConversationHistoryLifecycle(),
    rendererAdmissions: new WeakMap<object, RendererDocumentAdmission>(),
    window: null,
    quitting: false,
    conversations: undefined as
      | undefined
      | {
          settledWithinEffect(): Effect.Effect<void, PersistenceError>
          closeEffect(): Effect.Effect<void, PersistenceError>
        },
    customization: undefined as undefined | { close(): void },
    updates: undefined as undefined | { dispose(): void },
    providerUpdates: undefined as undefined | { dispose(): void },
    extensions: undefined as undefined | { close(): Promise<void> },
    sourceCode: undefined as undefined | { close(): Promise<void> },
    applicationRuntime: undefined as undefined | { dispose(): Promise<void> },
    ssh: undefined as
      | undefined
      | {
          cancelRendererRequests(): Promise<void>
          disconnectAndWaitEffect(): Effect.Effect<void, Error>
        },
    sourceStartupTimer: undefined,
    sourceReloadTimer: undefined,
    researchDocuments: { clear: () => events.push('research:clear') },
    flushConversationHistory: async () => {
      events.push('history:flush')
    },
    releaseProvidersOnQuit: async () => {
      events.push('providers:release')
    },
    Store: class {
      constructor() {
        events.push('profiles:constructed')
      }
      async init() {
        events.push('profiles:init-start')
        await initialStore.promise
        events.push('profiles:init-complete')
      }
    },
    ConversationStore: class {
      constructor() {
        events.push('history:constructed')
      }
    },
    CustomizationStore: class {
      constructor() {
        events.push('customization:constructed')
      }
    },
    app: {
      getPath: () => '/owned/partial-startup-fixture',
      on: (event: string, listener: (event: { preventDefault(): void }) => void) =>
        listeners.set(event, listener),
      quit: () => {
        events.push('app:quit')
        appQuit.release()
      },
    },
    console: {
      error: (_message: string, error: Error) => events.push(`reported:${error.message}`),
    },
    clearTimeout,
    coordinator: undefined as undefined | { init(): Promise<void> },
  }
  runInNewContext(executable, context, { filename: productionPath })
  if (!context.coordinator) throw new Error('Production lifecycle coordinator was not initialized')
  recordings.push({ name, events })
  return {
    context,
    events,
    initialStore,
    appQuit,
    coordinator: context.coordinator,
    quit: () =>
      listeners.get('before-quit')!({ preventDefault: () => events.push('quit:prevented') }),
  }
}

afterAll(() => {
  const proofPath = process.env.LIFE_HISTORY_MAIN_PROOF
  if (!proofPath) return
  mkdirSync(dirname(proofPath), { recursive: true })
  writeFileSync(
    proofPath,
    JSON.stringify(
      {
        productionPath,
        productionSHA256: createHash('sha256').update(productionSource).digest('hex'),
        extractedSHA256: createHash('sha256').update(extractedSource).digest('hex'),
        extractedSource,
        boundary:
          'Actual Main initialization and quit coordinator; held profile initialization and explicit failing cleanup boundaries',
        cases: recordings,
      },
      null,
      2,
    ) + '\n',
  )
})

describe('actual Main conversation lifecycle during startup and quit', () => {
  it('does not begin startup once native quit has taken ownership', async () => {
    const { context, events, coordinator } = fixture('quit precedes initialization')
    context.quitting = true
    await expect(coordinator.init()).rejects.toThrow('Life is shutting down.')
    expect(events).toEqual([])
    expect(context.conversations).toBeUndefined()
    expect(context.customization).toBeUndefined()
  })

  it('cannot publish a history writer or renderer after quit overtakes initial profile loading', async () => {
    const { context, events, coordinator, initialStore, appQuit, quit } = fixture(
      'quit overtakes partial profile initialization',
    )
    const startup = coordinator.init()
    const failedStartup = expect(startup).rejects.toThrow('Life is shutting down.')
    expect(events).toEqual(['profiles:constructed', 'profiles:init-start'])
    quit()
    await appQuit.promise
    expect(context.quitting).toBe(true)
    expect(events).toContain('providers:release')
    initialStore.release()
    await failedStartup
    expect(events).toContain('profiles:init-complete')
    expect(context.conversations).toBeUndefined()
    expect(context.customization).toBeUndefined()
    expect(events).not.toContain('history:constructed')
    expect(events).not.toContain('customization:constructed')
    expect(events.filter((event) => event === 'app:quit')).toHaveLength(1)
  })

  it('observes history and disconnect failures while still closing every available resource when extensions are absent', async () => {
    const { context, events, appQuit, quit } = fixture(
      'independent partial-init shutdown resources',
    )
    const uncertainty = new PersistenceError({
      operation: 'shutdown-uncertain',
      path: '/owned/history-fixture',
      message: 'No native history ACK before worker retirement.',
      cause: new Error('lost ACK'),
    })
    context.conversations = {
      settledWithinEffect: () =>
        Effect.sync(() => {
          events.push('history:proof')
        }).pipe(Effect.andThen(Effect.fail(uncertainty))),
      closeEffect: () =>
        Effect.sync(() => {
          events.push('history:close')
        }).pipe(Effect.andThen(Effect.fail(uncertainty))),
    }
    context.customization = {
      close: () => {
        events.push('customization:close')
      },
    }
    context.updates = {
      dispose: () => {
        events.push('updates:dispose')
      },
    }
    context.providerUpdates = {
      dispose: () => {
        events.push('provider-updates:dispose')
      },
    }
    context.ssh = {
      cancelRendererRequests: async () => {
        events.push('ssh:cancel-requests')
      },
      disconnectAndWaitEffect: () =>
        Effect.sync(() => {
          events.push('ssh:disconnect')
        }).pipe(Effect.andThen(Effect.fail(new Error('Owned SSH disconnect failed.')))),
    }
    context.sourceCode = {
      close: async () => {
        events.push('source:close')
        throw new Error('Owned source close failed.')
      },
    }
    context.applicationRuntime = {
      dispose: async () => {
        events.push('runtime:dispose')
      },
    }
    expect(context.extensions).toBeUndefined()
    quit()
    await appQuit.promise
    expect(context.historyLifecycle.failure?.operation).toBe('shutdown-uncertain')
    for (const resource of [
      'customization:close',
      'updates:dispose',
      'provider-updates:dispose',
      'providers:release',
      'ssh:disconnect',
      'source:close',
      'history:close',
      'runtime:dispose',
    ])
      expect(events.filter((event) => event === resource)).toHaveLength(1)
    expect(events).toContain('reported:Owned SSH disconnect failed.')
    expect(events).toContain('reported:Owned source close failed.')
    expect(
      events.filter((event) => event.startsWith('reported:Life could not confirm')),
    ).toHaveLength(2)
    expect(events.indexOf('history:close')).toBeLessThan(events.indexOf('runtime:dispose'))
    expect(events.indexOf('source:close')).toBeLessThan(events.indexOf('runtime:dispose'))
    expect(events.at(-1)).toBe('app:quit')
    quit()
    expect(events.filter((event) => event === 'app:quit')).toHaveLength(1)
  })
})
