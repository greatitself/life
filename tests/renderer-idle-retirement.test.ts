import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Effect, Scheduler } from 'effect'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationHistoryLifecycle,
  type CapturedHistoryDocument,
} from '../src/main/conversation-history-lifecycle'
import { runEffect } from '../src/main/effect-runtime'
import { PersistenceError } from '../src/main/persistence-effects'
import { RendererDocumentAdmission, RendererReloadFlights } from '../src/main/renderer-recovery'
import { NativeDocumentReadiness } from '../src/main/native-document-readiness'

const productionPath = resolve(
  process.env.LIFE_IDLE_RETIREMENT_INDEX ?? resolve(import.meta.dirname, '../src/main/index.ts'),
)
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

function assignment(name: string): string {
  return uniqueSource(
    `${name} assignment`,
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === name,
  )
}

function declaration(name: string): string {
  return uniqueSource(
    `${name} declaration`,
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      ),
  )
}

function listener(receiver: 'ipcMain' | 'app', event: string): string {
  return uniqueSource(
    `${receiver} ${event} listener`,
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === receiver &&
      node.expression.expression.name.text === 'on' &&
      ts.isStringLiteral(node.expression.arguments[0]) &&
      node.expression.arguments[0].text === event,
  )
}

const createWindowSource = uniqueSource(
  'createWindow function',
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow',
)
const createWindowNode = ts.createSourceFile(
  'create-window.ts',
  createWindowSource,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TS,
).statements[0] as ts.FunctionDeclaration
const createWindowAdmission = createWindowNode
  .body!.statements.slice(0, 2)
  .map((statement) => statement.getText())
  .join('\n')

