import { useCallback, useEffect, useRef, useState } from 'react'
import type { LifeConfig, LifeConfigPatch } from '../shared/customization'
import type { LifeExtensionsSnapshot } from '../shared/extensions'
import type { LifeSourceContext, LifeSourceSnapshot } from '../shared/source-code'
import type {
  AgentEvent,
  ConnectionState,
  ModelOption,
  Provider,
  StartInput,
} from '../shared/types'
import { api, errorText } from './api'
import { planLocalCustomization } from './customization'
import {
  extractLifeThreadResponse,
  maximumLifeRepairAttempts,
  maximumLifeSourceReads,
} from './life-thread'
import { fallbackModelCatalog } from './model-catalog'
import { applyEvent, finishThreadTurn, type Thread } from './state'
import { buildStudioInstructions } from './studio-instructions'
import {
  STUDIO_HISTORY_KEY,
  createStudioSession,
  encodeStudioSessions,
  migrateLegacyStudioPending,
  readStudioSessions,
  type StudioProposal,
  type StudioSession,
} from './studio-history'
import { pendingSourceApplyKey } from './source-session'
import { readThreads } from './state'
import {
  STUDIO_PENDING_KEY as pendingKey,
  encodeStudioPending,
  readStudioPending,
} from './studio-pending'

const activeKey = 'life.studio.active.v1'
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
}

export interface StudioOptions {
  connection: ConnectionState
  config: LifeConfig
  extensions: LifeExtensionsSnapshot
  source: LifeSourceSnapshot
  applySettings: (patch: LifeConfigPatch) => Promise<void>
  onNotify?: (message: string) => void
}

function initialSessions(provider: Provider): StudioSession[] {
  const saved = readStudioSessions()
  return saved.length ? saved : [createStudioSession(provider)]
}

