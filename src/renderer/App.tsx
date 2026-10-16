import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BrainCircuit,
  BarChart3,
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
  AgentQuestionReply,
  ConnectionProfile,
  ConnectionState,
  HostKeyRequest,
  ModelOption,
  PermissionMode,
  Provider,
  StartInput,
} from '../shared/types'
import { api, desktop, errorText, streamlinedWorkspace } from './api'
import { connectionMachineIdentity } from '../shared/connection-identity'
import { flushSync } from 'react-dom'
import { AgentEventBatch, coalesceAgentEvents } from './agent-event-batch'
import { providerPermissionMode } from '../shared/permissions'
import './workspace-presentation.css'
import {
  applyEvent,
  acceptsAgentEvent,
  admitAgentEvents,
  applyNativeRecoveryOwner,
  nativeRecoveryBlocksMutation,
  restoreNativeMainOwner,
  resolveAgentRequest,
  finishThreadTurn,
  bindLegacyThreadWorkspace,
  normalizeModelChoices,
  readThreads,
  type Thread,
  type Message,
} from './state'
import { fallbackModelCatalog, withProviderDefault } from './model-catalog'
import { ProviderIcon } from './components/Icons'
import { ThreadBadge } from './components/ThreadBadge'
import { Modal } from './components/Modal'
import {
  ConnectionDialog,
  ProjectDialog,
  HostHistoryDialog,
  CustomizationDialog,
  UpdateDialog,
  UsageDialog,
  ExtensionDialog,
  SourceCodeDialog,
  PortForwardDialog,
} from './components/DeferredDialogs'
import { ApprovalCard } from './components/MessageView'
import { PendingQuestionPanel } from './components/PendingQuestionPanel'
import { pendingQuestionDrafts } from './pending-question-drafts'
import { formatAsyncQuestionReply } from '../shared/async-questions'
import { ThreadTimeline } from './components/ThreadTimeline'
import { previewNavigableMessages, threadHasRunningChildren } from './thread-presentation'
import { WorkspaceSurfaces } from './components/WorkspaceSurfaces'
import { ResizeHandle, usePanelSizes } from './components/SidebarResize'
import { ThreadMessageNavigator } from './components/ThreadMessageNavigator'
import { LifeBrand, TitleBar, TitleBarContent } from './components/TitleBar'
import { ActiveProject } from './components/ActiveProject'
import { CustomizationStudio } from './components/CustomizationStudio'
import { hostHistoryThread, appendHostHistory } from './host-history'
import type { HostHistoryPage } from '../shared/agent-history'
import { ConversationHistoryHydration } from './conversation-hydration'
import { loadConversationHistory } from './conversation-load'
import { nativeCheckpointConversationThreads } from './conversation-load-protocol'
import {
  getConversationSourceRaw,
  hasConversationSource,
  projectConversationSource,
} from './conversation-source'
import { useBuiltinFeatures } from './builtin-extensions'
import { SidebarThread } from './components/SidebarThread'
import { ThreadActionsMenu } from './components/ThreadActionsMenu'
import {
  applyThreadAction,
  captureThreadArrangementChanges,
  undoThreadArrangement,
  threadCanArchive,
  type ThreadAction,
  type ThreadUndoChange,
} from './thread-management'
import {
  nextThreadSnoozeDeadline,
  startThreadSnoozeClock,
  wakeExpiredThreadSnoozes,
} from './thread-snooze-clock'
import './workspace-integration.css'
import { LifeMap as ResearchView } from './components/LifeMap'
import { CustomPanels } from './components/CustomPanels'
import { useLifeConfig } from './useLifeConfig'
import { ProviderUpdatesButton, ProviderUpdatesDialog } from './components/ProviderUpdatesDialog'
import { emptyProviderUpdatesState, type ProviderUpdatesState } from '../shared/provider-updates'
import type { ProviderUsageSnapshot } from '../shared/usage'
import type { UpdateState } from '../shared/updates'
import { ExtensionHost } from './components/ExtensionHost'
import { useExtensions } from './useExtensions'
import { useSourceCode } from './useSourceCode'
import { SidebarProjects } from './components/SidebarProjects'
import { readProjects } from './research'
import { LIFE_VERSION } from '../shared/version'
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
  ResearchDialogs,
} from './components/ResearchWorkbench'
import './components/life-workbench.css'
import { ResearchLayout } from './components/ResearchLayout'
import { useConversationDrafts } from './conversation-drafts'
import { useConversationScroll } from './conversation-scroll'
import {
  readCachedConversationHistory,
  reconcileConversationHistory,
  useConversationPersistence,
} from './conversation-persistence'
import {
  carryNativeProjectionAuthoredTransition,
  carryNativeProjectionAttachmentUpdate,
  carryNativeProjectionMembership,
  registerNativeProjectionLoadedBaseline,
  registerNativeProjectionMainCacheBaseline,
  registerNativeProjectionMembershipTransition,
  registerNativeProjectionCacheMembership,
} from './native-projection-admissions'
import { mainNativeRecoveryRequest } from './native-recovery-consumers'
import { getNativeConversationLoad } from './conversation-load-provenance'
import {
  attestCachedConversationHistoryRecovery,
  getEffectiveCachedConversationHistorySavedAt,
} from './main-cache-recovery'
import './components/research-machine.css'
import './components/research-interface.css'
import './components/thread-management-ui.css'
import { useWorkspacePanelVisibility } from './useWorkspacePanelVisibility'
import './components/t3-chat.css'
import './components/t3-composer.css'
import './components/t3-workspace-layout.css'

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
  const [providerUpdatesOpen, setProviderUpdatesOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [providerUpdateState, setProviderUpdateState] =
    useState<ProviderUpdatesState>(emptyProviderUpdatesState)
  const [accountSnapshots, setAccountSnapshots] = useState<
    Partial<Record<Provider, ProviderUsageSnapshot>>
  >({})
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
  const [threads, setHydratedThreads] = useState<Thread[]>(() =>
    api?.conversations ? [] : readThreads(),
  )
  const setThreads = useCallback<Dispatch<SetStateAction<Thread[]>>>((update) => {
    setHydratedThreads((previous) =>
      carryNativeProjectionMembership(
        previous,
        typeof update === 'function' ? update(previous) : update,
      ),
    )
  }, [])
  const threadsCurrent = useRef(threads)
  threadsCurrent.current = threads
  const [toast, setToast] = useState('')
  const [threadUndo, setThreadUndo] = useState<{
    message: string
    changes: ThreadUndoChange[]
    reopenId?: string
  }>()
  const [renamingThread, setRenamingThread] = useState<string>()
  const [deletingThread, setDeletingThread] = useState<Thread>()
  const [threadTitleDraft, setThreadTitleDraft] = useState('')
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
    if (!historyReady) return
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
  const [recoveryReady, setRecoveryReady] = useState(!api?.window.initialRecovery)
  const [historyReady, setHistoryReady] = useState(!api?.conversations)
  const [nativeHistoryReady, setNativeHistoryReady] = useState(!api?.conversations)
  type RecoverySupport = {
    mode: 'durable' | 'unsupported-clean' | 'blocked'
    message?: string
  }
  const legacyRecoverySupport: RecoverySupport = {
    mode: api?.agent.recover ? 'durable' : 'unsupported-clean',
  }
  const recoverySupportRequest = useRef<Promise<RecoverySupport> | undefined>(undefined)
  const [nativeRecoverySupport, setNativeRecoverySupport] = useState<RecoverySupport | undefined>(
    api?.agent.recoverySupport ? undefined : legacyRecoverySupport,
  )
  const nativeRecoverySupportCurrent = useRef(nativeRecoverySupport)
  nativeRecoverySupportCurrent.current = nativeRecoverySupport
  const getRecoverySupport = () =>
    (recoverySupportRequest.current ||= api?.agent.recoverySupport
      ? api.agent.recoverySupport().catch((error): RecoverySupport => ({
          mode: 'blocked',
          message: `Native recovery support could not be verified. ${errorText(error)}`,
        }))
      : Promise.resolve(legacyRecoverySupport))
  const [nativeRecoveryReady, setNativeRecoveryReady] = useState(
    !api?.agent.recoverySupport && !api?.agent.recover,
  )
  const [nativeRecoveryRetry, setNativeRecoveryRetry] = useState(0)
  const nativeRecoveryHydrated = useRef(false)
  const nativeRecoveryBuffered = useRef<AgentEvent[]>([])
  const nativeEventDelivery = useRef<((event: AgentEvent) => void) | undefined>(undefined)
  const [historyLoadError, setHistoryLoadError] = useState('')
  const [historyRetry, setHistoryRetry] = useState(0)
  const historyLoad = useRef<ConversationHistoryHydration | undefined>(undefined)
  const historyWritable =
    historyReady &&
    nativeHistoryReady &&
    Boolean(nativeRecoverySupport && nativeRecoverySupport.mode !== 'blocked')
  const historyWritableCurrent = useRef(historyWritable)
  historyWritableCurrent.current = historyWritable
  nativeRecoveryHydrated.current = historyWritable && nativeRecoveryReady
  const startupReady = recoveryReady && historyWritable && nativeRecoveryReady
  const conversationPersistence = useConversationPersistence(
    threads,
    api?.conversations?.save,
    setToast,
    historyWritable && nativeRecoveryReady,
    api?.conversations?.checkpoint,
    api?.conversations?.supportsMessageFields === true,
    api?.conversations?.supportsMessageAppends === true,
    nativeRecoverySupport?.mode === 'durable' ? api?.agent.prepareRecoveryCache : undefined,
  )
  const canMutateHistory = useCallback(() => {
    if (historyWritable) return true
    if (nativeRecoverySupport?.mode === 'blocked')
      setToast(
        nativeRecoverySupport.message ||
          'Native recovery is unavailable. Saved conversations remain available to read and export.',
      )
    else if (historyLoadError)
      setToast('Conversation changes are paused until disk history can be read. Use Retry loading.')
    return false
  }, [historyWritable, historyLoadError, nativeRecoverySupport])
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
  const workspaceScopeKey = JSON.stringify([
    connection.profile?.id,
    connection.workspace,
    workspaceActiveId || 'draft',
  ])
  const [workspaceOpen, setWorkspaceOpen] = useWorkspacePanelVisibility(
    workspaceScopeKey,
    config.workspacePanel && window.innerWidth > 980,
    config.workspacePanel,
  )
  const previousWorkspacePanelPreference = useRef(config.workspacePanel)
  const [workspaceSurfacesMounted, setWorkspaceSurfacesMounted] = useState(workspaceOpen)
  const [workspaceMaximizedKey, setWorkspaceMaximizedKey] = useState<string>()
  const [composerElement, setComposerElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (workspaceOpen) setWorkspaceSurfacesMounted(true)
  }, [workspaceOpen])
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
  const terminalScopeKey = JSON.stringify([connection.profile?.id, connection.workspace])
  const terminalScopeCurrent = useRef(terminalScopeKey)
  terminalScopeCurrent.current = terminalScopeKey
  const [terminalState, setTerminalState] = useState({ scope: terminalScopeKey, open: false })
  const terminalOpen = terminalState.scope === terminalScopeKey && terminalState.open
  const setTerminalOpen: Dispatch<SetStateAction<boolean>> = useCallback((value) => {
    const scope = terminalScopeCurrent.current
    setTerminalState((previous) => ({
      scope,
      open: typeof value === 'function' ? value(previous.scope === scope && previous.open) : value,
    }))
  }, [])
  useEffect(() => {
    setTerminalState((previous) =>
      previous.scope === terminalScopeKey ? previous : { scope: terminalScopeKey, open: false },
    )
  }, [terminalScopeKey])
  const panels = usePanelSizes(config.sidebarWidth, config.workspacePanelWidth, sidebarOpen, 0)
  useEffect(() => {
    if (terminalOpen) {
      setWorkspaceOpen(true)
      setView('workspace')
    }
  }, [terminalOpen])
  const [refreshKey, setRefreshKey] = useState(0)
  const lifeMap = useLifeMap(setToast, builtin.enabled('project-map'))
  const researchLinkedThreadsKey = JSON.stringify([...workbench.linkedThreadIds].sort())
  const agentThreads = useMemo(
    () => threads.filter((thread) => !thread.purpose && !workbench.linkedThreadIds.has(thread.id)),
    [threads, researchLinkedThreadsKey],
  )
  useEffect(() => {
    if (!historyWritable) return
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
  }, [workbench.scopeKey, workbench.goals, historyWritable])
  const legacyResearchDirectories = useMemo(
    () => researchLegacyDirectories(threads, workbench.linkedThreadIds),
    [threads, researchLinkedThreadsKey],
  )
  const sidebarProfiles = useMemo(() => {
    const occupied = new Set(agentThreads.map((thread) => thread.profileId))
    return profiles.filter(
      (profile) =>
        !legacyResearchDirectories.has(profile.workspace.replace(/\/+$/, '') || '/') ||
        occupied.has(profile.id),
    )
  }, [profiles, legacyResearchDirectories, agentThreads])
  const projectCatalog = useMemo(
    () => workspaceCatalog(profiles, agentThreads, connection, legacyResearchDirectories),
    [profiles, agentThreads, connection, legacyResearchDirectories],
  )
  const projectColorKeys = useMemo(
    () => [
      ...projectCatalog.map((project) => project.key),
      ...lifeMap.projects.map((project) => project.key),
    ],
    [projectCatalog, lifeMap.projects],
  )
  const searchResults = useMemo(
    () =>
      !searchOpen
        ? []
        : !query
          ? agentThreads
          : agentThreads.filter((thread) =>
              `${thread.title} ${thread.messages.map((m) => m.text).join(' ')}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ),
    [searchOpen, query, agentThreads],
  )
  useThreadMetadata(
    connection,
    refreshKey,
    threads.length,
    setThreads,
    historyWritable && builtin.enabled('thread-git-metadata'),
  )
  const snoozeDeadline = useMemo(() => nextThreadSnoozeDeadline(threads), [threads])
  useEffect(() => {
    if (!historyWritable || snoozeDeadline === undefined) return
    const wake = (now: number) =>
      setThreads((previous) =>
        historyWritableCurrent.current ? wakeExpiredThreadSnoozes(previous, now) : previous,
      )
    let cancel = startThreadSnoozeClock(snoozeDeadline, wake)
    const resume = () => {
      if (document.visibilityState === 'hidden') return
      cancel()
      cancel = startThreadSnoozeClock(snoozeDeadline, wake)
    }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancel()
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [snoozeDeadline, historyWritable])
  const [threadMenu, setThreadMenu] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef<
    { id?: string; start?: { cancelled: boolean; dispatched: boolean } } | undefined
  >(undefined)
  const sourceReloading = useRef(false)
  const runningChoices = useRef(
    new Map<string, Pick<StartInput, 'model' | 'reasoningEffort' | 'serviceTier'>>(),
  )
  const appContext = useRef({ preferences, config, extensions, connection })
  appContext.current = { preferences, config, extensions, connection }
  const active = threads.find((t) => t.id === activeId)
  const pendingQuestions =
    active?.pending.filter(
      (event) => event.type === 'question' && Boolean(event.questions?.length),
    ) || []
  const pendingQuestion = pendingQuestions[0]
  useEffect(() => {
    if (!historyWritable || !nativeRecoveryReady || !pendingQuestionDrafts.hasDrafts()) return
    for (const thread of threads) pendingQuestionDrafts.pruneSession(thread.id, thread.pending)
  }, [threads, historyWritable, nativeRecoveryReady])
  useEffect(() => {
    const markVisibleRead = () => {
      if (
        !historyWritable ||
        !activeId ||
        document.visibilityState === 'hidden' ||
        (view === 'investigation' && !researchAgentOpen)
      )
        return
      const seenAt = Date.now()
      setThreads((previous) => {
        const next = previous.map((thread) =>
          thread.id === activeId &&
          (!thread.lastReadAt ||
            thread.lastReadAt < (thread.completedAt || 0) ||
            thread.lastReadAt < (thread.attentionAt || 0))
            ? {
                ...thread,
                lastReadAt: Math.max(seenAt, thread.completedAt || 0, thread.attentionAt || 0),
              }
            : thread,
        )
        return next.some((thread, index) => thread !== previous[index]) ? next : previous
      })
    }
    markVisibleRead()
    document.addEventListener('visibilitychange', markVisibleRead)
    window.addEventListener('focus', markVisibleRead)
    return () => {
      document.removeEventListener('visibilitychange', markVisibleRead)
      window.removeEventListener('focus', markVisibleRead)
    }
  }, [historyWritable, activeId, active?.completedAt, active?.attentionAt, view, researchAgentOpen])
  useEffect(() => {
    if (!threadUndo) return
    const timer = window.setTimeout(() => setThreadUndo(undefined), 5000)
    return () => window.clearTimeout(timer)
  }, [threadUndo])
  useEffect(() => {
    if (threadUndo && toast !== threadUndo.message) setThreadUndo(undefined)
  }, [toast, threadUndo])
  const { conversation, viewportRef, stickToBottom, setStickToBottom } = useConversationScroll(
    JSON.stringify([
      view,
      active?.profileId,
      activeId || draftKey,
      view === 'investigation' ? workbench.scopeKey : undefined,
    ]),
    { messages: active?.messages, pending: active?.pending, queue: active?.queue },
  )
  const navigableMessages = useMemo(
    () =>
      active ? (streamlinedWorkspace ? previewNavigableMessages(active) : active.messages) : [],
    [active],
  )
  useEffect(() => {
    settingsRequest.current += 1
    cancelThreadContext()
    setThreadMenu(false)
  }, [view, activeId, workbench.scopeKey])
  const currentProvider = active?.provider || provider
  const currentModel = active?.model ?? model
  const currentReasoningEffort = active ? (active.reasoningEffort ?? '') : reasoningEffort
  const currentServiceTier = active ? (active.serviceTier ?? '') : serviceTier
  const currentMode = providerPermissionMode(currentProvider, active?.mode || mode)
  const connected = connection.status === 'connected'
  const localEnvironment = connection.profile?.transport === 'local'
  const projectReady = connected && Boolean(connection.workspace)
  const draftUploads = useDraftUploads(
    attachments,
    connection,
    historyWritable &&
      builtin.enabled('thread-attachments') &&
      (view === 'investigation' ? connected && Boolean(researchUploadWorkspace) : projectReady) &&
      (!active || active.profileId === 'life-local' || queueConnectionMatches(active, connection)),
    view === 'investigation' && researchUploadWorkspace
      ? { scope: 'machine', workspace: researchUploadWorkspace }
      : undefined,
  )
  const busy = active?.busy || false
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
        nativeRecoveryBlocksMutation(
          threadsCurrent.current.find((thread) => thread.id === threadId),
        ) ||
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
    historyWritable &&
    nativeRecoveryReady &&
    !nativeRecoveryBlocksMutation(active) &&
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
        const currentThread = threadsCurrent.current.find((item) => item.id === thread.id)
        if (
          appContext.current.connection.profile?.id === thread.profileId &&
          currentThread?.nativeRecoveryOwner &&
          (currentThread.busy || nativeRecoveryBlocksMutation(currentThread))
        ) {
          // Main retains this active native owner and its reconnect. A delayed
          // hydration reply must not replace that retry with new credentials.
          return false
        }
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
      connectOpen ||
      projectOpen ||
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
    if (!api?.agent.recoverySupport) return
    let disposed = false
    void getRecoverySupport().then((support) => {
      if (disposed) return
      setNativeRecoverySupport(support)
      if (support.mode !== 'durable') nativeRecoveryBuffered.current = []
      if (support.mode === 'unsupported-clean') setNativeRecoveryReady(true)
      if (support.mode === 'blocked')
        setToast(
          support.message ||
            'Native recovery is unavailable. Saved conversations remain available to read and export.',
        )
    })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (!api?.window.initialRecovery) return
    let disposed = false
    // StrictMode mounts effects twice; consume the native intent only once.
    initialRecoveryRequest.current ||= api.window.initialRecovery()
    void initialRecoveryRequest.current
      .then((recovery) => {
        if (disposed) return
        if (recovery) reviewRecoveredExtensions()
        setRecoveryReady(true)
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
    if (!api?.conversations) return
    const nativeConversations = api.conversations
    const controller = new AbortController()
    // Failed reads never authorize replacing unknown durable membership with
    // cached or empty history. The retry controller shares StrictMode reads.
    historyLoad.current ||= new ConversationHistoryHydration((signal) =>
      loadConversationHistory(nativeConversations, signal),
    )
    void historyLoad.current
      .load(controller.signal)
      .then(async (saved) => {
        if (controller.signal.aborted) return
        const cached = readCachedConversationHistory()
        if (!nativeRecoverySupportCurrent.current) {
          // A capability query can remain pending after the disk read. Publish
          // its passive view for reading/export while authored writes stay gated.
          setHydratedThreads(
            reconcileConversationHistory(saved, cached).map((thread) =>
              bindLegacyThreadWorkspace(thread, appContext.current.connection),
            ),
          )
          setHistoryReady(true)
        }
        const recoverySupport = await getRecoverySupport()
        if (controller.signal.aborted) return
        const nativeLoad = saved ? getNativeConversationLoad(saved) : undefined
        if (recoverySupport.mode === 'durable' && nativeLoad && api?.agent.attestLoadedHistory) {
          const admissions = await api.agent.attestLoadedHistory({ hash: nativeLoad.hash })
          if (controller.signal.aborted) return
          for (const row of nativeLoad.rows)
            for (const admission of admissions)
              if (row.id === admission.sessionId)
                registerNativeProjectionLoadedBaseline(row, admission)
        }
        if (recoverySupport.mode === 'durable' && api?.agent.attestRecoveryCache) {
          const cacheLoad = await attestCachedConversationHistoryRecovery(
            cached,
            api.agent.attestRecoveryCache,
          )
          if (controller.signal.aborted) return
          if (cacheLoad) {
            for (const row of cacheLoad.rows)
              for (const admission of cacheLoad.projectionAdmissions)
                if (row.id === admission.sessionId)
                  registerNativeProjectionMainCacheBaseline(row, admission)
            await registerNativeProjectionCacheMembership(
              cached.threads,
              cacheLoad.membershipAdmissions || [],
              cached,
            )
          }
        }
        if (controller.signal.aborted) return
        const reconciled = reconcileConversationHistory(saved, cached)
        conversationPersistence.advanceClock(
          Math.max(saved?.savedAt || 0, getEffectiveCachedConversationHistorySavedAt(cached) || 0),
        )
        if (saved) {
          const nativeBaseline = nativeCheckpointConversationThreads(saved)
          if (nativeBaseline)
            conversationPersistence.adoptNativeCheckpoint(nativeBaseline, saved.savedAt, true)
        }
        setHydratedThreads(
          carryNativeProjectionMembership(
            reconciled,
            reconciled.map((thread) =>
              bindLegacyThreadWorkspace(thread, appContext.current.connection),
            ),
          ),
        )
        setHistoryLoadError('')
        setToast((current) =>
          current.startsWith('Could not load the disk history.') ||
          current ===
            'Conversation changes are paused until disk history can be read. Use Retry loading.'
            ? ''
            : current,
        )
        setNativeHistoryReady(true)
        setHistoryReady(true)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        const cached = readCachedConversationHistory()
        conversationPersistence.advanceClock(cached.savedAt || 0)
        setHydratedThreads(
          cached.threads.map((thread) =>
            bindLegacyThreadWorkspace(thread, appContext.current.connection),
          ),
        )
        const message = `Could not load the disk history. Its original file is preserved. ${errorText(error)}`
        setHistoryLoadError(message)
        setToast(message)
        setHistoryReady(true)
      })
    return () => {
      controller.abort()
    }
  }, [
    conversationPersistence.advanceClock,
    conversationPersistence.adoptNativeCheckpoint,
    historyRetry,
  ])

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
    const updates = api?.providerUpdates
    if (!updates) return
    let current = true
    let eventRevision = 0
    const unsubscribe = updates.onState((state) => {
      eventRevision++
      setProviderUpdateState(state)
    })
    const requestedRevision = eventRevision
    void updates
      .get()
      .then((state) => {
        if (current && eventRevision === requestedRevision) setProviderUpdateState(state)
      })
      .catch((error) => {
        if (current) setToast(errorText(error))
      })
    return () => {
      current = false
      unsubscribe()
    }
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
    if (previousWorkspacePanelPreference.current === config.workspacePanel) return
    previousWorkspacePanelPreference.current = config.workspacePanel
    setWorkspaceOpen(config.workspacePanel)
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
      if (
        state.profile?.id !== appContext.current.connection.profile?.id ||
        state.profile?.transport !== appContext.current.connection.profile?.transport ||
        state.profile?.host !== appContext.current.connection.profile?.host ||
        state.profile?.port !== appContext.current.connection.profile?.port ||
        state.profile?.username !== appContext.current.connection.profile?.username ||
        state.status !== 'connected'
      )
        setAccountSnapshots({})
      appContext.current.connection = state
      setConnection(state)
      if (state.status === 'connected')
        setThreads((previous) => previous.map((thread) => bindLegacyThreadWorkspace(thread, state)))
      if (state.status === 'disconnected') setTerminalOpen(false)
    }
    void api.connection.state().then(updateConnection)
    const offConnection = api.onConnection(updateConnection)
    const offHost = api.onHostKey(setHostKey)
    const eventBatch = new AgentEventBatch((events) => {
      const byThread = new Map<string, AgentEvent[]>()
      for (const event of events) {
        if (
          event.nativeRecovery &&
          ((event.type === 'status' && event.status === 'resumed') ||
            (event.nativeRecovery.deliveryToken &&
              ['running', 'idle'].includes(event.nativeRecovery.ownerStatus || '')))
        ) {
          const target = threadsCurrent.current.find((thread) => thread.id === event.sessionId)
          if (target && nativeRecoveryBlocksMutation(target) && acceptsAgentEvent(target, event))
            setNativeRecoveryRetry((revision) => revision + 1)
        }
        if (event.type === 'account-usage' && !event.sessionId) {
          const snapshot = event.details as ProviderUsageSnapshot | undefined
          const connected = appContext.current.connection
          const profile = connected.profile
          if (
            snapshot &&
            profile &&
            connected.status === 'connected' &&
            snapshot.machineIdentity === connectionMachineIdentity(profile)
          )
            setAccountSnapshots((previous) =>
              (previous[snapshot.provider]?.fetchedAt ?? -Infinity) > snapshot.fetchedAt
                ? previous
                : { ...previous, [snapshot.provider]: snapshot },
            )
          continue
        }
        const current = byThread.get(event.sessionId) || []
        current.push(event)
        byThread.set(event.sessionId, current)
        const currentThread = threadsCurrent.current.find((thread) => thread.id === event.sessionId)
        if (
          acceptsAgentEvent(
            threadsCurrent.current.find((thread) => thread.id === event.sessionId) ||
              ({ id: '' } as Thread),
            event,
          ) &&
          (!event.nativeRecovery ||
            event.nativeRecovery.localTurn === undefined ||
            event.nativeRecovery.localTurn === currentThread?.turn) &&
          !event.agentId &&
          (event.type === 'complete' ||
            (event.type === 'error' &&
              !(
                event.details &&
                typeof event.details === 'object' &&
                'recoverable' in event.details &&
                event.details.recoverable === true
              )))
        )
          runningChoices.current.delete(event.sessionId)
      }
      if (byThread.size)
        setThreads((previous) =>
          previous.map((thread) => {
            const updates = byThread.get(thread.id)
            return updates
              ? coalesceAgentEvents(admitAgentEvents(thread, updates)).reduce(applyEvent, thread)
              : thread
          }),
        )
      if (events.some((event) => event.type === 'complete' && !event.agentId))
        setRefreshKey((key) => key + 1)
    })
    nativeEventDelivery.current = (event) => eventBatch.push(event)
    const offAgent = api.onAgent((event) => {
      if (
        event.nativeRecovery &&
        nativeRecoverySupportCurrent.current &&
        nativeRecoverySupportCurrent.current.mode !== 'durable'
      )
        return
      if (event.nativeRecovery && !nativeRecoveryHydrated.current) {
        nativeRecoveryBuffered.current.push(event)
        return
      }
      eventBatch.push(event)
    })
    // History's unload listener runs after this subscription effect. Publish
    // the final received deltas before it reads the current conversation.
    const flushEvents = () => flushSync(() => eventBatch.flush())
    window.addEventListener('beforeunload', flushEvents)
    window.addEventListener('life:history-checkpoint', flushEvents)
    return () => {
      offConnection()
      offHost()
      offAgent()
      nativeEventDelivery.current = undefined
      window.removeEventListener('beforeunload', flushEvents)
      window.removeEventListener('life:history-checkpoint', flushEvents)
      eventBatch.dispose()
    }
  }, [refreshProfiles])

  useEffect(() => {
    if (!historyWritable || nativeRecoverySupport?.mode !== 'durable' || !api?.agent.recover) return
    let disposed = false
    setNativeRecoveryReady(false)
    nativeRecoveryHydrated.current = false
    void api.agent
      .recover(mainNativeRecoveryRequest(threadsCurrent.current))
      .then(({ owners }) => {
        if (disposed) return
        setThreads((previous) =>
          owners.reduce((recovered, owner) => {
            if (owner.originalInput?.clientRecovery) return restoreNativeMainOwner(recovered, owner)
            if (recovered.filter((thread) => thread.id === owner.sessionId).length !== 1)
              return recovered
            return recovered.map((thread) =>
              thread.id === owner.sessionId ? applyNativeRecoveryOwner(thread, owner) : thread,
            )
          }, previous),
        )
        const uncertain = owners.find((owner) => owner.status === 'unknown')
        if (uncertain)
          setToast(
            uncertain.message ||
              'Life could not verify the original native owner. This conversation is preserved; sending and permission responses stay paused.',
          )
        setNativeRecoveryReady(true)
        nativeRecoveryHydrated.current = true
        const buffered = nativeRecoveryBuffered.current
        nativeRecoveryBuffered.current = []
        for (const event of buffered) nativeEventDelivery.current?.(event)
      })
      .catch((error) => {
        if (!disposed) setToast(`Native recovery could not be reconciled. ${errorText(error)}`)
      })
    return () => {
      disposed = true
    }
  }, [
    historyWritable,
    historyRetry,
    nativeRecoveryRetry,
    nativeRecoverySupport?.mode,
    connection.status,
    connection.profile?.id,
  ])

  useEffect(() => {
    const retire = () => {
      sourceReloading.current = true
    }
    const unload = () => {
      // Electron can prevent this attempted navigation and keep the document
      // alive. Flush received work without blocking its subsequent messages.
      void conversationPersistence.flush()
    }
    const checkpointWindow = window as Window & {
      __lifeFlushConversationHistory?: (retireDocument?: boolean) => Promise<void>
      __lifeFlushStudioHistory?: () => Promise<void>
    }
    const flushHistory = (retireDocument = false) => {
      // Native close/reload can await this checkpoint before replacing the
      // document. The stream listener flushes queued deltas synchronously first.
      if (retireDocument === true) retire()
      window.dispatchEvent(new Event('life:history-checkpoint'))
      return Promise.all([
        conversationPersistence.flush(),
        draftState.flush(),
        checkpointWindow.__lifeFlushStudioHistory?.(),
      ]).then(() => undefined)
    }
    checkpointWindow.__lifeFlushConversationHistory = flushHistory
    window.addEventListener('beforeunload', unload)
    window.addEventListener('pagehide', retire)
    return () => {
      window.removeEventListener('beforeunload', unload)
      window.removeEventListener('pagehide', retire)
      if (checkpointWindow.__lifeFlushConversationHistory === flushHistory)
        delete checkpointWindow.__lifeFlushConversationHistory
    }
  }, [conversationPersistence.flush, draftState.flush])
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
  }, [connected, connection.profile?.id, connection.workspace, startupReady, view])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 6500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto'
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, view === 'workspace' ? 200 : 180) + 'px'
    }
  }, [draft, view, activeId])
  useLayoutEffect(() => {
    if (view !== 'workspace' || !composerElement) return
    const area = composerElement.closest<HTMLElement>('.chat-area')
    if (!area) return
    let measured = -1
    const update = (height: number) => {
      const next = Math.ceil(height)
      if (next === measured) return
      measured = next
      area.style.setProperty('--life-composer-height', `${next}px`)
    }
    update(composerElement.getBoundingClientRect().height)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry)
        update(
          entry.borderBoxSize?.[0]?.blockSize ?? composerElement.getBoundingClientRect().height,
        )
    })
    observer.observe(composerElement, { box: 'border-box' })
    return () => {
      observer.disconnect()
      area.style.removeProperty('--life-composer-height')
    }
  }, [composerElement, view])

  const newThread = useCallback(() => {
    if (!canMutateHistory()) return
    const selected = threadsCurrent.current.find((thread) => thread.id === activeIdCurrent.current)
    if (selected) {
      setProvider(selected.provider)
      setModel(selected.model)
      setReasoningEffort(selected.reasoningEffort || '')
      setServiceTier(selected.serviceTier || '')
      setMode(selected.mode)
    }
    if (draftState.hasContent('agents:new')) {
      const createdAt = Date.now()
      const retained: Thread = {
        id: crypto.randomUUID(),
        profileId: connection.profile?.id || 'life-local',
        ...(connection.workspace ? { workspace: connection.workspace } : {}),
        provider,
        title: 'Draft thread',
        messages: [],
        busy: false,
        model,
        reasoningEffort,
        serviceTier,
        mode,
        createdAt,
        updatedAt: createdAt,
        lastReadAt: createdAt,
        turn: 0,
        pending: [],
      }
      draftState.move('agents:new', 'agents:' + retained.id)
      setThreads((previous) => [retained, ...previous])
    }
    emergencyReview.current = false
    cancelThreadContext()
    if (!attachmentTransfer.current) submitting.current = undefined
    setView('workspace')
    activeIdCurrent.current = undefined
    setWorkspaceActiveId(undefined)
    setThreadMenu(false)
    setStickToBottom(true)
    textarea.current?.focus()
  }, [
    canMutateHistory,
    draftState.hasContent,
    draftState.move,
    connection,
    provider,
    model,
    reasoningEffort,
    serviceTier,
    mode,
  ])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !historyReady ||
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
        providerUpdatesOpen ||
        usageOpen ||
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
          if (!canMutateHistory()) return
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
        if (
          key === 'z' &&
          !e.shiftKey &&
          threadUndo &&
          !(
            e.target instanceof Element &&
            e.target.closest('input, textarea, [contenteditable="true"]')
          )
        ) {
          e.preventDefault()
          undoThreadAction()
        }
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const rows = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.sidebar .thread-row'),
          ).filter((row) => row.offsetParent !== null)
          const index = rows.findIndex((row) => row.getAttribute('aria-current') === 'page')
          const next =
            rows[
              index < 0
                ? 0
                : Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
            ]
          if (next) {
            e.preventDefault()
            next.click()
            next.focus()
          }
        }
      }
      if (e.key === 'Escape') setThreadMenu(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    newThread,
    historyReady,
    canMutateHistory,
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
    providerUpdatesOpen,
    usageOpen,
    extensionsOpen,
    sourceCodeOpen,
    view,
    workbench.goal?.id,
    workbench.editor,
    threadUndo,
  ])
  function attachFiles(files: File[]) {
    if (!canMutateHistory()) return
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

  async function send(
    queued?: QueuedSubmission,
    intent?: 'queue',
    question?: { event: AgentEvent; answers: Record<string, string[]> },
  ): Promise<boolean | undefined> {
    if (!startupReady) return
    if (
      !queued &&
      !question &&
      (draftState.restoring || draftState.unavailableAttachments.length)
    ) {
      setToast(
        draftState.restoring
          ? 'Your draft attachments are being restored. Try again shortly.'
          : 'Reattach or remove the unavailable files before sending this draft.',
      )
      return
    }
    let active = threadsCurrent.current.find(
      (thread) =>
        thread.id === (question?.event.sessionId || queued?.threadId || activeIdCurrent.current),
    )
    if (nativeRecoveryBlocksMutation(active)) {
      setToast(
        'Life is verifying the original native owner. Your draft is kept until this conversation can safely continue.',
      )
      return
    }
    const researchThreadContext =
      active?.purpose === 'research' ? workbench.contextForThread(active.id) : undefined
    const researchScope = researchThreadContext?.scope || workbench.scope
    const researchTarget = queued
      ? workbench.forThread(active?.id)
      : !question && view === 'investigation'
        ? workbench.selection()
        : workbench.forThread(active?.id)
    const queuedMessage = queued
      ? active?.queue?.find((item) => item.id === queued.messageId)
      : undefined
    if (queued && (!active || !queuedMessage || active.busy)) return
    if (!queued && !question && view === 'investigation' && !researchTarget) {
      workbench.newGoal()
      return
    }
    if (!queued && !question && !draft.trim() && !attachments.length) return
    const selectedAttachments = question ? [] : queued ? queued.files : [...attachments]
    if (selectedAttachments.length && !builtin.enabled('thread-attachments')) {
      setToast(
        'Enable the attachments extension before sending these files. Your message and attachments are kept.',
      )
      return
    }
    const prompt = question
      ? formatAsyncQuestionReply(question.event.questions || [], question.answers)
      : queued
        ? queuedMessage!.text
        : draft
    let connection = appContext.current.connection
    let connected = connection.status === 'connected'
    let projectReady = connected && Boolean(connection.workspace)
    if (!prompt.trim() && !selectedAttachments.length) return
    if (
      question &&
      active?.pending.some(
        (request) =>
          request.requestId !== question.event.requestId && request.responseMode !== 'message',
      )
    )
      throw new Error('Resolve the native approval request before sending this follow-up answer.')
    if (question && active?.busy) {
      return submitQuestionSteering(active, question.event, question.answers)
    }
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
      !question &&
      active &&
      (active.busy ||
        queue.sendingThreadId ||
        (active.queue?.[0] && !active.queue[0].paused && !active.queue[0].error))
    ) {
      if (!builtin.enabled('message-queue')) {
        await steerDraft()
        return
      }
      const queuedId = await queue.enqueue(active, prompt, selectedAttachments)
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
    if (active) {
      const latest = threadsCurrent.current.find((thread) => thread.id === active!.id)
      if (
        !latest ||
        latest.turn !== active.turn ||
        (latest.busy && !active.busy) ||
        latest.pending.some(
          (request) =>
            !question ||
            (request.requestId !== question.event.requestId && request.responseMode !== 'message'),
        )
      ) {
        if (!queued)
          setToast(
            'The thread changed while its project was opening. Your draft is kept; send it again when the thread is ready.',
          )
        return
      }
      active = latest
    }
    const userMessageId = crypto.randomUUID()
    const transfer = selectedAttachments.length
      ? { id: '', controller: new AbortController() }
      : undefined
    const submission = { id: active?.id, start: { cancelled: false, dispatched: false } }
    submitting.current = submission
    if (!queued && !question) {
      setDraft((current) => (current === prompt ? '' : current))
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
        createdAt: Date.now(),
        lastReadAt: Date.now(),
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
    let userMessage: Message = {
      id: userMessageId,
      role: 'user',
      text: prompt,
      turn,
      createdAt: Date.now(),
    }
    const next: Thread = {
      ...thread,
      mode: providerPermissionMode(thread.provider, thread.mode),
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
      snoozedAt: undefined,
      settledAt: undefined,
      archivedAt: undefined,
      updatedAt: Date.now(),
      messages: [...thread.messages, userMessage],
    }
    setThreads((previous) => {
      const current = previous.find((item) => item.id === id)
      return [
        carryNativeProjectionAuthoredTransition(
          current || thread,
          {
            ...next,
            nativeRecovery: current?.nativeRecovery ?? next.nativeRecovery,
            nativeRecoveryOwner: current?.nativeRecoveryOwner ?? next.nativeRecoveryOwner,
            messages: [...(current?.messages ?? thread.messages), userMessage],
            model: current?.model ?? next.model,
            reasoningEffort: current?.reasoningEffort ?? next.reasoningEffort,
            serviceTier: current?.serviceTier ?? next.serviceTier,
            queue: queued
              ? (current?.queue || []).filter((item) => item.id !== queued.messageId)
              : current?.queue,
          },
          userMessageId,
        ),
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
        const preparedWorkspace = await workbench.prepareForThread(id)
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
              ? carryNativeProjectionAttachmentUpdate(
                  item,
                  {
                    ...item,
                    messages: item.messages.map((message) =>
                      message.id === userMessageId
                        ? { ...message, attachments: selectedAttachments.map(attachmentMetadata) }
                        : message,
                    ),
                  },
                  userMessageId,
                )
              : item,
          ),
        )
      }
      const input: StartInput = {
        sessionId: id,
        localTurn: turn,
        provider: thread.provider,
        remoteId: thread.remoteId,
        workspace: next.workspace || connection.workspace,
        ...(next.purpose === 'research' ? { scope: 'research' as const } : {}),
        prompt,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort ?? '',
        serviceTier: thread.serviceTier ?? '',
        mode: next.mode,
        ...(question
          ? { questionReply: { requestId: question.event.requestId!, answers: question.answers } }
          : {}),
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
        userMessage = { ...userMessage, attachments: uploaded }
        setThreads((previous) =>
          previous.map((item) =>
            item.id === id && item.turn === turn
              ? carryNativeProjectionAttachmentUpdate(
                  item,
                  {
                    ...item,
                    messages: item.messages.map((message) =>
                      message.id === userMessageId
                        ? { ...message, attachments: uploaded }
                        : message,
                    ),
                  },
                  userMessageId,
                )
              : item,
          ),
        )
      }
      if (transfer?.controller.signal.aborted)
        throw new DOMException('Attachment upload cancelled.', 'AbortError')
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      if (sourceReloading.current)
        throw new Error('Life is reloading. The queued message will be paused.')
      if (submission.start.cancelled) return
      const actualConnection = await api!.connection.state()
      if (submission.start.cancelled) return
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
      if (nativeRecoverySupportCurrent.current?.mode === 'durable')
        input.clientRecovery = {
          kind: 'main',
          userMessage,
          threadSeed: {
            id,
            profileId: next.profileId,
            workspace: input.workspace,
            provider: next.provider,
            title: next.title,
            ...(next.purpose ? { purpose: next.purpose } : {}),
            ...(next.researchContext ? { researchContext: next.researchContext } : {}),
            ...(next.createdAt !== undefined ? { createdAt: next.createdAt } : {}),
            updatedAt: next.updatedAt,
            turn,
            messages: [],
            busy: false,
            pending: [],
            model: input.model || '',
            mode: input.mode,
            ...(input.reasoningEffort !== undefined
              ? { reasoningEffort: input.reasoningEffort }
              : {}),
            ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
          },
        }
      runningChoices.current.set(id, {
        model: input.model || '',
        reasoningEffort: input.reasoningEffort || '',
        serviceTier: input.serviceTier || '',
      })
      submission.start.dispatched = true
      await api!.agent.start(input)
      if (selectedAttachments.length) {
        const sentIds = new Set(selectedAttachments.map((item) => item.id))
        setAttachments((current) => current.filter((item) => !sentIds.has(item.id)))
      }
      return true
    } catch (e) {
      if (!queued && !question) draftState.restoreSubmission(prompt, selectedAttachments)
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
      if (question) throw e
    } finally {
      if (attachmentTransfer.current === transfer) attachmentTransfer.current = undefined
      if (transfer) setAttachmentProgress((current) => (current?.id === id ? undefined : current))
      if (submitting.current === submission) submitting.current = undefined
      queue.wake()
    }
  }
  async function submitSteering(
    thread: Thread,
    prompt: string,
    files: DraftAttachment[],
    questionReply?: AgentQuestionReply,
    clientRecovery?: unknown,
  ) {
    if (!nativeRecoveryReady || nativeRecoveryBlocksMutation(thread)) return
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
        ...(questionReply ? { questionReply, clientRecovery } : {}),
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
  async function submitQuestionSteering(
    thread: Thread,
    event: AgentEvent,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const prompt = formatAsyncQuestionReply(event.questions || [], answers)
    const precedingMessageId = thread.messages.at(-1)?.id
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      submission: 'steering',
      text: prompt,
      turn: thread.turn,
      createdAt: Date.now(),
    }
    const uploaded = await submitSteering(
      thread,
      prompt,
      [],
      { requestId: event.requestId!, answers },
      {
        kind: 'main',
        userMessage,
        threadSeed: {
          id: thread.id,
          profileId: thread.profileId,
          ...(thread.workspace !== undefined ? { workspace: thread.workspace } : {}),
          provider: thread.provider,
          title: thread.title,
          ...(thread.purpose ? { purpose: thread.purpose } : {}),
          ...(thread.researchContext ? { researchContext: thread.researchContext } : {}),
          ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
          updatedAt: userMessage.createdAt,
          turn: thread.turn,
          messages: [],
          busy: false,
          pending: [],
          model: thread.model,
          mode: thread.mode,
          ...(thread.reasoningEffort !== undefined
            ? { reasoningEffort: thread.reasoningEffort }
            : {}),
          ...(thread.serviceTier !== undefined ? { serviceTier: thread.serviceTier } : {}),
        },
      },
    )
    if (!uploaded)
      throw new Error('The turn is not ready to receive your answer. Your answers are kept.')
    setThreads((previous) =>
      previous.map((item) => {
        if (item.id !== thread.id || item.messages.some((message) => message.id === userMessage.id))
          return item
        const precedingIndex = precedingMessageId
          ? item.messages.findIndex((message) => message.id === precedingMessageId)
          : -1
        const nextTurnIndex = item.messages.findIndex((message) => message.turn > userMessage.turn)
        const insertAt =
          precedingIndex >= 0
            ? precedingIndex + 1
            : nextTurnIndex >= 0
              ? nextTurnIndex
              : item.messages.length
        const completed = !item.busy || item.turn !== userMessage.turn
        const message: Message = completed
          ? {
              ...userMessage,
              finishedAt: Date.now(),
              finishStatus:
                item.turnStatus === 'interrupted' && item.turn === userMessage.turn
                  ? 'interrupted'
                  : 'completed',
            }
          : userMessage
        return carryNativeProjectionAuthoredTransition(
          item,
          {
            ...item,
            updatedAt: Date.now(),
            messages: [
              ...item.messages.slice(0, insertAt),
              message,
              ...item.messages.slice(insertAt),
            ],
          },
          userMessage.id,
        )
      }),
    )
    return true
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
    if (!active || !api || !canMutateHistory()) return
    if (!nativeRecoveryReady || nativeRecoveryBlocksMutation(active)) return
    queue.pause(active.id)
    const submission = submitting.current?.id === active.id ? submitting.current : undefined
    // Stop can arrive while connection/context preparation still precedes the
    // start IPC. Cancel that exact submission before acknowledging interruption.
    const cancelledBeforeDispatch = Boolean(submission?.start && !submission.start.dispatched)
    if (submission?.start && cancelledBeforeDispatch) submission.start.cancelled = true
    if (attachmentTransfer.current?.id === active.id) {
      attachmentTransfer.current.controller.abort()
      return
    }
    try {
      if (!cancelledBeforeDispatch) await api.agent.stop(active.id)
      setThreads((previous) =>
        previous.map((thread) =>
          thread.id === active.id && thread.turn === active.turn && thread.busy
            ? applyEvent(thread, { sessionId: thread.id, type: 'complete', status: 'interrupted' })
            : thread,
        ),
      )
      if (submission && submitting.current === submission) submitting.current = undefined
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
    if (!canMutateHistory()) return
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
        void api.agent.configure({ sessionId: active.id, ...next }).catch((error) => {
          if (!isCurrent()) return
          setToast(errorText(error))
        })
      }
    } else {
      if (next.model !== undefined) setModel(next.model)
      if (next.mode) setMode(next.mode)
      if (next.reasoningEffort !== undefined) setReasoningEffort(next.reasoningEffort)
      if (next.serviceTier !== undefined) setServiceTier(next.serviceTier)
    }
  }
  async function respond(
    event: AgentEvent,
    accepted: boolean,
    answers?: Record<string, string[]>,
    decisionId?: string,
  ) {
    if (!historyWritable)
      throw new Error('Read the saved disk history before answering this request.')
    if (!api || !event.requestId) throw new Error('This request is no longer available.')
    const target = threadsCurrent.current.find((thread) => thread.id === event.sessionId)
    if (!nativeRecoveryReady || nativeRecoveryBlocksMutation(target))
      throw new Error('Life must verify the original native owner before answering this request.')
    if (!target?.pending.some((request) => request.requestId === event.requestId))
      throw new Error('This request is no longer pending.')
    if (event.responseMode === 'message' && accepted) {
      if (!answers) throw new Error('Answer the question before submitting.')
      const sent = await send(undefined, undefined, { event, answers })
      if (!sent)
        throw new Error('The thread is not ready to receive your answer. Your answers are kept.')
    } else {
      await api.agent.respond(event.sessionId, event.requestId, accepted, answers, decisionId)
    }
    const choice = event.approvalChoices?.find((choice) => choice.id === decisionId)
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === event.sessionId
          ? resolveAgentRequest(thread, event.requestId!, accepted, answers, Date.now(), choice)
          : thread,
      ),
    )
  }
  function importHostHistory(page: HostHistoryPage) {
    if (!canMutateHistory()) return
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
    if (!canMutateHistory()) return
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
    if (!historyReady) return
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
    if (!canMutateHistory()) return
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
    if (!historyReady) return
    emergencyReview.current = false
    setView('workspace')
    activeIdCurrent.current = thread.id
    setWorkspaceActiveId(thread.id)
    setSearchOpen(false)
    setQuery('')
    setThreadMenu(false)
    setProjectOpen(false)
    if (thread.profileId === 'life-local') cancelThreadContext()
    else if (profilesLoaded) void restoreThreadContext(thread)
  }
  function exportThread(thread: Thread, format?: number | string) {
    if (format === 'recovery') {
      const text = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        threads: [projectConversationSource(thread)],
      })
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'life-thread-recovery.json'
      link.click()
      URL.revokeObjectURL(url)
      return
    }
    const text = thread.messages
      .map((message) => {
        const role =
          message.role === 'user'
            ? 'You'
            : message.role === 'error'
              ? 'Error'
              : message.role === 'tool'
                ? message.title || 'Tool'
                : providerName(thread.provider)
        return `## ${role}\n\n${message.input ? `Input:\n\n${message.input}\n\n` : ''}${message.text}`
      })
      .join('\n\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'life-thread.md'
    link.click()
    URL.revokeObjectURL(url)
  }
  function undoThreadAction() {
    if (!canMutateHistory()) return
    const undo = threadUndo
    if (!undo) return
    const preparingId = submitting.current?.id
    if (
      preparingId &&
      undo.changes.some(
        (change) =>
          change.id === preparingId &&
          ((change.before.settled && !change.after.settled) ||
            (change.before.snoozedUntil &&
              change.before.snoozedUntil !== change.after.snoozedUntil) ||
            (change.before.archivedAt && change.before.archivedAt !== change.after.archivedAt)),
      )
    ) {
      const message = 'This message is being prepared. Wait for it to finish, then retry Undo.'
      setThreadUndo({ ...undo, message })
      setToast(message)
      return
    }
    const current = threadsCurrent.current
    const restored = undoThreadArrangement(current, undo.changes)
    setThreads((previous) => undoThreadArrangement(previous, undo.changes))
    if (restored !== current && undo.reopenId) {
      const thread = threadsCurrent.current.find((item) => item.id === undo.reopenId)
      if (thread) selectThread(thread)
    }
    setThreadUndo(undefined)
    setToast(
      restored !== current
        ? 'Thread arrangement restored.'
        : 'The thread has newer activity or edits. Its current arrangement was kept.',
    )
  }
  function threadOccurrence(thread: Thread, candidates: Thread[]): Thread | undefined {
    const exact = candidates.find((item) => item === thread)
    if (exact) return exact
    if (hasConversationSource(thread)) {
      const raw = getConversationSourceRaw(thread)
      const source = candidates.find(
        (item) => hasConversationSource(item) && getConversationSourceRaw(item) === raw,
      )
      return source
    }
    const matching = candidates.filter((item) => item.id === thread.id)
    return matching.length === 1 ? matching[0] : undefined
  }
  function handleThreadAction(thread: Thread, action: ThreadAction, value?: number | string) {
    const current = threadOccurrence(thread, threadsCurrent.current)
    if (!current || !historyReady) return
    if (action !== 'copy' && action !== 'export' && !canMutateHistory()) return
    if (
      !['copy', 'export', 'delete'].includes(action) &&
      threadsCurrent.current.filter((item) => item.id === current.id).length > 1
    ) {
      setToast('These saved threads share an ID. Export recovery JSON before organizing them.')
      return
    }
    if (
      ['archive', 'delete', 'settle', 'snooze'].includes(action) &&
      submitting.current?.id === current.id
    ) {
      setToast(
        'This message is being prepared. Wait for it to finish before organizing the thread.',
      )
      return
    }
    if (action === 'rename') {
      setThreadTitleDraft(current.title)
      setRenamingThread(current.id)
      return
    }
    if (action === 'export') {
      exportThread(current, value)
      return
    }
    if (action === 'settings') {
      setCustomizeOpen(true)
      setThreadMenu(false)
      return
    }
    if (action === 'delete') {
      if (threadCanArchive(current)) setDeletingThread(current)
      setThreadMenu(false)
      return
    }
    if (action === 'copy') {
      const text =
        value === 'path' ? current.workspace : value === 'branch' ? current.gitBranch : current.id
      if (text)
        void navigator.clipboard
          .writeText(text)
          .then(() => setToast('Copied to clipboard.'))
          .catch((error) => setToast(errorText(error)))
      return
    }
    const now = Date.now()
    const before = threadsCurrent.current
    const after = applyThreadAction(
      before,
      current.id,
      action,
      now,
      typeof value === 'number' ? value : undefined,
    )
    if (after === before) return
    const changes = captureThreadArrangementChanges(before, after)
    setThreads((previous) =>
      applyThreadAction(
        previous,
        current.id,
        action,
        now,
        typeof value === 'number' ? value : undefined,
      ),
    )
    const messages: Partial<Record<ThreadAction, string>> = {
      pin: 'Thread pinned.',
      unpin: 'Thread unpinned.',
      'move-up': 'Thread moved up.',
      'move-down': 'Thread moved down.',
      settle: 'Thread settled.',
      restore: 'Thread restored.',
      wake: 'Thread awakened.',
      snooze: 'Thread snoozed.',
      archive: 'Thread archived.',
      unarchive: 'Thread restored from archive.',
      'mark-unread': 'Thread marked unread.',
      'mark-read': 'Thread marked read.',
    }
    const message = messages[action] || 'Thread updated.'
    if (action === 'move-up' || action === 'move-down')
      window.dispatchEvent(new Event('life:thread-arranged'))
    const reopenId =
      action === 'archive' && activeIdCurrent.current === current.id ? current.id : undefined
    setThreadUndo({ message, changes, reopenId })
    setToast(message)
    if (reopenId) newThread()
    setThreadMenu(false)
    if (!reopenId && !renamingThread)
      window.requestAnimationFrame(() => {
        const row = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.sidebar [data-thread-row]'),
        ).find(
          (element) => element.dataset.threadRow === current.id && element.offsetParent !== null,
        )
        row?.focus({ preventScroll: true })
      })
  }
  async function deleteSavedThread() {
    const target = deletingThread && threadOccurrence(deletingThread, threadsCurrent.current)
    if (!target || !canMutateHistory() || !threadCanArchive(target)) return
    const sharedId = threadsCurrent.current.some(
      (thread) => thread !== target && thread.id === target.id,
    )
    const researchLinked = !sharedId && workbench.linkedThreadIds.has(target.id)
    const restoreResearchLinks = researchLinked
      ? workbench.unlinkThreadWithRollback(target.id)
      : undefined
    if (researchLinked && !restoreResearchLinks) return
    const draft = draftState.snapshot('agents:' + target.id)
    const candidates = new Set([
      ...threadAttachmentIds(target),
      ...draft.attachments.map((file) => file.id),
      ...draft.unavailableAttachments.map((file) => file.id),
    ])
    const next = registerNativeProjectionMembershipTransition(
      threadsCurrent.current,
      threadsCurrent.current.filter((thread) => thread !== target),
    )
    setThreads((previous) => {
      const selected = threadOccurrence(target, previous)
      return selected
        ? registerNativeProjectionMembershipTransition(
            previous,
            previous.filter((thread) => thread !== selected),
          )
        : previous
    })
    setDeletingThread(undefined)
    if (activeIdCurrent.current === target.id && view !== 'investigation') newThread()
    let historyDeleted = false
    try {
      const saved = await conversationPersistence.flush(next)
      if (!saved) {
        const linksRestored = restoreResearchLinks?.() ?? true
        setThreads((previous) =>
          threadOccurrence(target, previous) ? previous : [target, ...previous],
        )
        setToast(
          linksRestored
            ? 'The thread could not be deleted from saved history. It has been restored.'
            : 'The thread was restored, but its Research link could not be saved. Keep this window open and retry after freeing storage.',
        )
        return
      }
      historyDeleted = true
      if (!threadsCurrent.current.some((thread) => thread.id === target.id))
        draftState.clear('agents:' + target.id)
      const retained = new Set([
        ...threadsCurrent.current.flatMap(threadAttachmentIds),
        ...draftState.retainedAttachmentIds(),
      ])
      await deleteAttachmentFiles([...candidates].filter((id) => !retained.has(id)))
      setToast('Thread deleted.')
    } catch (error) {
      if (!historyDeleted) {
        restoreResearchLinks?.()
        setThreads((previous) =>
          threadOccurrence(target, previous) ? previous : [target, ...previous],
        )
      }
      setToast(errorText(error))
    }
  }
  function selectUsageThread(id: string) {
    if (!historyReady) return
    const thread = threadsCurrent.current.find((item) => item.id === id)
    if (!thread) return
    if (thread.purpose === 'research' || workbench.linkedThreadIds.has(thread.id)) {
      const context = workbench.contextForThread(thread.id)
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
      setView('investigation')
    } else if (thread.purpose === 'customization') {
      if (streamlinedWorkspace) setStudioOpen(true)
      else setView('customization')
    } else selectThread(thread)
    setUsageOpen(false)
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
  const workspacePanelMaximized =
    view === 'workspace' &&
    workspaceOpen &&
    panels.rightInline &&
    workspaceMaximizedKey === workspaceScopeKey
  const setWorkspacePanelMaximized = useCallback(
    (value: boolean) => setWorkspaceMaximizedKey(value ? workspaceScopeKey : undefined),
    [workspaceScopeKey],
  )

  return (
    <ProjectColorsProvider
      threads={agentThreads}
      profiles={profiles}
      connection={connection}
      projectKeys={projectColorKeys}
    >
      <div
        className={`app-shell life-desktop-layout life-unified-layout life-refined-layout life-polished-layout ${builtin.enabled('collapsed-branding') ? 'life-bottom-brand-layout' : ''} life-header-actions-layout ${view === 'workspace' ? 'life-t3-agents-layout' : ''} ${replacement ? 'life-replacement-active' : ''} ${!sidebarOpen ? 'sidebar-hidden' : ''} ${!workspaceOpen || view !== 'workspace' || replacement ? 'workspace-hidden' : ''}`}
        data-view={view}
        data-right-panel-maximized={workspacePanelMaximized || undefined}
        data-right-panel-inline={panels.rightInline}
        data-research-agent-open={view === 'investigation' && researchAgentOpen && !replacement}
        data-platform={platform}
        data-panel-size={config.workspacePanelWidth === 320 ? 'adaptive' : 'custom'}
        data-sidebar-size={config.sidebarWidth === 260 ? 'adaptive' : 'custom'}
        style={
          {
            ...panels.style,
            ...(workspacePanelMaximized
              ? {
                  '--life-panel-width': sidebarOpen
                    ? 'calc(100vw - var(--life-navigation-width))'
                    : 'calc(100vw - var(--life-collapsed-width))',
                }
              : {}),
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
          utilityActions={
            <>
              <button
                type="button"
                className="icon-button"
                aria-label="Usage"
                title="Provider usage and account limits"
                aria-haspopup="dialog"
                onClick={() => setUsageOpen(true)}
              >
                <BarChart3 size={16} />
              </button>
              <ProviderUpdatesButton
                state={providerUpdateState}
                onClick={() => setProviderUpdatesOpen(true)}
              />
            </>
          }
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
        {!historyReady ? (
          <div className="extension-recovery-bar" role="status">
            Loading saved conversations…
          </div>
        ) : null}
        {historyLoadError ? (
          <div className="extension-recovery-bar" role="status">
            <span>
              {historyLoadError} Showing the local cache. Conversation changes are paused until disk
              history can be read.
            </span>
            <button
              onClick={() => {
                setHistoryReady(false)
                setHistoryLoadError('')
                setHistoryRetry((attempt) => attempt + 1)
              }}
            >
              Retry loading
            </button>
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
          <div className="app-body" inert={!historyReady} aria-busy={!historyReady}>
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
                  onAction={handleThreadAction}
                  draftThreadIds={draftState.draftThreadIds}
                  onArrange={(thread, patch) => {
                    if (!canMutateHistory()) return
                    setThreads((previous) =>
                      previous.map((item) =>
                        item.id === thread.id ? { ...item, ...patch } : item,
                      ),
                    )
                  }}
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
                      onSelect={selectThread}
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
                      title="Local and SSH environments"
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
                    {!localEnvironment ? (
                      <button
                        className="icon-button extension-sidebar-entry"
                        aria-label={`Ports ${config.autoPortForward ? 'Auto' : 'Off'}`}
                        title={`Port forwarding: ${config.autoPortForward ? 'automatic' : 'off'}`}
                        onClick={() => setPortsOpen(true)}
                      >
                        <Cable size={16} />
                      </button>
                    ) : null}
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
              documentRecoveryReady={nativeRecoveryReady}
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
              <main
                className="main-workspace"
                id="main-content"
                data-agent-workspace={view === 'workspace' ? 'true' : undefined}
                inert={workspacePanelMaximized || undefined}
                aria-hidden={workspacePanelMaximized || undefined}
              >
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
                      {view === 'investigation' && workbench.goals.length ? (
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
                              ? localEnvironment
                                ? 'Local connected'
                                : 'SSH connected'
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
                        <ThreadActionsMenu
                          thread={active}
                          onAction={handleThreadAction}
                          open={threadMenu}
                          onOpenChange={setThreadMenu}
                          trigger={
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Thread actions"
                              aria-expanded={threadMenu}
                            >
                              <Ellipsis size={18} />
                            </button>
                          }
                        />
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
                    {active && builtin.enabled('message-navigation') && view !== 'investigation' ? (
                      <ThreadMessageNavigator
                        key={active.id}
                        messages={navigableMessages}
                        searchMessages={active.messages}
                        conversation={conversation}
                        onJump={() => setStickToBottom(false)}
                      />
                    ) : null}
                    <div
                      className={`conversation ${!active ? 'empty-conversation' : ''}`}
                      ref={viewportRef}
                    >
                      {!active && view === 'investigation' ? null : !active ? (
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
                          <ThreadTimeline thread={active} agentWorkspace={view === 'workspace'} />
                          {active.pending
                            .filter(
                              (event) => event.type !== 'question' || !event.questions?.length,
                            )
                            .map((event) => (
                              <ApprovalCard
                                key={event.requestId}
                                event={event}
                                onRespond={(accepted, answers, decisionId) =>
                                  respond(event, accepted, answers, decisionId)
                                }
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
                              onRemove={(id) => {
                                if (canMutateHistory()) queue.remove(active.id, id)
                              }}
                            />
                          ) : null}
                        </div>
                      )}
                    </div>
                    {active && !stickToBottom ? (
                      <button
                        className="scroll-bottom icon-button"
                        aria-label="Scroll to latest message"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => setStickToBottom(true)}
                      >
                        <ChevronDown size={14} />
                        <span>Scroll to end</span>
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
                    <div
                      className="composer-container life-reference-composer"
                      ref={setComposerElement}
                    >
                      {pendingQuestion ? (
                        <>
                          <PendingQuestionPanel
                            event={pendingQuestion}
                            onRespond={respond}
                            disabled={
                              !historyWritable ||
                              !nativeRecoveryReady ||
                              nativeRecoveryBlocksMutation(active)
                            }
                            pendingCount={pendingQuestions.length}
                            active={
                              (view !== 'investigation' || researchAgentOpen) &&
                              !workspacePanelMaximized
                            }
                          />
                          {busy || (active && threadHasRunningChildren(active)) ? (
                            <button
                              type="button"
                              className="button secondary"
                              aria-label="Stop agent and pause queued messages"
                              disabled={Boolean(queue.actionId)}
                              onClick={() => void stop()}
                            >
                              <Square size={13} /> Stop
                            </button>
                          ) : null}
                        </>
                      ) : null}
                      {!pendingQuestion && config.commands.length ? (
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

                      <div
                        hidden={Boolean(pendingQuestion)}
                        style={pendingQuestion ? { display: 'none' } : undefined}
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
                          disabled={
                            !historyWritable || queue.preparing || Boolean(attachmentProgress)
                          }
                          onRemove={(id) => {
                            if (!canMutateHistory()) return
                            cancelAttachmentUpload(id)
                            setAttachments((current) => current.filter((item) => item.id !== id))
                            if (
                              !draftState.retainedAttachmentIds().has(id) &&
                              !threadsCurrent.current.some((thread) =>
                                threadAttachmentIds(thread).includes(id),
                              )
                            )
                              void deleteAttachmentFiles([id]).catch((error) =>
                                setToast(errorText(error)),
                              )
                          }}
                        />
                        {draftState.restoring ? (
                          <p className="draft-restoration-status" role="status">
                            Restoring draft attachments…
                          </p>
                        ) : null}
                        {draftState.unavailableAttachments.length ? (
                          <div className="draft-unavailable-attachments" role="alert">
                            <p>
                              These draft files need to be reattached or removed before sending.
                            </p>
                            {draftState.unavailableAttachments.map((file) => (
                              <div key={file.id}>
                                <span title={file.error}>{file.name}</span>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Remove unavailable attachment ${file.name}`}
                                  onClick={() => draftState.removeUnavailable(file.id)}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
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
                            modeDisabled={!historyWritable}
                            providerDisabled={!historyWritable || Boolean(active)}
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
                                title="Send your message to the current turn without interrupting it"
                                disabled={
                                  !queueControlsReady || (!draft.trim() && !attachments.length)
                                }
                                onClick={() => void steerDraft()}
                              >
                                Steer
                              </button>
                            ) : null}

                            {view !== 'investigation' ? (
                              <AttachmentPicker
                                disabled={
                                  !historyWritable || queue.preparing || Boolean(attachmentProgress)
                                }
                                onFiles={attachFiles}
                              />
                            ) : null}
                            {busy || (active && threadHasRunningChildren(active)) ? (
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
                                !startupReady ||
                                nativeRecoveryBlocksMutation(active) ||
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
                      {view !== 'investigation' ? (
                        <div className="composer-caption composer-worktree-strip">
                          <span>
                            <span className={`status-dot ${connected ? 'online' : ''}`} />
                            {
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
                            }
                          </span>
                          <span
                            className="composer-machine-status"
                            title={
                              connected
                                ? localEnvironment
                                  ? 'Runs on the computer running Life'
                                  : `${connection.profile?.username}@${connection.profile?.host}`
                                : undefined
                            }
                          >
                            {connected ? (
                              <>
                                {localEnvironment ? <Computer size={14} /> : <Cloud size={14} />}
                                <span>{localEnvironment ? 'Local' : connection.profile?.host}</span>
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
            {(workspaceOpen || workspaceSurfacesMounted) &&
            builtin.enabled('workspace-surfaces') ? (
              <WorkspaceSurfaces
                key={`${connection.profile?.id || ''}:${connection.workspace || ''}`}
                open={workspaceOpen && view === 'workspace'}
                inline={panels.rightInline}
                maximized={workspacePanelMaximized}
                onMaximizedChange={setWorkspacePanelMaximized}
                threadScopeKey={workspaceScopeKey}
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
        <UsageDialog
          open={usageOpen}
          onOpenChange={setUsageOpen}
          threads={threads}
          profiles={profiles}
          activeThreadId={activeId}
          activeProfileId={connection.profile?.id}
          activeMachineIdentity={
            connection.profile ? connectionMachineIdentity(connection.profile) : undefined
          }
          connected={connected}
          onReadUsage={api?.agent.usage}
          accountSnapshots={Object.values(accountSnapshots).filter(
            (snapshot): snapshot is ProviderUsageSnapshot => Boolean(snapshot),
          )}
          onSelectThread={selectUsageThread}
        />
        <ProviderUpdatesDialog
          open={providerUpdatesOpen}
          onOpenChange={setProviderUpdatesOpen}
          state={providerUpdateState}
          onCheck={async () => {
            if (!api?.providerUpdates)
              throw new Error('Provider version checks are unavailable in this interface.')
            await api.providerUpdates.check()
          }}
        />
        <UpdateDialog
          open={updatesOpen}
          onOpenChange={setUpdatesOpen}
          state={updateState}
          busy={threads.some((thread) => thread.busy || threadHasRunningChildren(thread))}
          onCheck={async () => {
            if (api) setUpdateState(await api.updates.check())
          }}
          onDownload={async () => {
            if (api) setUpdateState(await api.updates.download())
          }}
          onAutoDownload={async (enabled) => {
            if (api) setUpdateState(await api.updates.setAutoDownload(enabled))
          }}
          onInstall={async () => {
            await api?.updates.install()
          }}
        />
        <PortForwardDialog
          open={portsOpen && !localEnvironment}
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
          beforeConnect={async () => {
            cancelThreadContext()
            await threadContext.current.settled()
          }}
          onConnected={(state) => {
            appContext.current.connection = state
            setConnection(state)
            const selectedWorkspaceThread = threadsCurrent.current.find(
              (thread) => thread.id === workspaceActiveId,
            )
            if (
              selectedWorkspaceThread &&
              selectedWorkspaceThread.profileId !== state.profile?.id
            ) {
              // A successful environment choice retires only the old selection
              // intent. Its conversation and owned draft remain in history even
              // if the project picker is closed before choosing a folder.
              if (viewCurrent.current !== 'investigation') activeIdCurrent.current = undefined
              setWorkspaceActiveId(undefined)
              setThreadMenu(false)
              setStickToBottom(true)
            }
            setRequestedProfileId(undefined)
            setSuggestedProject(undefined)
            setProjectOpen(true)
          }}
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
            {searchResults.map((t) => (
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
            ) : !searchResults.length ? (
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
              <Computer size={16} /> Set up your environment
            </h3>
            <p>
              Local runs agents on the computer running Life. You can also connect a Linux or macOS
              machine over SSH. Choose an existing project directory, then install and sign in to
              either agent on that computer.
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
        <Modal
          open={Boolean(renamingThread)}
          onOpenChange={(open) => {
            if (!open) setRenamingThread(undefined)
          }}
          title="Rename thread"
          description="Choose a title for this conversation."
        >
          <form
            className="thread-name-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!canMutateHistory()) return
              const title = threadTitleDraft.trim()
              if (!title || !renamingThread) return
              setThreads((previous) =>
                previous.map((thread) =>
                  thread.id === renamingThread
                    ? { ...thread, title, titleSource: 'manual' }
                    : thread,
                ),
              )
              setRenamingThread(undefined)
            }}
          >
            <label htmlFor="life-thread-title">Thread title</label>
            <input
              id="life-thread-title"
              autoFocus
              value={threadTitleDraft}
              maxLength={200}
              onChange={(event) => setThreadTitleDraft(event.target.value)}
            />
            <button type="submit" className="button primary" disabled={!threadTitleDraft.trim()}>
              Save title
            </button>
          </form>
        </Modal>
        <Modal
          open={Boolean(deletingThread)}
          onOpenChange={(open) => {
            if (!open) setDeletingThread(undefined)
          }}
          title="Delete thread"
          description="Delete this saved conversation and its draft? Project files and the provider’s own history remain on the connected machine."
        >
          <div className="thread-delete-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setDeletingThread(undefined)}
            >
              Keep thread
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                !deletingThread ||
                !threadCanArchive(threadOccurrence(deletingThread, threads) ?? deletingThread)
              }
              onClick={() => void deleteSavedThread()}
            >
              Delete saved thread
            </button>
          </div>
        </Modal>
        {toast ? (
          <div className="toast" role="status">
            <span>{toast}</span>
            {threadUndo && toast === threadUndo.message ? (
              <button type="button" className="thread-undo-button" onClick={undoThreadAction}>
                Undo
              </button>
            ) : null}
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