// Execute the real production coordinator without importing Electron or starting
// an application. Only Electron/SSH/provider boundaries are replaced below.
const extractedSource = [
  uniqueSource(
    'assertStartupActive function',
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'assertStartupActive',
  ),
  declaration('assertRendererAdmission'),
  declaration('permitsRendererAdmission'),
  uniqueSource(
    'captureHistoryDocument function',
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHistoryDocument',
  ),
  uniqueSource(
    'cancelRendererWork function',
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'cancelRendererWork',
  ),
  assignment('cancelRendererSessions'),
  assignment('flushNativeRecovery'),
  assignment('finalizeRendererSuspension'),
  assignment('rendererHandoffAdmitted'),
  assignment('rendererWorkPending'),
  assignment('providerRetirementPending'),
  assignment('releaseIdleProviders'),
  declaration('rendererHandoff'),
  declaration('suspendedRendererDocument'),
  uniqueSource(
    'beginRendererHandoff function',
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'beginRendererHandoff',
  ),
  declaration('sourceReloads'),
  declaration('reloadSource'),
  listener('ipcMain', 'terminal:write'),
  listener('ipcMain', 'terminal:resize'),
  // Keep the actual replacement guard while replacing BrowserWindow construction.
  `function createWindow() { ${createWindowAdmission} recordWindowCreation(); }`,
  listener('app', 'activate'),
  'globalThis.coordinator = { reloadSource, cancelRendererWork, permitsRendererAdmission };',
].join('\n')
const executable = ts.transpileModule(extractedSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

type Provider = 'codex' | 'claude'
type Snapshot = {
  label: string
  events: string[]
  documentRevision: number
  permitsNewWork: boolean
  permitsCheckpoint: boolean
  liveWriters: Provider[]
}
type Recording = { name: string; snapshots: Snapshot[] }
const recordings: Recording[] = []

class IdleWriter {
  exited = false
  private resolveExit!: (confirmed: boolean) => void
  private rejectExit!: (error: Error) => void
  readonly terminal = new Promise<boolean>((resolve, reject) => {
    this.resolveExit = resolve
    this.rejectExit = reject
  })

  constructor(
    readonly provider: Provider,
    private readonly events: string[],
    private readonly label: string = provider,
  ) {
    void this.terminal.catch(() => {})
  }

  closeAcknowledged() {
    this.events.push(`${this.label}:close-ack`)
  }

  async release() {
    this.events.push(`${this.label}:release-start`)
    this.closeAcknowledged()
    const confirmed = await this.terminal
    this.events.push(`${this.label}:release-complete`)
    return [confirmed]
  }

  exit() {
    if (this.exited) return
    this.exited = true
    this.events.push(`${this.label}:terminal-exit`)
    this.resolveExit(true)
  }

  failExit(failure: 'unconfirmed' | 'rejected') {
    this.events.push(`${this.label}:terminal-${failure}`)
    if (failure === 'unconfirmed') this.resolveExit(false)
    else this.rejectExit(new Error(`${this.provider} terminal exit could not be confirmed`))
  }
}

type Owner = {
  isDestroyed(): boolean
  webContents: { reload(): void; isDestroyed(): boolean; mainFrame: object }
}

function fixture(name: string) {
  const events: string[] = []
  const nativeDocuments = new NativeDocumentReadiness()
  const historyLifecycle = new ConversationHistoryLifecycle()
  const admission = new RendererDocumentAdmission()
  historyLifecycle.commitDocument(admission)
  const writers = {
    codex: new IdleWriter('codex', events),
    claude: new IdleWriter('claude', events),
  }
  const retirementWriters = Object.values(writers)
  const owner: Owner = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: {},
      reload: () => {
        events.push('renderer:reload')
        nativeDocuments.commit(owner)
        historyLifecycle.commitDocument(admission)
        events.push('renderer:commit')
        if (retirementWriters.some((writer) => !writer.exited))
          events.push('renderer:cold-resume-before-writer-exit')
      },
    },
  }
  nativeDocuments.commit(owner)
  const rendererAdmissions = new WeakMap([[owner, admission]])
  const nativeListeners = new Map<string, (...args: unknown[]) => void>()
  const appListeners = new Map<string, () => void>()
  const context = {
    window: owner as Owner | null,
    rendererAdmissions,
    historyLifecycle,
    nativeDocuments,
    commitDocument: (next: RendererDocumentAdmission): void => {
      nativeDocuments.commit(context.window ?? owner)
      historyLifecycle.commitDocument(next)
    },
    Effect,
    runEffect,
    RendererReloadFlights,
    sourceReloadTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    quitting: false,
    localApplies: 0,
    busy: false,
    releaseIdleProviders: async () => {},
    cancelRendererSessions: () => {},
    researchDocuments: { clear: () => events.push('research:clear') },
    ssh: {
      cancelRendererRequests: async () => events.push('ssh:cancel-requests'),
      writeTerminal: (data: string) => events.push(`terminal:write:${data}`),
      resizeTerminal: (cols: number, rows: number) =>
        events.push(`terminal:resize:${cols}:${rows}`),
    },
    hostHistory: { cancelAll: () => events.push('history:cancel') },
    flushConversationHistory: async (
      flushing: Owner | null,
      document?: CapturedHistoryDocument,
    ) => {
      expect(flushing).toBe(owner)
      if (document && !document.ownsDocument()) return
      events.push('history:flush')
    },
    conversations: {
      settledWithinEffect: (): Effect.Effect<void, PersistenceError> =>
        Effect.sync(() => {
          events.push('history:settled')
        }),
      closeEffect: (): Effect.Effect<void, PersistenceError> => Effect.void,
    },
    ipcMain: {
      on: (channel: string, operation: (...args: unknown[]) => void) =>
        nativeListeners.set(channel, operation),
    },
    app: { on: (event: string, operation: () => void) => appListeners.set(event, operation) },
    recordWindowCreation: () => events.push('renderer:new-window'),
    agents: {
      hasRunningSessions: (): boolean => context.busy,
      hasPendingRendererWork: (): boolean => context.busy,
      hasUntrackedRunningSessions: (): boolean => context.busy,
      rendererHandoffAdmitted: async (): Promise<boolean> => !context.busy,
      flushRecovery: async (): Promise<void> => {},
      finalizeRendererSuspension: () => {},
      suspendRendererConsumers: () => events.push('agents:suspend-consumers'),
      hasProviderRetirementTargets: (): boolean =>
        retirementWriters.some((writer) => !writer.exited),
      close: () => {
        events.push('agents:close')
        if (retirementWriters.some((writer) => !writer.exited))
          events.push('agents:close-with-unconfirmed-native-target')
        if (context.busy) {
          events.push('agents:close-with-pending-native-work')
          events.push('fresh-native-work:cancelled')
          context.busy = false
        }
        for (const writer of retirementWriters) writer.closeAcknowledged()
      },
      releaseIdleProviders: () => {
        if (admission.allows('agent:start')) events.push('codex:retirement-with-admission-open')
        return writers.codex.release()
      },
      releaseIdleClaudeProviders: () => {
        if (admission.allows('agent:start')) events.push('claude:retirement-with-admission-open')
        return writers.claude.release()
      },
    },
    dialog: {
      showErrorBox: (title: string, error: string) => events.push(`dialog:${title}:${error}`),
    },
    setTimeout,
    clearTimeout,
    coordinator: undefined as
      | {
          reloadSource(): Promise<void>
          cancelRendererWork(owner?: Owner | null): Promise<void>
          permitsRendererAdmission(channel: string): boolean
        }
      | undefined,
  }
  runInNewContext(executable, context, { filename: productionPath })
  if (!context.coordinator) throw new Error('Production coordinator did not initialize')
  const recording: Recording = { name, snapshots: [] }
  recordings.push(recording)
  const snapshot = (label: string) => {
    const value: Snapshot = {
      label,
      events: [...events],
      documentRevision: admission.documentRevision,
      permitsNewWork: admission.allows('agent:start'),
      permitsCheckpoint: admission.allows('conversations:checkpoint'),
      liveWriters: retirementWriters
        .filter((writer) => !writer.exited)
        .map((writer) => writer.provider),
    }
    recording.snapshots.push(value)
    return value
  }
  const registerIdleWriter = (provider: Provider, label: string) => {
    const writer = new IdleWriter(provider, events, label)
    retirementWriters.push(writer)
    return writer
  }
  return {
    context,
    coordinator: context.coordinator,
    owner,
    admission,
    historyLifecycle,
    nativeListeners,
    appListeners,
    events,
    writers,
    snapshot,
    registerIdleWriter,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
afterAll(() => {
  const proofPath = process.env.LIFE_IDLE_RETIREMENT_PROOF
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
          'Actual main coordinator; fake provider close ACK and manually released terminal exit',
        cases: recordings,
      },
      null,
      2,
    ) + '\n',
  )
})

