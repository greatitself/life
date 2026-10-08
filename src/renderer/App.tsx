import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  Computer,
  Ellipsis,
  Folder,
  Gauge,
  GitPullRequest,
  Keyboard,
  Network,
  LoaderCircle,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Unplug,
  X,
} from 'lucide-react'
import type {
  AgentEvent,
  ConnectionProfile,
  ConnectionState,
  HostKeyRequest,
  ModelOption,
  PermissionMode,
  Provider,
  StartInput,
} from '../shared/types'
import type { LifeSourceContext } from '../shared/source-code'
import { api, desktop, errorText } from './api'
import {
  applyEvent,
  bindLegacyThreadWorkspace,
  normalizeModelChoices,
  readThreads,
  type Thread,
} from './state'
import { fallbackModelCatalog, withProviderDefault } from './model-catalog'
import { RelayMark, ProviderIcon } from './components/Icons'
import { Modal } from './components/Modal'
import { ConnectionDialog } from './components/ConnectionDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { MessageView, ApprovalCard } from './components/MessageView'
import { WorkspacePanel } from './components/WorkspacePanel'
import { RemoteTerminal } from './components/RemoteTerminal'
import { TitleBar } from './components/TitleBar'
import { ResearchView } from './components/ResearchView'
import { CustomizationDialog } from './components/CustomizationDialog'
import { CustomPanels } from './components/CustomPanels'
import { useLifeConfig } from './useLifeConfig'
import { UpdateDialog } from './components/UpdateDialog'
import type { UpdateState } from '../shared/updates'
import { ExtensionDialog } from './components/ExtensionDialog'
import { ExtensionHost } from './components/ExtensionHost'
import { useExtensions } from './useExtensions'
import { useSourceCode } from './useSourceCode'
import { SourceCodeDialog } from './components/SourceCodeDialog'
import { SidebarThread } from './components/SidebarThread'
import { readProjects } from './research'
import { LIFE_VERSION } from '../shared/version'
import { PortForwardDialog } from './components/PortForwardDialog'
import { planLocalCustomization } from './customization'
import {
  buildLifeThreadPrompt,
  detectLifeIntent,
  extractLifeThreadResponse,
  maximumLifeRepairAttempts,
  maximumLifeSourceReads,
  stripLifeIntent,
  type LifeThreadPromptOptions,
} from './life-thread'
import {
  encodePendingSourceApply,
  loadPendingSourceApply,
  pendingSourceApplyKey,
} from './source-session'
import './enhancements.css'

interface LifeTurn {
  turn: number
  parts: Map<string, string>
  finishing: boolean
  request: string
  profileId: string
  start?: StartInput
  reads: number
  repairs: number
  source?: LifeSourceContext
  paths?: string[]
}

