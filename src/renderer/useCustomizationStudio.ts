import { useCallback, useEffect, useRef, useState } from 'react'
import type { LifeConfig, LifeConfigPatch } from '../shared/customization'
import type { LifeExtensionsSnapshot } from '../shared/extensions'
import type { LifeSourceContext, LifeSourceSnapshot } from '../shared/source-code'
import type {
  AgentEvent,
  ConnectionState,
  ModelOption,
  NativeRecoveryOwnerState,
  NativeRecoverySupport,
  Provider,
  StartInput,
} from '../shared/types'
import { api, errorText } from './api'
import {
  carryNativeProjectionAuthoredTransition,
  nativeProjectionAdmissions,
  registerNativeProjectionCacheBaseline,
} from './native-projection-admissions'
import { hasNativeRecoveryConsumerIdentity } from './native-recovery-consumers'
import { planLocalCustomization } from './customization'
import {
  extractLifeThreadResponse,
  maximumLifeRepairAttempts,
  maximumLifeSourceReads,
} from './life-thread'
import { fallbackModelCatalog } from './model-catalog'
import {
  acceptsAgentEvent,
  applyEvent,
  applyNativeRecoveryOwner,
  finishThreadTurn,
  nativeRecoveryBlocksMutation,
  normalizeNativeRecovery,
  resolveAgentRequest,
  type Thread,
} from './state'
import { buildStudioInstructions } from './studio-instructions'
import {
  createStudioSession,
  migrateLegacyStudioPending,
  maximumStudioRequestCharacters,
  readStudioHistory,
  restoreNativeStudioSession,
  studioRecoveryCacheRow,
  type StudioProposal,
  type StudioSession,
} from './studio-history'
import { reconcileStudioSessionLifecycle, resetStudioSessionRequests } from './studio-source'
import { pendingSourceApplyKey } from './source-session'
import { readThreads } from './state'
import {
  getStudioPlannerRecoveryStep,
  parseStudioPlannerRecovery,
  restoreStudioPlannerRecovery,
  settleStudioPlannerAction,
  startStudioPlannerAction,
  type StudioPlannerAction,
  type StudioPlannerRecovery,
} from './studio-planner-recovery'
import {
  STUDIO_PENDING_KEY as pendingKey,
  encodeStudioPending,
  readStudioPending,
} from './studio-pending'

const activeKey = 'life.studio.active.v1'
const recoverySupportQuery = api?.agent.recoverySupport
class StudioRecoveryPending extends Error {}
interface StudioRun {
  request: string
  profileId: string
  input: StartInput
  source?: LifeSourceContext
  parts: Map<string, string>
  reads: number
  repairs: number
  finishing: boolean
  autoApply: boolean
  recovery?: StudioPlannerRecovery
  recoveryWrites?: Promise<void>
  partsCursor?: { transportId: string; throughEventRevision: number }
  ownerGeneration?: number
  stopRequested?: boolean
  recoveryBlocked?: boolean
  awaitingGeneration?: boolean
  nativeEvents?: AgentEvent[]
}

export interface StudioOptions {
  connection: ConnectionState
  /** Main conversation recovery shares the native admission guard. */
  documentRecoveryReady?: boolean
  config: LifeConfig
  extensions: LifeExtensionsSnapshot
  source: LifeSourceSnapshot
  applySettings: (patch: LifeConfigPatch) => Promise<void>
  onNotify?: (message: string) => void
}