describe('production source reload waits for idle native writers', () => {
  it('suspends consumers and awaits both terminal exits before admitting a new document', async () => {
    const { coordinator, writers, events, snapshot } = fixture(
      'idle Codex and Claude terminal barrier',
    )
    let acknowledged = false
    const acknowledgement = coordinator.reloadSource().then(() => {
      acknowledged = true
    })
    await vi.advanceTimersByTimeAsync(100)
    await acknowledgement
    const beforeRetirement = snapshot('renderer acknowledged before retirement')
    await vi.advanceTimersByTimeAsync(100)
    const awaitingBoth = snapshot('close ACKs received but both native writers remain alive')
    writers.codex.exit()
    await vi.advanceTimersByTimeAsync(0)
    const awaitingClaude = snapshot('Codex exited while Claude still owns its native writer')
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    const afterExit = snapshot('both native writers exited')

    expect(acknowledged).toBe(true)
    expect(beforeRetirement.permitsNewWork).toBe(true)
    expect(beforeRetirement.events).toEqual([])
    expect(awaitingBoth.permitsNewWork).toBe(false)
    expect(awaitingBoth.permitsCheckpoint).toBe(true)
    expect(awaitingBoth.events).toContain('codex:release-start')
    expect(awaitingBoth.events).toContain('claude:release-start')
    expect(awaitingBoth.events).not.toContain('codex:retirement-with-admission-open')
    expect(awaitingBoth.events).not.toContain('claude:retirement-with-admission-open')
    expect(awaitingBoth.events).not.toContain('agents:close')
    expect(awaitingBoth.events).not.toContain('renderer:reload')
    expect(awaitingClaude.permitsNewWork).toBe(false)
    expect(awaitingClaude.events).not.toContain('agents:close')
    expect(awaitingClaude.events).not.toContain('renderer:reload')
    expect(afterExit.permitsNewWork).toBe(true)
    expect(afterExit.events).not.toContain('renderer:cold-resume-before-writer-exit')
    for (const provider of ['codex', 'claude'])
      expect(events.indexOf(`${provider}:terminal-exit`)).toBeLessThan(
        events.indexOf('renderer:reload'),
      )
    expect(events.indexOf('history:flush')).toBeLessThan(events.indexOf('agents:suspend-consumers'))
    expect(afterExit.events).not.toContain('agents:close')
    expect(events.indexOf('history:settled')).toBeLessThan(events.indexOf('renderer:reload'))
  })

  it('keeps one document flight while an acknowledged idle provider is still retiring', async () => {
    const { coordinator, writers, events, snapshot } = fixture('retirement coalescing')
    const first = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    const second = coordinator.reloadSource()
    const duringRetirement = snapshot('second request during native terminal barrier')
    writers.codex.exit()
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    snapshot('terminal barrier completed')
    expect(second).toBe(first)
    expect(duringRetirement.events).not.toContain('renderer:reload')
    expect(events.filter((event) => event === 'codex:release-start')).toHaveLength(1)
    expect(events.filter((event) => event === 'claude:release-start')).toHaveLength(1)
    expect(events.filter((event) => event === 'renderer:reload')).toHaveLength(1)
  })

  it.each([
    { provider: 'codex' as const, failure: 'unconfirmed' as const },
    { provider: 'codex' as const, failure: 'rejected' as const },
    { provider: 'claude' as const, failure: 'unconfirmed' as const },
    { provider: 'claude' as const, failure: 'rejected' as const },
  ])(
    'keeps both reload attempts suspended after $provider termination is $failure',
    async ({ provider, failure }) => {
      const { coordinator, writers, snapshot } = fixture(`${provider} terminal ${failure}`)
      const acknowledgement = coordinator.reloadSource()
      await vi.advanceTimersByTimeAsync(200)
      await acknowledgement
      snapshot('close ACKs cannot confirm native terminal exit')
      writers[provider].failExit(failure)
      writers[provider === 'codex' ? 'claude' : 'codex'].exit()
      await vi.advanceTimersByTimeAsync(0)
      const unconfirmed = snapshot('native terminal exit could not be established')
      expect(unconfirmed.permitsNewWork).toBe(false)
      expect(unconfirmed.permitsCheckpoint).toBe(true)
      expect(unconfirmed.events).not.toContain('agents:close')
      expect(unconfirmed.events).not.toContain('renderer:reload')
      expect(unconfirmed.events).not.toContain('renderer:cold-resume-before-writer-exit')
      expect(
        unconfirmed.events.some((event) => event.startsWith('dialog:Life reload failed:')),
      ).toBe(true)

      // Reuse the same live writer and already failed terminal result. An
      // automatic retry must not mistake the failed release for an empty owner.
      const failedWriter = writers[provider]
      const secondAcknowledgement = coordinator.reloadSource()
      await vi.advanceTimersByTimeAsync(200)
      await secondAcknowledgement
      const secondAttempt = snapshot('second reload retains the same unconfirmed native writer')
      expect(writers[provider]).toBe(failedWriter)
      expect(secondAttempt.liveWriters).toEqual([provider])
      expect(secondAttempt.documentRevision).toBe(unconfirmed.documentRevision)
      expect(secondAttempt.permitsNewWork).toBe(false)
      expect(secondAttempt.permitsCheckpoint).toBe(true)
      expect(secondAttempt.events).not.toContain('agents:close')
      expect(secondAttempt.events).not.toContain('renderer:reload')
      expect(secondAttempt.events).not.toContain('renderer:cold-resume-before-writer-exit')
      expect(
        secondAttempt.events.filter((event) => event === `${provider}:release-start`),
      ).toHaveLength(2)
      const errors = secondAttempt.events.filter((event) =>
        event.startsWith('dialog:Life reload failed:'),
      )
      expect(errors).toHaveLength(2)
      const explicitError =
        failure === 'unconfirmed'
          ? 'An idle provider has not confirmed its exit. The current interface is paused; use Restart Interface to recover.'
          : `${provider} terminal exit could not be confirmed`
      expect(errors.every((error) => error.endsWith(explicitError))).toBe(true)
    },
  )

  it('keeps an active document admitted and does not start retiring its providers', async () => {
    const { context, coordinator, snapshot } = fixture('busy document control')
    context.busy = true
    let acknowledged = false
    void coordinator.reloadSource().then(() => {
      acknowledged = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const active = snapshot('active provider work remains owned by the existing document')
    expect(acknowledged).toBe(false)
    expect(active.permitsNewWork).toBe(true)
    expect(active.events).toEqual([])
  })

  it('abandons a scheduled source request after another native document commits', async () => {
    const { context, coordinator, admission, snapshot } = fixture('stale document control')
    const acknowledgement = coordinator.reloadSource()
    context.commitDocument(admission)
    await vi.advanceTimersByTimeAsync(200)
    await acknowledgement
    const fresh = snapshot('scheduled old request observed a fresh native document')
    expect(fresh.permitsNewWork).toBe(true)
    expect(fresh.events).toEqual([])
  })

  it('does not retire fresh native work after the old document awaits provider terminal exit', async () => {
    const { context, coordinator, admission, writers, events, snapshot } = fixture(
      'fresh document commits while old provider terminal waits are pending',
    )
    const acknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await acknowledgement
    const awaitingOldExit = snapshot('old document received close ACKs and awaits real exit')
    context.commitDocument(admission)
    events.push('manual-renderer:commit')
    expect(admission.allows('agent:start')).toBe(false)
    snapshot('fresh document waits for the original native terminal barrier')
    writers.codex.exit()
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    const oldExitCompleted = snapshot('old terminal waits complete after fresh document admission')

    expect(awaitingOldExit.permitsNewWork).toBe(false)
    expect(awaitingOldExit.events).not.toContain('agents:close')
    expect(oldExitCompleted.documentRevision).toBeGreaterThan(awaitingOldExit.documentRevision)
    expect(oldExitCompleted.permitsNewWork).toBe(true)
    const freshBoundary = events.length
    context.busy = true
    events.push('fresh-native-work:accepted')
    await vi.advanceTimersByTimeAsync(200)
    const afterFreshAdmission = events.slice(freshBoundary)
    expect(context.busy).toBe(true)
    expect(oldExitCompleted.events).not.toContain('fresh-native-work:cancelled')
    expect(oldExitCompleted.events).not.toContain('agents:close')
    expect(afterFreshAdmission).not.toContain('research:clear')
    expect(afterFreshAdmission).not.toContain('ssh:cancel-requests')
    expect(afterFreshAdmission).not.toContain('history:cancel')
    expect(afterFreshAdmission).not.toContain('history:flush')
    expect(oldExitCompleted.events).not.toContain('renderer:reload')
    expect(oldExitCompleted.events.some((event) => event.startsWith('dialog:'))).toBe(false)
  })

  it('keeps a fresh document paused when an original native terminal exit remains unconfirmed', async () => {
    const { context, coordinator, admission, writers, events, snapshot } = fixture(
      'old failed terminal wait completes after fresh document admission',
    )
    const acknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await acknowledgement
    snapshot('old renderer awaits its unconfirmed native writer')
    context.commitDocument(admission)
    events.push('manual-renderer:commit')
    expect(admission.allows('agent:start')).toBe(false)
    writers.codex.failExit('unconfirmed')
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    const staleFailure = snapshot('old terminal failure is scoped away from the fresh document')
    expect(staleFailure.documentRevision).toBe(2)
    expect(staleFailure.permitsNewWork).toBe(false)
    expect(staleFailure.permitsCheckpoint).toBe(true)
    expect(context.busy).toBe(false)
    expect(staleFailure.events).not.toContain('agents:close')
    expect(staleFailure.events).not.toContain('fresh-native-work:cancelled')
    expect(staleFailure.events.filter((event) => event === 'history:flush')).toHaveLength(1)
    expect(staleFailure.events).not.toContain('renderer:reload')
    expect(staleFailure.events.some((event) => event.startsWith('dialog:'))).toBe(false)
  })

  it('does not flush a fresh document after old renderer request cancellation settles', async () => {
    const { context, coordinator, admission, writers, events, snapshot } = fixture(
      'renderer cancellation settles after fresh document admission',
    )
    let settleRequests!: (value: number) => void
    const cancelledRequests = new Promise<number>((resolve) => {
      settleRequests = resolve
    })
    context.ssh.cancelRendererRequests = () => {
      events.push('ssh:cancel-requests')
      return cancelledRequests
    }
    const acknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await acknowledgement
    writers.codex.exit()
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    const oldCancellation = snapshot('old native owners closed while renderer cancellation is held')
    expect(oldCancellation.events).toContain('agents:suspend-consumers')
    expect(oldCancellation.events.filter((event) => event === 'history:flush')).toHaveLength(1)
    context.commitDocument(admission)
    events.push('manual-renderer:commit')
    expect(admission.allows('agent:start')).toBe(false)
    settleRequests(0)
    await vi.advanceTimersByTimeAsync(0)
    const settledOldRequests = snapshot(
      'old cancellation continuation leaves the fresh document owned',
    )
    const freshBoundary = events.length
    context.busy = true
    events.push('fresh-native-work:accepted')
    await vi.advanceTimersByTimeAsync(200)
    const afterFreshAdmission = events.slice(freshBoundary)
    expect(settledOldRequests.documentRevision).toBe(2)
    expect(settledOldRequests.permitsNewWork).toBe(true)
    expect(context.busy).toBe(true)
    expect(afterFreshAdmission).not.toContain('agents:close')
    expect(afterFreshAdmission).not.toContain('fresh-native-work:cancelled')
    expect(afterFreshAdmission).not.toContain('history:flush')
    expect(afterFreshAdmission).not.toContain('history:settled')
    expect(afterFreshAdmission).not.toContain('renderer:reload')
    expect(afterFreshAdmission.some((event) => event.startsWith('dialog:'))).toBe(false)
  })

  it('serializes new document admission and its idle target behind the original native exit', async () => {
    const { context, coordinator, admission, writers, events, snapshot, registerIdleWriter } =
      fixture('fresh document joins an old retirement memo before acquiring a new idle target')
    const codexTargets = [writers.codex]
    let codexFlight: Promise<boolean[]> | undefined
    let codexReleaseCalls = 0
    context.agents.releaseIdleProviders = () => {
      codexReleaseCalls++
      if (codexFlight) {
        events.push('codex:old-retirement-snapshot-joined')
        return codexFlight
      }
      const captured = codexTargets.filter((writer) => !writer.exited)
      events.push(
        captured.includes(writers.codex)
          ? 'codex:old-retirement-snapshot-collected'
          : 'codex:fresh-retirement-snapshot-collected',
      )
      const flight: Promise<boolean[]> = Promise.all(captured.map((writer) => writer.release()))
        .then((results) => results.flat())
        .finally(() => {
          if (codexFlight === flight) codexFlight = undefined
        })
      codexFlight = flight
      return flight
    }
    context.agents.releaseIdleClaudeProviders = () =>
      writers.claude.exited ? Promise.resolve([]) : writers.claude.release()

    const oldAcknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await oldAcknowledgement
    snapshot('document 1 awaits its captured native retirement snapshot')
    expect(codexReleaseCalls).toBe(1)
    context.commitDocument(admission)
    events.push('manual-renderer:commit')
    expect(admission.allows('agent:start')).toBe(false)
    expect(codexReleaseCalls).toBe(1)
    expect(events).not.toContain('renderer:reload')
    writers.codex.exit()
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    expect(admission.allows('agent:start')).toBe(true)
    expect(events).not.toContain('renderer:reload')
    const freshTarget = registerIdleWriter('codex', 'codex-document-2')
    codexTargets.push(freshTarget)
    events.push('fresh-native-idle-target:accepted')
    const freshAcknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await freshAcknowledgement
    const recollectedFreshTarget = snapshot(
      'the admitted document retires its independently acquired idle target',
    )
    expect(codexReleaseCalls).toBe(2)
    expect(recollectedFreshTarget.permitsNewWork).toBe(false)
    expect(recollectedFreshTarget.permitsCheckpoint).toBe(true)
    expect(recollectedFreshTarget.events).toContain('codex:fresh-retirement-snapshot-collected')
    expect(recollectedFreshTarget.events).toContain('codex-document-2:release-start')
    expect(recollectedFreshTarget.events).not.toContain('agents:close')
    expect(recollectedFreshTarget.events.filter((event) => event === 'history:flush')).toHaveLength(
      2,
    )
    expect(recollectedFreshTarget.events).not.toContain('renderer:reload')
    expect(recollectedFreshTarget.events.some((event) => event.startsWith('dialog:'))).toBe(false)

    freshTarget.exit()
    await vi.advanceTimersByTimeAsync(0)
    const allTargetsExited = snapshot('document 2 reloads only after its own native target exits')
    expect(codexReleaseCalls).toBe(2)
    expect(context.agents.hasPendingRendererWork()).toBe(false)
    expect(context.agents.hasProviderRetirementTargets()).toBe(false)
    expect(allTargetsExited.liveWriters).toEqual([])
    expect(allTargetsExited.documentRevision).toBe(3)
    expect(allTargetsExited.permitsNewWork).toBe(true)
    expect(
      allTargetsExited.events.filter((event) => event === 'agents:suspend-consumers'),
    ).toHaveLength(2)
    expect(allTargetsExited.events.filter((event) => event === 'renderer:reload')).toHaveLength(1)
    expect(allTargetsExited.events).not.toContain('agents:close-with-pending-native-work')
    expect(allTargetsExited.events).not.toContain('agents:close-with-unconfirmed-native-target')
    expect(allTargetsExited.events).not.toContain('renderer:cold-resume-before-writer-exit')
    expect(events.indexOf('codex-document-2:terminal-exit')).toBeLessThan(
      events.indexOf('renderer:reload'),
    )
    expect(allTargetsExited.events.some((event) => event.startsWith('dialog:'))).toBe(false)
  })

  it('abandons an acknowledged request when its window is replaced before retirement', async () => {
    const { context, coordinator, snapshot } = fixture('replaced window control')
    const acknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(100)
    await acknowledgement
    context.window = {
      isDestroyed: () => false,
      webContents: { reload: () => {}, isDestroyed: () => false, mainFrame: {} },
    }
    await vi.advanceTimersByTimeAsync(100)
    const replaced = snapshot('old owner replaced during acknowledgement delay')
    expect(replaced.events).toEqual([])
    expect(replaced.permitsNewWork).toBe(true)
  })

  it('keeps manual recovery paused until idle providers confirm their native exits', async () => {
    const { coordinator, owner, writers, snapshot } = fixture('manual recovery terminal barrier')
    let settled = false
    const recovery = coordinator.cancelRendererWork(owner).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    const waiting = snapshot('manual recovery retains both original native writers')
    expect(settled).toBe(false)
    expect(waiting.permitsNewWork).toBe(false)
    expect(waiting.liveWriters).toEqual(['codex', 'claude'])
    expect(waiting.events).not.toContain('agents:close')
    expect(waiting.events).toContain('agents:suspend-consumers')
    expect(waiting.events).toContain('codex:release-start')
    expect(waiting.events).toContain('claude:release-start')
    writers.codex.exit()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    writers.claude.exit()
    await recovery
    const confirmed = snapshot('manual recovery observes both actual terminal acknowledgements')
    expect(confirmed.liveWriters).toEqual([])
    expect(confirmed.permitsNewWork).toBe(false)
    expect(confirmed.events).toContain('history:settled')
    expect(confirmed.events).not.toContain('agents:close')
  })

  it('admits native terminal sends only from the current healthy frame', () => {
    const { owner, events, nativeListeners } = fixture('native terminal document ownership')
    const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }
    nativeListeners.get('terminal:write')!(event, '  Exact terminal input\r\n  ')
    nativeListeners.get('terminal:resize')!(event, 120, 30)
    nativeListeners.get('terminal:write')!({ ...event, senderFrame: {} }, 'stale input')
    nativeListeners.get('terminal:resize')!(event, 0, 30)
    expect(events).toEqual([
      'terminal:write:  Exact terminal input\r\n  ',
      'terminal:resize:120:30',
    ])
  })

  it('holds fresh document and terminal admission until the current history proof completes', async () => {
    const { context, coordinator, admission, owner, writers, nativeListeners, events, snapshot } =
      fixture('native commit during healthy history proof')
    writers.codex.exit()
    writers.claude.exit()
    events.length = 0
    let acknowledge!: (effect: Effect.Effect<void, PersistenceError>) => void
    context.conversations.settledWithinEffect = () =>
      Effect.callback((resume) => {
        events.push('history:proof-pending')
        acknowledge = resume
      })
    const cancellation = coordinator.cancelRendererWork(owner)
    expect(admission.allows('agent:start')).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toContain('history:proof-pending')
    context.commitDocument(admission)
    const fresh = new RendererDocumentAdmission()
    context.commitDocument(fresh)
    const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }
    nativeListeners.get('terminal:write')!(event, 'must stay paused')
    nativeListeners.get('terminal:resize')!(event, 120, 30)
    expect(() => context.historyLifecycle.assertCanCreateDocument()).toThrow('still saving history')
    expect(admission.allows('agent:start')).toBe(false)
    expect(fresh.allows('agent:start')).toBe(false)
    snapshot('a committed document remains paused while the accepted write is unconfirmed')
    acknowledge(Effect.void)
    await cancellation
    expect(admission.allows('agent:start')).toBe(true)
    expect(fresh.allows('agent:start')).toBe(true)
    nativeListeners.get('terminal:write')!(event, 'healthy after ACK')
    expect(events).not.toContain('terminal:write:must stay paused')
    expect(events).not.toContain('terminal:resize:120:30')
    expect(events).toContain('terminal:write:healthy after ACK')
    expect(() => context.historyLifecycle.assertCanCreateDocument()).not.toThrow()
    snapshot('real healthy proof permits current and newly committed documents')
  })

  it('does not leave a fresh document paused when its commit wins the handoff acquisition boundary', async () => {
    const { context, coordinator, admission, owner, writers, events, snapshot } = fixture(
      'native commit before history resource acquisition',
    )
    writers.codex.exit()
    writers.claude.exit()
    events.length = 0
    let committedBeforeAcquire = false
    class CommitBeforeAcquireScheduler extends Scheduler.MixedScheduler {
      override shouldYield(fiber: Parameters<Scheduler.MixedScheduler['shouldYield']>[0]) {
        if (
          !committedBeforeAcquire &&
          Reflect.get(context.historyLifecycle, 'activeHandoffs') === 0
        ) {
          committedBeforeAcquire = true
          context.commitDocument(admission)
          events.push('manual-renderer:commit-before-history-acquire')
          expect(admission.allows('agent:start')).toBe(true)
          return true
        }
        return super.shouldYield(fiber)
      }
    }
    context.runEffect = (program, options) =>
      runEffect(
        program.pipe(
          Effect.provideService(Scheduler.Scheduler, new CommitBeforeAcquireScheduler('sync')),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, 8),
        ),
        options,
      )
    const cancellation = coordinator.cancelRendererWork(owner)
    await vi.advanceTimersByTimeAsync(0)
    await cancellation
    expect(committedBeforeAcquire).toBe(true)
    expect(admission.documentRevision).toBe(2)
    expect(context.historyLifecycle.failure).toBeUndefined()
    snapshot('completed old history attempt leaves its healthy successor admitted')
    expect(admission.allows('agent:start')).toBe(true)
  })

  it('prevents activate from creating a new window while an old history worker is retiring', async () => {
    const { context, coordinator, owner, appListeners, events, snapshot } = fixture(
      'closed old window during worker retirement',
    )
    let finishExit!: (effect: Effect.Effect<void, PersistenceError>) => void
    context.conversations.settledWithinEffect = () =>
      Effect.callback((resume) => {
        events.push('history:worker-exit-pending')
        finishExit = resume
      })
    const cancellation = coordinator.cancelRendererWork(owner)
    const rejection = expect(cancellation).rejects.toMatchObject({
      operation: 'shutdown-uncertain',
    })
    await vi.advanceTimersByTimeAsync(0)
    context.window = null
    expect(context.historyLifecycle.failure).toBeUndefined()
    appListeners.get('activate')!()
    expect(events).not.toContain('renderer:new-window')
    expect(events.some((event) => event.includes('still saving history'))).toBe(true)
    snapshot('new window blocked before uncertainty returns from actual worker exit')
    finishExit(
      Effect.fail(
        new PersistenceError({
          operation: 'shutdown-uncertain',
          path: '/owned/history-fixture',
          message: 'Accepted work has an unknown disk outcome.',
          cause: new Error('no worker ACK'),
        }),
      ),
    )
    await rejection
    appListeners.get('activate')!()
    expect(events).not.toContain('renderer:new-window')
    expect(context.historyLifecycle.failure?.operation).toBe('shutdown-uncertain')
    snapshot('new window remains blocked after the retired actor reports uncertainty')
  })

  it('retains failed source history proof after flight clearing and rejects late ACK or fresh native work', async () => {
    const { context, coordinator, writers, admission, owner, nativeListeners, events, snapshot } =
      fixture('source reload history failure remains sticky')
    let complete!: (effect: Effect.Effect<void, PersistenceError>) => void
    context.conversations.settledWithinEffect = () =>
      Effect.callback((resume) => {
        events.push('history:proof-pending')
        complete = resume
      })
    const acknowledgement = coordinator.reloadSource()
    await vi.advanceTimersByTimeAsync(200)
    await acknowledgement
    writers.codex.exit()
    writers.claude.exit()
    await vi.advanceTimersByTimeAsync(0)
    context.commitDocument(admission)
    expect(admission.allows('agent:start')).toBe(false)
    complete(
      Effect.fail(
        new PersistenceError({
          operation: 'shutdown-uncertain',
          path: '/owned/history-fixture',
          message: 'Disk commit was not acknowledged.',
          cause: new Error('lost native ACK'),
        }),
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    const failure = context.historyLifecycle.failure!
    expect(failure.operation).toBe('shutdown-uncertain')
    // The native UUID changed while the old proof was pending. Its stale
    // callback must not display an old-document dialog in the new document.
    expect(events.filter((event) => event.startsWith('dialog:Life reload failed:'))).toHaveLength(0)
    expect(events).not.toContain('renderer:reload')
    // The old callback cannot turn the failed effect into a successful handoff.
    complete(Effect.void)
    context.conversations.settledWithinEffect = () => Effect.void
    context.commitDocument(admission)
    const fresh = new RendererDocumentAdmission()
    context.commitDocument(fresh)
    await expect(coordinator.reloadSource()).rejects.toBe(failure)
    await expect(coordinator.cancelRendererWork(owner)).rejects.toBe(failure)
    const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }
    nativeListeners.get('terminal:write')!(event, 'must not start after late ACK')
    nativeListeners.get('terminal:resize')!(event, 120, 30)
    expect(admission.allows('agent:start')).toBe(false)
    expect(fresh.allows('agent:start')).toBe(false)
    expect(events).not.toContain('terminal:write:must not start after late ACK')
    expect(events).not.toContain('terminal:resize:120:30')
    expect(events).not.toContain('renderer:reload')
    expect(() => context.historyLifecycle.assertCanCreateDocument()).toThrow(failure)
    snapshot('failed source flight and late callback cannot reopen the history actor')
  })
})
