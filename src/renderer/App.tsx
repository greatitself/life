import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BrainCircuit,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  Computer,
  Cloud,
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
  finishThreadTurn,
  bindLegacyThreadWorkspace,
  normalizeModelChoices,
  readThreads,
  type Thread,
} from './state'
import { fallbackModelCatalog, withProviderDefault } from './model-catalog'
import { ProviderIcon } from './components/Icons'
import { ThreadBadge } from './components/ThreadBadge'
import { Modal } from './components/Modal'
import { ConnectionDialog } from './components/ConnectionDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { ApprovalCard } from './components/MessageView'
import { ThreadTimeline } from './components/ThreadTimeline'
import { summarizeSourceChanges } from './thread-activity'
import { WorkspaceSurfaces } from './components/WorkspaceSurfaces'
import { ResizeHandle, usePanelSizes } from './components/SidebarResize'
import { ThreadMessageNavigator } from './components/ThreadMessageNavigator'
import { LifeBrand, TitleBar, TitleBarContent } from './components/TitleBar'
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
import { SidebarProjects } from './components/SidebarProjects'
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
import {
  attachmentMetadata,
  attachmentPrompt,
  deleteAttachmentFiles,
  saveAttachmentFiles,
  selectDraftAttachments,
  type DraftAttachment,
} from './attachments'
import { AttachmentList, AttachmentPicker } from './components/ThreadAttachments'
import { QueuedMessages } from './components/QueuedMessages'
import {
  pauseQueuedMessages,
  queueConnectionMatches,
  threadAttachmentIds,
  useThreadQueue,
  type QueuedSubmission,
} from './thread-queue'
import './thread-refinements.css'
import { ReferenceComposerControls, ReferenceComposerDetails } from './components/ReferenceComposer'
import { useThreadMetadata } from './thread-metadata'
import { cancelAttachmentUpload, ensureAttachmentUploads, useDraftUploads } from './draft-upload'
import './components/sidebar-footer-layout.css'
import './components/life-chrome-polish.css'
import './components/collapsed-brand-footer.css'
import './components/header-action-spacing.css'
import { ThreadContextController } from './thread-context'

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
  const researchTitle =
    config.labels.researchTitle === 'Research map' ? 'Map' : config.labels.researchTitle
  const workspaceTitle =
    config.labels.workspaceTitle === 'Agent workspace' ? 'Agents' : config.labels.workspaceTitle
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
  const [titleBarContent, setTitleBarContent] = useState<HTMLDivElement | null>(null)
  const [headerLeadingActions, setHeaderLeadingActions] = useState<HTMLDivElement | null>(null)
  const [sidebarFooter, setSidebarFooter] = useState<HTMLDivElement | null>(null)
  const [surfaceHeader, setSurfaceHeader] = useState<HTMLDivElement | null>(null)
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
  const profilesCurrent = useRef(profiles)
  profilesCurrent.current = profiles
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>({ status: 'disconnected' })
  const [threads, setThreads] = useState<Thread[]>(readThreads)
  const threadsCurrent = useRef(threads)
  threadsCurrent.current = threads
  const [activeId, setActiveId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem('life.active-thread.v1') || undefined
    } catch {
      return undefined
    }
  })
  const activeIdCurrent = useRef(activeId)
  activeIdCurrent.current = activeId
  const threadContext = useRef(new ThreadContextController())
  const threadContextOperation = useRef(0)
  const restoringThreadId = useRef<string | undefined>(undefined)
  const [openingThread, setOpeningThread] = useState<string>()
  const initialRecoveryRequest = useRef<Promise<boolean> | undefined>(undefined)
  const emergencyReview = useRef(false)
  const recoveryReviewed = useRef(false)
  const [startupReady, setStartupReady] = useState(!api?.window.initialRecovery)
  const [provider, setProvider] = useState<Provider>(config.defaultProvider)
  const [model, setModel] = useState(config.defaultModel)
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [serviceTier, setServiceTier] = useState('')
  const [mode, setMode] = useState<PermissionMode>(config.defaultMode)
  const [models, setModels] = useState<ModelOption[]>([{ id: '', name: 'Agent default' }])
  const modelCatalogs = useRef(new Map<string, ModelOption[]>())
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [attachmentProgress, setAttachmentProgress] = useState<{ id: string; percent: number }>()
  const attachmentTransfer = useRef<{ id: string; controller: AbortController } | undefined>(
    undefined,
  )
  const [connectOpen, setConnectOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [suggestedProject, setSuggestedProject] = useState<string>()
  const [requestedProfileId, setRequestedProfileId] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sidebarFiltersOpen, setSidebarFiltersOpen] = useState(false)
  const [hostKey, setHostKey] = useState<HostKeyRequest>()
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => config.workspacePanel && window.innerWidth > 1080,
  )
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 600)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const panels = usePanelSizes(config.sidebarWidth, config.workspacePanelWidth, sidebarOpen, 0)
  useEffect(() => {
    if (terminalOpen) {
      setWorkspaceOpen(true)
      setView('workspace')
    }
  }, [terminalOpen])
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState('')
  useThreadMetadata(connection, refreshKey, threads.length, setThreads)
  useEffect(() => {
    const sleeping = threads.filter((thread) => typeof thread.snoozedUntil === 'number')
    if (!sleeping.length) return
    const wakeAt = Math.min(...sleeping.map((thread) => thread.snoozedUntil!))
    const timer = window.setTimeout(
      () => {
        const now = Date.now()
        setThreads((previous) =>
          previous.map((thread) =>
            thread.snoozedUntil && thread.snoozedUntil <= now
              ? { ...thread, snoozedUntil: undefined }
              : thread,
          ),
        )
      },
      Math.min(2147483647, Math.max(0, wakeAt - Date.now())),
    )
    return () => window.clearTimeout(timer)
  }, [threads])
  const [threadMenu, setThreadMenu] = useState(false)
  const [stickToBottom, setStickToBottom] = useState(true)
  const conversation = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef<{ id?: string } | undefined>(undefined)
  const lifeTurns = useRef(new Map<string, LifeTurn>())
  const sourceReloading = useRef(false)
  const runningChoices = useRef(
    new Map<string, Pick<StartInput, 'model' | 'reasoningEffort' | 'serviceTier'>>(),
  )
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
  const draftUploads = useDraftUploads(
    attachments,
    connection,
    projectReady &&
      (!active || active.profileId === 'life-local' || queueConnectionMatches(active, connection)),
  )
  const busy = active?.busy || false
  const applyingLife = active ? lifeTurns.current.get(active.id)?.finishing === true : false
  const projectIntent = /^\s*(?:\/project|@project)(?:\s|$)/i.test(draft)
  const lifeIntent = !projectIntent && (detectLifeIntent(draft) || active?.lifeScope === true)
  const queue = useThreadQueue({
    threads,
    connection,
    onThreads: setThreads,
    onError: setToast,
    send,
    isBlocked: (threadId) =>
      Boolean(
        !startupReady ||
        emergencyReview.current ||
        submitting.current ||
        attachmentTransfer.current ||
        sourceReloading.current ||
        threadContext.current.busy ||
        lifeTurns.current.get(threadId)?.finishing,
      ),
    stop: async (thread) => {
      if (!api) throw new Error('Sending requires the desktop application.')
      const state = await api.connection.state()
      if (!queueConnectionMatches(thread, state))
        throw new Error('Select this thread’s machine and project to send its queued message.')
      if (lifeTurns.current.get(thread.id)?.finishing)
        throw new Error('Life is saving this change. The follow-up will remain queued.')
      lifeTurns.current.delete(thread.id)
      await api.agent.stop(thread.id)
      setThreads((previous) =>
        previous.map((item) =>
          item.id === thread.id && item.turn === thread.turn
            ? { ...item, busy: false, pending: [] }
            : item,
        ),
      )
    },
  })
  const runChoices = active ? runningChoices.current.get(active.id) : undefined
  const choicesChanged =
    busy &&
    Boolean(runChoices) &&
    (currentModel !== (runChoices?.model || '') ||
      currentReasoningEffort !== (runChoices?.reasoningEffort || '') ||
      currentServiceTier !== (runChoices?.serviceTier || ''))
  const waitingMessage = active?.queue?.[0]
  const queueing =
    busy ||
    Boolean(
      active &&
      (queue.sendingThreadId ||
        (waitingMessage && !waitingMessage.paused && !waitingMessage.error)),
    )
  const queueControlsReady =
    Boolean(active && queueConnectionMatches(active, connection)) &&
    !applyingLife &&
    !restoringThreadId.current &&
    !threadContext.current.busy &&
    !submitting.current &&
    !attachmentTransfer.current &&
    !sourceReloading.current &&
    !queue.preparing &&
    !queue.actionId
  const refreshProfiles = useCallback(() => {
    void api?.profiles
      .list()
      .then((saved) => {
        profilesCurrent.current = saved
        setProfiles(saved)
        setProfilesLoaded(true)
      })
      .catch((e) => setToast(errorText(e)))
  }, [])

  async function restoreThreadContext(thread: Thread): Promise<boolean> {
    if (!startupReady || emergencyReview.current) return false
    if (!api || thread.profileId === 'life-local') return Boolean(api)
    if (activeIdCurrent.current !== thread.id) return false
    const operation = ++threadContextOperation.current
    restoringThreadId.current = thread.id
    setOpeningThread(thread.id)
    try {
      const result = await threadContext.current.restore(
        thread,
        profilesCurrent.current,
        api.connection,
      )
      if (activeIdCurrent.current !== thread.id || operation !== threadContextOperation.current)
        return false
      if (result.kind === 'ready') {
        lifeContext.current.connection = result.connection
        setConnection(result.connection)
        setProjectOpen(false)
        return true
      }
      if (result.kind === 'credentials') {
        setRequestedProfileId(result.profileId)
        setConnectOpen(true)
      } else if (result.kind === 'project') {
        setSuggestedProject(result.path)
        setProjectOpen(true)
        if (result.error) setToast(errorText(result.error))
      } else if (result.kind === 'unavailable') setToast(errorText(result.error))
      return false
    } catch (error) {
      if (activeIdCurrent.current === thread.id) setToast(errorText(error))
      return false
    } finally {
      if (operation === threadContextOperation.current) {
        restoringThreadId.current = undefined
        setOpeningThread(undefined)
      }
      queue.wake()
    }
  }

  function cancelThreadContext() {
    threadContext.current.cancel()
    threadContextOperation.current++
    restoringThreadId.current = undefined
    setOpeningThread(undefined)
  }

  function reviewRecoveredExtensions() {
    if (recoveryReviewed.current) return
    recoveryReviewed.current = true
    // Emergency recovery intentionally disconnects SSH. Late startup/context
    // results must not reconnect it or obscure the single recovery review.
    emergencyReview.current = true
    cancelThreadContext()
    activeIdCurrent.current = undefined
    setActiveId(undefined)
    setRequestedProfileId(undefined)
    setSuggestedProject(undefined)
    setConnectOpen(false)
    setProjectOpen(false)
    setHostKey(undefined)
    setCustomizeOpen(false)
    setSourceCodeOpen(false)
    setUpdatesOpen(false)
    setPortsOpen(false)
    setHelpOpen(false)
    setSearchOpen(false)
    setSidebarFiltersOpen(false)
    setThreadMenu(false)
    setExtensionRecovery(true)
    setView('research')
    setExtensionsOpen(true)
  }

  useEffect(() => {
    if (!api?.window.initialRecovery) return
    let disposed = false
    // StrictMode mounts effects twice; consume the native intent only once.
    initialRecoveryRequest.current ||= api.window.initialRecovery()
    void initialRecoveryRequest.current
      .then((recovery) => {
        if (disposed) return
        if (recovery) reviewRecoveredExtensions()
        setStartupReady(true)
        queue.wake()
      })
      .catch((error) => {
        if (!disposed) setToast(errorText(error))
      })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('life.active-thread.v1', activeId)
      else localStorage.removeItem('life.active-thread.v1')
    } catch {
      /* The conversation remains usable when browser storage is full. */
    }
  }, [activeId])

  useEffect(() => {
    if (!startupReady || !profilesLoaded || !activeId || !api || emergencyReview.current) return
    const thread = threadsCurrent.current.find((item) => item.id === activeId)
    if (thread && thread.profileId !== 'life-local') void restoreThreadContext(thread)
  }, [activeId, profilesLoaded, startupReady])

  useEffect(() => {
    if (!api) return
    return api.extensions.onRecovery(reviewRecoveredExtensions)
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
          previous.map((thread) => ({
            ...thread,
            ...(interrupted.has(thread.id) ? { busy: false, pending: [] } : {}),
            queue: pauseQueuedMessages(thread.queue),
          })),
        )
      }
    }
    void api.connection.state().then(updateConnection)
    const offConnection = api.onConnection(updateConnection)
    const offHost = api.onHostKey(setHostKey)
    const offAgent = api.onAgent((event) => {
      if (event.type === 'complete' || event.type === 'error')
        runningChoices.current.delete(event.sessionId)
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
          return applyLife
            ? {
                ...next,
                busy: true,
                messages: next.messages.map((message) =>
                  message.role === 'user' && message.turn === t.turn
                    ? { ...message, finishedAt: undefined, finishStatus: undefined }
                    : message,
                ),
              }
            : next
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
          const finished = finishThreadTurn(thread, failure ? 'failed' : 'completed')
          const messages = finished.messages
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
          return {
            ...thread,
            messages,
            busy: false,
            pending: [],
            queue: failure ? pauseQueuedMessages(thread.queue) : thread.queue,
          }
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
      runningChoices.current.set(id, {
        model: lifeTurn.start.model || '',
        reasoningEffort: lifeTurn.start.reasoningEffort || '',
        serviceTier: lifeTurn.start.serviceTier || '',
      })
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
        const fileChanges = summarizeSourceChanges(response.patch, lifeTurn.source)
        setThreads((previous) =>
          previous.map((thread) =>
            thread.id === id && thread.turn === lifeTurn.turn
              ? {
                  ...thread,
                  messages: thread.messages.map((item) =>
                    item.role === 'user' && item.turn === lifeTurn.turn
                      ? { ...item, fileChanges }
                      : item,
                  ),
                }
              : thread,
          ),
        )
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
      sourceReloading.current = true
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
        sourceReloading.current = false
        queue.wake()
        setToast(`Life saved the compiled source but could not reload: ${errorText(error)}`)
      }
      return
    }
    completeLifeTurn(id, lifeTurn, message, failure)
  }
  useEffect(() => {
    const unload = () => {
      sourceReloading.current = true
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
      const thread = threadsCurrent.current.find((item) => item.id === activeIdCurrent.current)
      if (thread?.workspace && thread.profileId === connection.profile?.id) {
        if (startupReady && !emergencyReview.current && !restoringThreadId.current)
          void restoreThreadContext(thread)
      } else if (startupReady && !emergencyReview.current && !restoringThreadId.current) {
        setSuggestedProject(undefined)
        setProjectOpen(true)
      }
    } else if (!connected) {
      setProjectOpen(false)
    }
    setTerminalOpen(false)
  }, [connected, connection.profile?.id, connection.workspace, startupReady])
  useEffect(() => {
    if (stickToBottom && conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight
  }, [active?.messages, active?.pending, active?.queue, stickToBottom])
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
    emergencyReview.current = false
    cancelThreadContext()
    if (!attachmentTransfer.current) submitting.current = undefined
    setView('workspace')
    activeIdCurrent.current = undefined
    setActiveId(undefined)
    setDraft('')
    setAttachments([])
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
        sidebarFiltersOpen ||
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
    sidebarFiltersOpen,
    customizeOpen,
    portsOpen,
    updatesOpen,
    extensionsOpen,
    sourceCodeOpen,
  ])
  function attachFiles(files: File[]) {
    if (!files.length) return
    if (attachmentTransfer.current || queue.preparing) {
      setToast(
        'Wait for the current upload or attachment preparation to finish before attaching more files.',
      )
      return
    }
    const selected = selectDraftAttachments(attachments, files)
    setAttachments(selected.attachments)
    if (selected.errors.length) setToast(selected.errors.join(' '))
  }

  async function send(queued?: QueuedSubmission): Promise<boolean | undefined> {
    if (!startupReady) return
    const active = threadsCurrent.current.find(
      (thread) => thread.id === (queued?.threadId || activeIdCurrent.current),
    )
    const queuedMessage = queued
      ? active?.queue?.find((item) => item.id === queued.messageId)
      : undefined
    if (queued && (!active || !queuedMessage || active.busy)) return
    if (!queued && !draft.trim() && !attachments.length) return
    const selectedAttachments = queued ? queued.files : [...attachments]
    const prompt = queued
      ? queuedMessage!.text
      : draft.trim() || 'Please review the attached files.'
    let connection = lifeContext.current.connection
    let connected = connection.status === 'connected'
    let projectReady = connected && Boolean(connection.workspace)
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
    if (
      !queued &&
      active &&
      (active.busy ||
        queue.sendingThreadId ||
        (active.queue?.[0] && !active.queue[0].paused && !active.queue[0].error))
    ) {
      const queuedId = await queue.enqueue(active, prompt, selectedAttachments)
      if (queuedId) {
        if (activeIdCurrent.current === active.id)
          setDraft((current) => (current === draft ? '' : current))
        const savedIds = new Set(selectedAttachments.map((item) => item.id))
        setAttachments((current) => current.filter((item) => !savedIds.has(item.id)))
        setStickToBottom(true)
      }
      return
    }
    if (submitting.current || sourceReloading.current || (!queued && queue.sendingThreadId)) {
      if (!queued) setToast('A message is being prepared. Try again shortly.')
      return
    }
    const localPatch =
      isLife && !selectedAttachments.length ? planLocalCustomization(userRequest, config) : null
    const offlineLocal = Boolean(localPatch) && (!projectReady || !api)
    if (
      !offlineLocal &&
      active &&
      active.profileId !== 'life-local' &&
      !queueConnectionMatches(active, connection)
    ) {
      // Queue pumping never changes a workspace behind another thread. Direct
      // sends restore their already saved context before consuming the draft.
      if (queued) return
      const preparation = { id: active.id }
      submitting.current = preparation
      let ready = false
      try {
        ready = await restoreThreadContext(active)
      } finally {
        if (submitting.current === preparation) submitting.current = undefined
      }
      if (!ready || activeIdCurrent.current !== active.id) return
      connection = lifeContext.current.connection
      connected = connection.status === 'connected'
      projectReady = connected && Boolean(connection.workspace)
    }
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
      !queueConnectionMatches(active, connection)
    )
      return
    const userMessageId = crypto.randomUUID()
    const transfer = selectedAttachments.length
      ? { id: '', controller: new AbortController() }
      : undefined
    const submission = { id: active?.id }
    submitting.current = submission
    if (!queued) {
      setDraft('')
      setStickToBottom(true)
    }
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
      activeIdCurrent.current = thread.id
      setActiveId(thread.id)
    }
    const id = thread.id
    submission.id = id
    if (transfer) {
      transfer.id = id
      attachmentTransfer.current = transfer
      setAttachmentProgress({ id, percent: 0 })
    }
    const turn = thread.turn + 1
    const next: Thread = {
      ...thread,
      profileId: offlineLocal ? thread.profileId : connection.profile!.id,
      workspace: offlineLocal ? thread.workspace : connection.workspace,
      turn,
      busy: true,
      lifeScope: isLife,
      settled: false,
      snoozedUntil: undefined,
      updatedAt: Date.now(),
      messages: [
        ...thread.messages,
        { id: userMessageId, role: 'user', text: prompt, turn, createdAt: Date.now() },
      ],
    }
    setThreads((previous) => {
      const current = previous.find((item) => item.id === id)
      return [
        {
          ...next,
          model: current?.model ?? next.model,
          reasoningEffort: current?.reasoningEffort ?? next.reasoningEffort,
          serviceTier: current?.serviceTier ?? next.serviceTier,
          queue: queued
            ? (current?.queue || []).filter((item) => item.id !== queued.messageId)
            : current?.queue,
        },
        ...previous.filter((item) => item.id !== id),
      ]
    })
    let lifeSubmission: LifeTurn | undefined
    try {
      if (transfer) {
        if (transfer.controller.signal.aborted)
          throw new DOMException('Attachment upload cancelled.', 'AbortError')
        await saveAttachmentFiles(selectedAttachments)
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === userMessageId
                      ? { ...message, attachments: selectedAttachments.map(attachmentMetadata) }
                      : message,
                  ),
                }
              : item,
          ),
        )
      }
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
                    ...finishThreadTurn(item, 'completed').messages,
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
        return true
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
      if (transfer) {
        const uploaded = await ensureAttachmentUploads(
          selectedAttachments,
          connection,
          transfer.controller.signal,
          (percent) =>
            setAttachmentProgress((current) => (current?.id === id ? { id, percent } : current)),
        )
        input.prompt = attachmentPrompt(input.prompt, uploaded)
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? {
                  ...item,
                  messages: item.messages.map((message) =>
                    message.id === userMessageId ? { ...message, attachments: uploaded } : message,
                  ),
                }
              : item,
          ),
        )
      }
      if (isLife) {
        const lifeTurn: LifeTurn = {
          turn,
          parts: new Map(),
          finishing: false,
          request: input.prompt,
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
          input.prompt,
          config,
          extensions.extensions,
          api!.extensions.capabilities,
          { source },
        )
      }
      if (transfer?.controller.signal.aborted)
        throw new DOMException('Attachment upload cancelled.', 'AbortError')
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      if (sourceReloading.current)
        throw new Error('Life is reloading. The queued message will be paused.')
      const actualConnection = await api!.connection.state()
      if (
        actualConnection.status !== 'connected' ||
        actualConnection.profile?.id !== connection.profile?.id ||
        actualConnection.workspace !== input.workspace
      )
        throw new Error('The connection or project changed before the message could be sent.')
      const latestChoices = threadsCurrent.current.find((item) => item.id === id)
      input.model = latestChoices?.model ?? input.model
      input.reasoningEffort = latestChoices?.reasoningEffort ?? input.reasoningEffort
      input.serviceTier = latestChoices?.serviceTier ?? input.serviceTier
      runningChoices.current.set(id, {
        model: input.model || '',
        reasoningEffort: input.reasoningEffort || '',
        serviceTier: input.serviceTier || '',
      })
      await api!.agent.start(input)
      if (selectedAttachments.length) {
        const sentIds = new Set(selectedAttachments.map((item) => item.id))
        setAttachments((current) => current.filter((item) => !sentIds.has(item.id)))
      }
      return true
    } catch (e) {
      if (!queued && selectedAttachments.length && activeIdCurrent.current === id)
        setDraft((current) => current || prompt)
      if (transfer?.controller.signal.aborted) {
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? applyEvent(item, { sessionId: id, type: 'complete', status: 'interrupted' })
              : item,
          ),
        )
        lifeTurns.current.delete(id)
        return
      }
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
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      if (transfer) setAttachmentProgress((current) => (current?.id === id ? undefined : current))
      if (submitting.current === submission) submitting.current = undefined
      queue.wake()
    }
  }
  async function applyRunSettings() {
    const thread = threadsCurrent.current.find((item) => item.id === activeIdCurrent.current)
    if (!thread?.busy || !queueControlsReady) return
    const messageId = await queue.enqueue(
      thread,
      'Continue my most recent request using the selected model, reasoning effort, and speed settings. Continue from the work already completed.',
      [],
    )
    if (messageId) await queue.sendNow(thread.id, messageId)
  }
  async function stop() {
    if (!active || !api) return
    if (lifeTurns.current.get(active.id)?.finishing) return
    queue.pause(active.id)
    if (attachmentTransfer.current?.id === active.id) {
      attachmentTransfer.current.controller.abort()
      return
    }
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
    } finally {
      queue.wake()
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
    emergencyReview.current = false
    setView('workspace')
    activeIdCurrent.current = thread.id
    setActiveId(thread.id)
    setDraft('')
    setAttachments([])
    setSearchOpen(false)
    setQuery('')
    setStickToBottom(true)
    setThreadMenu(false)
    setProjectOpen(false)
    if (thread.profileId === 'life-local') cancelThreadContext()
    else if (profilesLoaded) void restoreThreadContext(thread)
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
  const composerMetadata =
    active?.profileId === connection.profile?.id && active?.workspace === connection.workspace
      ? active
      : threads.find(
          (thread) =>
            projectReady &&
            thread.profileId === connection.profile?.id &&
            thread.workspace === connection.workspace &&
            thread.gitBranch,
        )

  return (
    <div
      className={`app-shell life-desktop-layout life-unified-layout life-refined-layout life-polished-layout life-bottom-brand-layout life-header-actions-layout ${replacement ? 'life-replacement-active' : ''} ${!sidebarOpen ? 'sidebar-hidden' : ''} ${!workspaceOpen || view !== 'workspace' || replacement ? 'workspace-hidden' : ''}`}
      data-platform={platform}
      data-panel-size={config.workspacePanelWidth === 320 ? 'adaptive' : 'custom'}
      data-sidebar-size={config.sidebarWidth === 260 ? 'adaptive' : 'custom'}
      style={panels.style}
    >
      <TitleBar
        theme={config.theme}
        researchTitle={researchTitle}
        workspaceTitle={workspaceTitle}
        platform={platform}
        maximized={maximized}
        sidebarOpen={sidebarOpen}
        onSidebarToggle={replacement ? undefined : () => setSidebarOpen((open) => !open)}
        view={view}
        onViewChange={replacement ? undefined : setView}
        contentRef={setTitleBarContent}
        surfaceContentRef={setSurfaceHeader}
        leadingActionsRef={setHeaderLeadingActions}
        onThemeToggle={() => {
          void preferences
            .apply({ theme: config.theme === 'dark' ? 'light' : 'dark' })
            .catch((error) => setToast(errorText(error)))
        }}
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
          <aside className="sidebar" id="life-sidebar" aria-label="Projects and threads">
            {sidebarOpen ? <ResizeHandle {...panels.left} /> : null}
            <SidebarProjects
              threads={threads}
              profiles={profiles}
              connection={connection}
              activeId={activeId}
              onSelect={selectThread}
              onArrange={(thread, patch) =>
                setThreads((previous) =>
                  previous.map((item) => (item.id === thread.id ? { ...item, ...patch } : item)),
                )
              }
              onNewThread={newThread}
              shortcutModifier={shortcutModifier}
              filtersOpen={sidebarFiltersOpen}
              onFiltersOpenChange={setSidebarFiltersOpen}
              footerTarget={sidebarFooter}
              onAddProject={() => {
                cancelThreadContext()
                setRequestedProfileId(undefined)
                if (connected) {
                  setSuggestedProject(undefined)
                  setProjectOpen(true)
                } else setConnectOpen(true)
              }}
              onOpenProfile={(profileId) => {
                if (connection.profile?.id !== profileId || !connected) {
                  setRequestedProfileId(profileId)
                  setConnectOpen(true)
                } else newThread()
              }}
            >
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
            </SidebarProjects>
            <div className="sidebar-bottom">
              <div className="sidebar-arrangement-target" ref={setSidebarFooter} />
              <div className="sidebar-tool-row" aria-label="Life tools">
                {!sidebarOpen ? <LifeBrand className="sidebar-footer-brand" /> : null}
                <div className="sidebar-tool-actions">
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
                    <Cable size={16} />
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
                <button
                  type="button"
                  className="icon-button sidebar-collapse-control"
                  aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  aria-expanded={sidebarOpen}
                  aria-controls="life-sidebar"
                  title={`${sidebarOpen ? 'Collapse' : 'Expand'} sidebar (${shortcutModifier}+B)`}
                  onClick={() => setSidebarOpen((open) => !open)}
                >
                  <PanelLeft size={16} />
                </button>
              </div>
            </div>
          </aside>
          {view === 'extension' && selectedView ? (
            <main className="extension-view-main" id="main-content">
              <TitleBarContent target={titleBarContent}>
                <header className="workspace-header">
                  <div className="breadcrumbs">
                    <Code2 size={15} />
                    <strong>{selectedView.name}</strong>
                  </div>
                  <button className="button secondary" onClick={() => setExtensionsOpen(true)}>
                    Manage extensions
                  </button>
                </header>
              </TitleBarContent>
              {extensionHost(selectedView)}
            </main>
          ) : view === 'research' ? (
            <main className="research-main" id="main-content">
              <TitleBarContent target={titleBarContent}>
                <header className="workspace-header">
                  <div className="breadcrumbs">
                    <Network size={16} />
                    <strong>{researchTitle}</strong>
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
              </TitleBarContent>
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
              <TitleBarContent target={titleBarContent}>
                <header className="workspace-header">
                  <div className="breadcrumbs">
                    {active ? (
                      <span className="header-project-badge" aria-hidden="true">
                        <ThreadBadge thread={active} />
                      </span>
                    ) : (
                      <Folder size={15} />
                    )}
                    <span title={active?.workspace || connection.workspace}>
                      {(active?.workspace || connection.workspace)
                        ?.split('/')
                        .filter(Boolean)
                        .pop() ||
                        titleProfile?.name ||
                        workspaceTitle}
                    </span>
                    <span className="breadcrumb-separator" aria-hidden="true">
                      /
                    </span>
                    <strong>{active?.title || 'New thread'}</strong>
                  </div>
                  <div className="header-actions thread-header-actions">
                    <span className={`connection-pill ${connected ? 'connected' : ''}`}>
                      <span className={`status-dot ${connected ? 'online' : ''}`} />
                      {openingThread
                        ? 'Opening thread'
                        : connection.status === 'connecting'
                          ? 'Connecting'
                          : connected
                            ? 'SSH connected'
                            : 'Offline'}
                    </span>
                    {!workspaceOpen ? (
                      <TitleBarContent target={headerLeadingActions}>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Expand workspace sidebar"
                          title="Expand workspace sidebar"
                          aria-expanded={false}
                          onClick={() => setWorkspaceOpen(true)}
                        >
                          <PanelRight size={16} />
                        </button>
                      </TitleBarContent>
                    ) : null}
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
                                const retained = new Set(
                                  threads
                                    .filter((item) => item.id !== active.id)
                                    .flatMap(threadAttachmentIds),
                                )
                                const removed = threadAttachmentIds(active).filter(
                                  (id) => !retained.has(id),
                                )
                                void deleteAttachmentFiles(removed).catch((error) =>
                                  setToast(errorText(error)),
                                )
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
              </TitleBarContent>
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
                {active ? (
                  <ThreadMessageNavigator
                    key={active.id}
                    messages={active.messages}
                    conversation={conversation}
                    onJump={() => setStickToBottom(false)}
                  />
                ) : null}
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
                      <ThreadTimeline thread={active} />
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
                            : attachmentProgress?.id === active.id
                              ? `Uploading attachments (${attachmentProgress.percent}%)`
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
                      <QueuedMessages
                        messages={active.queue || []}
                        working={busy}
                        canSendNow={queueControlsReady}
                        actionId={queue.actionId}
                        onSendNow={(id) => void queue.sendNow(active.id, id)}
                        onRemove={(id) => queue.remove(active.id, id)}
                      />
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
                <div className="composer-container life-reference-composer">
                  {config.commands.length ? (
                    <div className="prompt-commands" aria-label="Custom prompt commands">
                      {config.commands.map((command) => (
                        <button
                          key={command.id}
                          disabled={queue.preparing || Boolean(attachmentProgress)}
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
                  {choicesChanged ? (
                    <div className="run-settings-note" role="status">
                      <span>New settings ready for the next message</span>
                      <button
                        type="button"
                        disabled={!queueControlsReady}
                        title="Interrupt the current response and continue with the selected settings"
                        onClick={() => void applyRunSettings()}
                      >
                        Apply now
                      </button>
                    </div>
                  ) : null}
                  <div
                    className={`composer ${busy ? 'busy' : ''}`}
                    onDragOver={(event) => {
                      if (event.dataTransfer.types.includes('Files')) {
                        event.preventDefault()
                        event.dataTransfer.dropEffect =
                          attachmentProgress || queue.preparing ? 'none' : 'copy'
                      }
                    }}
                    onDrop={(event) => {
                      if (event.dataTransfer.files.length) {
                        event.preventDefault()
                        event.stopPropagation()
                        attachFiles(Array.from(event.dataTransfer.files))
                      }
                    }}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files)
                      if (files.length) {
                        event.preventDefault()
                        attachFiles(files)
                      }
                    }}
                  >
                    <AttachmentList
                      attachments={attachments}
                      uploadStates={draftUploads.states}
                      onRetry={draftUploads.retry}
                      disabled={queue.preparing || Boolean(attachmentProgress)}
                      onRemove={(id) => {
                        cancelAttachmentUpload(id)
                        setAttachments((current) => current.filter((item) => item.id !== id))
                        if (
                          !threadsCurrent.current.some((thread) =>
                            threadAttachmentIds(thread).includes(id),
                          )
                        )
                          void deleteAttachmentFiles([id]).catch((error) =>
                            setToast(errorText(error)),
                          )
                      }}
                    />
                    {attachmentProgress && attachmentProgress.id === activeId ? (
                      <div className="attachment-upload-status" role="status">
                        <span>Uploading files… {attachmentProgress.percent}%</span>
                        <progress
                          value={attachmentProgress.percent}
                          max={100}
                          aria-label="Attachment upload progress"
                        />
                      </div>
                    ) : null}
                    <textarea
                      ref={textarea}
                      aria-label="Message your coding agent"
                      placeholder={
                        queueing
                          ? 'Add a follow-up to queue while the agent works…'
                          : lifeIntent
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
                      <ReferenceComposerControls
                        models={models}
                        provider={currentProvider}
                        model={currentModel}
                        reasoningEffort={currentReasoningEffort}
                        serviceTier={currentServiceTier}
                        mode={currentMode}
                        modeDisabled={busy}
                        providerDisabled={Boolean(active)}
                        onChange={updateSettings}
                        onProviderChange={(nextProvider, nextModel) => {
                          setProvider(nextProvider)
                          setModel(nextModel)
                          setReasoningEffort('')
                          setServiceTier('')
                        }}
                      />
                      <div className="composer-send-actions">
                        <AttachmentPicker
                          disabled={queue.preparing || Boolean(attachmentProgress)}
                          onFiles={attachFiles}
                        />
                        {busy ? (
                          <button
                            type="button"
                            className="send-button stop-button"
                            aria-label={
                              applyingLife
                                ? 'Applying Life change'
                                : attachmentProgress?.id === activeId
                                  ? 'Cancel attachment upload'
                                  : 'Stop agent and pause queued messages'
                            }
                            disabled={applyingLife || Boolean(queue.actionId)}
                            onClick={() => void stop()}
                          >
                            {applyingLife ? (
                              <LoaderCircle size={15} className="spinning" />
                            ) : (
                              <Square size={13} fill="currentColor" />
                            )}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`send-button ${!queueing && !projectReady ? 'connect-send' : ''}`}
                          aria-label={
                            queueing
                              ? 'Queue follow-up message'
                              : projectReady || lifeIntent
                                ? 'Send message'
                                : connected
                                  ? 'Select project to send'
                                  : 'Connect to send'
                          }
                          title={
                            queueing
                              ? 'Queue this message using the selected settings for its next turn'
                              : projectReady || lifeIntent
                                ? 'Send message'
                                : connected
                                  ? 'Select project to send'
                                  : 'Connect to send'
                          }
                          disabled={
                            queue.preparing ||
                            Boolean(attachmentProgress) ||
                            ((queueing || projectReady || lifeIntent) &&
                              !draft.trim() &&
                              !attachments.length)
                          }
                          onClick={() => {
                            if (queueing) void send()
                            else if (!connected && !lifeIntent) setConnectOpen(true)
                            else if (!projectReady && !lifeIntent) setProjectOpen(true)
                            else void send()
                          }}
                        >
                          <ArrowUp size={20} />
                        </button>
                      </div>
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
                          <Cloud size={14} />
                          <span>{connection.profile?.host}</span>
                        </>
                      ) : (
                        '/life changes Life'
                      )}
                    </span>
                    <ReferenceComposerDetails
                      thread={composerMetadata}
                      connection={connection}
                      onWorkspace={() => setWorkspaceOpen(true)}
                      onNotify={setToast}
                    />
                  </div>
                </div>
              </div>
            </main>
          )}
          {workspaceOpen && view === 'workspace' ? (
            <WorkspaceSurfaces
              key={`${connection.profile?.id || ''}:${connection.workspace || ''}`}
              headerTarget={surfaceHeader}
              theme={config.theme}
              terminalOpen={terminalOpen}
              onTerminalChange={setTerminalOpen}
              threads={threads}
              activeThread={active}
              onSelectThread={selectThread}
              resize={panels.right}
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
        onOpenChange={(open) => {
          setExtensionsOpen(open)
          if (!open) {
            emergencyReview.current = false
            queue.wake()
          }
        }}
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
        beforeSelect={() => threadContext.current.settled()}
        hasActiveTurns={threads.some(
          (thread) => thread.busy && thread.profileId === connection.profile?.id,
        )}
        onSelected={(state) => {
          emergencyReview.current = false
          cancelThreadContext()
          lifeContext.current.connection = state
          setConnection(state)
          setTerminalOpen(false)
          setView('workspace')
          refreshProfiles()
          if (
            active &&
            (active.profileId !== state.profile?.id || active.workspace !== state.workspace)
          ) {
            activeIdCurrent.current = undefined
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