const providerName = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude Code')
const effortName = (effort: string) =>
  effort === 'xhigh'
    ? 'Extra high'
    : effort.replace(
        /(^|[_-])([a-z])/g,
        (_, separator, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`,
      )
const shortcutModifier = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'
const starterPrompts = [
  {
    icon: Code2,
    title: 'Explore a codebase',
    subtitle: 'Find your way around a project',
    prompt:
      'Explore this codebase and explain its architecture, main entry points, and how to run it.',
  },
  {
    icon: Sparkles,
    title: 'Build something',
    subtitle: 'Turn an idea into working code',
    prompt:
      'Help me build a new feature in this project. First look at the existing code and ask me what I want to create.',
  },
  {
    icon: GitPullRequest,
    title: 'Review changes',
    subtitle: 'A second set of eyes on your work',
    prompt:
      'Review the current Git changes for bugs, regressions, and missing edge cases. Explain each finding with file references.',
  },
]

export function App() {
  const preferences = useLifeConfig()
  const { config } = preferences
  const [view, setView] = useState<'research' | 'workspace' | 'extension'>(config.startView)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const extensions = useExtensions()
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [sourceCodeOpen, setSourceCodeOpen] = useState(false)
  const sourceUI = useSourceCode()
  const [selectedExtension, setSelectedExtension] = useState<string>()
  const [extensionRecovery, setExtensionRecovery] = useState(false)
  const enabledExtensions = extensions.extensions.filter((extension) => extension.enabled)
  const replacement = !extensionRecovery
    ? enabledExtensions.find((extension) => extension.renderer.placement === 'replace')
    : undefined
  const selectedView = enabledExtensions.find(
    (extension) => extension.id === selectedExtension && extension.renderer.placement === 'view',
  )
  const extensionPanels = enabledExtensions.filter(
    (extension) => extension.renderer.placement === 'panel',
  )
  useEffect(() => {
    const styles = enabledExtensions
      .filter((extension) => extension.hostCSS)
      .map((extension) => {
        const style = document.createElement('style')
        style.dataset.lifeExtension = extension.id
        style.textContent = extension.hostCSS || ''
        document.head.appendChild(style)
        return style
      })
    return () => styles.forEach((style) => style.remove())
  }, [extensions])
  const [maximized, setMaximized] = useState(false)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [portsOpen, setPortsOpen] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'unsupported',
    currentVersion: LIFE_VERSION,
    message: 'Updates are available in the installed desktop app.',
  })
  const platform =
    api?.platform ||
    (/Mac/i.test(navigator.platform)
      ? 'darwin'
      : /Win/i.test(navigator.platform)
        ? 'win32'
        : 'linux')
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [connection, setConnection] = useState<ConnectionState>({ status: 'disconnected' })
  const [threads, setThreads] = useState<Thread[]>(readThreads)
  const threadsCurrent = useRef(threads)
  threadsCurrent.current = threads
  const [activeId, setActiveId] = useState<string>()
  const [provider, setProvider] = useState<Provider>(config.defaultProvider)
  const [model, setModel] = useState(config.defaultModel)
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [serviceTier, setServiceTier] = useState('')
  const [mode, setMode] = useState<PermissionMode>(config.defaultMode)
  const [models, setModels] = useState<ModelOption[]>([{ id: '', name: 'Agent default' }])
  const modelCatalogs = useRef(new Map<string, ModelOption[]>())
  const [draft, setDraft] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [suggestedProject, setSuggestedProject] = useState<string>()
  const [requestedProfileId, setRequestedProfileId] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hostKey, setHostKey] = useState<HostKeyRequest>()
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => config.workspacePanel && window.innerWidth > 1080,
  )
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 600)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState('')
  const [threadMenu, setThreadMenu] = useState(false)
  const [stickToBottom, setStickToBottom] = useState(true)
  const conversation = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef<{ id?: string } | undefined>(undefined)
  const lifeTurns = useRef(new Map<string, LifeTurn>())
  const lifeContext = useRef({ preferences, config, extensions, connection })
  lifeContext.current = { preferences, config, extensions, connection }
  const restoredSourceApply = useRef(false)
  const active = threads.find((t) => t.id === activeId)
  const currentProvider = active?.provider || provider
  const currentModel = active?.model ?? model
  const currentReasoningEffort = active ? (active.reasoningEffort ?? '') : reasoningEffort
  const currentServiceTier = active ? (active.serviceTier ?? '') : serviceTier
  const currentModelOption = models.find((option) => option.id === currentModel)
  const effortOptions = currentModelOption?.supportedReasoningEfforts || []
  const tierOptions = currentModelOption?.serviceTiers || []
  const currentMode = active?.mode || mode
  const connected = connection.status === 'connected'
  const projectReady = connected && Boolean(connection.workspace)
  const busy = active?.busy || false
  const applyingLife = active ? lifeTurns.current.get(active.id)?.finishing === true : false
  const projectIntent = /^\s*(?:\/project|@project)(?:\s|$)/i.test(draft)
  const lifeIntent = !projectIntent && (detectLifeIntent(draft) || active?.lifeScope === true)
  const refreshProfiles = useCallback(() => {
    void api?.profiles
      .list()
      .then(setProfiles)
      .catch((e) => setToast(errorText(e)))
  }, [])

  useEffect(() => {
    if (!api) return
    return api.extensions.onRecovery(() => {
      setExtensionRecovery(true)
      setView('research')
      setExtensionsOpen(true)
    })
  }, [])
  useEffect(() => {
    if (view === 'extension' && !selectedView) setView('research')
  }, [view, selectedView])
  useEffect(() => {
    if (!api) return
    void api.updates.get().then(setUpdateState)
    return api.updates.onState(setUpdateState)
  }, [])
  useEffect(() => {
    setView(config.startView)
  }, [config.startView])
  useEffect(() => {
    setProvider(config.defaultProvider)
    setModel(config.defaultModel)
    setReasoningEffort('')
    setServiceTier('')
    setMode(config.defaultMode)
  }, [config.defaultProvider, config.defaultModel, config.defaultMode])
  useEffect(() => {
    setWorkspaceOpen(config.workspacePanel && window.innerWidth > 1080)
  }, [config.workspacePanel])
  useEffect(() => {
    if (!api) return
    void api.window.state().then(setMaximized)
    return api.window.onState(setMaximized)
  }, [])

  useEffect(() => {
    refreshProfiles()
    if (!api) return
    const updateConnection = (state: ConnectionState) => {
      lifeContext.current.connection = state
      setConnection(state)
      if (state.status === 'connected')
        setThreads((previous) => previous.map((thread) => bindLegacyThreadWorkspace(thread, state)))
      if (state.status === 'disconnected') {
        setTerminalOpen(false)
        const interrupted = new Set<string>()
        for (const [id, turn] of lifeTurns.current) {
          // Once a validated local mutation starts, disconnecting its remote
          // provider cannot cancel it. Keep its eventual result in the thread.
          if (!turn.finishing) {
            interrupted.add(id)
            lifeTurns.current.delete(id)
          }
        }
        setThreads((previous) =>
          previous.map((thread) =>
            interrupted.has(thread.id) ? { ...thread, busy: false, pending: [] } : thread,
          ),
        )
      }
    }
    void api.connection.state().then(updateConnection)
    const offConnection = api.onConnection(updateConnection)
    const offHost = api.onHostKey(setHostKey)
    const offAgent = api.onAgent((event) => {
      const lifeTurn = lifeTurns.current.get(event.sessionId)
      // The completed provider turn has handed over to a local atomic write.
      // Late provider events cannot cancel or replace that result.
      if (lifeTurn?.finishing) return
      if (lifeTurn?.start && event.type === 'session' && event.remoteId)
        lifeTurn.start.remoteId = event.remoteId
      if (lifeTurn && event.type === 'text') {
        const key = event.itemId || 'response'
        lifeTurn.parts.set(
          key,
          event.status === 'replace'
            ? event.text || ''
            : (lifeTurn.parts.get(key) || '') + (event.text || ''),
        )
      }
      const applyLife =
        lifeTurn &&
        event.type === 'complete' &&
        event.status !== 'interrupted' &&
        !lifeTurn.finishing
      if (lifeTurn && (event.type === 'error' || event.status === 'interrupted'))
        lifeTurns.current.delete(event.sessionId)
      if (applyLife) lifeTurn.finishing = true
      setThreads((previous) =>
        previous.map((t) => {
          if (t.id !== event.sessionId) return t
          const next = applyEvent(t, event)
          return applyLife ? { ...next, busy: true } : next
        }),
      )
      if (applyLife) void finishLifeTurn(event.sessionId, lifeTurn)
      if (event.type === 'complete') setRefreshKey((key) => key + 1)
    })
    return () => {
      offConnection()
      offHost()
      offAgent()
    }
  }, [refreshProfiles])

  function completeLifeTurn(
    id: string,
    lifeTurn: LifeTurn,
    message: string,
    failure?: string,
    synchronous = false,
  ) {
    lifeTurns.current.delete(id)
    const update = () =>
      setThreads((previous) =>
        previous.map((thread) => {
          if (thread.id !== id || thread.turn !== lifeTurn.turn) return thread
          const messages = thread.messages
            .filter((item) => item.turn !== lifeTurn.turn || item.role !== 'assistant')
            .map((item) =>
              item.role === 'tool' && item.status === 'running'
                ? { ...item, status: failure ? 'failed' : 'completed' }
                : item,
            )
          if (message.trim())
            messages.push({
              id: `${lifeTurn.turn}:life-response`,
              role: 'assistant',
              text: message,
              turn: lifeTurn.turn,
            })
          if (failure)
            messages.push({
              id: `${lifeTurn.turn}:life-error`,
              role: 'error',
              text: failure,
              turn: lifeTurn.turn,
            })
          return { ...thread, messages, busy: false, pending: [] }
        }),
      )
    if (synchronous) flushSync(update)
    else update()
  }

  function persistThreadHistory() {
    localStorage.setItem(
      'relay.threads.v1',
      JSON.stringify(
        threadsCurrent.current.map((thread) => ({ ...thread, pending: [], busy: false })),
      ),
    )
  }

  async function continueLifeTurn(
    id: string,
    lifeTurn: LifeTurn,
    options: LifeThreadPromptOptions,
    title: string,
    detail: string,
  ) {
    if (!api || !lifeTurn.start) throw new Error('The original agent conversation is unavailable.')
    const connection = lifeContext.current.connection
    if (connection.status !== 'connected' || connection.profile?.id !== lifeTurn.profileId)
      throw new Error('Reconnect this thread’s machine to continue the Life change.')
    if (lifeTurns.current.get(id) !== lifeTurn) return
    const prompt = buildLifeThreadPrompt(
      lifeTurn.request,
      lifeContext.current.config,
      lifeContext.current.extensions.extensions,
      api.extensions.capabilities,
      options,
    )
    lifeTurn.source = options.source
    lifeTurn.parts.clear()
    lifeTurn.finishing = false
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === id && thread.turn === lifeTurn.turn
          ? {
              ...thread,
              busy: true,
              pending: [],
              messages: [
                ...thread.messages.filter(
                  (message) => message.turn !== lifeTurn.turn || message.role !== 'assistant',
                ),
                {
                  id: `${lifeTurn.turn}:life-step-${lifeTurn.reads}-${lifeTurn.repairs}`,
                  role: 'tool',
                  title,
                  text: detail,
                  status: 'running',
                  turn: lifeTurn.turn,
                },
              ],
            }
          : thread,
      ),
    )
    try {
      await api.agent.start({ ...lifeTurn.start, prompt, mode: 'plan' })
    } catch (error) {
      if (lifeTurns.current.get(id) === lifeTurn)
        completeLifeTurn(id, lifeTurn, '', errorText(error))
    }
  }

  async function repairLifeTurn(
    id: string,
    lifeTurn: LifeTurn,
    diagnostics: string,
  ): Promise<boolean> {
    if (
      !api ||
      !lifeTurn.start ||
      lifeTurns.current.get(id) !== lifeTurn ||
      lifeTurn.repairs >= maximumLifeRepairAttempts
    )
      return false
    const connection = lifeContext.current.connection
    if (connection.status !== 'connected' || connection.profile?.id !== lifeTurn.profileId)
      return false
    lifeTurn.repairs += 1
    const index = await api.sourceCode.getContext()
    const wanted = lifeTurn.paths || lifeTurn.source?.files.map((file) => file.path) || []
    const paths = [...new Set(wanted)].filter((path) => index.paths.includes(path)).slice(0, 30)
    const missing = wanted.filter((path) => !index.paths.includes(path))
    const selected = paths.length ? await api.sourceCode.getContext({ paths }) : index
    const source: LifeSourceContext = {
      ...selected,
      files: [
        ...selected.files,
        ...(selected.revision === index.revision
          ? index.files.filter((file) => !selected.files.some((item) => item.path === file.path))
          : []),
      ],
    }
    if (missing.length)
      diagnostics += `\nSource paths no longer present in the active workspace: ${missing.join(', ')}. Recreate them if needed by the original request.`
    if (lifeTurns.current.get(id) !== lifeTurn) return true
    await continueLifeTurn(
      id,
      lifeTurn,
      { source, repair: { attempt: lifeTurn.repairs, diagnostics: diagnostics.slice(0, 40_000) } },
      `Repairing Life change (${lifeTurn.repairs}/${maximumLifeRepairAttempts})`,
      diagnostics,
    )
    return true
  }

  async function finishLifeTurn(id: string, lifeTurn: LifeTurn) {
    const current = () => lifeTurns.current.get(id) === lifeTurn
    const response = extractLifeThreadResponse([...lifeTurn.parts.values()].join('\n'))
    let message = response.message
    let failure: string | undefined
    let reload = false
    let changedPaths: string[] = []
    try {
      if (!current()) return
      if (response.kind === 'error') failure = response.error
      else if (response.kind === 'source-read') {
        if (!api) throw new Error('Source customization requires the desktop application.')
        if (lifeTurn.reads >= maximumLifeSourceReads)
          throw new Error(
            'The agent reached the six-read limit. Narrow the change or continue the request in this thread.',
          )
        lifeTurn.reads += 1
        const source = await api.sourceCode.getContext(response.read)
        if (!current()) return
        await continueLifeTurn(
          id,
          lifeTurn,
          { source, sourceRead: response.read },
          `Reading Life source (${lifeTurn.reads}/${maximumLifeSourceReads})`,
          response.read.paths.join('\n'),
        )
        return
      } else if (response.kind === 'settings') {
        await lifeContext.current.preferences.apply(response.patch)
        message = [
          message,
          `Updated Life settings: ${Object.keys(response.patch).join(', ')}. Undo is available in Settings.`,
        ]
          .filter(Boolean)
          .join('\n\n')
      } else if (response.kind === 'extension') {
        if (!api) throw new Error('Live extensions require the desktop application.')
        const state = await api.extensions.apply(response.manifest)
        if (state.errors[response.manifest.id]) throw new Error(state.errors[response.manifest.id])
        const installed = state.extensions.find((item) => item.id === response.manifest.id)
        if (!installed)
          throw new Error(
            'Life could not save the extension. Try again or inspect Manage extensions.',
          )
        message = [
          message,
          installed.enabled
            ? `Installed ${installed.name}. The extension is live; its source and rollback are available in Manage extensions.`
            : `Saved ${installed.name} disabled. Enable it or restore its previous version in Manage extensions.`,
        ]
          .filter(Boolean)
          .join('\n\n')
        if (current() && installed.enabled) setExtensionRecovery(false)
      } else if (response.kind === 'source') {
        if (!api) throw new Error('Source customization requires the desktop application.')
        lifeTurn.paths = [
          ...new Set([
            ...response.patch.files.map((file) => file.path),
            ...(lifeTurn.source?.files.map((file) => file.path) || []),
          ]),
        ].slice(0, 30)
        const state = await api.sourceCode.apply(response.patch)
        if (state.error || !state.enabled || !state.active)
          throw new Error(state.error || 'Life could not activate the compiled source.')
        changedPaths = response.patch.files.map((file) => file.path)
        message = [
          message,
          `Applied source extension: ${response.patch.summary}. Disable, export, or share it in Manage extensions. The compiled interface will reload; your conversation is preserved.`,
        ]
          .filter(Boolean)
          .join('\n\n')
        reload = true
      }
    } catch (error) {
      failure = errorText(error)
    }
    if (!current()) return
    if (failure) {
      try {
        if (await repairLifeTurn(id, lifeTurn, failure)) return
      } catch (error) {
        failure += `\n\nLife could not continue the repair: ${errorText(error)}`
      }
    }
    if (!current()) return
    if (reload && lifeTurn.start) {
      completeLifeTurn(id, lifeTurn, message, undefined, true)
      try {
        persistThreadHistory()
        localStorage.setItem(
          pendingSourceApplyKey,
          encodePendingSourceApply({
            id,
            turn: lifeTurn.turn,
            request: lifeTurn.request,
            profileId: lifeTurn.profileId,
            reads: lifeTurn.reads,
            repairs: lifeTurn.repairs,
            start: lifeTurn.start,
            paths: [
              ...new Set([
                ...changedPaths,
                ...(lifeTurn.source?.files.map((file) => file.path) || []),
              ]),
            ].slice(0, 30),
          }),
        )
        await api!.sourceCode.reload()
      } catch (error) {
        setToast(`Life saved the compiled source but could not reload: ${errorText(error)}`)
      }
      return
    }
    completeLifeTurn(id, lifeTurn, message, failure)
  }
  useEffect(() => {
    const unload = () => {
      try {
        persistThreadHistory()
      } catch {
        /* Existing quota feedback remains visible before reload. */
      }
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])

  useEffect(() => {
    if (!api || restoredSourceApply.current) return
    let disposed = false
    let stored: string | null = null
    try {
      stored = localStorage.getItem(pendingSourceApplyKey)
    } catch {
      return
    }
    const pending = loadPendingSourceApply(stored)
    if (!pending) {
      if (stored) localStorage.removeItem(pendingSourceApplyKey)
      return
    }
    void (async () => {
      const state = await api!.sourceCode.get()
      if (disposed || restoredSourceApply.current) return
      restoredSourceApply.current = true
      const thread = threadsCurrent.current.find((item) => item.id === pending.id)
      if (!thread || thread.turn !== pending.turn) {
        localStorage.removeItem(pendingSourceApplyKey)
        return
      }
      setActiveId(thread.id)
      setView('workspace')
      if (state.enabled) return
      if (!state.error) {
        localStorage.removeItem(pendingSourceApplyKey)
        return
      }
      localStorage.removeItem(pendingSourceApplyKey)
      const lifeTurn: LifeTurn = {
        turn: pending.turn,
        request: pending.request,
        profileId: pending.profileId,
        start: { ...pending.start, remoteId: thread.remoteId || pending.start.remoteId },
        reads: pending.reads,
        repairs: pending.repairs,
        paths: pending.paths,
        parts: new Map(),
        finishing: true,
      }
      lifeTurns.current.set(thread.id, lifeTurn)
      setThreads((previous) =>
        previous.map((item) =>
          item.id === thread.id ? { ...item, busy: true, lifeScope: true } : item,
        ),
      )
      try {
        const connected = await api!.connection.state()
        lifeContext.current.connection = connected
        setConnection(connected)
        if (
          await repairLifeTurn(
            thread.id,
            lifeTurn,
            `The compiled Life interface failed during startup and Life restored the working interface.\n${state.error}`,
          )
        )
          return
        completeLifeTurn(
          thread.id,
          lifeTurn,
          '',
          state.error +
            '\nAutomatic repair has stopped. Continue the request in this thread or restore source from Source code.',
        )
      } catch (error) {
        if (lifeTurns.current.get(thread.id) === lifeTurn)
          completeLifeTurn(
            thread.id,
            lifeTurn,
            '',
            `Life restored the working interface but could not continue the repair: ${errorText(error)}`,
          )
      }
    })().catch((error) => {
      if (!disposed) setToast(errorText(error))
    })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          'relay.threads.v1',
          JSON.stringify(threads.map((t) => ({ ...t, pending: [], busy: false }))),
        )
      } catch {
        setToast('Local history storage is full. Delete older threads to free space.')
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [threads])
  useEffect(() => {
    const catalogKey = `${connection.profile?.id || ''}:${connection.workspace || ''}:${currentProvider}`
    const cached = modelCatalogs.current.get(catalogKey)
    setModels(cached || fallbackModelCatalog(currentProvider))
    if (!api || !projectReady || connection[currentProvider] === 'missing') {
      return
    }
    let valid = true
    void api.agent
      .models(currentProvider)
      .then((m) => {
        if (valid) {
          if (!m.some((option) => option.id !== '') && cached) return
          const catalog = withProviderDefault(currentProvider, m)
          modelCatalogs.current.set(catalogKey, catalog)
          setModels(catalog)
        }
      })
      .catch((e) => {
        if (valid) {
          setModels(cached || fallbackModelCatalog(currentProvider))
          setToast(errorText(e))
        }
      })
    return () => {
      valid = false
    }
  }, [
    projectReady,
    connection.profile?.id,
    connection.workspace,
    currentProvider,
    connection.codex,
    connection.claude,
  ])
  useEffect(() => {
    if (connected && !connection.workspace) {
      setSuggestedProject(undefined)
      setProjectOpen(true)
    } else if (!connected) {
      setProjectOpen(false)
    }
    setTerminalOpen(false)
  }, [connected, connection.workspace])
  useEffect(() => {
    if (stickToBottom && conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight
  }, [active?.messages, active?.pending, stickToBottom])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 6500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto'
      textarea.current.style.height = Math.min(textarea.current.scrollHeight, 180) + 'px'
    }
  }, [draft])

  const newThread = useCallback(() => {
    submitting.current = undefined
    setView('workspace')
    setActiveId(undefined)
    setDraft('')
    setThreadMenu(false)
    setStickToBottom(true)
    textarea.current?.focus()
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        hostKey ||
        connectOpen ||
        projectOpen ||
        helpOpen ||
        searchOpen ||
        customizeOpen ||
        portsOpen ||
        updatesOpen ||
        extensionsOpen ||
        sourceCodeOpen
      )
        return
      const key = e.key.toLowerCase()
      if (e.metaKey || e.ctrlKey) {
        if (key === 'k') {
          e.preventDefault()
          setSearchOpen(true)
        }
        if (key === 'n') {
          e.preventDefault()
          newThread()
        }
        if (key === ',') {
          e.preventDefault()
          setConnectOpen(true)
        }
        if (e.code === 'Backquote') {
          e.preventDefault()
          if (projectReady) setTerminalOpen((v) => !v)
          else if (connected) setProjectOpen(true)
          else setConnectOpen(true)
        }
        if (key === 'b') {
          e.preventDefault()
          setSidebarOpen((v) => !v)
        }
      }
      if (e.key === 'Escape') setThreadMenu(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    newThread,
    hostKey,
    connectOpen,
    projectOpen,
    projectReady,
    connected,
    helpOpen,
    searchOpen,
    customizeOpen,
    portsOpen,
    updatesOpen,
    extensionsOpen,
    sourceCodeOpen,
  ])
  async function send() {
    if (!draft.trim() || busy || submitting.current) return
    const prompt = draft.trim()
    const projectRequest = /^\s*(?:\/project|@project)(?:\s|$)/i.test(prompt)
    const isLife = !projectRequest && (detectLifeIntent(prompt) || active?.lifeScope === true)
    const userRequest = isLife
      ? stripLifeIntent(prompt)
      : prompt.replace(/^(?:\/project|@project)(?:\s+|$)/i, '').trim()
    if (!userRequest) {
      setToast(
        isLife
          ? 'Describe what you want to change or ask about Life.'
          : 'Describe your project request.',
      )
      return
    }
    const localPatch = isLife ? planLocalCustomization(userRequest, config) : null
    const offlineLocal = Boolean(localPatch) && (!projectReady || !api)
    if ((!connected || !api) && !offlineLocal) {
      setConnectOpen(true)
      return
    }
    if (!projectReady && !offlineLocal) {
      setSuggestedProject(active?.workspace)
      setProjectOpen(true)
      return
    }
    if (
      !offlineLocal &&
      active &&
      active.profileId !== 'life-local' &&
      active.profileId !== connection.profile?.id
    ) {
      setToast(
        'Connect to this thread’s machine to continue, or start a new thread on the current machine.',
      )
      return
    }
    if (
      !offlineLocal &&
      active &&
      active.profileId !== 'life-local' &&
      ((active.workspace && active.workspace !== connection.workspace) ||
        (active.remoteId && !active.workspace))
    ) {
      setToast(
        active.workspace
          ? 'Select this thread’s project to continue, or start a new thread in the current project.'
          : 'This older thread’s project could not be resolved. Start a new thread in the selected project.',
      )
      if (active.workspace) {
        setSuggestedProject(active.workspace)
        setProjectOpen(true)
      }
      return
    }
    const submission = { id: active?.id }
    submitting.current = submission
    setDraft('')
    setStickToBottom(true)
    let thread = active
    if (!thread) {
      thread = {
        id: crypto.randomUUID(),
        profileId: connection.profile?.id || 'life-local',
        ...(projectReady ? { workspace: connection.workspace } : {}),
        provider,
        title: prompt.slice(0, 54),
        messages: [],
        busy: false,
        model,
        reasoningEffort,
        serviceTier,
        mode,
        updatedAt: Date.now(),
        turn: 0,
        pending: [],
      }
      setActiveId(thread.id)
    }
    const id = thread.id
    submission.id = id
    const turn = thread.turn + 1
    const next: Thread = {
      ...thread,
      profileId: offlineLocal ? thread.profileId : connection.profile!.id,
      workspace: offlineLocal ? thread.workspace : connection.workspace,
      turn,
      busy: true,
      lifeScope: isLife,
      updatedAt: Date.now(),
      messages: [...thread.messages, { id: crypto.randomUUID(), role: 'user', text: prompt, turn }],
    }
    setThreads((previous) => [next, ...previous.filter((t) => t.id !== id)])
    let lifeSubmission: LifeTurn | undefined
    try {
      // A connected thread sends even simple Life changes to its existing harness so
      // follow-up questions share the actual provider conversation and remote identity.
      if (offlineLocal && localPatch) {
        lifeTurns.current.set(id, {
          turn,
          parts: new Map(),
          finishing: true,
          request: userRequest,
          profileId: thread.profileId,
          reads: 0,
          repairs: 0,
        })
        await preferences.apply(localPatch)
        lifeTurns.current.delete(id)
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? {
                  ...item,
                  busy: false,
                  messages: [
                    ...item.messages,
                    {
                      id: `${turn}:life-local`,
                      role: 'assistant',
                      text: `Updated Life settings locally: ${Object.keys(localPatch).join(', ')}. Undo is available in Settings.`,
                      turn,
                    },
                  ],
                }
              : item,
          ),
        )
        return
      }
      const input: StartInput = {
        sessionId: id,
        provider: thread.provider,
        remoteId: thread.remoteId,
        workspace: connection.workspace,
        prompt: userRequest,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort ?? '',
        serviceTier: thread.serviceTier ?? '',
        mode: isLife ? 'plan' : thread.mode,
      }
      if (isLife) {
        const lifeTurn: LifeTurn = {
          turn,
          parts: new Map(),
          finishing: false,
          request: userRequest,
          profileId: connection.profile!.id,
          start: input,
          reads: 0,
          repairs: 0,
        }
        lifeSubmission = lifeTurn
        lifeTurns.current.set(id, lifeTurn)
        const source = await api!.sourceCode.getContext()
        if (lifeTurns.current.get(id) !== lifeTurn) return
        lifeTurn.source = source
        input.prompt = buildLifeThreadPrompt(
          userRequest,
          config,
          extensions.extensions,
          api!.extensions.capabilities,
          { source },
        )
      }
      await api!.agent.start(input)
    } catch (e) {
      if (lifeSubmission && lifeTurns.current.get(id) !== lifeSubmission) return
      const lifeTurn = lifeTurns.current.get(id)
      if (lifeTurn?.turn === turn) lifeTurns.current.delete(id)
      setThreads((previous) =>
        previous.map((t) =>
          t.id === id && t.turn === turn
            ? applyEvent(t, { sessionId: id, type: 'error', text: errorText(e) })
            : t,
        ),
      )
    } finally {
      if (submitting.current === submission) submitting.current = undefined
    }
  }
  async function stop() {
    if (!active || !api) return
    if (lifeTurns.current.get(active.id)?.finishing) return
    lifeTurns.current.delete(active.id)
    try {
      await api.agent.stop(active.id)
      setThreads((previous) =>
        previous.map((thread) =>
          thread.id === active.id && thread.turn === active.turn
            ? { ...thread, busy: false, pending: [] }
            : thread,
        ),
      )
      if (submitting.current?.id === active.id) submitting.current = undefined
    } catch (e) {
      setToast(errorText(e))
    }
  }
  const updateSettings = (value: {
    model?: string
    mode?: PermissionMode
    reasoningEffort?: string
    serviceTier?: string
  }) => {
    let next = value
    if (value.model !== undefined && value.model !== currentModel) {
      const selectedModel = models.find((option) => option.id === value.model)
      const choices = normalizeModelChoices(
        {
          id: value.model,
          name: selectedModel?.name || value.model,
          supportedReasoningEfforts: selectedModel?.supportedReasoningEfforts || [],
          serviceTiers: selectedModel?.serviceTiers || [],
        },
        { reasoningEffort: currentReasoningEffort, serviceTier: currentServiceTier },
      )
      next = { ...choices, ...value }
    }
    if (active)
      setThreads((previous) => previous.map((t) => (t.id === active.id ? { ...t, ...next } : t)))
    else {
      if (next.model !== undefined) setModel(next.model)
      if (next.mode) setMode(next.mode)
      if (next.reasoningEffort !== undefined) setReasoningEffort(next.reasoningEffort)
      if (next.serviceTier !== undefined) setServiceTier(next.serviceTier)
    }
  }
  async function respond(event: AgentEvent, accepted: boolean, answers?: Record<string, string[]>) {
    if (!active || !api) return
    try {
      await api.agent.respond(active.id, event.requestId!, accepted, answers)
      setThreads((previous) =>
        previous.map((t) =>
          t.id === active.id
            ? { ...t, pending: t.pending.filter((p) => p.requestId !== event.requestId) }
            : t,
        ),
      )
    } catch (e) {
      setToast(errorText(e))
    }
  }
  function selectThread(thread: Thread) {
    setView('workspace')
    setActiveId(thread.id)
    setDraft('')
    setSearchOpen(false)
    setQuery('')
    setStickToBottom(true)
    setThreadMenu(false)
  }
  async function invokeExtensionUI(method: string, args: unknown): Promise<unknown> {
    const payload = Array.isArray(args) ? args[0] : args
    if (method === 'ui.notify') {
      if (typeof payload !== 'string') throw new Error('ui.notify expects text')
      setToast(payload.slice(0, 2000))
      return null
    }
    if (method === 'ui.navigate') {
      if (payload !== 'research' && payload !== 'workspace')
        throw new Error('ui.navigate expects research or workspace')
      setView(payload)
      return null
    }
    if (method === 'ui.threads') return threads.map((thread) => ({ ...thread, pending: [] }))
    if (method === 'ui.research.list') return readProjects(profiles)
    throw new Error(`This UI method is unavailable: ${method}`)
  }
  const extensionHost = (extension: (typeof enabledExtensions)[number]) => (
    <ExtensionHost
      key={extension.id}
      extension={extension}
      theme={config.theme}
      onError={setToast}
      onInvoke={invokeExtensionUI}
    />
  )
  const titleProfile = active ? profiles.find((p) => p.id === active.profileId) : connection.profile

  return (
    <div
      className={`app-shell life-desktop-layout ${!sidebarOpen ? 'sidebar-hidden' : ''} ${!workspaceOpen || view !== 'workspace' || replacement ? 'workspace-hidden' : ''}`}
      data-panel-size={config.workspacePanelWidth === 320 ? 'adaptive' : 'custom'}
      data-sidebar-size={config.sidebarWidth === 260 ? 'adaptive' : 'custom'}
    >
      <TitleBar
        theme={config.theme}
        platform={platform}
        maximized={maximized}
        onThemeToggle={() => {
          void preferences
            .apply({ theme: config.theme === 'dark' ? 'light' : 'dark' })
            .catch((error) => setToast(errorText(error)))
        }}
        version={LIFE_VERSION}
      />
      {!sourceUI.enabled && sourceUI.error ? (
        <div className="extension-recovery-bar" role="status">
          <span>{sourceUI.error}</span>
          <button onClick={() => setSourceCodeOpen(true)}>Review source changes</button>
        </div>
      ) : null}
      {replacement ? (
        <div className="extension-replacement">
          <div className="extension-recovery-bar">
            <span>{replacement.name}</span>
            <button
              onClick={() => {
                setExtensionRecovery(true)
                setView('research')
              }}
            >
              Back to Life
            </button>
            <button onClick={() => setExtensionsOpen(true)}>Manage extensions</button>
            <small>{shortcutModifier} ⇧ L to recover</small>
          </div>
          {extensionHost(replacement)}
        </div>
      ) : (
        <div className="app-body">
          <aside className="sidebar" aria-label="Projects and threads">
            <div className="brand">
              <button
                className="icon-button"
                title="Toggle sidebar (Ctrl+B)"
                aria-label="Hide sidebar"
                onClick={() => setSidebarOpen(false)}
              >
                <PanelLeft size={17} />
              </button>
              <span className="brand-mark">
                <RelayMark size={22} />
              </span>
              <strong>Life</strong>
              <nav className="view-switch" aria-label="Workspace views">
                <button
                  aria-label="Map"
                  title="Research map"
                  aria-pressed={view === 'research'}
                  onClick={() => setView('research')}
                >
                  <Network size={15} />
                </button>
                <button
                  aria-label="Workspace"
                  title="Agent workspace"
                  aria-pressed={view === 'workspace'}
                  onClick={() => setView('workspace')}
                >
                  <MessageSquare size={15} />
                </button>
              </nav>
            </div>
            {enabledExtensions
              .filter((extension) => extension.renderer.placement === 'view')
              .map((extension) => (
                <button
                  className={`extension-sidebar-view ${view === 'extension' && selectedExtension === extension.id ? 'selected' : ''}`}
                  key={extension.id}
                  onClick={() => {
                    setSelectedExtension(extension.id)
                    setView('extension')
                  }}
                >
                  <Code2 size={14} />
                  <span>{extension.name}</span>
                </button>
              ))}
            <div className="sidebar-search-row">
              <button className="sidebar-search" onClick={() => setSearchOpen(true)}>
                <Search size={16} />
                <span>Search threads</span>
                <kbd>{shortcutModifier} K</kbd>
              </button>
              <button
                className="new-thread-button"
                aria-label="New thread"
                title={`New thread (${shortcutModifier}+N)`}
                onClick={newThread}
              >
                <Plus size={17} /> <span>New thread</span> <kbd>{shortcutModifier} N</kbd>
              </button>
            </div>
            <div className="sidebar-section-title">
              <span>
                <Folder size={16} /> All projects
              </span>
              <button
                className="icon-button"
                aria-label="Add workspace"
                onClick={() => setConnectOpen(true)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="project-list">
              {!profiles.length ? (
                <button className="empty-project" onClick={() => setConnectOpen(true)}>
                  <span className="empty-project-icon">
                    <Folder size={17} />
                    <Plus size={9} />
                  </span>
                  <span>
                    Add your first workspace<small>Connect a remote project</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ) : null}
              {[...threads]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((thread) => (
                  <SidebarThread
                    key={thread.id}
                    thread={thread}
                    projectName={
                      thread.workspace?.split('/').filter(Boolean).pop() ||
                      profiles.find((profile) => profile.id === thread.profileId)?.name ||
                      'Previous project'
                    }
                    active={activeId === thread.id}
                    onSelect={() => selectThread(thread)}
                  />
                ))}
              {profiles
                .filter((profile) => !threads.some((thread) => thread.profileId === profile.id))
                .map((profile) => (
                  <button
                    className="project-heading"
                    key={profile.id}
                    onClick={() => {
                      if (connection.profile?.id !== profile.id || !connected) {
                        setRequestedProfileId(profile.id)
                        setConnectOpen(true)
                      } else newThread()
                    }}
                  >
                    <Folder size={16} />
                    <span>{profile.name}</span>
                    {connection.profile?.id === profile.id && connected ? (
                      <span className="status-dot online" />
                    ) : (
                      <Server size={12} className="muted" />
                    )}
                  </button>
                ))}
            </div>
            <div className="sidebar-bottom">
              <button
                className={`machine-card ${connected ? 'connected' : ''}`}
                title={
                  connected
                    ? `${connection.profile?.username}@${connection.profile?.host}`
                    : 'Connect over SSH'
                }
                onClick={() => setConnectOpen(true)}
              >
                <span className={`status-dot ${connected ? 'online' : ''}`} />
                <span>
                  <strong>{connected ? connection.profile?.name : 'Connect a machine'}</strong>
                  <small>
                    {connected
                      ? `${connection.profile?.username}@${connection.profile?.host}`
                      : 'Work from anywhere'}
                  </small>
                </span>
                {connection.status === 'connecting' ? (
                  <LoaderCircle size={14} className="spinning" />
                ) : (
                  <ChevronRight size={14} />
                )}
              </button>
              <div className="sidebar-tool-row" aria-label="Life tools">
                <button
                  className="icon-button"
                  aria-label="Settings"
                  title="Settings"
                  onClick={() => setCustomizeOpen(true)}
                >
                  <Settings2 size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Connections"
                  title="SSH connections"
                  onClick={() => setConnectOpen(true)}
                >
                  <Server size={16} />
                </button>
                <button
                  className="icon-button extension-sidebar-entry"
                  aria-label="Live extensions"
                  title={`Live extensions (${extensions.extensions.length + (sourceUI.extensions?.length || 0)})`}
                  onClick={() => setExtensionsOpen(true)}
                >
                  <Code2 size={16} />
                  {extensions.extensions.length + (sourceUI.extensions?.length || 0) ? (
                    <i className="tool-notification-dot" />
                  ) : null}
                </button>
                <button
                  className="icon-button extension-sidebar-entry"
                  aria-label={`Ports ${config.autoPortForward ? 'Auto' : 'Off'}`}
                  title={`Port forwarding: ${config.autoPortForward ? 'automatic' : 'off'}`}
                  onClick={() => setPortsOpen(true)}
                >
                  <Network size={16} />
                </button>
                <button
                  className="icon-button extension-sidebar-entry"
                  aria-label={`Source code ${sourceUI.enabled ? 'Edited' : 'Built-in'}`}
                  title="Source code"
                  onClick={() => setSourceCodeOpen(true)}
                >
                  <Folder size={16} />
                </button>
                <button
                  className="icon-button update-life-button"
                  aria-label="Updates"
                  title={
                    updateState.status === 'available' || updateState.status === 'downloaded'
                      ? `Life ${updateState.version} available`
                      : `Life ${LIFE_VERSION} updates`
                  }
                  onClick={() => setUpdatesOpen(true)}
                >
                  <ArrowDown size={16} />
                  {updateState.status === 'available' || updateState.status === 'downloaded' ? (
                    <i className="tool-notification-dot" />
                  ) : null}
                </button>
                <button
                  className="icon-button"
                  aria-label="Help and keyboard shortcuts"
                  title="Help and keyboard shortcuts"
                  onClick={() => setHelpOpen(true)}
                >
                  <CircleHelp size={16} />
                </button>
              </div>
            </div>
          </aside>
          {view === 'extension' && selectedView ? (
            <main className="extension-view-main" id="main-content">
              <header className="workspace-header">
                <div className="breadcrumbs">
                  {!sidebarOpen ? (
                    <button
                      className="icon-button"
                      aria-label="Show sidebar"
                      onClick={() => setSidebarOpen(true)}
                    >
                      <PanelLeft size={17} />
                    </button>
                  ) : null}
                  <Code2 size={15} />
                  <strong>{selectedView.name}</strong>
                </div>
                <button className="button secondary" onClick={() => setExtensionsOpen(true)}>
                  Manage extensions
                </button>
              </header>
              {extensionHost(selectedView)}
            </main>
          ) : view === 'research' ? (
            <main className="research-main" id="main-content">
              <header className="workspace-header">
                <div className="breadcrumbs">
                  {!sidebarOpen ? (
                    <button
                      className="icon-button"
                      aria-label="Show sidebar"
                      onClick={() => setSidebarOpen(true)}
                    >
                      <PanelLeft size={17} />
                    </button>
                  ) : null}
                  <Network size={16} />
                  <strong>{config.labels.researchTitle}</strong>
                </div>
                <div className="header-actions">
                  <button className="button secondary" onClick={() => setConnectOpen(true)}>
                    <Server size={14} /> Connect
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Settings"
                    onClick={() => setCustomizeOpen(true)}
                  >
                    <Settings2 size={17} />
                  </button>
                </div>
              </header>
              <div className="research-view-scroll">
                <ResearchView
                  profiles={profiles}
                  threads={threads}
                  theme={config.theme}
                  onNotify={setToast}
                  onOpenWorkspace={(profileId, threadId) => {
                    const thread = threads.find((item) => item.id === threadId)
                    if (thread) selectThread(thread)
                    else newThread()
                    if (profileId && (connection.profile?.id !== profileId || !connected)) {
                      setRequestedProfileId(profileId)
                      setConnectOpen(true)
                    }
                  }}
                />
                <CustomPanels config={config} view="research" />
                {extensionPanels.length ? (
                  <section className="extension-panel-grid" aria-label="Live extension panels">
                    {extensionPanels.map(extensionHost)}
                  </section>
                ) : null}
              </div>
            </main>
          ) : (
            <main className="main-workspace" id="main-content">
              <header className="workspace-header">
                <div className="breadcrumbs">
                  {!sidebarOpen ? (
                    <button
                      className="icon-button"
                      aria-label="Show sidebar"
                      onClick={() => setSidebarOpen(true)}
                    >
                      <PanelLeft size={17} />
                    </button>
                  ) : null}
                  {active ? (
                    <ProviderIcon provider={active.provider} size={16} />
                  ) : (
                    <Folder size={15} />
                  )}
                  <span title={active?.workspace || connection.workspace}>
                    {(active?.workspace || connection.workspace)
                      ?.split('/')
                      .filter(Boolean)
                      .pop() ||
                      titleProfile?.name ||
                      config.labels.workspaceTitle}
                  </span>
                  <span className="breadcrumb-separator" aria-hidden="true">
                    /
                  </span>
                  <strong>{active?.title || 'New thread'}</strong>
                </div>
                <div className="header-actions">
                  {connected ? (
                    <button
                      className="project-picker-button"
                      aria-label="Select project"
                      title={connection.workspace || 'Choose a remote project'}
                      onClick={() => {
                        setSuggestedProject(undefined)
                        setProjectOpen(true)
                      }}
                    >
                      <Folder size={14} />
                      <span>
                        {connection.workspace?.split('/').filter(Boolean).pop() ||
                          (connection.workspace === '/' ? '/' : 'Select project')}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                  ) : null}
                  <span className={`connection-pill ${connected ? 'connected' : ''}`}>
                    <span className={`status-dot ${connected ? 'online' : ''}`} />
                    {connection.status === 'connecting'
                      ? 'Connecting'
                      : connected
                        ? 'SSH connected'
                        : 'Offline'}
                  </span>
                  <button
                    className={`icon-button ${terminalOpen ? 'selected' : ''}`}
                    aria-label="Toggle remote terminal"
                    aria-pressed={terminalOpen}
                    onClick={() => {
                      if (projectReady) setTerminalOpen((v) => !v)
                      else if (connected) setProjectOpen(true)
                      else setConnectOpen(true)
                    }}
                  >
                    <Terminal size={17} />
                  </button>
                  <button
                    className={`icon-button ${workspaceOpen ? 'selected' : ''}`}
                    aria-label="Toggle workspace panel"
                    aria-pressed={workspaceOpen}
                    onClick={() => setWorkspaceOpen((v) => !v)}
                  >
                    <PanelRight size={17} />
                  </button>
                  {active ? (
                    <div className="thread-menu-container">
                      <button
                        className="icon-button"
                        aria-label="Thread actions"
                        aria-expanded={threadMenu}
                        onClick={() => setThreadMenu((v) => !v)}
                      >
                        <Ellipsis size={18} />
                      </button>
                      {threadMenu ? (
                        <div className="thread-menu">
                          <button
                            onClick={() => {
                              const text = active.messages
                                .filter((m) => m.role !== 'tool')
                                .map(
                                  (m) =>
                                    `## ${m.role === 'user' ? 'You' : m.role === 'error' ? 'Error' : providerName(active.provider)}\n\n${m.text}`,
                                )
                                .join('\n\n')
                              const url = URL.createObjectURL(
                                new Blob([text], { type: 'text/markdown' }),
                              )
                              const link = document.createElement('a')
                              link.href = url
                              link.download = 'life-thread.md'
                              link.click()
                              URL.revokeObjectURL(url)
                              setThreadMenu(false)
                            }}
                          >
                            Export thread
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setThreads((previous) =>
                                previous.map((thread) =>
                                  thread.id === active.id
                                    ? { ...thread, lifeScope: !active.lifeScope }
                                    : thread,
                                ),
                              )
                              setThreadMenu(false)
                            }}
                          >
                            {active.lifeScope
                              ? 'Return to project messages'
                              : 'Message Life in this thread'}
                          </button>
                          <button
                            onClick={() => {
                              setCustomizeOpen(true)
                              setThreadMenu(false)
                            }}
                          >
                            Settings and undo
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setThreads((t) => t.filter((item) => item.id !== active.id))
                              newThread()
                            }}
                          >
                            Delete thread
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </header>
              {!desktop ? (
                <div className="browser-preview">
                  <Computer size={13} />
                  <span>Desktop interface preview</span>
                  <span className="preview-divider">/</span>
                  <span>Launch Electron to connect your machines</span>
                </div>
              ) : null}
              {connection.error && !connectOpen ? (
                <div className="connection-error" role="alert">
                  <span>{connection.error}</span>
                  <button onClick={() => setConnectOpen(true)}>
                    Reconnect <ArrowRight size={13} />
                  </button>
                </div>
              ) : null}
              <div className="chat-area">
                <div
                  className={`conversation ${!active ? 'empty-conversation' : ''}`}
                  ref={conversation}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100)
                  }}
                >
                  {!active ? (
                    <div className="welcome workspace-start">
                      <div className="workspace-start-label">
                        <MessageSquare size={17} /> New thread
                      </div>
                      <h1>{config.labels.welcomeTitle}</h1>
                      <p>{config.labels.welcomeSubtitle}</p>
                      <div className="provider-cards">
                        {(['codex', 'claude'] as const).map((p) => (
                          <button
                            className={`provider-card ${provider === p ? 'active' : ''}`}
                            key={p}
                            onClick={() => {
                              setProvider(p)
                              setModel('')
                              setReasoningEffort('')
                              setServiceTier('')
                            }}
                            aria-pressed={provider === p}
                          >
                            <span className={`provider-card-icon ${p}`}>
                              <ProviderIcon provider={p} size={23} />
                            </span>
                            <span>
                              <strong>{providerName(p)}</strong>
                              <small>{p === 'codex' ? 'By OpenAI' : 'By Anthropic'}</small>
                            </span>
                            <span className="provider-radio">
                              {provider === p ? <Check size={11} /> : null}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="starter-grid" aria-label="Suggested prompts">
                        {starterPrompts.map((item) => (
                          <button
                            className="starter-card"
                            key={item.title}
                            onClick={() => {
                              setDraft(item.prompt)
                              textarea.current?.focus()
                            }}
                          >
                            <item.icon size={18} />
                            <strong>{item.title}</strong>
                            <span>{item.subtitle}</span>
                            <ArrowUpRight size={13} className="starter-arrow" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="messages">
                      {active.messages.map((message) => (
                        <MessageView
                          key={message.id}
                          message={message}
                          provider={active.provider}
                        />
                      ))}
                      {active.pending.map((event) => (
                        <ApprovalCard
                          key={event.requestId}
                          event={event}
                          onRespond={(accepted, answers) => respond(event, accepted, answers)}
                        />
                      ))}
                      {busy && !active.pending.length ? (
                        <div className="agent-working" role="status">
                          <span className="working-indicator">
                            <i />
                            <i />
                            <i />
                          </span>
                          {applyingLife
                            ? 'Applying Life change'
                            : `${providerName(currentProvider)} is working`}
                          <span>
                            {applyingLife
                              ? 'Saving and checking the result'
                              : active?.lifeScope
                                ? 'on your Life request'
                                : 'on your remote machine'}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                {active && !stickToBottom ? (
                  <button
                    className="scroll-bottom icon-button"
                    aria-label="Scroll to latest message"
                    onClick={() => setStickToBottom(true)}
                  >
                    <ArrowDown size={17} />
                  </button>
                ) : null}
                <CustomPanels config={config} view="workspace" />
                {extensionPanels.length ? (
                  <section
                    className="extension-panel-grid workspace-extension-panels"
                    aria-label="Live extension panels"
                  >
                    {extensionPanels.map(extensionHost)}
                  </section>
                ) : null}
                <div className="composer-container">
                  {config.commands.length ? (
                    <div className="prompt-commands" aria-label="Custom prompt commands">
                      {config.commands.map((command) => (
                        <button
                          key={command.id}
                          disabled={busy}
                          onClick={() => {
                            setDraft(command.prompt)
                            if (!active) {
                              if (command.provider) {
                                setProvider(command.provider)
                                setModel('')
                                setReasoningEffort('')
                                setServiceTier('')
                              }
                              if (command.mode) setMode(command.mode)
                            }
                            textarea.current?.focus()
                          }}
                        >
                          {command.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className={`composer ${busy ? 'busy' : ''}`}>
                    <textarea
                      ref={textarea}
                      aria-label="Message your coding agent"
                      placeholder={
                        lifeIntent
                          ? 'Describe a Life change, or /project to return to your code…'
                          : projectReady
                            ? 'Ask for changes, explore ideas, or send a follow-up…'
                            : connected
                              ? 'Choose a project, or /life switch to light for local settings…'
                              : 'Connect a machine, or /life switch to light for local settings…'
                      }
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          void send()
                        }
                      }}
                      rows={2}
                    />
                    <div className="composer-toolbar">
                      <div className="composer-options">
                        <label className="composer-select provider-select" title="Coding agent">
                          <ProviderIcon provider={currentProvider} size={15} />
                          <select
                            aria-label="Coding agent"
                            value={currentProvider}
                            disabled={Boolean(active)}
                            onChange={(e) => {
                              setProvider(e.target.value as Provider)
                              setModel('')
                              setReasoningEffort('')
                              setServiceTier('')
                            }}
                          >
                            <option value="codex">Codex</option>
                            <option value="claude">Claude Code</option>
                          </select>
                          <ChevronDown size={11} />
                        </label>
                        <span className="toolbar-divider" />
                        <label className="composer-select model-select">
                          <select
                            aria-label="Agent model"
                            value={currentModel}
                            disabled={busy}
                            onChange={(e) => updateSettings({ model: e.target.value })}
                          >
                            {models.map((m) => (
                              <option value={m.id} key={m.id}>
                                {m.name}
                              </option>
                            ))}
                            {currentModel && !models.some((m) => m.id === currentModel) ? (
                              <option value={currentModel}>{currentModel}</option>
                            ) : null}
                          </select>
                          <ChevronDown size={11} />
                        </label>
                        {effortOptions.length || currentReasoningEffort ? (
                          <label
                            className="composer-select reasoning-select"
                            title={
                              effortOptions.find(
                                (option) => option.reasoningEffort === currentReasoningEffort,
                              )?.description || 'How much reasoning the model uses for this thread'
                            }
                          >
                            <BrainCircuit size={13} />
                            <select
                              aria-label="Reasoning effort"
                              value={currentReasoningEffort}
                              disabled={busy}
                              onChange={(event) =>
                                updateSettings({ reasoningEffort: event.target.value })
                              }
                            >
                              <option value="">
                                Reasoning: default
                                {currentModelOption?.defaultReasoningEffort
                                  ? ` (${effortName(currentModelOption.defaultReasoningEffort)})`
                                  : ''}
                              </option>
                              {effortOptions.map((option) => (
                                <option
                                  key={option.reasoningEffort}
                                  value={option.reasoningEffort}
                                  title={option.description}
                                >
                                  {effortName(option.reasoningEffort)}
                                </option>
                              ))}
                              {currentReasoningEffort &&
                              !effortOptions.some(
                                (option) => option.reasoningEffort === currentReasoningEffort,
                              ) ? (
                                <option value={currentReasoningEffort}>
                                  {effortName(currentReasoningEffort)} (unavailable)
                                </option>
                              ) : null}
                            </select>
                            <ChevronDown size={11} />
                          </label>
                        ) : null}
                        {tierOptions.length || currentServiceTier ? (
                          <label
                            className="composer-select tier-select"
                            title={
                              tierOptions.find((option) => option.id === currentServiceTier)
                                ?.description ||
                              'Provider service tier and response speed for this thread'
                            }
                          >
                            <Gauge size={13} />
                            <select
                              aria-label="Service tier"
                              value={currentServiceTier}
                              disabled={busy}
                              onChange={(event) =>
                                updateSettings({ serviceTier: event.target.value })
                              }
                            >
                              <option value="">Speed: default</option>
                              {tierOptions.map((option) => (
                                <option
                                  key={option.id}
                                  value={option.id}
                                  title={option.description}
                                >
                                  {option.name}
                                </option>
                              ))}
                              {currentServiceTier &&
                              !tierOptions.some((option) => option.id === currentServiceTier) ? (
                                <option value={currentServiceTier}>
                                  {currentServiceTier} (unavailable)
                                </option>
                              ) : null}
                            </select>
                            <ChevronDown size={11} />
                          </label>
                        ) : null}
                        <label
                          className="composer-select mode-select"
                          title={
                            currentMode === 'review'
                              ? 'Ask before actions that need approval'
                              : currentMode === 'edit'
                                ? 'Allow workspace edits; review other actions'
                                : 'Plan without changing files'
                          }
                        >
                          <ShieldCheck size={13} />
                          <select
                            aria-label="Agent permission mode"
                            value={currentMode}
                            disabled={busy}
                            onChange={(e) =>
                              updateSettings({ mode: e.target.value as PermissionMode })
                            }
                          >
                            <option value="review">Review actions</option>
                            <option value="edit">Allow edits</option>
                            <option value="plan">Plan only</option>
                          </select>
                          <ChevronDown size={11} />
                        </label>
                      </div>
                      {busy ? (
                        <button
                          className="send-button stop-button"
                          aria-label={applyingLife ? 'Applying Life change' : 'Stop agent'}
                          disabled={applyingLife}
                          onClick={() => void stop()}
                        >
                          {applyingLife ? (
                            <LoaderCircle size={15} className="spinning" />
                          ) : (
                            <Square size={13} fill="currentColor" />
                          )}
                        </button>
                      ) : (
                        <button
                          className={`send-button ${!projectReady ? 'connect-send' : ''}`}
                          aria-label={
                            projectReady || lifeIntent
                              ? 'Send message'
                              : connected
                                ? 'Select project to send'
                                : 'Connect to send'
                          }
                          disabled={(projectReady || lifeIntent) && !draft.trim()}
                          onClick={() => {
                            if (!connected && !lifeIntent) setConnectOpen(true)
                            else if (!projectReady && !lifeIntent) setProjectOpen(true)
                            else void send()
                          }}
                        >
                          {!projectReady && !lifeIntent ? (
                            <>
                              <span>{connected ? 'Select project' : 'Connect'}</span>
                              <ArrowUpRight size={15} />
                            </>
                          ) : (
                            <ArrowUp size={18} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="composer-caption composer-worktree-strip">
                    <span>
                      <span className={`status-dot ${connected ? 'online' : ''}`} />
                      {lifeIntent ? (
                        <>
                          Life scope
                          {active?.lifeScope ? (
                            <button
                              type="button"
                              className="life-scope-reset"
                              disabled={busy}
                              onClick={() => {
                                setThreads((previous) =>
                                  previous.map((thread) =>
                                    thread.id === active.id
                                      ? { ...thread, lifeScope: false }
                                      : thread,
                                  ),
                                )
                              }}
                            >
                              Return to project
                            </button>
                          ) : (
                            <span> · This message changes Life</span>
                          )}
                        </>
                      ) : (
                        <button
                          className="composer-project-control"
                          aria-label="Choose workspace project"
                          title={connection.workspace || 'Choose a project after connecting'}
                          onClick={() => {
                            if (connected) {
                              setSuggestedProject(undefined)
                              setProjectOpen(true)
                            } else setConnectOpen(true)
                          }}
                        >
                          <Folder size={13} />
                          <span>
                            {projectReady
                              ? connection.workspace
                                  ?.split('/')
                                  .filter(Boolean)
                                  .slice(-2)
                                  .join('/') || '/'
                              : connected
                                ? 'Choose a project'
                                : 'Connect a machine'}
                          </span>
                          <ChevronDown size={11} />
                        </button>
                      )}
                    </span>
                    <span
                      className="composer-machine-status"
                      title={
                        connected
                          ? `${connection.profile?.username}@${connection.profile?.host}`
                          : undefined
                      }
                    >
                      {connected ? (
                        <>
                          <Server size={12} /> {connection.profile?.host}
                        </>
                      ) : (
                        '/life changes Life'
                      )}
                    </span>
                    <span className="composer-keyboard-hint">
                      <kbd>↵</kbd> Send <span className="caption-dot">·</span> <kbd>⇧ ↵</kbd> New
                      line
                    </span>
                  </div>
                </div>
              </div>
              {terminalOpen ? (
                <RemoteTerminal
                  theme={config.theme}
                  connected={projectReady}
                  onClose={() => setTerminalOpen(false)}
                />
              ) : null}
            </main>
          )}
          {workspaceOpen && view === 'workspace' ? (
            <WorkspacePanel
              connection={connection}
              onConnect={() => (connected ? setProjectOpen(true) : setConnectOpen(true))}
              onClose={() => setWorkspaceOpen(false)}
              refreshKey={refreshKey}
              onAttach={(path) => {
                setDraft(
                  (d) =>
                    `${d}${d ? '\n' : ''}Please look at ${path.replace(connection.workspace + '/', '')}. `,
                )
                textarea.current?.focus()
              }}
              onTerminal={() => {
                if (projectReady) setTerminalOpen(true)
                else if (connected) setProjectOpen(true)
                else setConnectOpen(true)
              }}
            />
          ) : null}
        </div>
      )}
      <ExtensionDialog
        open={extensionsOpen}
        onOpenChange={setExtensionsOpen}
        connection={connection}
        defaultProvider={config.defaultProvider}
        onInstalled={(extension) => {
          setExtensionRecovery(false)
          if (extension.renderer.placement === 'view') {
            setSelectedExtension(extension.id)
            setView('extension')
          }
        }}
      />
      <SourceCodeDialog
        open={sourceCodeOpen}
        onOpenChange={setSourceCodeOpen}
        onNotify={setToast}
      />
      <UpdateDialog
        open={updatesOpen}
        onOpenChange={setUpdatesOpen}
        state={updateState}
        busy={threads.some((thread) => thread.busy)}
        onCheck={async () => {
          if (api) setUpdateState(await api.updates.check())
        }}
        onDownload={async () => {
          if (api) setUpdateState(await api.updates.download())
        }}
        onInstall={async () => {
          await api?.updates.install()
        }}
      />
      <PortForwardDialog
        open={portsOpen}
        onOpenChange={setPortsOpen}
        enabled={config.autoPortForward}
        onEnabledChange={(enabled) => preferences.apply({ autoPortForward: enabled })}
      />
      <CustomizationDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        state={preferences.state}
        connected={connected}
        onApply={preferences.apply}
        onUndo={preferences.undo}
        onReset={preferences.reset}
        onReload={preferences.reload}
        onOpenExtensions={() => {
          setCustomizeOpen(false)
          setExtensionsOpen(true)
        }}
      />
      <ConnectionDialog
        open={connectOpen}
        initialProfileId={requestedProfileId}
        suspended={Boolean(hostKey)}
        onOpenChange={setConnectOpen}
        profiles={profiles}
        refreshProfiles={refreshProfiles}
        connection={connection}
      />
      <ProjectDialog
        open={projectOpen && connected && !connectOpen && !hostKey}
        onOpenChange={setProjectOpen}
        connection={connection}
        suggestedPath={suggestedProject}
        hasActiveTurns={threads.some(
          (thread) => thread.busy && thread.profileId === connection.profile?.id,
        )}
        onSelected={(state) => {
          setConnection(state)
          setTerminalOpen(false)
          setView('workspace')
          refreshProfiles()
          if (
            active &&
            (active.profileId !== state.profile?.id || active.workspace !== state.workspace)
          ) {
            setActiveId(undefined)
            setThreadMenu(false)
            setStickToBottom(true)
          }
        }}
      />
      <Modal
        open={Boolean(hostKey)}
        onOpenChange={(v) => {
          if (!v && hostKey) {
            void api?.connection.trust(hostKey.id, false)
            setHostKey(undefined)
          }
        }}
        title="Trust this machine?"
        description="Verify the fingerprint with your server administrator before connecting."
        className="host-key-modal"
      >
        <div className="host-key-details">
          <Server size={24} />
          <strong>{hostKey?.host}</strong>
          <span>SSH host key fingerprint</span>
          <code>{hostKey?.fingerprint}</code>
        </div>
        <div className="modal-actions">
          <button
            className="button secondary"
            onClick={() => {
              if (hostKey) void api?.connection.trust(hostKey.id, false)
              setHostKey(undefined)
            }}
          >
            Cancel
          </button>
          <button
            className="button primary"
            onClick={() => {
              if (hostKey) void api?.connection.trust(hostKey.id, true)
              setHostKey(undefined)
            }}
          >
            <ShieldCheck size={15} /> Trust and connect
          </button>
        </div>
      </Modal>
      <Modal
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Find a thread"
        description="Search your saved conversations."
        className="search-modal"
      >
        <div className="search-input">
          <Search size={17} />
          <input
            aria-label="Search saved threads"
            placeholder="Search by title or message…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="search-results">
          {threads
            .filter((t) =>
              `${t.title} ${t.messages.map((m) => m.text).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((t) => (
              <button key={t.id} onClick={() => selectThread(t)}>
                <ProviderIcon provider={t.provider} size={19} />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {providerName(t.provider)} ·{' '}
                    {profiles.find((p) => p.id === t.profileId)?.name || 'Previous workspace'}
                  </small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          {!threads.length ? (
            <div className="small-empty">
              Your threads will appear here after you send your first message.
            </div>
          ) : !threads.some((t) =>
              `${t.title} ${t.messages.map((m) => m.text).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ) ? (
            <div className="small-empty">No matching threads. Try another search.</div>
          ) : null}
        </div>
      </Modal>
      <Modal
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Make yourself at home"
        description="A few things to get you going in Life."
      >
        <div className="help-section">
          <h3>
            <Server size={16} /> Set up your remote machine
          </h3>
          <p>
            Life connects to a Linux or macOS machine over SSH. Choose an existing project
            directory, then install and sign in to either agent on that machine.
          </p>
          <div className="help-command">
            <span>Codex</span>
            <code>
              npm install -g @openai/codex
              <br />
              codex login --device-auth
            </code>
          </div>
          <div className="help-command">
            <span>Claude Code</span>
            <code>
              curl -fsSL https://claude.ai/install.sh | bash
              <br />
              claude auth login
            </code>
          </div>
          <p>
            Use Life’s terminal to finish setup, then reconnect to refresh the available agents.
          </p>
        </div>
        <div className="help-section">
          <h3>
            <Keyboard size={16} /> Keyboard shortcuts
          </h3>
          {[
            ['New thread', 'Ctrl / ⌘ N'],
            ['Search threads', 'Ctrl / ⌘ K'],
            ['Connections', 'Ctrl / ⌘ ,'],
            ['Toggle terminal', 'Ctrl / ⌘ `'],
            ['Toggle sidebar', 'Ctrl / ⌘ B'],
            ['Send message', 'Enter'],
            ['New line', 'Shift + Enter'],
          ].map(([label, key]) => (
            <div className="shortcut" key={label}>
              <span>{label}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
        {connected ? (
          <button
            className="button secondary disconnect-button"
            onClick={async () => {
              await api?.connection.disconnect()
              setHelpOpen(false)
            }}
          >
            <Unplug size={15} /> Disconnect {connection.profile?.name}
          </button>
        ) : null}
      </Modal>
      {toast ? (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