export function useCustomizationStudio(options: StudioOptions) {
  const [sessions, setSessions] = useState(() => initialSessions(options.config.defaultProvider))
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem(activeKey) || ''
    } catch {
      return ''
    }
  })
  const [models, setModels] = useState<ModelOption[]>([])
  const [feedback, setFeedback] = useState('')
  const [notice, setNotice] = useState('')
  const [autoApply, setAutoApply] = useState(true)
  const current = useRef(sessions)
  const latest = useRef(options)
  const runs = useRef(new Map<string, StudioRun>())
  const historyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const finishRef = useRef<(id: string, run: StudioRun) => Promise<void>>(async () => {})
  current.current = sessions
  latest.current = options
  const active = sessions.find((session) => session.id === activeId) || sessions[0]

  const mutate = useCallback((id: string, change: (session: StudioSession) => StudioSession) => {
    if (!alive.current) return
    const next = current.current.map((session) => (session.id === id ? change(session) : session))
    current.current = next
    setSessions(next)
    clearTimeout(historyTimer.current)
    historyTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STUDIO_HISTORY_KEY, encodeStudioSessions(current.current))
      } catch {
        if (alive.current)
          setFeedback(
            'Studio history storage is full. Export older conversations before removing them.',
          )
      }
    }, 300)
  }, [])

  function receipt(id: string, title: string, text: string, status = 'completed') {
    mutate(id, (session) => ({
      ...session,
      updatedAt: Date.now(),
      thread: {
        ...session.thread,
        messages: [
          ...session.thread.messages,
          {
            id: `studio:${crypto.randomUUID()}`,
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
  }

  function finish(id: string, stage: StudioSession['stage'], error?: string) {
    runs.current.delete(id)
    const status =
      error || stage === 'failed' ? 'failed' : stage === 'interrupted' ? 'interrupted' : 'completed'
    mutate(id, (session) => {
      const finished = finishThreadTurn(session.thread, status)
      return {
        ...session,
        stage,
        updatedAt: Date.now(),
        thread: {
          ...finished,
          busy: false,
          pending: finished.pending.filter((request) => Boolean(request.agentId)),
          messages: error
            ? [
                ...finished.messages,
                {
                  id: crypto.randomUUID(),
                  role: 'error',
                  text: error,
                  turn: session.thread.turn,
                },
              ]
            : finished.messages,
        },
      }
    })
    if (error) setFeedback(error)
  }

  async function send(
    id: string,
    run: StudioRun,
    extra: {
      sourceRead?: { paths: string[] }
      repair?: { attempt: number; diagnostics: string }
    } = {},
  ) {
    if (!api || runs.current.get(id) !== run) return
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
    run.finishing = false
    run.input.remoteId = session.thread.remoteId || run.input.remoteId
    await api.agent.start({
      ...run.input,
      prompt: run.request,
      mode: 'plan',
      scope: 'life-customization',
      studioContext: context,
    })
  }

  async function repair(id: string, run: StudioRun, diagnostics: string): Promise<boolean> {
    if (!api || runs.current.get(id) !== run || run.repairs >= maximumLifeRepairAttempts)
      return false
    if (
      latest.current.connection.status !== 'connected' ||
      latest.current.connection.profile?.id !== run.profileId
    )
      return false
    run.repairs++
    const index = await api.sourceCode.getContext()
    const session = current.current.find((item) => item.id === id)
    const proposed =
      session?.proposal?.kind === 'source'
        ? session.proposal.patch.files.map((file) => file.path)
        : []
    const paths = [...new Set([...proposed, ...(run.source?.files.map((file) => file.path) || [])])]
      .filter((path) => index.paths.includes(path))
      .slice(0, 30)
    run.source = paths.length ? await api.sourceCode.getContext({ paths }) : index
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
    mutate(id, (session) => ({
      ...session,
      stage: 'applying',
      thread: { ...session.thread, busy: true },
    }))
    if (run) run.finishing = true
    try {
      if (proposal.kind === 'settings') {
        await latest.current.applySettings(proposal.patch)
        receipt(id, 'Settings applied', Object.keys(proposal.patch).join('\n'))
      } else if (proposal.kind === 'extension') {
        if (!api) throw new Error('Runtime extensions require the Life desktop application.')
        const state = await api.extensions.apply(proposal.manifest)
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
        const state = await api.sourceCode.apply(proposal.patch)
        if (state.error || !state.enabled || !state.active)
          throw new Error(state.error || 'The source extension did not activate.')
        receipt(id, 'Source build passed', proposal.patch.summary)
        mutate(id, (session) => ({
          ...session,
          changes: proposal.patch.files.map((file) => file.path),
        }))
        mutate(id, (session) => ({
          ...session,
          stage: 'complete',
          thread: { ...finishThreadTurn(session.thread, 'completed'), busy: false, pending: [] },
        }))
        if (run) {
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
        localStorage.setItem(STUDIO_HISTORY_KEY, encodeStudioSessions(current.current))
        await api.sourceCode.reload()
        runs.current.delete(id)
        return
      }
      finish(id, 'complete')
      latest.current.onNotify?.('Life customization applied.')
    } catch (error) {
      const detail = errorText(error)
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
      if (response.kind === 'source-read') {
        if (!api) throw new Error('Life source reads require the desktop application.')
        if (run.reads >= maximumLifeSourceReads)
          throw new Error(
            'Six source reads completed. Continue with a more focused request; the full conversation is saved.',
          )
        run.reads++
        receipt(
          id,
          `Reading source ${run.reads} of ${maximumLifeSourceReads}`,
          response.read.paths.join('\n'),
          'running',
        )
        run.source = await api.sourceCode.getContext(response.read)
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
        finish(id, 'complete')
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
        run.finishing = false
        mutate(id, (session) => ({ ...session, thread: { ...session.thread, busy: false } }))
      }
    } catch (error) {
      const detail = errorText(error)
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
    const off = api?.onAgent((event: AgentEvent) => {
      if (!current.current.some((session) => session.id === event.sessionId)) return
      const run = runs.current.get(event.sessionId)
      const ownsPlanner = Boolean(run && !run.finishing)
      const completed =
        ownsPlanner &&
        !event.agentId &&
        event.type === 'complete' &&
        (event.status === 'completed' || !event.status)
      // Provider output and child lifecycles outlive the parent's proposal. Keep all
      // known-session content while reserving root completion for the owning planner.
      mutate(event.sessionId, (session) => {
        const applied = applyEvent(session.thread, event)
        if (
          !ownsPlanner &&
          !event.agentId &&
          ['complete', 'error', 'status'].includes(event.type)
        ) {
          const previous = new Map(session.thread.messages.map((message) => [message.id, message]))
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
        return {
          ...session,
          updatedAt: Date.now(),
          thread: { ...applied, ...(completed ? { busy: true } : {}) },
        }
      })
      if (!run || !ownsPlanner) return
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
    })
    return () => {
      alive.current = false
      off?.()
    }
  }, [mutate])

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
    if (api && options.connection.status === 'connected')
      void api.agent
        .models(active.thread.provider)
        .then((next) => {
          if (!disposed && next.length) setModels(next)
        })
        .catch(() => {})
    return () => {
      disposed = true
    }
  }, [active?.thread.provider, options.connection.status, options.connection.profile?.id])

  useEffect(() => {
    if (!api) return
    let disposed = false
    void (async () => {
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
        localStorage.setItem(STUDIO_HISTORY_KEY, encodeStudioSessions(next))
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
  }, [])

  async function submit(request: string) {
    if (!active || active.thread.busy || !request.trim()) return false
    setFeedback('')
    setNotice('')
    const id = active.id
    const turn = active.thread.turn + 1
    const localPatch = planLocalCustomization(request, latest.current.config)
    const state = latest.current.connection
    if (
      !localPatch &&
      active.thread.remoteId &&
      active.thread.profileId &&
      active.thread.profileId !== state.profile?.id
    ) {
      setFeedback(
        'This customization conversation belongs to a different machine. Reconnect that environment or create a new customization.',
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
    mutate(id, (session) => ({
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
    }))
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
        provider: active.thread.provider,
        remoteId: active.thread.remoteId,
        prompt: request,
        model: active.thread.model || undefined,
        reasoningEffort: active.thread.reasoningEffort || undefined,
        serviceTier: active.thread.serviceTier || undefined,
        mode: 'plan',
      },
    }
    runs.current.set(id, run)
    try {
      run.source = await api!.sourceCode.getContext()
      if (runs.current.get(id) !== run) return true
      await send(id, run)
    } catch (error) {
      if (runs.current.get(id) === run) finish(id, 'failed', errorText(error))
    }
    return true
  }

  async function stop() {
    if (!active) return
    const run = runs.current.get(active.id)
    if (run?.finishing) return
    runs.current.delete(active.id)
    try {
      await api?.agent.stop(active.id)
    } catch (error) {
      setFeedback(errorText(error))
    }
    finish(active.id, 'interrupted')
  }

  function newSession(provider = latest.current.config.defaultProvider) {
    const session = createStudioSession(provider)
    const next = [session, ...current.current]
    current.current = next
    setSessions(next)
    setActiveId(session.id)
    setFeedback('')
    try {
      localStorage.setItem(STUDIO_HISTORY_KEY, encodeStudioSessions(next))
    } catch {
      setFeedback('Studio history storage is full.')
    }
  }

  async function updateThread(
    patch: Partial<Pick<Thread, 'provider' | 'model' | 'reasoningEffort' | 'serviceTier'>>,
  ) {
    if (!active) return
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
    if (!title.trim()) return
    mutate(id, (session) => ({
      ...session,
      thread: { ...session.thread, title: title.trim().slice(0, 160) },
    }))
  }

  function remove(id: string) {
    if (current.current.find((session) => session.id === id)?.thread.busy) return
    runs.current.delete(id)
    void api?.agent.dispose(id).catch((error) => setFeedback(errorText(error)))
    let next = current.current.filter((session) => session.id !== id)
    if (!next.length) next = [createStudioSession(latest.current.config.defaultProvider)]
    current.current = next
    setSessions(next)
    if (active?.id === id) setActiveId(next[0].id)
    try {
      localStorage.setItem(STUDIO_HISTORY_KEY, encodeStudioSessions(next))
    } catch {
      setFeedback('The conversation could not be removed from local storage.')
    }
  }

  return {
    sessions,
    active,
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
    applyProposal: () =>
      active?.proposal
        ? apply(active.id, active.proposal, runs.current.get(active.id))
        : Promise.resolve(),
    discardProposal: () => {
      if (active) {
        runs.current.delete(active.id)
        mutate(active.id, (session) => ({
          ...session,
          proposal: undefined,
          stage: 'complete',
          thread: { ...session.thread, busy: false },
        }))
      }
    },
    respond: async (event: AgentEvent, accepted: boolean, answers?: Record<string, string[]>) => {
      if (!api || !active || !event.requestId) return
      await api.agent.respond(active.id, event.requestId, accepted, answers)
      mutate(active.id, (session) => ({
        ...session,
        thread: {
          ...session.thread,
          pending: session.thread.pending.filter((item) => item.requestId !== event.requestId),
        },
      }))
    },
  }
}
