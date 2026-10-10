import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
  History,
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
  Target,
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
import { api, desktop, errorText, streamlinedWorkspace } from './api'
import { webInterface } from './web-interface'
import { webPermissionMode } from '../shared/permissions'
import './workspace-presentation.css'
import {
  applyEvent,
  resolveAgentRequest,
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
import { previewNavigableMessages } from './thread-presentation'
import { WorkspaceSurfaces } from './components/WorkspaceSurfaces'
import { ResizeHandle, usePanelSizes } from './components/SidebarResize'
import { ThreadMessageNavigator } from './components/ThreadMessageNavigator'
import { LifeBrand, TitleBar, TitleBarContent } from './components/TitleBar'
import { ActiveProject } from './components/ActiveProject'
import { CustomizationStudio } from './components/CustomizationStudio'
import { HostHistoryDialog } from './components/HostHistoryDialog'
import { hostHistoryThread, appendHostHistory } from './host-history'
import type { HostHistoryPage } from '../shared/agent-history'
import { useBuiltinFeatures } from './builtin-extensions'
import { SidebarThread } from './components/SidebarThread'
import './workspace-integration.css'
import { LifeMap as ResearchView } from './components/LifeMap'
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
import './enhancements.css'
import {
  attachmentMetadata,
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
import './components/message-attachment-layout.css'
import './components/thread-presentation-attachments.css'
import { ProjectColorsProvider } from './components/ProjectColors'
import {
  useLifeMap,
  useResearchWorkbench,
  workspaceCatalog,
  workspaceProject,
  researchConversationDirectory,
  researchConversationContext,
  researchScopeMatches,
  researchLegacyDirectories,
  type WorkspaceProject,
} from './workbench'
import {
  ResearchSidebar,
  ResearchGoalMenu,
  ResearchProblemContext,
  ResearchProblemStart,
  ResearchDialogs,
} from './components/ResearchWorkbench'
import './components/life-workbench.css'
import { ResearchLayout } from './components/ResearchLayout'
import { useConversationDrafts } from './conversation-drafts'
import './components/research-machine.css'

const providerName = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude Code')
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
  const [view, setView] = useState<
    'research' | 'workspace' | 'investigation' | 'extension' | 'customization'
  >(config.startView)
  const viewCurrent = useRef(view)
  viewCurrent.current = view
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const extensions = useExtensions()
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const returnToStudioAfterExtensions = useRef(false)
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
  const [toast, setToast] = useState('')
  const builtin = useBuiltinFeatures()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const workbench = useResearchWorkbench(
    setToast,
    connection,
    builtin.enabled('research-workbench'),
    view === 'investigation',
  )
  const [workspaceActiveId, setWorkspaceActiveId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem('life.active-thread.v1') || undefined
    } catch {
      return undefined
    }
  })
  const researchLinkedId = workbench.problem ? workbench.problem.threadId : workbench.goal?.threadId
  const researchLinkedThread = threads.find((thread) => thread.id === researchLinkedId)
  const researchUploadWorkspace = workbench.conversationDirectory
  const researchThreadMatches = Boolean(
    researchLinkedThread &&
    (!workbench.scope ||
      (researchLinkedThread.profileId === workbench.scope.profileId &&
        (!researchLinkedThread.researchContext ||
          researchLinkedThread.researchContext.scopeKey === workbench.scope.key))),
  )
  const activeId =
    view === 'investigation'
      ? researchThreadMatches
        ? researchLinkedId
        : undefined
      : workspaceActiveId
  function setActiveId(id: string | undefined) {
    if (view !== 'investigation') setWorkspaceActiveId(id)
  }
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
  const draftKey =
    view === 'investigation'
      ? JSON.stringify([
          'research',
          workbench.scopeKey,
          workbench.goal?.id || 'new',
          workbench.problem?.id || 'overview',
        ])
      : 'agents:' + (workspaceActiveId || 'new')
  const draftState = useConversationDrafts(draftKey, setToast, builtin.enabled('persistent-drafts'))
  const { draft, setDraft, attachments, setAttachments } = draftState
  const [attachmentProgress, setAttachmentProgress] = useState<{ id: string; percent: number }>()
  const attachmentTransfer = useRef<{ id: string; controller: AbortController } | undefined>(
    undefined,
  )
  const [connectOpen, setConnectOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const workspacePickerOrigin = useRef<'research' | 'investigation' | undefined>(undefined)
  const previousPickers = useRef({ connectOpen: false, projectOpen: false })
  useEffect(() => {
    const previous = previousPickers.current
    previousPickers.current = { connectOpen, projectOpen }
    if (
      !connectOpen &&
      !projectOpen &&
      (previous.projectOpen || (previous.connectOpen && connection.status === 'disconnected'))
    )
      workspacePickerOrigin.current = undefined
  }, [connectOpen, projectOpen, connection.status])
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
  const [researchAgentOpen, setResearchAgentOpen] = useState(() => {
    try {
      return localStorage.getItem('life.research.agent-sidebar-open.v1') !== 'false'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('life.research.agent-sidebar-open.v1', String(researchAgentOpen))
    } catch {
      /* The toggle remains usable. */
    }
  }, [researchAgentOpen])
  const [researchAgentWidth, setResearchAgentWidth] = useState(440)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const panels = usePanelSizes(config.sidebarWidth, config.workspacePanelWidth, sidebarOpen, 0)
  useEffect(() => {
    if (terminalOpen) {
      setWorkspaceOpen(true)
      setView('workspace')
    }
  }, [terminalOpen])
  const [refreshKey, setRefreshKey] = useState(0)
  const lifeMap = useLifeMap(setToast, builtin.enabled('project-map'))
  const agentThreads = threads.filter(
    (thread) => !thread.purpose && !workbench.linkedThreadIds.has(thread.id),
  )
  useEffect(() => {
    setThreads((previous) => {
      const next = previous.map((thread) => {
        const context = workbench.contextForThread(thread.id)
        return context && thread.purpose !== 'research'
          ? {
              ...thread,
              purpose: 'research' as const,
              researchContext: researchConversationContext(context.target, context.scope),
            }
          : thread
      })
      return next.some((thread, index) => thread !== previous[index]) ? next : previous
    })
  }, [workbench.scopeKey, workbench.goals])
  const legacyResearchDirectories = useMemo(
    () => researchLegacyDirectories(threads, workbench.linkedThreadIds),
    [threads, workbench.scopeKey, workbench.goals],
  )
  const sidebarProfiles = profiles.filter(
    (profile) =>
      !legacyResearchDirectories.has(profile.workspace.replace(/\/+$/, '') || '/') ||
      agentThreads.some((thread) => thread.profileId === profile.id),
  )
  const projectCatalog = useMemo(
    () => workspaceCatalog(profiles, agentThreads, connection, legacyResearchDirectories),
    [profiles, threads, connection, workbench.scopeKey, workbench.goals],
  )
  useThreadMetadata(
    connection,
    refreshKey,
    threads.length,
    setThreads,
    builtin.enabled('thread-git-metadata'),
  )
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
  const sourceReloading = useRef(false)
  const runningChoices = useRef(
    new Map<string, Pick<StartInput, 'model' | 'reasoningEffort' | 'serviceTier'>>(),
  )
  const appContext = useRef({ preferences, config, extensions, connection })
  appContext.current = { preferences, config, extensions, connection }
  const active = threads.find((t) => t.id === activeId)
  const navigableMessages = useMemo(
    () =>
      active ? (streamlinedWorkspace ? previewNavigableMessages(active) : active.messages) : [],
    [active],
  )
  useEffect(() => {
    settingsRequest.current += 1
    cancelThreadContext()
    setThreadMenu(false)
    setSettingsNote('')
    setStickToBottom(true)
  }, [view, activeId, workbench.scopeKey])
  const currentProvider = active?.provider || provider
  const currentModel = active?.model ?? model
  const currentReasoningEffort = active ? (active.reasoningEffort ?? '') : reasoningEffort
  const currentServiceTier = active ? (active.serviceTier ?? '') : serviceTier
  const currentMode = webInterface
    ? webPermissionMode(currentProvider, active?.mode || mode)
    : active?.mode || mode
  const connected = connection.status === 'connected'
  const projectReady = connected && Boolean(connection.workspace)
  const draftUploads = useDraftUploads(
    attachments,
    connection,
    builtin.enabled('thread-attachments') &&
      (view === 'investigation' ? connected && Boolean(researchUploadWorkspace) : projectReady) &&
      (!active || active.profileId === 'life-local' || queueConnectionMatches(active, connection)),
    view === 'investigation' && researchUploadWorkspace
      ? { scope: 'machine', workspace: researchUploadWorkspace }
      : undefined,
  )
  const busy = active?.busy || false
  const [settingsNote, setSettingsNote] = useState('')
  const settingsRequest = useRef(0)
  const queue = useThreadQueue({
    threads,
    connection,
    onThreads: setThreads,
    onError: setToast,
    send,
    isBlocked: (threadId) =>
      Boolean(
        !startupReady ||
        !builtin.enabled('message-queue') ||
        (threadsCurrent.current.find((thread) => thread.id === threadId)?.purpose === 'research' &&
          !builtin.enabled('research-workbench')) ||
        emergencyReview.current ||
        submitting.current ||
        attachmentTransfer.current ||
        sourceReloading.current ||
        threadContext.current.busy,
      ),
    steer: steerQueuedMessage,
  })
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
        appContext.current.connection = result.connection
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

  async function restoreResearchContext(): Promise<void> {
    const scope = workbench.scope
    if (
      !scope ||
      !api ||
      !startupReady ||
      emergencyReview.current ||
      viewCurrent.current !== 'investigation'
    )
      return
    const operation = ++threadContextOperation.current
    const id = 'research:' + scope.key
    restoringThreadId.current = id
    setOpeningThread(id)
    try {
      const result = await threadContext.current.restore(
        { id, profileId: scope.profileId, workspace: scope.root, purpose: 'research' },
        profilesCurrent.current,
        api.connection,
      )
      if (operation !== threadContextOperation.current || viewCurrent.current !== 'investigation')
        return
      if (result.kind === 'ready') {
        appContext.current.connection = result.connection
        setConnection(result.connection)
        setProjectOpen(false)
      } else if (result.kind === 'credentials') {
        workspacePickerOrigin.current = 'investigation'
        setRequestedProfileId(scope.profileId)
        setSuggestedProject(scope.workspace)
        setConnectOpen(true)
      } else if (result.kind === 'project') {
        workspacePickerOrigin.current = 'investigation'
        setSuggestedProject(result.path || scope.workspace)
        setProjectOpen(true)
        if (result.error) setToast(errorText(result.error))
      } else if (result.kind === 'unavailable') setToast(result.error)
    } catch (cause) {
      if (operation === threadContextOperation.current) setToast(errorText(cause))
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
    setWorkspaceActiveId(undefined)
    setRequestedProfileId(undefined)
    setSuggestedProject(undefined)
    setConnectOpen(false)
    setProjectOpen(false)
    setHostKey(undefined)
    setCustomizeOpen(false)
    setSourceCodeOpen(false)
    workbench.closeEditor()
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
      if (workspaceActiveId) localStorage.setItem('life.active-thread.v1', workspaceActiveId)
      else localStorage.removeItem('life.active-thread.v1')
    } catch {
      /* The conversation remains usable when browser storage is full. */
    }
  }, [workspaceActiveId])

  useEffect(() => {
    if (
      !startupReady ||
      !profilesLoaded ||
      !api ||
      emergencyReview.current ||
      (view !== 'workspace' && view !== 'investigation')
    )
      return
    const thread = threadsCurrent.current.find((item) => item.id === activeId)
    if (view === 'investigation') void restoreResearchContext()
    else if (thread && !thread.purpose && thread.profileId !== 'life-local')
      void restoreThreadContext(thread)
  }, [view, activeId, workbench.scopeKey, profilesLoaded, startupReady])

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
      appContext.current.connection = state
      setConnection(state)
      if (state.status === 'connected')
        setThreads((previous) => previous.map((thread) => bindLegacyThreadWorkspace(thread, state)))
      if (state.status === 'disconnected') setTerminalOpen(false)
    }
    void api.connection.state().then(updateConnection)
    const offConnection = api.onConnection(updateConnection)
    const offHost = api.onHostKey(setHostKey)
    const offAgent = api.onAgent((event) => {
      if (event.type === 'complete' || event.type === 'error')
        runningChoices.current.delete(event.sessionId)
      setThreads((previous) =>
        previous.map((thread) =>
          thread.id === event.sessionId ? applyEvent(thread, event) : thread,
        ),
      )
      if (event.type === 'complete') setRefreshKey((key) => key + 1)
    })
    return () => {
      offConnection()
      offHost()
      offAgent()
    }
  }, [refreshProfiles])

  function persistThreadHistory() {
    const history = threadsCurrent.current.map((thread) => ({ ...thread, pending: [] }))
    localStorage.setItem('relay.threads.v1', JSON.stringify(history))
    void api?.conversations?.save(history).catch((error) => setToast(errorText(error)))
  }
  useEffect(() => {
    const unload = () => {
      sourceReloading.current = true
      try {
        persistThreadHistory()
      } catch {
        /* Quota feedback remains visible. */
      }
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const history = threads.map((t) => ({ ...t, pending: [] }))
        localStorage.setItem('relay.threads.v1', JSON.stringify(history))
        void api?.conversations?.save(history).catch((error) => setToast(errorText(error)))
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
    if (!api || !connected || connection[currentProvider] === 'missing') {
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
    if (view !== 'workspace') return
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
  }, [connected, connection.profile?.id, connection.workspace, startupReady, view])
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
  }, [draft, view, activeId])

  const newThread = useCallback(() => {
    emergencyReview.current = false
    cancelThreadContext()
    if (!attachmentTransfer.current) submitting.current = undefined
    setView('workspace')
    activeIdCurrent.current = undefined
    setWorkspaceActiveId(undefined)
    draftState.clear('agents:new')
    setThreadMenu(false)
    setStickToBottom(true)
    textarea.current?.focus()
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        (e.target instanceof Element && Boolean(e.target.closest('[role="dialog"]'))) ||
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
        sourceCodeOpen ||
        workbench.editor
      )
        return
      const key = e.key.toLowerCase()
      if (e.metaKey || e.ctrlKey) {
        if (key === 'k') {
          e.preventDefault()
          if (view === 'investigation') {
            setSidebarOpen(true)
            window.requestAnimationFrame(() =>
              document.getElementById('life-research-search')?.focus(),
            )
          } else setSearchOpen(true)
        }
        if (key === 'n') {
          e.preventDefault()
          if (view === 'investigation') workbench.newProblem()
          else newThread()
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
    view,
    workbench.goal?.id,
    workbench.editor,
  ])
  function attachFiles(files: File[]) {
    if (!files.length || !builtin.enabled('thread-attachments')) return
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

  async function send(queued?: QueuedSubmission, intent?: 'queue'): Promise<boolean | undefined> {
    if (!startupReady) return
    const active = threadsCurrent.current.find(
      (thread) => thread.id === (queued?.threadId || activeIdCurrent.current),
    )
    const researchThreadContext =
      active?.purpose === 'research' ? workbench.contextForThread(active.id) : undefined
    const researchScope = researchThreadContext?.scope || workbench.scope
    const researchTarget = queued
      ? workbench.forThread(active?.id)
      : view === 'investigation'
        ? workbench.selection()
        : workbench.forThread(active?.id)
    const queuedMessage = queued
      ? active?.queue?.find((item) => item.id === queued.messageId)
      : undefined
    if (queued && (!active || !queuedMessage || active.busy)) return
    if (!queued && view === 'investigation' && !researchTarget) {
      workbench.newGoal()
      return
    }
    if (!queued && !draft.trim() && !attachments.length) return
    const selectedAttachments = queued ? queued.files : [...attachments]
    if (selectedAttachments.length && !builtin.enabled('thread-attachments')) {
      setToast(
        'Enable the attachments extension before sending these files. Your message and attachments are kept.',
      )
      return
    }
    const prompt = queued ? queuedMessage!.text : draft
    let connection = appContext.current.connection
    let connected = connection.status === 'connected'
    let projectReady = connected && Boolean(connection.workspace)
    if (!prompt.trim() && !selectedAttachments.length) return
    if (streamlinedWorkspace && !queued && active?.busy && intent !== 'queue') {
      await steerDraft()
      return
    }
    if (intent === 'queue' && !builtin.enabled('message-queue')) {
      setToast('Enable message queueing to queue this follow-up. Your message is kept.')
      return
    }
    if (
      !queued &&
      active &&
      (active.busy ||
        queue.sendingThreadId ||
        (active.queue?.[0] && !active.queue[0].paused && !active.queue[0].error))
    ) {
      if (!builtin.enabled('message-queue')) {
        await steerDraft()
        return
      }
      const queuedId = await queue.enqueue(
        active,
        prompt,
        selectedAttachments,
        !webInterface && researchTarget
          ? researchTarget.goal.method?.activeOperation || 'explore'
          : undefined,
      )
      if (queuedId) {
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
    if (
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
      connection = appContext.current.connection
      connected = connection.status === 'connected'
      projectReady = connected && Boolean(connection.workspace)
    }
    if (!connected || !api) {
      if (view === 'investigation' && researchTarget)
        workspacePickerOrigin.current = 'investigation'
      setConnectOpen(true)
      return
    }
    if (!projectReady && !researchTarget) {
      if (view === 'investigation' && researchTarget)
        workspacePickerOrigin.current = 'investigation'
      setSuggestedProject(active?.workspace)
      setProjectOpen(true)
      return
    }
    if (active && active.profileId !== 'life-local' && !queueConnectionMatches(active, connection))
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
        ...(researchTarget && researchScope
          ? {
              purpose: 'research' as const,
              workspace: researchConversationDirectory(researchTarget, researchScope),
              researchContext: researchConversationContext(researchTarget, researchScope),
            }
          : projectReady
            ? { workspace: connection.workspace }
            : {}),
        provider,
        title: 'New thread',
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
      if (view !== 'investigation') draftState.move('agents:new', 'agents:' + thread.id)
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
      mode: webInterface ? webPermissionMode(thread.provider, thread.mode) : thread.mode,
      profileId: connection.profile!.id,
      workspace:
        researchTarget && researchScope
          ? researchConversationDirectory(researchTarget, researchScope)
          : thread.purpose === 'research'
            ? thread.workspace
            : connection.workspace,
      ...(researchTarget && researchScope
        ? {
            purpose: 'research' as const,
            researchContext: researchConversationContext(researchTarget, researchScope),
          }
        : {}),
      turn,
      busy: true,
      lifeScope: undefined,
      turnStatus: 'running',
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
    try {
      if (
        researchTarget &&
        (researchTarget.problem
          ? researchTarget.problem.threadId
          : researchTarget.goal.threadId) !== id &&
        !workbench.linkThread(researchTarget.goal.id, researchTarget.problem?.id, id)
      )
        throw new Error(
          'Could not save this problem’s conversation. Try again after freeing local storage.',
        )
      if (researchTarget) {
        await workbench.flushForThread(id)
        const preparedWorkspace = await workbench.prepareForThread(
          id,
          webInterface
            ? undefined
            : queuedMessage?.researchOperation ||
                researchTarget.goal.method?.activeOperation ||
                'explore',
        )
        if (preparedWorkspace !== next.workspace)
          throw new Error(
            'This Research conversation changed before its context could be prepared. Your message is kept.',
          )
        if (!workbench.forThread(id))
          throw new Error(
            'This Research goal or problem changed before the message could be sent. Refresh it and try again.',
          )
      }
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
      const input: StartInput = {
        sessionId: id,
        provider: thread.provider,
        remoteId: thread.remoteId,
        workspace: next.workspace || connection.workspace,
        ...(next.purpose === 'research' ? { scope: 'research' as const } : {}),
        prompt,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort ?? '',
        serviceTier: thread.serviceTier ?? '',
        mode: next.mode,
      }
      if (transfer) {
        const uploaded = await ensureAttachmentUploads(
          selectedAttachments,
          connection,
          transfer.controller.signal,
          (percent) =>
            setAttachmentProgress((current) => (current?.id === id ? { id, percent } : current)),
          next.purpose === 'research' ? { scope: 'machine', workspace: next.workspace } : undefined,
        )
        input.attachments = uploaded
          .filter((file) => file.remotePath)
          .map((file) => ({ remotePath: file.remotePath!, name: file.name, mimeType: file.mime }))
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
      if (transfer?.controller.signal.aborted)
        throw new DOMException('Attachment upload cancelled.', 'AbortError')
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      if (sourceReloading.current)
        throw new Error('Life is reloading. The queued message will be paused.')
      const actualConnection = await api!.connection.state()
      if (
        actualConnection.status !== 'connected' ||
        actualConnection.profile?.id !== connection.profile?.id ||
        (next.purpose !== 'research' && actualConnection.workspace !== input.workspace)
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
      if (!queued) setDraft((current) => current || prompt)
      if (transfer?.controller.signal.aborted) {
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? applyEvent(item, { sessionId: id, type: 'complete', status: 'interrupted' })
              : item,
          ),
        )
        return
      }
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
  async function submitSteering(thread: Thread, prompt: string, files: DraftAttachment[]) {
    if (!api || !startupReady || submitting.current || attachmentTransfer.current) return
    const turn = thread.turn
    const submission = { id: thread.id }
    const transfer = { id: thread.id, controller: new AbortController() }
    submitting.current = submission
    if (files.length) {
      attachmentTransfer.current = transfer
      setAttachmentProgress({ id: thread.id, percent: 0 })
    }
    try {
      const start = await api.connection.state()
      if (!thread.busy || !queueConnectionMatches(thread, start))
        throw new Error('Reconnect this thread’s machine before steering.')
      await saveAttachmentFiles(files)
      const uploaded = files.length
        ? await ensureAttachmentUploads(
            files,
            start,
            transfer.controller.signal,
            (percent) =>
              setAttachmentProgress((current) =>
                current?.id === thread.id ? { id: thread.id, percent } : current,
              ),
            thread.purpose === 'research'
              ? { scope: 'machine', workspace: thread.workspace }
              : undefined,
          )
        : []
      const current = threadsCurrent.current.find((item) => item.id === thread.id)
      const state = await api.connection.state()
      if (
        transfer.controller.signal.aborted ||
        !current?.busy ||
        current.turn !== turn ||
        threadContext.current.busy ||
        !queueConnectionMatches(current, state) ||
        state.profile?.id !== start.profile?.id
      )
        throw new Error(
          'The turn or environment changed before steering was sent. Your message is kept.',
        )
      await api.agent.steer({
        sessionId: thread.id,
        prompt,
        attachments: uploaded
          .filter((file) => file.remotePath)
          .map((file) => ({ remotePath: file.remotePath!, name: file.name, mimeType: file.mime })),
      })
      return uploaded
    } finally {
      if (submitting.current === submission) submitting.current = undefined
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      setAttachmentProgress((current) => (current?.id === thread.id ? undefined : current))
      queue.wake()
    }
  }
  async function steerQueuedMessage(submission: QueuedSubmission): Promise<boolean | undefined> {
    const thread = threadsCurrent.current.find((item) => item.id === submission.threadId)
    const message = thread?.queue?.find((item) => item.id === submission.messageId)
    if (!thread || !message) return
    return (await submitSteering(thread, message.text, submission.files)) ? true : undefined
  }
  async function steerDraft() {
    const thread = threadsCurrent.current.find((item) => item.id === activeIdCurrent.current)
    const text = draft
    const files = [...attachments]
    const insertAt = thread?.messages.length || 0
    const sentAt = Date.now()
    if (!thread || (!text.trim() && !files.length)) return
    if (files.length && !builtin.enabled('thread-attachments')) {
      setToast('Enable the attachments extension before steering with these files.')
      return
    }
    try {
      const uploaded = await submitSteering(thread, text, files)
      if (!uploaded) return
      setThreads((previous) =>
        previous.map((item) =>
          item.id === thread.id
            ? {
                ...item,
                updatedAt: Date.now(),
                messages: [
                  ...item.messages.slice(0, insertAt),
                  {
                    id: crypto.randomUUID(),
                    role: 'user',
                    submission: 'steering',
                    text,
                    turn: thread.turn,
                    createdAt: sentAt,
                    attachments: uploaded,
                    ...(!item.busy
                      ? {
                          finishedAt: Date.now(),
                          finishStatus:
                            item.turnStatus === 'interrupted' ? 'interrupted' : 'completed',
                        }
                      : {}),
                  },
                  ...item.messages.slice(insertAt),
                ],
              }
            : item,
        ),
      )
      setDraft((current) => (current === text ? '' : current))
      const sent = new Set(files.map((file) => file.id))
      setAttachments((current) => current.filter((file) => !sent.has(file.id)))
    } catch (error) {
      setToast(errorText(error))
    }
  }
  async function stop() {
    if (!active || !api) return
    queue.pause(active.id)
    if (attachmentTransfer.current?.id === active.id) {
      attachmentTransfer.current.controller.abort()
      return
    }
    try {
      await api.agent.stop(active.id)
      setThreads((previous) =>
        previous.map((thread) =>
          thread.id === active.id && thread.turn === active.turn
            ? { ...thread, busy: false, turnStatus: 'interrupted', pending: [] }
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
    const request = ++settingsRequest.current
    const settingsThreadId = active?.id
    const settingsView = view
    const isCurrent = () =>
      request === settingsRequest.current &&
      activeIdCurrent.current === settingsThreadId &&
      viewCurrent.current === settingsView
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
    if (active) {
      setThreads((previous) =>
        previous.map((thread) => (thread.id === active.id ? { ...thread, ...next } : thread)),
      )
      if (api) {
        if (!webInterface) setSettingsNote('Applying settings…')
        void api.agent
          .configure({ sessionId: active.id, ...next })
          .then((result) => {
            if (!isCurrent() || webInterface) return
            setSettingsNote(
              result.note ||
                (result.applied === 'live'
                  ? 'Settings apply to the next model step in this turn.'
                  : 'Settings saved for the next request.'),
            )
          })
          .catch((error) => {
            if (!isCurrent()) return
            if (webInterface) setToast(errorText(error))
            else setSettingsNote(errorText(error))
          })
      } else if (!webInterface) setSettingsNote('Settings saved for the next request.')
    } else {
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
          t.id === active.id ? resolveAgentRequest(t, event.requestId!, accepted, answers) : t,
        ),
      )
    } catch (e) {
      setToast(errorText(e))
    }
  }
  function importHostHistory(page: HostHistoryPage) {
    if (!connection.profile) return
    const existing = threadsCurrent.current.find(
      (thread) =>
        thread.profileId === connection.profile!.id &&
        thread.provider === page.session.provider &&
        thread.remoteId === page.session.remoteId,
    )
    if (
      existing?.purpose === 'research' ||
      (existing && workbench.linkedThreadIds.has(existing.id))
    ) {
      const context = workbench.contextForThread(existing.id)
      if (!builtin.enabled('research-workbench')) {
        setToast('Enable Research to open this conversation.')
        return
      }
      if (
        !context ||
        !researchScopeMatches(context.scope, connection) ||
        !workbench.useWorkspace(connection)
      ) {
        setToast('Open this conversation from its Research goal to preserve its context.')
        return
      }
      workbench.selectGoal(context.target.goal.id)
      if (context.target.problem) workbench.selectProblem(context.target.problem.id)
      setResearchAgentOpen(true)
      setHistoryOpen(false)
      setView('investigation')
      return
    }
    if (existing?.purpose === 'customization') {
      setHistoryOpen(false)
      if (streamlinedWorkspace) setStudioOpen(true)
      else setView('customization')
      return
    }
    let imported: Thread
    try {
      const snapshot = hostHistoryThread(page, connection.profile.id, connection.home)
      imported = existing || snapshot
    } catch (error) {
      setToast(errorText(error))
      return
    }
    setThreads((previous) => [imported, ...previous.filter((thread) => thread.id !== imported.id)])
    setHistoryOpen(false)
    selectThread(imported)
  }
  async function loadMoreHostHistory() {
    if (!active?.importedHistory?.nextCursor || !api?.hostHistory || historyLoading) return
    if (connection.profile?.id !== active.profileId || !connected) {
      setConnectOpen(true)
      return
    }
    const id = active.id
    setHistoryLoading(true)
    try {
      const page = await api.hostHistory.read({
        id: `${active.provider}:${active.remoteId}`,
        cursor: active.importedHistory.nextCursor,
        requestId: crypto.randomUUID(),
      })
      setThreads((previous) =>
        previous.map((thread) => (thread.id === id ? appendHostHistory(thread, page) : thread)),
      )
    } catch (error) {
      setToast(errorText(error))
    } finally {
      setHistoryLoading(false)
    }
  }
  function openMapProject(project: WorkspaceProject) {
    const previous = threadsCurrent.current
      .filter(
        (thread) =>
          !thread.purpose &&
          thread.profileId === project.profileId &&
          thread.workspace === project.workspace,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (previous) {
      selectThread(previous)
      return
    }
    const thread: Thread = {
      id: crypto.randomUUID(),
      profileId: project.profileId,
      workspace: project.workspace,
      provider,
      title: 'New thread',
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
    setThreads((current) => [thread, ...current])
    selectThread(thread)
  }
  function selectThread(thread: Thread) {
    emergencyReview.current = false
    setView('workspace')
    activeIdCurrent.current = thread.id
    setWorkspaceActiveId(thread.id)
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
    if (method === 'ui.research.list') return workbench.goals
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
    <ProjectColorsProvider
      threads={agentThreads}
      profiles={profiles}
      connection={connection}
      projectKeys={[
        ...projectCatalog.map((project) => project.key),
        ...lifeMap.projects.map((project) => project.key),
      ]}
    >
      <div
        className={`app-shell life-desktop-layout life-unified-layout life-refined-layout life-polished-layout ${builtin.enabled('collapsed-branding') ? 'life-bottom-brand-layout' : ''} life-header-actions-layout ${replacement ? 'life-replacement-active' : ''} ${!sidebarOpen ? 'sidebar-hidden' : ''} ${!workspaceOpen || view !== 'workspace' || replacement ? 'workspace-hidden' : ''}`}
        data-view={view}
        data-research-agent-open={view === 'investigation' && researchAgentOpen && !replacement}
        data-platform={platform}
        data-panel-size={config.workspacePanelWidth === 320 ? 'adaptive' : 'custom'}
        data-sidebar-size={config.sidebarWidth === 260 ? 'adaptive' : 'custom'}
        style={
          {
            ...panels.style,
            '--life-research-panel-width': `${researchAgentWidth}px`,
          } as CSSProperties
        }
      >
        <TitleBar
          theme={config.theme}
          version={!builtin.enabled('hide-version') ? LIFE_VERSION : undefined}
          researchTitle={
            builtin.enabled('navigation-names') ? researchTitle : config.labels.researchTitle
          }
          workspaceTitle={
            builtin.enabled('navigation-names') ? workspaceTitle : config.labels.workspaceTitle
          }
          platform={platform}
          environment={{
            connection,
            savedProfile: titleProfile,
            workspace: view === 'investigation' ? workbench.scope?.root : undefined,
            scope:
              view === 'investigation'
                ? 'research'
                : view === 'customization'
                  ? 'customization'
                  : 'agents',
            onConnect: () => setConnectOpen(true),
            onChooseProject: () => {
              setSuggestedProject(undefined)
              setProjectOpen(true)
            },
            onManageConnections: () => setConnectOpen(true),
          }}
          maximized={maximized}
          sidebarOpen={sidebarOpen || view === 'research'}
          onSidebarToggle={replacement ? undefined : () => setSidebarOpen((open) => !open)}
          view={view}
          onViewChange={replacement ? undefined : setView}
          contentRef={setTitleBarContent}
          surfaceContentRef={setSurfaceHeader}
          leadingActionsRef={setHeaderLeadingActions}
          studioOpen={studioOpen}
          onStudioToggle={
            streamlinedWorkspace
              ? () => {
                  setStudioOpen((open) => !open)
                  if (replacement) {
                    setExtensionRecovery(true)
                    setView('research')
                  }
                  setProjectOpen(false)
                  setThreadMenu(false)
                }
              : undefined
          }
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
              <button
                onClick={() => {
                  if (streamlinedWorkspace) {
                    setExtensionRecovery(true)
                    setView('research')
                    setStudioOpen(true)
                  } else setExtensionsOpen(true)
                }}
              >
                {streamlinedWorkspace ? 'Customize Life' : 'Manage extensions'}
              </button>
              <small>{shortcutModifier} ⇧ L to recover</small>
            </div>
            {extensionHost(replacement)}
          </div>
        ) : (
          <div className="app-body">
            <aside
              className="sidebar"
              id="life-sidebar"
              aria-label={
                view === 'investigation' ? 'Research goals and problems' : 'Projects and threads'
              }
            >
              {sidebarOpen && builtin.enabled('sidebar-resizing') ? (
                <ResizeHandle {...panels.left} />
              ) : null}
              {view === 'investigation' ? (
                <ResearchSidebar
                  workbench={workbench}
                  threads={threads}
                  footerTarget={sidebarFooter}
                  filtersOpen={sidebarFiltersOpen}
                  onFiltersOpenChange={setSidebarFiltersOpen}
                  onChooseWorkspace={() => {
                    workspacePickerOrigin.current = 'investigation'
                    cancelThreadContext()
                    if (connected) {
                      setSuggestedProject(workbench.scope?.workspace || connection.workspace)
                      setProjectOpen(true)
                    } else {
                      setRequestedProfileId(workbench.scope?.profileId)
                      setConnectOpen(true)
                    }
                  }}
                />
              ) : builtin.enabled('project-thread-navigation') ? (
                <SidebarProjects
                  threads={agentThreads}
                  profiles={sidebarProfiles}
                  connection={connection}
                  activeId={activeId}
                  onSelect={selectThread}
                  onArrange={(thread, patch) =>
                    setThreads((previous) =>
                      previous.map((item) =>
                        item.id === thread.id ? { ...item, ...patch } : item,
                      ),
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
              ) : (
                <div className="basic-thread-list">
                  <div className="basic-thread-list-heading">
                    <strong>Threads</strong>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="New thread"
                      onClick={newThread}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  {agentThreads.map((thread) => (
                    <SidebarThread
                      key={thread.id}
                      thread={thread}
                      projectName={
                        thread.workspace?.split('/').filter(Boolean).pop() || 'Conversation'
                      }
                      active={thread.id === activeId}
                      onSelect={() => selectThread(thread)}
                    />
                  ))}
                </div>
              )}
              <div className="sidebar-bottom">
                {!streamlinedWorkspace ? (
                  <button
                    type="button"
                    className={`life-studio-entry ${view === 'customization' ? 'selected' : ''}`}
                    aria-label="Life Studio"
                    aria-pressed={view === 'customization'}
                    title="Customize Life in its dedicated workspace"
                    onClick={() => {
                      cancelThreadContext()
                      setView('customization')
                      setProjectOpen(false)
                      setThreadMenu(false)
                    }}
                  >
                    <Sparkles size={16} />
                    <span>
                      <strong>Life Studio</strong>
                      <small>Customize your application</small>
                    </span>
                    <ArrowUpRight size={13} />
                  </button>
                ) : null}

                <div className="sidebar-arrangement-target" ref={setSidebarFooter} />
                <div className="sidebar-tool-row" aria-label="Life tools">
                  {!sidebarOpen ? <LifeBrand className="sidebar-footer-brand" /> : null}
                  <div className="sidebar-tool-actions">
                    <button
                      className="icon-button"
                      aria-label="Host chat history"
                      title="Codex and Claude Code chats from this machine"
                      onClick={() => setHistoryOpen(true)}
                    >
                      <History size={16} />
                    </button>

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
                    {!streamlinedWorkspace ? (
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
                    ) : null}
                    <button
                      className="icon-button extension-sidebar-entry"
                      aria-label={`Ports ${config.autoPortForward ? 'Auto' : 'Off'}`}
                      title={`Port forwarding: ${config.autoPortForward ? 'automatic' : 'off'}`}
                      onClick={() => setPortsOpen(true)}
                    >
                      <Cable size={16} />
                    </button>
                    {!streamlinedWorkspace ? (
                      <button
                        className="icon-button extension-sidebar-entry"
                        aria-label={`Source code ${sourceUI.enabled ? 'Edited' : 'Built-in'}`}
                        title="Source code"
                        onClick={() => setSourceCodeOpen(true)}
                      >
                        <Folder size={16} />
                      </button>
                    ) : null}
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
            <CustomizationStudio
              visible={streamlinedWorkspace ? studioOpen : view === 'customization'}
              dialog={streamlinedWorkspace}
              onOpenChange={setStudioOpen}
              connection={connection}
              config={config}
              extensions={extensions}
              source={sourceUI}
              applySettings={preferences.apply}
              onNotify={setToast}
              onConnect={() => {
                if (streamlinedWorkspace) setStudioOpen(false)
                setConnectOpen(true)
              }}
              onOpenExtensions={() => {
                if (streamlinedWorkspace) {
                  returnToStudioAfterExtensions.current = true
                  setStudioOpen(false)
                }
                setExtensionsOpen(true)
              }}
              onOpenSource={() => {
                if (streamlinedWorkspace) setStudioOpen(false)
                setSourceCodeOpen(true)
              }}
              onOpenSettings={() => {
                if (streamlinedWorkspace) setStudioOpen(false)
                setCustomizeOpen(true)
              }}
            />
            {view === 'customization' ? null : (view === 'research' &&
                !builtin.enabled('project-map')) ||
              (view === 'investigation' && !builtin.enabled('research-workbench')) ? (
              <main className="feature-disabled-main">
                <h1>{view === 'research' ? 'Project Map' : 'Research'} is disabled</h1>
                <p>
                  Enable its built-in extension to use this workspace. Your projects and research
                  files are preserved.
                </p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    if (streamlinedWorkspace) setStudioOpen(true)
                    else setExtensionsOpen(true)
                  }}
                >
                  {streamlinedWorkspace ? 'Customize Life' : 'Manage extensions'}
                </button>
              </main>
            ) : view === 'extension' && selectedView ? (
              <main className="extension-view-main" id="main-content">
                <TitleBarContent target={titleBarContent}>
                  <header className="workspace-header">
                    <div className="breadcrumbs">
                      <Code2 size={15} />
                      <strong>{selectedView.name}</strong>
                    </div>
                    {!streamlinedWorkspace ? (
                      <button className="button secondary" onClick={() => setExtensionsOpen(true)}>
                        Manage extensions
                      </button>
                    ) : null}
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
                    key={extensionRecovery ? 'recovery' : 'map'}
                    map={lifeMap}
                    catalog={projectCatalog}
                    connection={connection}
                    onOpenProject={openMapProject}
                    onChooseWorkspace={() => {
                      workspacePickerOrigin.current = 'research'
                      cancelThreadContext()
                      setRequestedProfileId(undefined)
                      if (connected) {
                        setSuggestedProject(undefined)
                        setProjectOpen(true)
                      } else setConnectOpen(true)
                    }}
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
                      {view === 'investigation' ? (
                        <Target size={15} />
                      ) : active ? (
                        <span className="header-project-badge" aria-hidden="true">
                          <ThreadBadge thread={active} />
                        </span>
                      ) : (
                        <Folder size={15} />
                      )}
                      {webInterface && view === 'investigation' && workbench.goals.length ? (
                        <ResearchGoalMenu
                          workbench={workbench}
                          trigger={
                            <button
                              type="button"
                              className="research-header-goal"
                              title={workbench.goal?.goal}
                              aria-label={`Research goal: ${workbench.goal?.title || 'Choose goal'}`}
                            >
                              <span>{workbench.goal?.title || 'Research'}</span>
                              <ChevronDown size={12} aria-hidden="true" />
                            </button>
                          }
                        />
                      ) : (
                        <span
                          title={
                            view === 'investigation'
                              ? workbench.goal?.goal
                              : active?.workspace || connection.workspace
                          }
                        >
                          {view === 'investigation'
                            ? workbench.goal?.title || 'Research'
                            : (active?.workspace || connection.workspace)
                                ?.split('/')
                                .filter(Boolean)
                                .pop() ||
                              titleProfile?.name ||
                              workspaceTitle}
                        </span>
                      )}
                      <span className="breadcrumb-separator" aria-hidden="true">
                        /
                      </span>
                      <strong>
                        {view === 'investigation'
                          ? workbench.problem?.title || 'Goal overview'
                          : active?.title || 'New thread'}
                      </strong>
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
                      {view === 'investigation' ? (
                        <TitleBarContent target={headerLeadingActions}>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={
                              researchAgentOpen
                                ? 'Collapse research agent sidebar'
                                : 'Expand research agent sidebar'
                            }
                            title={
                              researchAgentOpen
                                ? 'Collapse research agent sidebar'
                                : 'Expand research agent sidebar'
                            }
                            aria-expanded={researchAgentOpen}
                            aria-controls="life-research-agent-sidebar"
                            onClick={() => setResearchAgentOpen((open) => !open)}
                          >
                            <PanelRight size={16} />
                          </button>
                        </TitleBarContent>
                      ) : !workspaceOpen ? (
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
                                  if (
                                    view === 'investigation' &&
                                    !workbench.unlinkThread(active.id)
                                  )
                                    return
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
                                  if (view !== 'investigation') newThread()
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
                <ResearchLayout
                  enabled={view === 'investigation'}
                  open={researchAgentOpen}
                  onOpenChange={setResearchAgentOpen}
                  headerTarget={surfaceHeader}
                  onSidebarWidthChange={setResearchAgentWidth}
                  workbench={workbench}
                  threads={threads}
                >
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
                  {view === 'investigation' && workbench.problem ? (
                    <ResearchProblemContext workbench={workbench} />
                  ) : null}
                  <div className="chat-area">
                    {active &&
                    builtin.enabled('message-navigation') &&
                    !(webInterface && view === 'investigation') ? (
                      <ThreadMessageNavigator
                        key={active.id}
                        messages={navigableMessages}
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
                      {!active && view === 'investigation' ? (
                        !webInterface ? (
                          <ResearchProblemStart
                            problem={workbench.problem}
                            goal={workbench.goal}
                            onNewGoal={workbench.newGoal}
                            provider={provider}
                            onProvider={(next) => {
                              setProvider(next)
                              setModel('')
                              setReasoningEffort('')
                              setServiceTier('')
                            }}
                          />
                        ) : null
                      ) : !active ? (
                        <ActiveProject
                          connection={connection}
                          savedProfile={titleProfile}
                          onConnect={() => setConnectOpen(true)}
                          onChooseProject={() => {
                            setSuggestedProject(undefined)
                            setProjectOpen(true)
                          }}
                        >
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
                        </ActiveProject>
                      ) : (
                        <div className="messages">
                          {active.importedHistory?.nextCursor ? (
                            <div className="host-history-more" role="status">
                              <span>More messages are available in this host conversation.</span>
                              <button
                                type="button"
                                className="button secondary"
                                disabled={historyLoading}
                                onClick={() => void loadMoreHostHistory()}
                              >
                                {historyLoading ? 'Loading history…' : 'Load more history'}
                              </button>
                            </div>
                          ) : null}
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
                              {attachmentProgress?.id === active.id
                                ? `Uploading attachments (${attachmentProgress.percent}%)`
                                : `${providerName(currentProvider)} is working`}
                              <span>
                                {active.turnStatus === 'reconnecting'
                                  ? 'waiting for the machine to reconnect'
                                  : 'on your remote machine'}
                              </span>
                            </div>
                          ) : null}
                          {builtin.enabled('message-queue') ? (
                            <QueuedMessages
                              messages={active.queue || []}
                              working={busy}
                              canSendNow={queueControlsReady}
                              actionId={queue.actionId}
                              onSendNow={(id) => void queue.sendNow(active.id, id)}
                              onRemove={(id) => queue.remove(active.id, id)}
                            />
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
                      {!webInterface && settingsNote ? (
                        <div className="run-settings-note" role="status">
                          {settingsNote}
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
                          aria-label={
                            view === 'investigation'
                              ? `Message ${providerName(currentProvider)} about ${workbench.problem?.title || workbench.goal?.title || 'research'}`
                              : 'Message your coding agent'
                          }
                          disabled={view === 'investigation' && !workbench.goal}
                          placeholder={
                            view === 'investigation' && !workbench.goal
                              ? 'Create a goal to begin…'
                              : streamlinedWorkspace && busy
                                ? 'Send an update… Enter to steer · Tab to queue'
                                : queueing
                                  ? 'Add a follow-up to queue while the agent works…'
                                  : view === 'investigation'
                                    ? `Ask ${providerName(currentProvider)} about this ${workbench.problem ? 'problem' : 'goal'}…`
                                    : projectReady
                                      ? 'Ask for changes, explore ideas, or send a follow-up…'
                                      : connected
                                        ? 'Choose a project to start a thread…'
                                        : 'Connect a machine to start a thread…'
                          }
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (
                              streamlinedWorkspace &&
                              busy &&
                              e.key === 'Tab' &&
                              !e.shiftKey &&
                              !e.ctrlKey &&
                              !e.metaKey &&
                              !e.altKey &&
                              !e.nativeEvent.isComposing &&
                              (draft.trim() || attachments.length)
                            ) {
                              e.preventDefault()
                              void send(undefined, 'queue')
                              return
                            }
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
                            modeDisabled={false}
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
                            {busy && !streamlinedWorkspace ? (
                              <button
                                type="button"
                                className="composer-steer"
                                aria-label="Steer current response"
                                title={
                                  !webInterface && active?.purpose === 'research'
                                    ? 'Steer the current Research operation. The toolbar approach applies to a new turn.'
                                    : 'Send your message to the current turn without interrupting it'
                                }
                                disabled={
                                  !queueControlsReady || (!draft.trim() && !attachments.length)
                                }
                                onClick={() => void steerDraft()}
                              >
                                Steer
                              </button>
                            ) : null}

                            {!(webInterface && view === 'investigation') ? (
                              <AttachmentPicker
                                disabled={queue.preparing || Boolean(attachmentProgress)}
                                onFiles={attachFiles}
                              />
                            ) : null}
                            {busy ? (
                              <button
                                type="button"
                                className="send-button stop-button"
                                aria-label={
                                  attachmentProgress?.id === activeId
                                    ? 'Cancel attachment upload'
                                    : 'Stop agent and pause queued messages'
                                }
                                disabled={Boolean(queue.actionId)}
                                onClick={() => void stop()}
                              >
                                <Square size={13} fill="currentColor" />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`send-button ${streamlinedWorkspace && busy ? 'steer-send' : ''} ${!queueing && !projectReady ? 'connect-send' : ''}`}
                              aria-keyshortcuts="Enter"
                              aria-label={
                                streamlinedWorkspace && busy
                                  ? 'Steer current response'
                                  : queueing
                                    ? 'Queue follow-up message'
                                    : projectReady || view === 'investigation'
                                      ? 'Send message'
                                      : connected
                                        ? 'Select project to send'
                                        : 'Connect to send'
                              }
                              title={
                                streamlinedWorkspace && busy
                                  ? 'Steer current response (Enter). Queue this message with Tab.'
                                  : queueing
                                    ? 'Queue this message using the selected settings for its next turn'
                                    : projectReady || view === 'investigation'
                                      ? 'Send message'
                                      : connected
                                        ? 'Select project to send'
                                        : 'Connect to send'
                              }
                              disabled={
                                (streamlinedWorkspace && busy && !queueControlsReady) ||
                                queue.preparing ||
                                Boolean(attachmentProgress) ||
                                ((queueing || projectReady || view === 'investigation') &&
                                  !draft.trim() &&
                                  !attachments.length)
                              }
                              onClick={() => {
                                if (
                                  view === 'investigation' ||
                                  queueing ||
                                  (streamlinedWorkspace && busy)
                                )
                                  void send()
                                else if (!connected) setConnectOpen(true)
                                else if (!projectReady) setProjectOpen(true)
                                else void send()
                              }}
                            >
                              <ArrowUp size={20} />
                            </button>
                          </div>
                        </div>
                      </div>
                      {!(webInterface && view === 'investigation') ? (
                        <div className="composer-caption composer-worktree-strip">
                          <span>
                            <span className={`status-dot ${connected ? 'online' : ''}`} />
                            {view === 'investigation' ? (
                              <button
                                className="composer-project-control"
                                aria-label="Edit research goal"
                                title={workbench.goal?.goal || 'New research goal'}
                                onClick={workbench.goal ? workbench.editGoal : workbench.newGoal}
                              >
                                <Target size={13} />
                                <span>{workbench.goal?.title || 'New goal'}</span>
                              </button>
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
                              'No machine connected'
                            )}
                          </span>
                          <ReferenceComposerDetails
                            thread={composerMetadata}
                            connection={connection}
                            onWorkspace={() => setWorkspaceOpen(true)}
                            onNotify={setToast}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </ResearchLayout>
              </main>
            )}
            {workspaceOpen && view === 'workspace' && builtin.enabled('workspace-surfaces') ? (
              <WorkspaceSurfaces
                key={`${connection.profile?.id || ''}:${connection.workspace || ''}`}
                headerTarget={surfaceHeader}
                theme={config.theme}
                terminalOpen={terminalOpen}
                onTerminalChange={setTerminalOpen}
                threads={agentThreads}
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
              if (streamlinedWorkspace && returnToStudioAfterExtensions.current) {
                returnToStudioAfterExtensions.current = false
                setStudioOpen(true)
              }
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
        <HostHistoryDialog
          key={connection.profile?.id || 'no-machine'}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          api={api?.hostHistory}
          connected={connected}
          onImport={importHostHistory}
          existingIds={threads
            .filter((thread) => thread.profileId === connection.profile?.id && thread.remoteId)
            .map((thread) => `${thread.provider}:${thread.remoteId}`)}
        />
        <ResearchDialogs workbench={workbench} />
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
            appContext.current.connection = state
            setConnection(state)
            setTerminalOpen(false)
            const destination = workspacePickerOrigin.current || view
            workspacePickerOrigin.current = undefined
            if (destination === 'research' && state.profile && state.workspace) {
              lifeMap.connect(
                workspaceProject(
                  state.profile.id,
                  state.workspace,
                  state.profile.name || state.profile.host,
                ),
              )
              setView('research')
            } else if (destination === 'investigation') {
              workbench.useWorkspace(state)
              setView('investigation')
            } else setView('workspace')
            refreshProfiles()
            if (
              destination === 'workspace' &&
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
            {agentThreads
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
            {!agentThreads.length ? (
              <div className="small-empty">
                Your threads will appear here after you send your first message.
              </div>
            ) : !agentThreads.some((t) =>
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
              [streamlinedWorkspace ? 'Send or steer while working' : 'Send message', 'Enter'],
              ...(streamlinedWorkspace ? [['Queue while working', 'Tab']] : []),
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
    </ProjectColorsProvider>
  )
}