export function useCustomizationStudio(options: StudioOptions) {
  const [history] = useState(() => readStudioHistory())
  const historyOwner = useRef(history)
  const [sessions, setSessions] = useState(() =>
    history.sessions.length
      ? history.sessions
      : [createStudioSession(options.config.defaultProvider)],
  )
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem(activeKey) || ''
    } catch {
      return ''
    }
  })
  const [models, setModels] = useState<ModelOption[]>([])
  const [feedback, setFeedback] = useState(history.storageError || '')
  const [notice, setNotice] = useState('')
  const recoveryFeedback = useRef('')
  const [autoApply, setAutoApply] = useState(true)
  const current = useRef(sessions)
  const latest = useRef(options)
  const runs = useRef(new Map<string, StudioRun>())
  const historyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const historyDirty = useRef(false)
  const historyWait = useRef('')
  const historyWrites = useRef<Promise<void>>(Promise.resolve())
  const historyFlush = useRef<Promise<void> | undefined>(undefined)
  const pendingSessionRegistrations = useRef(new Set<string>())
  const alive = useRef(true)
  const [recoverySupport, setRecoverySupport] = useState<NativeRecoverySupport | undefined>(() =>
    recoverySupportQuery
      ? undefined
      : { mode: api?.agent.recover ? 'durable' : 'unsupported-clean' },
  )
  const recoverySupportCurrent = useRef(recoverySupport)
  recoverySupportCurrent.current = recoverySupport
  const [nativeRecoveryReady, setNativeRecoveryReady] = useState(
    recoverySupport?.mode === 'unsupported-clean',
  )
  const [nativeRecoveryRetry, setNativeRecoveryRetry] = useState(0)
  const admittedNativeOwners = useRef(
    new Map<
      string,
      Map<
        string,
        {
          cursor: NonNullable<Thread['nativeRecovery']>[string]
          messages: Thread['messages']
        }
      >
    >(),
  )
  const recoveredNativeOwners = useRef(new Map<string, NativeRecoveryOwnerState>())
  const recoveryInFlight = useRef(recoverySupport?.mode !== 'unsupported-clean')
  const recoveryEpoch = useRef(0)
  const recoveryEvents = useRef<AgentEvent[]>([])
  const deliverRecoveryEvent = useRef<((event: AgentEvent) => void) | undefined>(undefined)
  const finishRef = useRef<(id: string, run: StudioRun) => Promise<void>>(async () => {})
  current.current = sessions
  latest.current = options
  const active = sessions.find((session) => session.id === activeId) || sessions[0]

  function usesDurableRecovery(): boolean {
    return recoverySupportCurrent.current?.mode === 'durable'
  }
  function supportBlocksMutation(): boolean {
    const mode = recoverySupportCurrent.current?.mode
    return mode === undefined || mode === 'blocked'
  }
  function supportMessage(): string {
    return (
      recoverySupportCurrent.current?.message ||
      (supportBlocksMutation()
        ? 'Life is verifying native recovery support. This Studio conversation remains available to read and export.'
        : 'Life is verifying the original native Studio owner. Your draft is kept until this conversation can safely continue.')
    )
  }

  useEffect(() => {
    if (!recoverySupportQuery) return
    let disposed = false
    void Promise.resolve()
      .then(() => recoverySupportQuery())
      .then((support) => {
        if (disposed) return
        if (!['durable', 'unsupported-clean', 'blocked'].includes(support.mode))
          throw new Error('Life received an unknown native recovery support mode.')
        recoverySupportCurrent.current = support
        setRecoverySupport(support)
        if (support.mode === 'unsupported-clean') {
          recoveryInFlight.current = false
          setNativeRecoveryReady(true)
          const buffered = recoveryEvents.current
          recoveryEvents.current = []
          for (const event of buffered)
            if (!event.nativeRecovery) deliverRecoveryEvent.current?.(event)
        } else if (support.mode === 'blocked') {
          recoveryInFlight.current = true
          recoveryEvents.current = []
          setNativeRecoveryReady(false)
          setFeedback(
            support.message ||
              'Native recovery is blocked. Read or export this Studio conversation before continuing.',
          )
        } else
          recoveryEvents.current = recoveryEvents.current.filter((event) => event.nativeRecovery)
      })
      .catch((error) => {
        if (disposed) return
        const support: NativeRecoverySupport = {
          mode: 'blocked',
          message: `Native recovery support could not be verified. ${errorText(error)}`,
        }
        recoverySupportCurrent.current = support
        setRecoverySupport(support)
        recoveryInFlight.current = true
        recoveryEvents.current = []
        setNativeRecoveryReady(false)
        setFeedback(support.message!)
      })
    return () => {
      disposed = true
    }
  }, [])

  function bindNativeStudioWorkspace(thread: Thread, owner: NativeRecoveryOwnerState): Thread {
    const input = owner.originalInput
    const workspace = input?.workspace
    // The private native workspace stays known while its transport reconnects.
    // Bind that identity before replay; owner status still gates every mutation.
    if (
      owner.sessionId !== thread.id ||
      input?.sessionId !== thread.id ||
      input.scope !== 'life-customization' ||
      input.provider !== thread.provider ||
      typeof workspace !== 'string' ||
      !workspace.startsWith('/') ||
      /[\x00-\x1f\x7f]/.test(workspace) ||
      thread.workspaceUnknown ||
      (thread.workspace !== undefined && thread.workspace !== workspace)
    )
      return thread
    return thread.workspace === workspace ? thread : { ...thread, workspace }
  }

  function admitOwnedStudioProjection(id: string) {
    if (!usesDurableRecovery()) return
    const thread = current.current.find((session) => session.id === id)?.thread
    const admissions = admittedNativeOwners.current.get(id)
    if (!thread || !admissions) return
    const native = nativeProjectionAdmissions([thread])
    for (const [transportId, proof] of admissions) {
      const cursor = thread.nativeRecovery?.[transportId]
      if (
        cursor === proof.cursor &&
        native?.some(
          (admission) =>
            admission.transportId === transportId &&
            admission.appliedRevision === cursor.appliedRevision &&
            admission.snapshotToken === cursor.snapshotToken &&
            admission.ownerGeneration === cursor.ownerGeneration,
        )
      )
        admissions.set(transportId, { cursor, messages: thread.messages })
    }
  }

  function capturePlanner(
    id: string,
    run: StudioRun,
    phase = run.recovery?.phase || 'planning',
  ): StudioPlannerRecovery {
    const session = current.current.find((candidate) => candidate.id === id)
    const user = session?.thread.messages.findLast(
      (message) => message.role === 'user' && message.turn === session.thread.turn,
    )
    return parseStudioPlannerRecovery({
      ...run.recovery,
      format: 'life-studio-planner-recovery',
      formatVersion: 1,
      sessionId: id,
      profileId: run.profileId,
      provider: run.input.provider,
      request: run.request,
      input: { ...run.input, scope: 'life-customization', clientRecovery: undefined },
      userMessage:
        run.recovery?.userMessage ||
        (user && user.createdAt !== undefined
          ? {
              id: user.id,
              role: 'user',
              text: user.text,
              turn: user.turn,
              createdAt: user.createdAt,
            }
          : undefined),
      sessionSeed:
        run.recovery?.sessionSeed ||
        (session && user
          ? {
              id: session.id,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              thread: {
                id: session.id,
                profileId: run.profileId,
                provider: run.input.provider,
                title: session.thread.title,
                model: session.thread.model,
                mode: 'plan',
                purpose: 'customization',
                updatedAt: session.thread.updatedAt,
                turn: session.thread.turn,
                messages: [],
                pending: [],
                busy: false,
                ...(run.input.remoteId ? { remoteId: run.input.remoteId } : {}),
                ...(run.input.workspace ? { workspace: run.input.workspace } : {}),
                ...(session.thread.reasoningEffort
                  ? { reasoningEffort: session.thread.reasoningEffort }
                  : {}),
                ...(session.thread.serviceTier ? { serviceTier: session.thread.serviceTier } : {}),
              },
            }
          : undefined),
      source: run.source,
      nativeIteration: run.recovery?.nativeIteration ?? 1,
      reads: run.reads,
      repairs: run.repairs,
      parts: [...run.parts].map(([itemId, text]) => ({ itemId, text })),
      finishing: run.finishing,
      autoApply: run.autoApply,
      phase,
      terminal: phase === 'finished' ? run.recovery?.terminal : undefined,
      applied: run.partsCursor,
    })
  }
  async function persistPlanner(
    id: string,
    run: StudioRun,
    phase?: StudioPlannerRecovery['phase'],
  ) {
    if (!usesDurableRecovery() || !api?.agent.updateRecoveryOwner || runs.current.get(id) !== run)
      return
    const captured = capturePlanner(id, run, phase)
    await persistPlannerSnapshot(id, run, captured)
  }
  function persistPlannerSnapshot(
    id: string,
    run: StudioRun,
    captured: StudioPlannerRecovery | (() => Promise<StudioPlannerRecovery>),
  ): Promise<void> {
    if (!usesDurableRecovery() || !api?.agent.updateRecoveryOwner) return Promise.resolve()
    const previousRecovery = run.recovery
    if (typeof captured !== 'function') run.recovery = captured
    const transportId = run.partsCursor?.transportId
    const ownerGeneration = run.ownerGeneration
    const projectionAdmissions = nativeProjectionAdmissions(
      current.current.filter((session) => session.id === id).map((session) => session.thread),
    )
    const next = (run.recoveryWrites || Promise.resolve())
      .then(async () => {
        const snapshot = typeof captured === 'function' ? await captured() : captured
        if (runs.current.get(id) !== run)
          throw new StudioRecoveryPending(
            'The previous Studio owner has been replaced by native reconciliation.',
          )
        if (typeof captured === 'function' && run.recovery === previousRecovery)
          run.recovery = snapshot
        return api!.agent.updateRecoveryOwner!({
          sessionId: id,
          clientRecovery: snapshot,
          ...(transportId ? { transportId } : {}),
          ...(ownerGeneration !== undefined ? { ownerGeneration } : {}),
          ...(projectionAdmissions ? { projectionAdmissions } : {}),
        }).then(() => {
          const owner = recoveredNativeOwners.current.get(id)
          if (
            owner &&
            owner.transportId === transportId &&
            owner.ownerGeneration === ownerGeneration
          )
            recoveredNativeOwners.current.set(id, { ...owner, clientRecovery: snapshot })
        })
      })
      .catch((error) => {
        throw new StudioRecoveryPending(
          `The native Studio checkpoint could not be committed. ${errorText(error)}`,
        )
      })
    run.recoveryWrites = next
    return next
  }
  function pauseNativePlanner(id: string, detail: string) {
    const run = runs.current.get(id)
    if (run) run.recoveryBlocked = true
    mutate(id, (session) => ({
      ...session,
      thread: {
        ...session.thread,
        busy: false,
        nativeRecoveryStatus: 'unknown',
        turnStatus: 'unknown',
      },
    }))
    setFeedback(detail)
  }
  async function performPlannerAction(
    id: string,
    run: StudioRun,
    action: StudioPlannerAction,
    phase: StudioPlannerRecovery['phase'],
  ): Promise<NonNullable<StudioPlannerAction['receipt']>> {
    const owner = recoveredNativeOwners.current.get(id)
    const transportId = run.partsCursor?.transportId || owner?.transportId
    const generation = run.ownerGeneration ?? owner?.ownerGeneration
    if (
      !usesDurableRecovery() ||
      !api?.agent.performRecoveryAction ||
      !transportId ||
      generation === undefined
    )
      throw new StudioRecoveryPending(
        'Life must verify the native Studio action owner before continuing this change.',
      )
    const intended = parseStudioPlannerRecovery({ ...capturePlanner(id, run, phase), action })
    await persistPlannerSnapshot(id, run, intended)
    const started =
      action.status === 'intended' ? startStudioPlannerAction(intended, action.id) : intended
    await persistPlannerSnapshot(id, run, started)
    const kinds = {
      'read-source': 'source-read',
      'apply-source': 'source-apply',
      'apply-settings': 'settings-apply',
      'apply-extension': 'extension-apply',
      'reload-source': 'reload',
      'start-provider': undefined,
    } as const
    const kind = kinds[action.kind]
    if (!kind)
      throw new StudioRecoveryPending(
        'A provider start is reconciled through its original native outbox.',
      )
    let result
    try {
      result = await api.agent.performRecoveryAction({
        actionId: action.id,
        sessionId: id,
        transportId,
        ownerGeneration: generation,
        kind,
        intent: action.intent,
      })
    } catch (error) {
      throw new StudioRecoveryPending(
        `The last Studio action is being reconciled. ${errorText(error)}`,
      )
    }
    if (runs.current.get(id) !== run)
      throw new StudioRecoveryPending(
        'The previous Studio action was replaced by native reconciliation.',
      )
    if (
      result.native.actionId !== action.id ||
      result.native.transportId !== transportId ||
      result.native.ownerGeneration !== generation
    )
      throw new StudioRecoveryPending(
        'The native Studio receipt belongs to a different action owner.',
      )
    if (result.status === 'failed') {
      const failure = result.error || 'The native Studio action could not complete.'
      await persistPlannerSnapshot(
        id,
        run,
        settleStudioPlannerAction(started, action.id, { error: failure }),
      )
      throw new Error(failure)
    }
    if (result.status !== 'succeeded' || !result.receipt)
      throw new StudioRecoveryPending(
        result.error || 'Life is reconciling the original Studio action before continuing.',
      )
    let settled: StudioPlannerRecovery
    try {
      settled = settleStudioPlannerAction(started, action.id, { receipt: result.receipt })
    } catch (error) {
      throw new StudioRecoveryPending(
        `The native Studio receipt could not be verified. ${errorText(error)}`,
      )
    }
    await persistPlannerSnapshot(id, run, settled)
    return settled.action!.receipt!
  }
  async function readPlannerSource(
    id: string,
    run: StudioRun,
    purpose: 'source-read' | 'repair-index' | 'repair-files',
    read?: { paths: string[] },
  ): Promise<LifeSourceContext> {
    if (!usesDurableRecovery() || !api?.agent.performRecoveryAction)
      return api!.sourceCode.getContext(read)
    const receipt = await performPlannerAction(
      id,
      run,
      {
        id: crypto.randomUUID(),
        iteration: run.recovery?.nativeIteration ?? 1,
        kind: 'read-source',
        status: 'intended',
        intent: { purpose, ...(read ? { read } : {}) },
      },
      purpose === 'source-read' ? 'reading' : 'repairing',
    )
    if (!('source' in receipt))
      throw new StudioRecoveryPending(
        'The native source read did not include its exact context receipt.',
      )
    return receipt.source
  }

  async function cacheHash(encoded: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  const persistHistory = useCallback((next: readonly StudioSession[]): Promise<void> => {
    historyDirty.current = true
    clearTimeout(historyTimer.current)
    historyTimer.current = undefined
    const write = historyWrites.current
      .catch(() => {})
      .then(async () => {
        // Native hydration validates the existing cache before any replacement can claim it.
        if (supportBlocksMutation() || recoveryInFlight.current) return
        const epoch = recoveryEpoch.current
        const prepared = historyOwner.current.prepare(next)
        const receipts: Parameters<
          NonNullable<NonNullable<typeof api>['agent']['acknowledgeRecoveryHistory']>
        >[0][] = []
        for (const { session, row, encodedRow } of prepared.views) {
          const storedThread = row.thread
          if (!storedThread || typeof storedThread !== 'object' || Array.isArray(storedThread))
            continue
          const stored = normalizeNativeRecovery(
            (storedThread as Record<string, unknown>).nativeRecovery,
          )
          const admitted = admittedNativeOwners.current.get(session.id)
          const run = runs.current.get(session.id)
          const owner = recoveredNativeOwners.current.get(session.id)
          const durable =
            usesDurableRecovery() &&
            api?.agent.updateRecoveryOwner &&
            api.agent.acknowledgeRecoveryHistory
          // Unchanged acknowledged bytes already own their private cache proof.
          // Changed native rows must prepare a new proof before replacing that cache.
          const unchanged = historyOwner.current.recoveryRow(session) === encodedRow
          const waitForProof = (reason: string, details?: Record<string, unknown>) => {
            const waiting = JSON.stringify({
              sessionId: session.id,
              reason,
              ownerGeneration: owner?.ownerGeneration,
              ownerTransport: owner?.transportId,
              ...details,
            })
            if (historyWait.current !== waiting) {
              historyWait.current = waiting
              console.info('[Life] Studio checkpoint waiting:', waiting)
            }
          }
          // The terminal checkpoint owns the stopped result; retain its prior cache.
          if (run?.stopRequested || run?.awaitingGeneration) {
            if (durable && !unchanged) return waitForProof('pending generation or Stop')
            continue
          }
          for (const [transportId, cursor] of Object.entries(session.thread.nativeRecovery || {})) {
            if (!durable || !cursor.snapshotToken || cursor.ownerGeneration === undefined) continue
            if (unchanged) continue
            if (!owner) return waitForProof('missing native owner')
            // The current owner prepares the row; its delivered projection may
            // end on an older registered generation of the same transport.
            if (owner.transportId !== transportId) continue
            const persisted = stored?.[transportId]
            const proof = admitted?.get(transportId)
            if (
              !usesDurableRecovery() ||
              !api?.agent.updateRecoveryOwner ||
              !api.agent.acknowledgeRecoveryHistory ||
              !cursor.snapshotToken ||
              cursor.ownerGeneration === undefined ||
              proof?.cursor !== cursor ||
              proof.messages !== session.thread.messages ||
              persisted?.appliedRevision !== cursor.appliedRevision ||
              persisted.snapshotToken !== cursor.snapshotToken ||
              persisted.ownerGeneration !== cursor.ownerGeneration
            )
              return waitForProof('projection', {
                generation: cursor.ownerGeneration,
                revision: cursor.appliedRevision,
                hasProof: Boolean(proof),
                sameCursor: proof?.cursor === cursor,
                sameMessages: proof?.messages === session.thread.messages,
                persisted,
              })
            if (
              run &&
              (run.partsCursor?.transportId !== transportId ||
                run.ownerGeneration !== owner.ownerGeneration)
            )
              return waitForProof('planner generation', {
                generation: cursor.ownerGeneration,
                plannerGeneration: run.ownerGeneration,
              })
            // Keep the cache dirty until its original native owner is admitted.
            // Waiting for reconnect is not a failed history write.
            if (owner.status !== 'running' && owner.status !== 'idle')
              return waitForProof('native owner status', { status: owner.status })
            // Historical cursors remain in the transcript. Only its exact
            // current owner can prepare a cache checkpoint for this planner.
            // Rows sharing a provider transport have different bytes and owners.
            const snapshotId = crypto.randomUUID()
            const planner = run
              ? capturePlanner(session.id, run)
              : parseStudioPlannerRecovery(owner.clientRecovery)
            let capturedHash = ''
            const capturePrepared = async () => {
              capturedHash = await cacheHash(encodedRow)
              return parseStudioPlannerRecovery({
                ...planner,
                preparedCache: {
                  snapshotId,
                  hash: capturedHash,
                  transportId,
                  snapshotToken: cursor.snapshotToken,
                  ownerGeneration: cursor.ownerGeneration,
                  throughEventRevision: cursor.appliedRevision,
                },
              })
            }
            // This proof owns the exact forthcoming bytes and planner parts before setItem.
            if (run) await persistPlannerSnapshot(session.id, run, capturePrepared)
            else {
              const captured = await capturePrepared()
              await api.agent.updateRecoveryOwner({
                sessionId: session.id,
                clientRecovery: captured,
                transportId: owner.transportId,
                ownerGeneration: owner.ownerGeneration,
                projectionAdmissions: nativeProjectionAdmissions([session.thread]),
              })
              if (recoveredNativeOwners.current.get(session.id) === owner)
                recoveredNativeOwners.current.set(session.id, {
                  ...owner,
                  clientRecovery: captured,
                })
            }
            receipts.push({
              kind: 'studio',
              sessionId: session.id,
              transportId,
              snapshotToken: cursor.snapshotToken,
              snapshotId,
              throughEventRevision: cursor.appliedRevision,
              durability: 'admitted-cache',
              fileHash: capturedHash,
            })
          }
        }
        if (recoveryInFlight.current || recoveryEpoch.current !== epoch)
          throw new StudioRecoveryPending(
            'Native recovery replaced the pending Studio cache snapshot.',
          )
        historyOwner.current.commitPrepared(prepared, localStorage)
        historyWait.current = ''
        historyDirty.current = current.current !== next
        for (const receipt of receipts) await api?.agent.acknowledgeRecoveryHistory?.(receipt)
      })
    historyWrites.current = write
    void write.catch(() => {
      historyDirty.current = true
      if (alive.current)
        setFeedback(
          historyOwner.current.storageError ||
            'Studio history could not be saved. The native recovery ledger retains its replay tail.',
        )
    })
    return write
  }, [])

  const flushHistory = useCallback(() => {
    if (historyFlush.current) return historyFlush.current
    const flushing = (async () => {
      await historyWrites.current.catch(() => {})
      if (historyDirty.current) await persistHistory(current.current)
    })()
    historyFlush.current = flushing
    const settled = () => {
      if (historyFlush.current === flushing) historyFlush.current = undefined
    }
    void flushing.then(settled, settled)
    return flushing
  }, [persistHistory])

  useEffect(() => {
    if (!nativeRecoveryReady || supportBlocksMutation() || recoveryInFlight.current) return
    const pending = [...pendingSessionRegistrations.current].filter((id) => {
      const session = current.current.find((candidate) => candidate.id === id)
      return session && !historyOwner.current.hasSession(session)
    })
    if (!pending.length) return
    void persistHistory(current.current).then(
      () => {
        for (const id of pending) {
          const session = current.current.find((candidate) => candidate.id === id)
          if (session && historyOwner.current.hasSession(session))
            pendingSessionRegistrations.current.delete(id)
        }
      },
      () => {},
    )
  }, [nativeRecoveryReady, recoverySupport?.mode, persistHistory])

  useEffect(() => {
    const checkpointWindow = window as Window & { __lifeFlushStudioHistory?: () => Promise<void> }
    checkpointWindow.__lifeFlushStudioHistory = flushHistory
    const unload = () => {
      void flushHistory().catch(() => {})
    }
    window.addEventListener('pagehide', unload)
    window.addEventListener('beforeunload', unload)
    window.addEventListener('life:history-checkpoint', unload)
    return () => {
      window.removeEventListener('pagehide', unload)
      window.removeEventListener('beforeunload', unload)
      window.removeEventListener('life:history-checkpoint', unload)
      if (checkpointWindow.__lifeFlushStudioHistory === flushHistory)
        delete checkpointWindow.__lifeFlushStudioHistory
      unload()
    }
  }, [flushHistory])

  const mutate = useCallback(
    (id: string, change: (session: StudioSession) => StudioSession) => {
      if (!alive.current) return
      const next = current.current.map((session) => {
        if (session.id !== id) return session
        const edited = change(session)
        return {
          ...edited,
          thread: usesDurableRecovery()
            ? carryNativeProjectionAuthoredTransition(session.thread, edited.thread)
            : edited.thread,
        }
      })
      current.current = next
      admitOwnedStudioProjection(id)
      setSessions(next)
      historyDirty.current = true
      clearTimeout(historyTimer.current)
      historyTimer.current = setTimeout(() => {
        try {
          persistHistory(current.current)
        } catch {
          if (alive.current)
            setFeedback(
              historyOwner.current.storageError ||
                'Studio history storage is full. Export older conversations before removing them.',
            )
        }
      }, 300)
    },
    [persistHistory],
  )

  function receipt(
    id: string,
    title: string,
    text: string,
    status = 'completed',
    actionId?: string,
  ) {
    mutate(id, (session) => ({
      ...session,
      updatedAt: Date.now(),
      thread: {
        ...session.thread,
        messages:
          actionId &&
          session.thread.messages.some(
            (message) => message.id === `studio:action:${actionId}:${title}`,
          )
            ? session.thread.messages
            : [
                ...session.thread.messages,
                {
                  id: actionId
                    ? `studio:action:${actionId}:${title}`
                    : `studio:${crypto.randomUUID()}`,
                  role: 'tool',
                  title,
                  text,
                  status,
                  turn: session.thread.turn,
                  createdAt: Date.now(),
                },
              ],
      },
    }))
    const action = runs.current.get(id)?.recovery?.action
    if (actionId && action?.id === actionId && action.status === 'succeeded')
      admitOwnedStudioProjection(id)
  }

  async function finish(id: string, stage: StudioSession['stage'], error?: string) {
    const run = runs.current.get(id)
    const finishedAt = run?.recovery?.terminal?.finishedAt ?? Date.now()
    const errorMessageId = error
      ? run?.recovery?.terminal?.errorMessageId || crypto.randomUUID()
      : undefined
    if (run && usesDurableRecovery() && api?.agent.updateRecoveryOwner) {
      run.finishing = true
      try {
        const terminal = {
          stage:
            stage === 'failed'
              ? ('failed' as const)
              : stage === 'interrupted'
                ? ('interrupted' as const)
                : ('complete' as const),
          ...(error ? { error } : {}),
          finishedAt,
          ...(errorMessageId ? { errorMessageId } : {}),
          ...(run.recovery?.terminal?.discarded ? { discarded: true as const } : {}),
        }
        await persistPlannerSnapshot(
          id,
          run,
          parseStudioPlannerRecovery({
            ...capturePlanner(id, run, 'finished'),
            terminal,
          }),
        )
      } catch (failure) {
        if (runs.current.get(id) !== run) return
        pauseNativePlanner(id, errorText(failure))
        return
      }
    }
    if (run && runs.current.get(id) !== run) return
    runs.current.delete(id)
    const status =
      stage === 'failed' ? 'failed' : stage === 'interrupted' ? 'interrupted' : 'completed'
    mutate(id, (session) => {
      const finished = finishThreadTurn(session.thread, status, finishedAt)
      return {
        ...session,
        stage,
        updatedAt: finishedAt,
        thread: carryNativeProjectionAuthoredTransition(finished, {
          ...finished,
          busy: false,
          pending: finished.pending.filter((request) => Boolean(request.agentId)),
          messages:
            error && !finished.messages.some((message) => message.id === errorMessageId)
              ? [
                  ...finished.messages,
                  {
                    id: errorMessageId!,
                    role: 'error',
                    text: error,
                    turn: session.thread.turn,
                    createdAt: finishedAt,
                  },
                ]
              : finished.messages,
        }),
      }
    })
    if (run && usesDurableRecovery() && api?.agent.updateRecoveryOwner)
      admitOwnedStudioProjection(id)
    if (error) setFeedback(error)
  }

  async function resumePlannerAction(id: string, run: StudioRun) {
    let sourceCommitted =
      run.recovery?.action?.kind === 'reload-source' ||
      (run.recovery?.action?.kind === 'apply-source' && run.recovery.action.status === 'succeeded')
    try {
      const action = run.recovery?.action
      if (!action) return
      if (
        run.recovery?.phase === 'finished' &&
        run.recovery.terminal &&
        ['intended', 'started'].includes(action.status) &&
        action.kind !== 'read-source'
      )
        throw new StudioRecoveryPending(
          'Life is reconciling the stopped Studio action; it will not start another mutation.',
        )
      if (action.status === 'failed') {
        if (run.recovery?.phase === 'finished' && run.recovery.terminal) {
          const terminal = run.recovery.terminal
          await finish(id, terminal.stage, terminal.error)
          return
        }
        if (
          ['apply-source', 'apply-settings', 'apply-extension', 'reload-source'].includes(
            action.kind,
          ) &&
          (await repair(id, run, action.error || 'The previous Studio action failed.'))
        )
          return
        await finish(id, 'failed', action.error || 'The previous Studio action failed.')
        return
      }
      const completed =
        action.status === 'succeeded'
          ? action.receipt!
          : await performPlannerAction(id, run, action, run.recovery!.phase)
      if (action.kind === 'apply-source') sourceCommitted = true
      if (runs.current.get(id) !== run) return
      if (run.recovery?.phase === 'finished' && run.recovery.terminal) {
        const terminal = run.recovery.terminal
        await finish(id, terminal.stage, terminal.error)
        return
      }
      if (action.kind === 'read-source') {
        if (!('source' in completed))
          throw new StudioRecoveryPending(
            'The recovered source read is missing its exact native receipt.',
          )
        if (action.intent.purpose === 'repair-index') {
          const response = extractLifeThreadResponse([...run.parts.values()].join('\n'))
          const proposed =
            response.kind === 'source' ? response.patch.files.map((file) => file.path) : []
          const paths = [
            ...new Set([...proposed, ...(run.source?.files.map((file) => file.path) || [])]),
          ]
            .filter((path) => completed.source.paths.includes(path))
            .slice(0, 30)
          run.source = paths.length
            ? await readPlannerSource(id, run, 'repair-files', { paths })
            : completed.source
        } else run.source = completed.source
        await send(id, run, run.recovery?.continuation || {})
        return
      }
      if (action.kind === 'apply-source') {
        if (
          !('snapshot' in completed) ||
          !completed.snapshot.enabled ||
          !completed.snapshot.active ||
          completed.snapshot.error
        )
          throw new Error('The recovered source build did not activate successfully.')
        receipt(id, 'Source build passed', action.intent.patch.summary, 'completed', action.id)
        mutate(id, (session) => ({
          ...session,
          stage: 'complete',
          changes: action.intent.patch.files.map((file) => file.path),
          thread: { ...finishThreadTurn(session.thread, 'completed'), busy: false, pending: [] },
        }))
        admitOwnedStudioProjection(id)
        await persistHistory(current.current)
        await performPlannerAction(
          id,
          run,
          {
            id: crypto.randomUUID(),
            iteration: run.recovery!.nativeIteration,
            kind: 'reload-source',
            status: 'intended',
            intent: { appliedActionId: action.id, revision: completed.snapshot.revision },
          },
          'reloading',
        )
        await finish(id, 'complete')
        return
      }
      if (action.kind === 'apply-settings')
        receipt(
          id,
          'Settings applied',
          Object.keys(action.intent.patch).join('\n'),
          'completed',
          action.id,
        )
      if (action.kind === 'apply-extension')
        receipt(
          id,
          'Runtime extension installed',
          `${action.intent.manifest.name}\n${action.intent.manifest.id}`,
          'completed',
          action.id,
        )
      if (action.kind !== 'start-provider') await finish(id, 'complete')
    } catch (error) {
      if (runs.current.get(id) !== run) return
      // A failed reload is proven by the native source generation's startup error.
      // An unready document or a manual rollback remains unknown and cannot authorize repair.
      if (
        run.recovery?.phase !== 'finished' &&
        run.recovery?.action?.kind === 'reload-source' &&
        run.recovery.action.status === 'failed'
      ) {
        try {
          if (await repair(id, run, errorText(error))) return
        } catch (failure) {
          if (failure instanceof StudioRecoveryPending) {
            pauseNativePlanner(id, errorText(failure))
            return
          }
        }
        await finish(id, 'failed', errorText(error))
        return
      }
      if (sourceCommitted) {
        pauseNativePlanner(
          id,
          `The source build passed. Life is reconciling its saved history and reload before continuing. ${errorText(error)}`,
        )
        return
      }
      if (error instanceof StudioRecoveryPending) pauseNativePlanner(id, errorText(error))
      else {
        try {
          if (await repair(id, run, errorText(error))) return
        } catch (failure) {
          if (failure instanceof StudioRecoveryPending) {
            pauseNativePlanner(id, errorText(failure))
            return
          }
        }
        await finish(id, 'failed', errorText(error))
      }
    }
  }

  async function send(
    id: string,
    run: StudioRun,
    extra: {
      sourceRead?: { paths: string[] }
      repair?: { attempt: number; diagnostics: string }
    } = {},
  ) {
    if (!api || supportBlocksMutation() || runs.current.get(id) !== run) return
    if (run.recoveryWrites) await run.recoveryWrites
    if (runs.current.get(id) !== run) return
    const state = latest.current.connection
    if (state.status !== 'connected' || state.profile?.id !== run.profileId)
      throw new Error(
        'Reconnect the Studio’s machine to continue this customization. Your request and source are saved.',
      )
    const context = buildStudioInstructions({
      config: latest.current.config,
      extensions: latest.current.extensions.extensions,
      capabilities: api.extensions.capabilities,
      source: run.source,
      ...extra,
    })
    const session = current.current.find((item) => item.id === id)
    if (!session || runs.current.get(id) !== run) return
    run.parts.clear()
    // A new native iteration starts with no response parts. Its generation
    // snapshot supplies the new ledger binding, including after a virtual reservation.
    run.partsCursor = undefined
    run.ownerGeneration = undefined
    run.finishing = false
    run.input.remoteId = session.thread.remoteId || run.input.remoteId
    const input: StartInput = {
      ...run.input,
      localTurn: session.thread.turn,
      prompt: run.request,
      mode: 'plan',
      scope: 'life-customization',
      studioContext: context,
    }
    if (!usesDurableRecovery()) delete input.clientRecovery
    run.input = input
    const previousIteration = run.recovery?.nativeIteration ?? 0
    run.recovery = capturePlanner(id, run, 'planning')
    run.recovery = parseStudioPlannerRecovery({
      ...run.recovery,
      nativeIteration: previousIteration + 1,
      action: undefined,
      // A new iteration may own a different native transport after renderer recovery.
      // Its empty response ledger cannot carry the previous transport's cache preparation.
      preparedCache: undefined,
      continuation: Object.keys(extra).length ? extra : undefined,
    })
    run.awaitingGeneration = usesDurableRecovery() && Boolean(api.agent.recover)
    try {
      await api.agent.start(
        usesDurableRecovery() ? { ...run.recovery.input, clientRecovery: run.recovery } : input,
      )
    } catch (error) {
      if (usesDurableRecovery() && api.agent.recover)
        throw new StudioRecoveryPending(
          `The native planner start is being reconciled. ${errorText(error)}`,
        )
      throw error
    }
    if (usesDurableRecovery() && api.agent.recover) {
      const result = await api.agent
        .recover({
          consumers: [
            {
              kind: 'studio',
              sessionId: id,
              profileId: run.profileId,
              ...(session.thread.workspace ? { workspace: session.thread.workspace } : {}),
              ...(input.remoteId ? { remoteId: input.remoteId } : {}),
              // This live handshake binds the newly admitted generation. Its
              // buffered output is replayed without claiming a cached prefix;
              // durable history hydration supplies its separate cache hash.
              ...(nativeProjectionAdmissions([session.thread])
                ? {
                    projectionAdmissions: nativeProjectionAdmissions([session.thread]),
                  }
                : {}),
            },
          ],
        })
        .catch((error) => {
          throw new StudioRecoveryPending(
            `The new native planner owner is being reconciled. ${errorText(error)}`,
          )
        })
      if (runs.current.get(id) !== run) return
      const owner = result.owners.find((candidate) => {
        const bound = restoreStudioPlannerRecovery(candidate, {
          sessionId: id,
          profileId: run.profileId,
          provider: input.provider,
        })
        return (
          bound?.planner.nativeIteration === run.recovery?.nativeIteration &&
          candidate.localTurn === input.localTurn &&
          (candidate.status === 'running' || candidate.status === 'idle')
        )
      })
      if (!owner || owner.ownerGeneration === undefined)
        throw new StudioRecoveryPending(
          'Life could not verify the exact new native planner generation. The original start and pending output are preserved.',
        )
      recoveredNativeOwners.current.set(id, owner)
      run.ownerGeneration = owner.ownerGeneration
      run.partsCursor = { transportId: owner.transportId, throughEventRevision: 0 }
      run.awaitingGeneration = false
      mutate(id, (current) => ({
        ...current,
        thread: applyNativeRecoveryOwner(bindNativeStudioWorkspace(current.thread, owner), owner),
      }))
      const buffered = run.nativeEvents || []
      run.nativeEvents = []
      buffered.sort((a, b) => (a.nativeRecovery?.revision ?? 0) - (b.nativeRecovery?.revision ?? 0))
      for (const event of buffered) deliverRecoveryEvent.current?.(event)
    }
  }

  async function repair(id: string, run: StudioRun, diagnostics: string): Promise<boolean> {
    if (!api || runs.current.get(id) !== run || run.repairs >= maximumLifeRepairAttempts)
      return false
    if (
      latest.current.connection.status !== 'connected' ||
      latest.current.connection.profile?.id !== run.profileId
    )
      return false
    const failedAction = run.recovery?.action
    if (failedAction?.kind === 'reload-source' && failedAction.status === 'failed')
      receipt(id, 'Startup recovered', diagnostics, 'completed', failedAction.id)
    const repairs = run.repairs + 1
    // Capture the admitted attempt before advancing its counter and intent together.
    const recovery = parseStudioPlannerRecovery({
      ...capturePlanner(id, run, 'repairing'),
      repairs,
      action: undefined,
      continuation: { repair: { attempt: repairs, diagnostics: diagnostics.slice(0, 40_000) } },
    })
    run.repairs = repairs
    run.recovery = recovery
    const index = await readPlannerSource(id, run, 'repair-index')
    const session = current.current.find((item) => item.id === id)
    const proposed =
      session?.proposal?.kind === 'source'
        ? session.proposal.patch.files.map((file) => file.path)
        : []
    const paths = [...new Set([...proposed, ...(run.source?.files.map((file) => file.path) || [])])]
      .filter((path) => index.paths.includes(path))
      .slice(0, 30)
    run.source = paths.length ? await readPlannerSource(id, run, 'repair-files', { paths }) : index
    if (runs.current.get(id) !== run) return true
    mutate(id, (value) => ({
      ...value,
      stage: 'planning',
      proposal: undefined,
      thread: { ...value.thread, busy: true },
    }))
    receipt(id, `Repair ${run.repairs} of ${maximumLifeRepairAttempts}`, diagnostics, 'running')
    await send(id, run, {
      repair: { attempt: run.repairs, diagnostics: diagnostics.slice(0, 40_000) },
    })
    return true
  }

  async function apply(id: string, proposal: StudioProposal, run?: StudioRun) {
    if (supportBlocksMutation()) throw new Error(supportMessage())
    let sourceCommitted = false
    mutate(id, (session) => ({
      ...session,
      stage: 'applying',
      thread: { ...session.thread, busy: true },
    }))
    if (run) run.finishing = true
    try {
      if (proposal.kind === 'settings') {
        if (run && usesDurableRecovery() && api?.agent.performRecoveryAction)
          await performPlannerAction(
            id,
            run,
            {
              id: crypto.randomUUID(),
              iteration: run.recovery?.nativeIteration ?? 1,
              kind: 'apply-settings',
              status: 'intended',
              intent: { patch: proposal.patch },
            },
            'applying',
          )
        else await latest.current.applySettings(proposal.patch)
        receipt(id, 'Settings applied', Object.keys(proposal.patch).join('\n'))
      } else if (proposal.kind === 'extension') {
        if (!api) throw new Error('Runtime extensions require the Life desktop application.')
        const state =
          run && usesDurableRecovery() && api.agent.performRecoveryAction
            ? (await performPlannerAction(
                id,
                run,
                {
                  id: crypto.randomUUID(),
                  iteration: run.recovery?.nativeIteration ?? 1,
                  kind: 'apply-extension',
                  status: 'intended',
                  intent: { manifest: proposal.manifest },
                },
                'applying',
              ),
              await api.extensions.get())
            : await api.extensions.apply(proposal.manifest)
        if (state.errors[proposal.manifest.id]) throw new Error(state.errors[proposal.manifest.id])
        if (!state.extensions.some((extension) => extension.id === proposal.manifest.id))
          throw new Error('The runtime extension could not be saved.')
        receipt(
          id,
          'Runtime extension installed',
          `${proposal.manifest.name}\n${proposal.manifest.id}`,
        )
      } else {
        if (!api) throw new Error('Source compilation requires the Life desktop application.')
        receipt(
          id,
          'Building source extension',
          proposal.patch.files.map((file) => file.path).join('\n'),
          'running',
        )
        let state: LifeSourceSnapshot
        if (run && usesDurableRecovery() && api.agent.performRecoveryAction) {
          const receipt = await performPlannerAction(
            id,
            run,
            {
              id: crypto.randomUUID(),
              iteration: run.recovery?.nativeIteration ?? 1,
              kind: 'apply-source',
              status: 'intended',
              intent: { patch: proposal.patch },
            },
            'applying',
          )
          sourceCommitted = true
          if (!('snapshot' in receipt))
            throw new StudioRecoveryPending(
              'The native source build did not include its exact receipt.',
            )
          state = receipt.snapshot
        } else state = await api.sourceCode.apply(proposal.patch)
        if (state.error || !state.enabled || !state.active)
          throw new Error(state.error || 'The source extension did not activate.')
        receipt(
          id,
          'Source build passed',
          proposal.patch.summary,
          'completed',
          run?.recovery?.action?.id,
        )
        mutate(id, (session) => ({
          ...session,
          changes: proposal.patch.files.map((file) => file.path),
        }))
        mutate(id, (session) => ({
          ...session,
          stage: 'complete',
          thread: { ...finishThreadTurn(session.thread, 'completed'), busy: false, pending: [] },
        }))
        if (run && usesDurableRecovery() && api.agent.performRecoveryAction)
          admitOwnedStudioProjection(id)
        if (run && (!usesDurableRecovery() || !api.agent.performRecoveryAction)) {
          localStorage.setItem(
            pendingKey,
            encodeStudioPending({
              id,
              request: run.request,
              profileId: run.profileId,
              input: run.input,
              reads: run.reads,
              repairs: run.repairs,
              paths: proposal.patch.files.map((file) => file.path),
            }),
          )
        }
        clearTimeout(historyTimer.current)
        await persistHistory(current.current)
        if (run && usesDurableRecovery() && api.agent.performRecoveryAction)
          await performPlannerAction(
            id,
            run,
            {
              id: crypto.randomUUID(),
              iteration: run.recovery?.nativeIteration ?? 1,
              kind: 'reload-source',
              status: 'intended',
              intent: { appliedActionId: run.recovery!.action!.id, revision: state.revision },
            },
            'reloading',
          )
        else await api.sourceCode.reload()
        runs.current.delete(id)
        return
      }
      finish(id, 'complete')
      latest.current.onNotify?.('Life customization applied.')
    } catch (error) {
      if (run && runs.current.get(id) !== run) return
      const detail = errorText(error)
      if (sourceCommitted) {
        pauseNativePlanner(
          id,
          `The source build passed. Life is reconciling its saved history and reload before continuing. ${detail}`,
        )
        return
      }
      if (error instanceof StudioRecoveryPending) {
        pauseNativePlanner(id, detail)
        return
      }
      if (run) {
        try {
          if (await repair(id, run, detail)) return
        } catch (repairError) {
          finish(
            id,
            'failed',
            `${detail}\n\nAutomatic repair could not continue: ${errorText(repairError)}`,
          )
          return
        }
      }
      finish(id, 'failed', detail)
    }
  }

  finishRef.current = async (id, run) => {
    if (runs.current.get(id) !== run) return
    run.finishing = true
    const response = extractLifeThreadResponse([...run.parts.values()].join('\n'))
    try {
      await persistPlanner(id, run, 'completing')
      if (response.kind === 'source-read') {
        if (!api) throw new Error('Life source reads require the desktop application.')
        if (run.reads >= maximumLifeSourceReads)
          throw new Error(
            'Six source reads completed. Continue with a more focused request; the full conversation is saved.',
          )
        run.reads++
        run.recovery = parseStudioPlannerRecovery({
          ...capturePlanner(id, run, 'reading'),
          action: undefined,
          continuation: { sourceRead: response.read },
        })
        receipt(
          id,
          `Reading source ${run.reads} of ${maximumLifeSourceReads}`,
          response.read.paths.join('\n'),
          'running',
        )
        run.source = await readPlannerSource(id, run, 'source-read', response.read)
        if (runs.current.get(id) !== run) return
        mutate(id, (session) => ({
          ...session,
          stage: 'planning',
          thread: { ...session.thread, busy: true },
        }))
        await send(id, run, { sourceRead: response.read })
        return
      }
      if (response.kind === 'error') throw new Error(response.error)
      if (response.kind === 'message') {
        await finish(id, 'complete')
        return
      }
      mutate(id, (session) => ({
        ...session,
        stage: 'review',
        proposal: response,
        changes:
          response.kind === 'source'
            ? response.patch.files.map((file) => file.path)
            : session.changes,
      }))
      if (run.autoApply) await apply(id, response, run)
      else {
        run.finishing = true
        await persistPlanner(id, run, 'review')
        mutate(id, (session) => ({ ...session, thread: { ...session.thread, busy: false } }))
      }
    } catch (error) {
      if (runs.current.get(id) !== run) return
      const detail = errorText(error)
      if (error instanceof StudioRecoveryPending) {
        pauseNativePlanner(id, detail)
        return
      }
      try {
        if (await repair(id, run, detail)) return
      } catch (repairError) {
        finish(
          id,
          'failed',
          `${detail}\n\nAutomatic repair could not continue: ${errorText(repairError)}`,
        )
        return
      }
      finish(id, 'failed', detail)
    }
  }

  useEffect(() => {
    alive.current = true
    const deliver = (event: AgentEvent) => {
      if (supportBlocksMutation() || (event.nativeRecovery && !usesDurableRecovery())) return
      const target = current.current.find((session) => session.id === event.sessionId)
      if (!target) return
      if (
        event.nativeRecovery &&
        ((event.type === 'status' && event.status === 'resumed') ||
          (event.nativeRecovery.deliveryToken &&
            ['running', 'idle'].includes(event.nativeRecovery.ownerStatus || ''))) &&
        nativeRecoveryBlocksMutation(target.thread) &&
        acceptsAgentEvent(target.thread, event)
      )
        setNativeRecoveryRetry((revision) => revision + 1)
      const run = runs.current.get(event.sessionId)
      const transcriptAdmitted = acceptsAgentEvent(target.thread, event)
      const plannerAdmitted =
        !event.agentId &&
        (!event.nativeRecovery
          ? transcriptAdmitted && (!usesDurableRecovery() || !api?.agent.recover)
          : Boolean(
              run &&
              !run.awaitingGeneration &&
              acceptsAgentEvent({ ...target.thread, nativeRecovery: undefined }, event) &&
              run.ownerGeneration !== undefined &&
              event.nativeRecovery.ownerGeneration === run.ownerGeneration &&
              event.nativeRecovery.localTurn === run.input.localTurn &&
              run.partsCursor?.transportId === event.nativeRecovery.transportId &&
              event.nativeRecovery.revision > run.partsCursor.throughEventRevision,
            ))
      if (!transcriptAdmitted && !plannerAdmitted) return
      const ownsPlanner = Boolean(run && !run.finishing && plannerAdmitted)
      const completed =
        ownsPlanner &&
        !event.agentId &&
        event.type === 'complete' &&
        (event.status === 'completed' || !event.status)
      // Provider output and child lifecycles outlive the parent's proposal. Keep all
      // known-session content while reserving root completion for the owning planner.
      if (transcriptAdmitted)
        mutate(event.sessionId, (session) => {
          const applied = applyEvent(session.thread, event)
          if (
            !ownsPlanner &&
            !event.nativeRecovery &&
            !event.agentId &&
            ['complete', 'error', 'status'].includes(event.type)
          ) {
            const previous = new Map(
              session.thread.messages.map((message) => [message.id, message]),
            )
            return {
              ...session,
              updatedAt: Date.now(),
              thread: {
                ...applied,
                busy: session.thread.busy,
                turnStatus: session.thread.turnStatus,
                agentStatus: session.thread.agentStatus,
                connectionStatus: session.thread.connectionStatus,
                pending: session.thread.pending,
                queue: session.thread.queue,
                messages: applied.messages.map((message) => {
                  const prior = previous.get(message.id)
                  return prior
                    ? {
                        ...message,
                        status: prior.status,
                        finishStatus: prior.finishStatus,
                        finishedAt: prior.finishedAt,
                      }
                    : message
                }),
              },
            }
          }
          const next = {
            ...session,
            updatedAt: event.nativeRecovery?.emittedAt ?? Date.now(),
            thread: { ...applied, ...(completed ? { busy: true } : {}) },
          }
          return event.nativeRecovery ? reconcileStudioSessionLifecycle(next) : next
        })
      if (transcriptAdmitted && event.nativeRecovery?.snapshotToken) {
        const applied = current.current.find((session) => session.id === event.sessionId)?.thread
        const cursor = applied?.nativeRecovery?.[event.nativeRecovery.transportId]
        if (applied && cursor) {
          let admitted = admittedNativeOwners.current.get(event.sessionId)
          if (!admitted) admittedNativeOwners.current.set(event.sessionId, (admitted = new Map()))
          admitted.set(event.nativeRecovery.transportId, { cursor, messages: applied.messages })
        }
      }
      if (!run || !ownsPlanner) return
      if (event.nativeRecovery) {
        run.partsCursor = {
          transportId: event.nativeRecovery.transportId,
          throughEventRevision: event.nativeRecovery.revision,
        }
        if (event.nativeRecovery.ownerGeneration !== undefined)
          run.ownerGeneration = event.nativeRecovery.ownerGeneration
      }
      if (event.type === 'session' && event.remoteId) run.input.remoteId = event.remoteId
      if (event.type === 'text' && !event.agentId && event.phase !== 'commentary') {
        const key = event.itemId || 'response'
        run.parts.set(
          key,
          event.status === 'replace'
            ? event.text || ''
            : (run.parts.get(key) || '') + (event.text || ''),
        )
      }
      if (completed) run.finishing = true
      if (completed) void finishRef.current(event.sessionId, run)
      else if (!event.agentId && event.type === 'error') finish(event.sessionId, 'failed')
      else if (!event.agentId && event.type === 'complete')
        finish(event.sessionId, event.status === 'failed' ? 'failed' : 'interrupted')
    }
    deliverRecoveryEvent.current = deliver
    const off = api?.onAgent((event: AgentEvent) => {
      if (recoverySupportCurrent.current === undefined) {
        recoveryEvents.current.push(event)
        return
      }
      if (supportBlocksMutation() || (event.nativeRecovery && !usesDurableRecovery())) return
      if (event.nativeRecovery && recoveryInFlight.current) {
        recoveryEvents.current.push(event)
        return
      }
      const run = runs.current.get(event.sessionId)
      if (event.nativeRecovery && !event.agentId && run?.awaitingGeneration) {
        ;(run.nativeEvents ||= []).push(event)
        return
      }
      deliver(event)
    })
    return () => {
      alive.current = false
      off?.()
      deliverRecoveryEvent.current = undefined
    }
  }, [mutate])

  useEffect(() => {
    if (!usesDurableRecovery() || !api?.agent.recover) return
    let disposed = false
    recoveryInFlight.current = true
    recoveryEpoch.current++
    setNativeRecoveryReady(false)
    const consumers = Promise.all(
      current.current
        .filter((session) =>
          hasNativeRecoveryConsumerIdentity(session.id, session.thread.profileId),
        )
        .map(async (session) => {
          const row = historyOwner.current.recoveryRow(session)
          const currentCache = studioRecoveryCacheRow(session.thread)
          return {
            kind: 'studio' as const,
            sessionId: session.id,
            profileId: session.thread.profileId,
            ...(session.thread.workspace ? { workspace: session.thread.workspace } : {}),
            ...(session.thread.remoteId ? { remoteId: session.thread.remoteId } : {}),
            ...(session.thread.nativeRecovery ? { applied: session.thread.nativeRecovery } : {}),
            ...(row !== undefined && currentCache ? { cacheHash: await cacheHash(row) } : {}),
            ...(nativeProjectionAdmissions([session.thread])
              ? {
                  projectionAdmissions: nativeProjectionAdmissions([session.thread]),
                }
              : {}),
          }
        }),
    )
    void consumers
      .then((consumers) => api!.agent.recover!({ consumers }))
      .then(async ({ owners }) => {
        if (disposed) return
        const resumptions: {
          id: string
          run: StudioRun
          step: ReturnType<typeof getStudioPlannerRecoveryStep>
        }[] = []
        for (const owner of owners) {
          const previous = current.current.find((session) => session.id === owner.sessionId)
          const cacheProof = previous ? studioRecoveryCacheRow(previous.thread) : undefined
          if (
            previous &&
            cacheProof &&
            owner.acceptedProjectionAdmission &&
            owner.acceptedCacheHash
          )
            await registerNativeProjectionCacheBaseline(
              previous.thread,
              owner.acceptedProjectionAdmission,
              cacheProof,
              owner.acceptedCacheHash,
            )
          if (disposed) return
          const restored = restoreNativeStudioSession(current.current, owner)
          current.current = restored
          setSessions(restored)
          recoveredNativeOwners.current.set(owner.sessionId, owner)
          mutate(owner.sessionId, (session) => ({
            ...session,
            thread: applyNativeRecoveryOwner(
              bindNativeStudioWorkspace(session.thread, owner),
              owner,
            ),
          }))
          const session = current.current.find((candidate) => candidate.id === owner.sessionId)
          const acceptedCursor = session?.thread.nativeRecovery?.[owner.transportId]
          if (
            session &&
            acceptedCursor &&
            owner.acceptedAppliedCursor &&
            acceptedCursor.appliedRevision === owner.acceptedAppliedCursor.appliedRevision &&
            acceptedCursor.snapshotToken === owner.acceptedAppliedCursor.snapshotToken &&
            acceptedCursor.ownerGeneration === owner.acceptedAppliedCursor.ownerGeneration
          ) {
            let admitted = admittedNativeOwners.current.get(owner.sessionId)
            if (!admitted) admittedNativeOwners.current.set(owner.sessionId, (admitted = new Map()))
            admitted.set(owner.transportId, {
              cursor: acceptedCursor,
              messages: session.thread.messages,
            })
          } else admitOwnedStudioProjection(owner.sessionId)
          const bound = session
            ? restoreStudioPlannerRecovery(owner, {
                sessionId: session.id,
                profileId: session.thread.profileId,
                provider: session.thread.provider,
              })
            : undefined
          if (
            bound &&
            (!runs.current.has(owner.sessionId) ||
              runs.current.get(owner.sessionId)?.recoveryBlocked)
          ) {
            const planner = bound.planner
            const step = getStudioPlannerRecoveryStep(bound)
            if (
              step === 'finished' &&
              planner.input.localTurn !== undefined &&
              session!.thread.turn > planner.input.localTurn
            )
              continue
            const run: StudioRun = {
              request: planner.request,
              profileId: planner.profileId,
              input: { ...planner.input },
              source: planner.source,
              parts: new Map(planner.parts.map((part) => [part.itemId, part.text])),
              reads: planner.reads,
              repairs: planner.repairs,
              finishing: planner.finishing,
              autoApply: planner.autoApply,
              recovery: planner,
              partsCursor: planner.applied || {
                transportId: owner.transportId,
                throughEventRevision: 0,
              },
              ownerGeneration: owner.ownerGeneration,
              recoveryBlocked: step === 'wait-owner',
            }
            runs.current.set(owner.sessionId, run)
            resumptions.push({ id: owner.sessionId, run, step })
          }
        }
        const uncertain = owners.find((owner) => owner.status === 'unknown')
        if (uncertain) {
          const message =
            uncertain.message ||
            'Life could not verify the original native Studio owner. Sending and permission responses stay paused; the conversation is preserved.'
          recoveryFeedback.current = message
          setFeedback(message)
        } else {
          const previous = recoveryFeedback.current
          recoveryFeedback.current = ''
          setFeedback((message) => (message === previous ? '' : message))
        }
        setNativeRecoveryReady(true)
        recoveryInFlight.current = false
        const buffered = recoveryEvents.current
        recoveryEvents.current = []
        for (const event of buffered) deliverRecoveryEvent.current?.(event)
        for (const { id, run, step } of resumptions) {
          if (runs.current.get(id) !== run) continue
          if (step === 'await-output') mutate(id, (session) => ({ ...session, stage: 'planning' }))
          else if (step === 'finish-response') void finishRef.current(id, run)
          else if (
            ['reconcile-action', 'continue-action', 'use-receipt'].includes(step) &&
            run.recovery?.action
          )
            void resumePlannerAction(id, run)
          else if (step === 'review') void finishRef.current(id, run)
          else if (step === 'finished' && run.recovery?.terminal) {
            const terminal = run.recovery.terminal
            if (terminal.discarded) mutate(id, (session) => ({ ...session, proposal: undefined }))
            void finish(id, terminal.stage, terminal.error)
          } else if (step === 'reconcile-action')
            setFeedback(
              'Life restored the owned Studio planner and is reconciling its last native action before continuing.',
            )
        }
      })
      .catch((error) => {
        if (!disposed)
          setFeedback(`Native Studio recovery could not be reconciled. ${errorText(error)}`)
      })
    return () => {
      disposed = true
    }
  }, [
    mutate,
    recoverySupport?.mode,
    nativeRecoveryRetry,
    options.connection.status,
    options.connection.profile?.id,
  ])

  useEffect(() => {
    if (!active) return
    try {
      localStorage.setItem(activeKey, active.id)
    } catch {
      /* History remains readable. */
    }
  }, [active?.id])

  useEffect(() => {
    if (!active) return
    let disposed = false
    setModels(fallbackModelCatalog(active.thread.provider))
    if (
      api &&
      nativeRecoveryReady &&
      options.documentRecoveryReady !== false &&
      options.connection.status === 'connected'
    )
      void api.agent
        .models(active.thread.provider)
        .then((next) => {
          if (!disposed && next.length) setModels(next)
        })
        .catch(() => {})
    return () => {
      disposed = true
    }
  }, [
    active?.thread.provider,
    options.connection.status,
    options.connection.profile?.id,
    nativeRecoveryReady,
    options.documentRecoveryReady,
  ])

  useEffect(() => {
    if (!api || supportBlocksMutation()) return
    let disposed = false
    void (async () => {
      if (api!.agent.recover) {
        // Passive archives cannot authorize a new provider run or source mutation,
        // including when this host uses the ordinary unsupported recovery path.
        if (localStorage.getItem(pendingSourceApplyKey) || localStorage.getItem(pendingKey))
          setNotice('An earlier Studio change is preserved. Continue it explicitly from Studio.')
        return
      }
      const legacy = migrateLegacyStudioPending(
        localStorage.getItem(pendingSourceApplyKey),
        readThreads(),
      )
      if (legacy) {
        const next = [
          legacy.session,
          ...current.current.filter((session) => session.id !== legacy.session.id),
        ]
        // Commit the isolated conversation before retiring the old pending marker.
        await persistHistory(next)
        current.current = next
        setSessions(next)
        localStorage.setItem(
          pendingKey,
          encodeStudioPending({
            id: legacy.pending.id,
            request: legacy.pending.request,
            profileId: legacy.pending.profileId,
            input: legacy.pending.start,
            reads: legacy.pending.reads,
            repairs: legacy.pending.repairs,
            paths: legacy.pending.paths,
          }),
        )
        localStorage.removeItem(pendingSourceApplyKey)
        setActiveId(legacy.session.id)
      }
      const stored = localStorage.getItem(pendingKey)
      const pending = readStudioPending(stored)
      if (!pending) {
        if (stored) localStorage.removeItem(pendingKey)
        return
      }
      const state = await api!.sourceCode.get()
      if (disposed) return
      localStorage.removeItem(pendingKey)
      if (state.enabled || !state.error) return
      const session = current.current.find((item) => item.id === pending.id)
      if (
        !session ||
        session.thread.profileId !== pending.profileId ||
        session.thread.provider !== pending.input.provider
      )
        return
      setActiveId(session.id)
      receipt(session.id, 'Startup recovered', state.error)
      const run: StudioRun = {
        request: pending.request,
        profileId: pending.profileId,
        input: { ...pending.input, remoteId: session.thread.remoteId },
        reads: pending.reads || 0,
        repairs: pending.repairs || 0,
        parts: new Map(),
        finishing: true,
        autoApply: true,
      }
      runs.current.set(session.id, run)
      latest.current = { ...latest.current, connection: await api!.connection.state() }
      if (!(await repair(session.id, run, state.error)))
        finish(
          session.id,
          'failed',
          `${state.error}\nLife restored the working interface. Reconnect the machine and continue this Studio conversation to repair the change.`,
        )
    })().catch((error) => {
      if (!disposed) setFeedback(errorText(error))
    })
    return () => {
      disposed = true
    }
  }, [recoverySupport?.mode])

  async function submit(request: string) {
    const selected = active
      ? current.current.find((session) => session.id === active.id)
      : undefined
    if (!selected || selected.thread.busy || runs.current.has(selected.id)) return false
    if (
      !nativeRecoveryReady ||
      options.documentRecoveryReady === false ||
      supportBlocksMutation() ||
      nativeRecoveryBlocksMutation(selected.thread)
    ) {
      setFeedback(supportMessage())
      return false
    }
    if (request.length > maximumStudioRequestCharacters) {
      setFeedback(
        'This request exceeds the 1,000,000-character limit. Shorten it to send; your exact draft stays available to edit or export.',
      )
      return false
    }
    if (!request.trim()) return false
    setFeedback('')
    setNotice('')
    const id = selected.id
    const turn = selected.thread.turn + 1
    const localPatch = planLocalCustomization(request, latest.current.config)
    const previousRun = runs.current.get(id)
    if (
      previousRun?.recovery?.phase === 'review' &&
      usesDurableRecovery() &&
      api?.agent.updateRecoveryOwner
    ) {
      try {
        await persistPlannerSnapshot(
          id,
          previousRun,
          parseStudioPlannerRecovery({
            ...capturePlanner(id, previousRun, 'finished'),
            terminal: { stage: 'complete', discarded: true, finishedAt: Date.now() },
          }),
        )
        if (runs.current.get(id) !== previousRun) return false
        runs.current.delete(id)
      } catch (error) {
        pauseNativePlanner(id, errorText(error))
        return false
      }
    }
    const state = latest.current.connection
    if (
      !localPatch &&
      selected.thread.remoteId &&
      selected.thread.profileId !== state.profile?.id
    ) {
      setFeedback(
        selected.thread.profileId
          ? 'This customization conversation belongs to a different machine. Reconnect that environment or create a new customization.'
          : 'The original machine for this customization conversation is unknown. Create a new customization to run an agent; the recovered history remains available to export.',
      )
      return false
    }
    if (!localPatch && (!api || state.status !== 'connected' || !state.profile)) {
      setFeedback(
        api
          ? 'Connect a machine with Codex or Claude Code to customize Life. A project selection is not required.'
          : 'Open Life to run a customization agent. Simple settings requests work offline.',
      )
      return false
    }
    mutate(id, (session) =>
      resetStudioSessionRequests({
        ...session,
        request,
        proposal: undefined,
        changes: [],
        stage: 'planning',
        updatedAt: Date.now(),
        thread: {
          ...session.thread,
          turn,
          busy: true,
          pending: [],
          profileId: localPatch ? session.thread.profileId : state.profile?.id || '',
          messages: [
            ...session.thread.messages,
            { id: crypto.randomUUID(), role: 'user', text: request, turn, createdAt: Date.now() },
          ],
        },
      }),
    )
    if (localPatch) {
      const proposal: StudioProposal = {
        kind: 'settings',
        patch: localPatch,
        message: 'This exact settings request can be applied locally.',
      }
      mutate(id, (session) => ({ ...session, proposal, stage: 'review' }))
      if (autoApply) await apply(id, proposal)
      else mutate(id, (session) => ({ ...session, thread: { ...session.thread, busy: false } }))
      return true
    }
    const run: StudioRun = {
      request,
      profileId: state.profile!.id,
      parts: new Map(),
      reads: 0,
      repairs: 0,
      finishing: false,
      autoApply,
      input: {
        sessionId: id,
        localTurn: turn,
        scope: 'life-customization',
        provider: selected.thread.provider,
        remoteId: selected.thread.remoteId,
        prompt: request,
        model: selected.thread.model || undefined,
        reasoningEffort: selected.thread.reasoningEffort || undefined,
        serviceTier: selected.thread.serviceTier || undefined,
        mode: 'plan',
      },
    }
    runs.current.set(id, run)
    try {
      if (
        usesDurableRecovery() &&
        api!.agent.reserveRecoveryOwner &&
        api!.agent.performRecoveryAction
      ) {
        const action: StudioPlannerAction = {
          id: crypto.randomUUID(),
          iteration: 0,
          kind: 'read-source',
          status: 'intended',
          intent: { purpose: 'initial' },
        }
        run.recovery = parseStudioPlannerRecovery({
          ...capturePlanner(id, run, 'preparing'),
          nativeIteration: 0,
          action,
        })
        const owner = await api!.agent.reserveRecoveryOwner({
          input: run.recovery.input,
          clientRecovery: run.recovery,
        })
        if (runs.current.get(id) !== run) return true
        const reservedThread = current.current.find((session) => session.id === id)?.thread
        if (
          owner.originalInput?.workspace &&
          reservedThread?.workspace !== undefined &&
          reservedThread.workspace !== owner.originalInput.workspace
        )
          throw new StudioRecoveryPending(
            'The saved Studio workspace differs from its verified native owner. The request is preserved while Life reconciles its original scope.',
          )
        recoveredNativeOwners.current.set(id, owner)
        run.ownerGeneration = owner.ownerGeneration
        run.partsCursor = { transportId: owner.transportId, throughEventRevision: 0 }
        mutate(id, (session) => ({
          ...session,
          thread: {
            ...applyNativeRecoveryOwner(bindNativeStudioWorkspace(session.thread, owner), owner),
            busy: true,
          },
        }))
        const receipt = await performPlannerAction(id, run, action, 'preparing')
        if (!('source' in receipt))
          throw new StudioRecoveryPending(
            'The initial native source read is missing its exact context receipt.',
          )
        run.source = receipt.source
      } else run.source = await api!.sourceCode.getContext()
      if (runs.current.get(id) !== run) return true
      await send(id, run)
    } catch (error) {
      if (runs.current.get(id) === run) {
        if (error instanceof StudioRecoveryPending) pauseNativePlanner(id, errorText(error))
        else await finish(id, 'failed', errorText(error))
      }
    }
    return true
  }

  async function stop() {
    if (!active) return
    if (
      !nativeRecoveryReady ||
      supportBlocksMutation() ||
      nativeRecoveryBlocksMutation(active.thread)
    )
      return
    const run = runs.current.get(active.id)
    if (run?.finishing) return
    if (run) run.stopRequested = true
    try {
      await api?.agent.stop(active.id)
    } catch (error) {
      setFeedback(errorText(error))
      if (run && usesDurableRecovery())
        pauseNativePlanner(
          active.id,
          `The native Stop request is being reconciled. ${errorText(error)}`,
        )
      if (usesDurableRecovery()) return
    }
    await finish(active.id, 'interrupted')
  }

  function newSession(provider = latest.current.config.defaultProvider) {
    if (supportBlocksMutation()) return
    const session = createStudioSession(provider)
    const next = [session, ...current.current]
    current.current = next
    setSessions(next)
    setActiveId(session.id)
    setFeedback('')
    try {
      persistHistory(next)
    } catch {
      setFeedback(historyOwner.current.storageError || 'Studio history storage is full.')
    }
  }

  async function updateThread(
    patch: Partial<Pick<Thread, 'provider' | 'model' | 'reasoningEffort' | 'serviceTier'>>,
  ) {
    if (!active) return
    if (
      !nativeRecoveryReady ||
      supportBlocksMutation() ||
      nativeRecoveryBlocksMutation(active.thread)
    ) {
      setFeedback(supportMessage())
      return
    }
    if (
      patch.provider !== undefined &&
      patch.provider !== active.thread.provider &&
      (active.thread.remoteId || runs.current.has(active.id))
    ) {
      setFeedback(
        'This conversation belongs to its original agent. Create a new customization to use another provider.',
      )
      return
    }
    mutate(active.id, (session) => ({ ...session, thread: { ...session.thread, ...patch } }))
    const run = runs.current.get(active.id)
    if (run) Object.assign(run.input, patch)
    if (api && run && active.thread.busy && !run.finishing) {
      try {
        const result = await api.agent.configure({
          sessionId: active.id,
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.reasoningEffort !== undefined
            ? { reasoningEffort: patch.reasoningEffort }
            : {}),
          ...(patch.serviceTier !== undefined ? { serviceTier: patch.serviceTier } : {}),
        })
        if (result.note) setNotice(result.note)
      } catch (error) {
        setFeedback(errorText(error))
      }
    }
  }

  function rename(id: string, title: string) {
    if (supportBlocksMutation()) return
    if (!title.trim()) return
    mutate(id, (session) => ({
      ...session,
      thread: { ...session.thread, title: title.trim().slice(0, 160) },
    }))
  }

  function remove(id: string) {
    if (supportBlocksMutation()) return
    if (current.current.find((session) => session.id === id)?.thread.busy) return
    runs.current.delete(id)
    void api?.agent.dispose(id).catch((error) => setFeedback(errorText(error)))
    let next = current.current.filter((session) => session.id !== id)
    if (!next.length) next = [createStudioSession(latest.current.config.defaultProvider)]
    current.current = next
    setSessions(next)
    if (active?.id === id) setActiveId(next[0].id)
    try {
      persistHistory(next)
    } catch {
      setFeedback(
        historyOwner.current.storageError ||
          'The conversation could not be removed from local storage.',
      )
    }
  }

  return {
    sessions,
    active,
    canSubmit: Boolean(
      active &&
      !active.thread.busy &&
      !runs.current.has(active.id) &&
      nativeRecoveryReady &&
      options.documentRecoveryReady !== false &&
      !supportBlocksMutation() &&
      !nativeRecoveryBlocksMutation(active.thread),
    ),
    models,
    feedback,
    notice,
    autoApply,
    setAutoApply,
    setActiveId,
    newSession,
    submit,
    stop,
    updateThread,
    rename,
    remove,
    registerSession: (id: string) => {
      const session = current.current.find((candidate) => candidate.id === id)
      if (!session || historyOwner.current.hasSession(session)) return
      if (supportBlocksMutation() || recoveryInFlight.current) {
        pendingSessionRegistrations.current.add(id)
        return
      }
      try {
        persistHistory(current.current)
      } catch {
        setFeedback(
          historyOwner.current.storageError ||
            'Studio history could not be saved. Export this conversation before closing Life.',
        )
      }
    },
    exportSession: () => (active ? historyOwner.current.projectSession(active) : undefined),
    applyProposal: async () => {
      if (!active?.proposal) return
      if (
        !nativeRecoveryReady ||
        supportBlocksMutation() ||
        nativeRecoveryBlocksMutation(active.thread)
      )
        throw new Error('Life must verify the native Studio owner before applying this proposal.')
      const run = runs.current.get(active.id)
      if (run?.recovery?.action && ['intended', 'started'].includes(run.recovery.action.status))
        throw new Error(
          'Life must reconcile the previous native Studio action before applying this proposal.',
        )
      await apply(active.id, active.proposal, run)
    },
    discardProposal: async () => {
      if (active) {
        if (
          !nativeRecoveryReady ||
          supportBlocksMutation() ||
          nativeRecoveryBlocksMutation(active.thread)
        )
          throw new Error(
            'Life must verify the native Studio owner before discarding this proposal.',
          )
        const run = runs.current.get(active.id)
        if (run && usesDurableRecovery() && api?.agent.updateRecoveryOwner) {
          await persistPlannerSnapshot(
            active.id,
            run,
            parseStudioPlannerRecovery({
              ...capturePlanner(active.id, run, 'finished'),
              terminal: { stage: 'complete', discarded: true },
            }),
          )
        }
        runs.current.delete(active.id)
        mutate(active.id, (session) => ({
          ...session,
          proposal: undefined,
          stage: 'complete',
          thread: { ...session.thread, busy: false },
        }))
      }
    },
    respond: async (
      event: AgentEvent,
      accepted: boolean,
      answers?: Record<string, string[]>,
      decisionId?: string,
    ) => {
      if (!api || !active || !event.requestId)
        throw new Error('This request is no longer available.')
      if (
        !nativeRecoveryReady ||
        supportBlocksMutation() ||
        nativeRecoveryBlocksMutation(active.thread)
      )
        throw new Error(
          'Life must verify the original native Studio owner before answering this request.',
        )
      if (
        event.sessionId !== active.id ||
        !current.current
          .find((session) => session.id === active.id)
          ?.thread.pending.some((request) => request.requestId === event.requestId)
      )
        throw new Error('This request is no longer pending.')
      await api.agent.respond(active.id, event.requestId, accepted, answers, decisionId)
      const choice = event.approvalChoices?.find((choice) => choice.id === decisionId)
      mutate(active.id, (session) => ({
        ...session,
        thread: resolveAgentRequest(
          session.thread,
          event.requestId!,
          accepted,
          answers,
          Date.now(),
          choice,
        ),
      }))
    },
  }
}
