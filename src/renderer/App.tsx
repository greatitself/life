import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  Computer,
  Ellipsis,
  Folder,
  GitBranch,
  GitPullRequest,
  HardDrive,
  Keyboard,
  LoaderCircle,
  MessageSquare,
  Minus,
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
} from '../shared/types'
import { api, desktop, errorText } from './api'
import { applyEvent, readThreads, type Thread } from './state'
import { RelayMark, ProviderIcon } from './components/Icons'
import { Modal } from './components/Modal'
import { ConnectionDialog } from './components/ConnectionDialog'
import { MessageView, ApprovalCard } from './components/MessageView'
import { WorkspacePanel } from './components/WorkspacePanel'
import { RemoteTerminal } from './components/RemoteTerminal'

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
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [connection, setConnection] = useState<ConnectionState>({ status: 'disconnected' })
  const [threads, setThreads] = useState<Thread[]>(readThreads)
  const [activeId, setActiveId] = useState<string>()
  const [provider, setProvider] = useState<Provider>('codex')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<PermissionMode>('review')
  const [models, setModels] = useState<ModelOption[]>([{ id: '', name: 'Agent default' }])
  const [draft, setDraft] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hostKey, setHostKey] = useState<HostKeyRequest>()
  const [workspaceOpen, setWorkspaceOpen] = useState(() => window.innerWidth > 1080)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 600)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState('')
  const [threadMenu, setThreadMenu] = useState(false)
  const [stickToBottom, setStickToBottom] = useState(true)
  const conversation = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const active = threads.find((t) => t.id === activeId)
  const currentProvider = active?.provider || provider
  const currentModel = active?.model ?? model
  const currentMode = active?.mode || mode
  const connected = connection.status === 'connected'
  const busy = active?.busy || false
  const refreshProfiles = useCallback(() => {
    void api?.profiles
      .list()
      .then(setProfiles)
      .catch((e) => setToast(errorText(e)))
  }, [])

  useEffect(() => {
    refreshProfiles()
    if (!api) return
    void api.connection.state().then(setConnection)
    const offConnection = api.onConnection((state) => {
      setConnection(state)
      if (state.status === 'disconnected') setTerminalOpen(false)
    })
    const offHost = api.onHostKey(setHostKey)
    const offAgent = api.onAgent((event) => {
      setThreads((previous) =>
        previous.map((t) => (t.id === event.sessionId ? applyEvent(t, event) : t)),
      )
      if (event.type === 'complete') setRefreshKey((key) => key + 1)
    })
    return () => {
      offConnection()
      offHost()
      offAgent()
    }
  }, [refreshProfiles])
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
    if (!api || !connected || connection[currentProvider] === 'missing') {
      setModels(
        currentProvider === 'claude'
          ? [
              { id: '', name: 'Claude default' },
              { id: 'sonnet', name: 'Sonnet' },
              { id: 'opus', name: 'Opus' },
              { id: 'haiku', name: 'Haiku' },
            ]
          : [{ id: '', name: 'Codex default' }],
      )
      return
    }
    let valid = true
    void api.agent
      .models(currentProvider)
      .then((m) => {
        if (valid) setModels(m)
      })
      .catch((e) => {
        if (valid) {
          setModels([{ id: '', name: 'Agent default' }])
          setToast(errorText(e))
        }
      })
    return () => {
      valid = false
    }
  }, [connected, currentProvider, connection.codex, connection.claude])
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
    setActiveId(undefined)
    setDraft('')
    setThreadMenu(false)
    setStickToBottom(true)
    textarea.current?.focus()
  }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || hostKey || connectOpen || helpOpen || searchOpen)
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
          setTerminalOpen((v) => !v)
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
  }, [newThread, hostKey, connectOpen, helpOpen, searchOpen])
  async function send() {
    if (!draft.trim() || busy || submitting.current) return
    if (!connected || !api) {
      setConnectOpen(true)
      return
    }
    if (active && active.profileId !== connection.profile?.id) {
      setToast(
        'Connect to this thread’s machine to continue, or start a new thread on the current machine.',
      )
      return
    }
    submitting.current = true
    const prompt = draft.trim()
    setDraft('')
    setStickToBottom(true)
    let thread = active
    if (!thread) {
      thread = {
        id: crypto.randomUUID(),
        profileId: connection.profile!.id,
        provider,
        title: prompt.slice(0, 54),
        messages: [],
        busy: false,
        model,
        mode,
        updatedAt: Date.now(),
        turn: 0,
        pending: [],
      }
      setActiveId(thread.id)
    }
    const id = thread.id
    const turn = thread.turn + 1
    const next: Thread = {
      ...thread,
      turn,
      busy: true,
      updatedAt: Date.now(),
      messages: [...thread.messages, { id: crypto.randomUUID(), role: 'user', text: prompt, turn }],
    }
    setThreads((previous) => [next, ...previous.filter((t) => t.id !== id)])
    try {
      await api.agent.start({
        sessionId: id,
        provider: thread.provider,
        remoteId: thread.remoteId,
        prompt,
        model: thread.model,
        mode: thread.mode,
      })
    } catch (e) {
      setThreads((previous) =>
        previous.map((t) =>
          t.id === id ? applyEvent(t, { sessionId: id, type: 'error', text: errorText(e) }) : t,
        ),
      )
    } finally {
      submitting.current = false
    }
  }
  async function stop() {
    if (!active || !api) return
    try {
      await api.agent.stop(active.id)
    } catch (e) {
      setToast(errorText(e))
    }
  }
  const updateSettings = (value: { model?: string; mode?: PermissionMode }) => {
    if (active)
      setThreads((previous) => previous.map((t) => (t.id === active.id ? { ...t, ...value } : t)))
    else {
      if (value.model !== undefined) setModel(value.model)
      if (value.mode) setMode(value.mode)
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
    setActiveId(thread.id)
    setDraft('')
    setSearchOpen(false)
    setQuery('')
    setStickToBottom(true)
    setThreadMenu(false)
  }
  const titleProfile = active ? profiles.find((p) => p.id === active.profileId) : connection.profile

  return (
    <div
      className={`app-shell ${!sidebarOpen ? 'sidebar-hidden' : ''} ${!workspaceOpen ? 'workspace-hidden' : ''}`}
    >
      <div className="titlebar">
        <div className="window-controls">
          <button
            className="window-dot close"
            aria-label="Close window"
            onClick={() => api?.window.close()}
          />
          <button
            className="window-dot minimize"
            aria-label="Minimize window"
            onClick={() => api?.window.minimize()}
          />
          <button
            className="window-dot maximize"
            aria-label="Maximize window"
            onClick={() => api?.window.maximize()}
          />
        </div>
        <span className="titlebar-name">Life</span>
        <span className="titlebar-center">A little closer to your next idea.</span>
        <span className="version">v0.1</span>
      </div>
      <div className="app-body">
        <aside className="sidebar" aria-label="Projects and threads">
          <div className="brand">
            <span className="brand-mark">
              <RelayMark size={24} />
            </span>
            <strong>
              life<span className="brand-period">.</span>
            </strong>
            <button
              className="icon-button"
              title="Toggle sidebar (Ctrl+B)"
              aria-label="Hide sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <button className="new-thread-button" onClick={newThread}>
            <Plus size={17} /> New thread <kbd>{shortcutModifier} N</kbd>
          </button>
          <button className="sidebar-search" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            <span>Search threads</span>
            <kbd>{shortcutModifier} K</kbd>
          </button>
          <div className="sidebar-section-title">
            <span>WORKSPACES</span>
            <button
              className="icon-button"
              aria-label="Add workspace"
              onClick={() => setConnectOpen(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="project-list">
            {profiles.length ? (
              profiles.map((profile) => (
                <div className="project-group" key={profile.id}>
                  <button
                    className="project-heading"
                    onClick={() => {
                      if (connection.profile?.id !== profile.id || !connected) setConnectOpen(true)
                      else newThread()
                    }}
                  >
                    <ChevronDown size={13} />
                    <Folder size={16} />
                    <span>{profile.name}</span>
                    {connection.profile?.id === profile.id && connected ? (
                      <span className="status-dot online" />
                    ) : (
                      <Server size={12} className="muted" />
                    )}
                  </button>
                  {threads
                    .filter((t) => t.profileId === profile.id)
                    .map((t) => (
                      <button
                        className={`thread-row ${activeId === t.id ? 'active' : ''}`}
                        key={t.id}
                        onClick={() => selectThread(t)}
                      >
                        <ProviderIcon provider={t.provider} size={13} />
                        <span>{t.title}</span>
                        {t.busy ? <span className="status-dot working" /> : null}
                      </button>
                    ))}
                  {!threads.some((t) => t.profileId === profile.id) ? (
                    <div className="project-no-threads">Your next idea starts here.</div>
                  ) : null}
                </div>
              ))
            ) : (
              <>
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
                <div className="sidebar-empty">
                  <div className="thread-skeleton">
                    <MessageSquare size={13} />
                    <span />
                  </div>
                  <div className="thread-skeleton">
                    <MessageSquare size={13} />
                    <span />
                  </div>
                  <div className="thread-skeleton">
                    <MessageSquare size={13} />
                    <span />
                  </div>
                  <p>
                    A place for every project.
                    <br />A thread for every idea.
                  </p>
                </div>
              </>
            )}
            {threads.filter((t) => !profiles.some((p) => p.id === t.profileId)).length ? (
              <div className="orphaned-threads">
                <span className="eyebrow">Previous threads</span>
                {threads
                  .filter((t) => !profiles.some((p) => p.id === t.profileId))
                  .map((t) => (
                    <button
                      className={`thread-row ${activeId === t.id ? 'active' : ''}`}
                      key={t.id}
                      onClick={() => selectThread(t)}
                    >
                      <ProviderIcon provider={t.provider} size={13} />
                      <span>{t.title}</span>
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
          <div className="sidebar-bottom">
            <button
              className={`machine-card ${connected ? 'connected' : ''}`}
              onClick={() => setConnectOpen(true)}
            >
              <span className="machine-icon">
                <Server size={17} />
              </span>
              <span>
                <strong>{connected ? connection.profile?.name : 'Connect a machine'}</strong>
                <small>
                  {connected
                    ? `${connection.profile?.username}@${connection.profile?.host}`
                    : 'Work from anywhere'}
                </small>
              </span>
              {connection.status === 'connecting' ? (
                <LoaderCircle size={15} className="spinning" />
              ) : connected ? (
                <span className="status-dot online" />
              ) : (
                <ArrowUpRight size={15} />
              )}
            </button>
            <div className="sidebar-bottom-actions">
              <button onClick={() => setConnectOpen(true)}>
                <Settings2 size={15} /> Connections
              </button>
              <button
                className="icon-button"
                aria-label="Help and keyboard shortcuts"
                onClick={() => setHelpOpen(true)}
              >
                <CircleHelp size={16} />
              </button>
            </div>
            <div className="sidebar-credit">
              <span className="tiny-logo">
                <RelayMark size={12} />
              </span>{' '}
              Your agents. Your machines.
            </div>
          </div>
        </aside>
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
              <Folder size={15} />
              <span>{titleProfile?.name || 'Workspace'}</span>
              <ChevronRight size={13} />
              <strong>{active?.title || 'New thread'}</strong>
            </div>
            <div className="header-actions">
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
                onClick={() => setTerminalOpen((v) => !v)}
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
                <div className="welcome">
                  <div className="welcome-emblem">
                    <RelayMark size={29} />
                  </div>
                  <div className="welcome-eyebrow">
                    <span /> YOUR IDEAS, WITHOUT BORDERS
                  </div>
                  <h1>Good work travels.</h1>
                  <p>
                    Your favorite coding agents.
                    <br />
                    Any machine you call home.
                  </p>
                  <div className="provider-cards">
                    {(['codex', 'claude'] as const).map((p) => (
                      <button
                        className={`provider-card ${provider === p ? 'active' : ''}`}
                        key={p}
                        onClick={() => {
                          setProvider(p)
                          setModel('')
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
                  <div className="welcome-divider">
                    <span />
                    <span>A little inspiration to get started</span>
                    <span />
                  </div>
                  <div className="starter-grid">
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
                    <MessageView key={message.id} message={message} provider={active.provider} />
                  ))}
                  {active.pending.map((event) => (
                    <ApprovalCard
                      key={event.requestId}
                      event={event}
                      onRespond={(accepted, answers) => respond(event, accepted, answers)}
                    />
                  ))}
                  {busy && !active.pending.length ? (
                    <div className="agent-working">
                      <span className="working-indicator">
                        <i />
                        <i />
                        <i />
                      </span>
                      {providerName(currentProvider)} is working<span>on your remote machine</span>
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
            <div className="composer-container">
              <div className={`composer ${busy ? 'busy' : ''}`}>
                <textarea
                  ref={textarea}
                  aria-label="Message your coding agent"
                  placeholder={
                    connected
                      ? 'What are we building?'
                      : 'What are we building? Connect a machine to get started.'
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
                        onChange={(e) => updateSettings({ mode: e.target.value as PermissionMode })}
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
                      aria-label="Stop agent"
                      onClick={() => void stop()}
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className={`send-button ${!connected ? 'connect-send' : ''}`}
                      aria-label={connected ? 'Send message' : 'Connect to send'}
                      disabled={connected && !draft.trim()}
                      onClick={() => {
                        if (!connected) setConnectOpen(true)
                        else void send()
                      }}
                    >
                      {!connected ? (
                        <>
                          <span>Connect</span>
                          <ArrowUpRight size={15} />
                        </>
                      ) : (
                        <ArrowUp size={18} />
                      )}
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-caption">
                <span>
                  <span className={`status-dot ${connected ? 'online' : ''}`} />
                  {connected ? connection.workspace : 'Agents run on your remote machine'}
                </span>
                <span>
                  <kbd>↵</kbd> Send <span className="caption-dot">·</span> <kbd>⇧ ↵</kbd> New line
                </span>
              </div>
            </div>
          </div>
          {terminalOpen ? (
            <RemoteTerminal connected={connected} onClose={() => setTerminalOpen(false)} />
          ) : null}
        </main>
        {workspaceOpen ? (
          <WorkspacePanel
            connection={connection}
            onConnect={() => setConnectOpen(true)}
            onClose={() => setWorkspaceOpen(false)}
            refreshKey={refreshKey}
            onAttach={(path) => {
              setDraft(
                (d) =>
                  `${d}${d ? '\n' : ''}Please look at ${path.replace(connection.workspace + '/', '')}. `,
              )
              textarea.current?.focus()
            }}
            onTerminal={() => setTerminalOpen(true)}
          />
        ) : null}
      </div>
      <ConnectionDialog
        open={connectOpen}
        suspended={Boolean(hostKey)}
        onOpenChange={setConnectOpen}
        profiles={profiles}
        refreshProfiles={refreshProfiles}
        connection={connection}
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
