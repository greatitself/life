import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Folder, History, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import type {
  HostHistoryAPI,
  HostHistoryPage,
  HostHistorySession,
} from '../../shared/agent-history'
import type { Provider } from '../../shared/types'
import { errorText, streamlinedWorkspace } from '../api'
import { Modal } from './Modal'
import { ProviderIcon } from './Icons'
import { MessageView } from './MessageView'
import './host-history.css'

export function HostHistoryDialog({
  open,
  onOpenChange,
  api,
  connected,
  onImport,
  existingIds = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  api?: HostHistoryAPI
  connected: boolean
  onImport: (page: HostHistoryPage) => void
  existingIds?: string[]
}) {
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<HostHistorySession[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [page, setPage] = useState<HostHistoryPage>()
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string>()
  const requests = useRef(new Set<string>())
  const listGeneration = useRef(0)
  const readGeneration = useRef(0)

  const cancelRequests = () => {
    for (const requestId of requests.current) void api?.cancel(requestId).catch(() => {})
    requests.current.clear()
  }
  useEffect(() => {
    if (!open || !connected || !api) {
      listGeneration.current++
      readGeneration.current++
      cancelRequests()
      setLoading(false)
      setReading(false)
      return
    }
    const generation = ++listGeneration.current
    readGeneration.current++
    cancelRequests()
    setPage(undefined)
    setReading(false)
    setSelected(undefined)
    setSessions([])
    setNextCursor(undefined)
    setError('')
    setWarnings([])
    setLoading(true)
    const timer = setTimeout(
      () => {
        const requestId = crypto.randomUUID()
        requests.current.add(requestId)
        void api
          .list({ provider, query, refresh: revision > 0, requestId })
          .then((result) => {
            if (generation !== listGeneration.current) return
            setSessions(result.sessions)
            setNextCursor(result.nextCursor)
            setWarnings(result.warnings)
          })
          .catch((error) => {
            if (generation === listGeneration.current) setError(errorText(error))
          })
          .finally(() => {
            requests.current.delete(requestId)
            if (generation === listGeneration.current) setLoading(false)
          })
      },
      query ? 250 : 0,
    )
    return () => {
      clearTimeout(timer)
      listGeneration.current++
      cancelRequests()
    }
  }, [open, connected, api, provider, query, revision])

  async function loadMoreSessions() {
    if (!api || !nextCursor || loading) return
    const generation = listGeneration.current
    const requestId = crypto.randomUUID()
    requests.current.add(requestId)
    setLoading(true)
    setError('')
    try {
      const result = await api.list({ provider, query, cursor: nextCursor, requestId })
      if (generation !== listGeneration.current) return
      setSessions((previous) => {
        const byId = new Map(previous.map((session) => [session.id, session]))
        for (const session of result.sessions) byId.set(session.id, session)
        return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      })
      setNextCursor(result.nextCursor)
      setWarnings(result.warnings)
    } catch (error) {
      if (generation === listGeneration.current) setError(errorText(error))
    } finally {
      requests.current.delete(requestId)
      if (generation === listGeneration.current) setLoading(false)
    }
  }

  async function readSession(id: string, cursor?: string) {
    if (!api || (reading && cursor)) return
    const generation = ++readGeneration.current
    for (const requestId of requests.current)
      if (requestId.startsWith('history-read:')) {
        void api.cancel(requestId).catch(() => {})
        requests.current.delete(requestId)
      }
    const requestId = `history-read:${crypto.randomUUID()}`
    requests.current.add(requestId)
    setSelected(id)
    setReading(true)
    setError('')
    if (!cursor) setPage(undefined)
    try {
      const result = await api.read({ id, cursor, requestId })
      if (generation !== readGeneration.current) return
      setPage((previous) => {
        if (!cursor || previous?.session.id !== id) return result
        const byId = new Map(previous.messages.map((message) => [message.id, message]))
        for (const message of result.messages) byId.set(message.id, message)
        return { ...result, messages: [...byId.values()] }
      })
      setWarnings(result.warnings)
    } catch (error) {
      if (generation === readGeneration.current) setError(errorText(error))
    } finally {
      requests.current.delete(requestId)
      if (generation === readGeneration.current) setReading(false)
    }
  }
  const imported = page && existingIds.includes(page.session.id)
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Host chat history"
      description="Browse Codex and Claude Code conversations already saved on this machine, including chats started outside Life."
      className="host-history-modal"
    >
      {!connected ? (
        <div className="host-history-empty">
          <History size={28} />
          <strong>Connect to a machine first</strong>
          <p>
            Its existing provider sessions will appear here after connecting. A project selection is
            optional.
          </p>
        </div>
      ) : !api ? (
        <div className="host-history-empty">
          <p>Host history is available in the Life desktop app.</p>
        </div>
      ) : (
        <>
          <div className="host-history-toolbar">
            <label className="host-history-search">
              <Search size={15} />
              <span className="sr-only">Search host chat history</span>
              <input
                placeholder="Search saved chat titles…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="host-history-providers" aria-label="History provider">
              {(['all', 'codex', 'claude'] as const).map((value) => (
                <button
                  key={value}
                  className={provider === value ? 'active' : ''}
                  aria-pressed={provider === value}
                  onClick={() => setProvider(value)}
                >
                  {value !== 'all' && <ProviderIcon provider={value} size={13} />}
                  {value === 'all' ? 'All' : value === 'codex' ? 'Codex' : 'Claude Code'}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="Refresh host chat history"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={15} className={loading ? 'spinning' : ''} />
            </button>
          </div>
          {error && (
            <div className="host-history-notice" role="alert">
              {error}
            </div>
          )}
          {warnings.length > 0 && (
            <details className="host-history-notice">
              <summary>History details ({warnings.length})</summary>
              {warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          <div className="host-history-layout">
            <div className="host-history-list" aria-label="Existing provider sessions">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`host-history-session ${selected === session.id ? 'selected' : ''}`}
                  onClick={() => void readSession(session.id)}
                  aria-pressed={selected === session.id}
                >
                  <div>
                    <ProviderIcon provider={session.provider} size={16} />
                    <strong>{session.title}</strong>
                  </div>
                  <span className="host-history-folder">
                    <Folder size={12} />
                    {session.workspace || 'Project folder unavailable'}
                  </span>
                  <span className="host-history-date">
                    {session.updatedAt
                      ? new Date(session.updatedAt).toLocaleString()
                      : 'Unknown date'}
                    <span>
                      {session.lifePurpose === 'research'
                        ? 'Research'
                        : session.archived
                          ? 'Archived'
                          : existingIds.includes(session.id)
                            ? 'In Life'
                            : ''}
                    </span>
                  </span>
                </button>
              ))}
              {loading && (
                <div className="host-history-loading" role="status">
                  <LoaderCircle size={17} className="spinning" /> Reading saved sessions…
                </div>
              )}
              {!loading && !sessions.length && (
                <div className="host-history-empty">
                  <History size={25} />
                  <p>
                    {query
                      ? 'No matching sessions on this page.'
                      : 'No existing conversations found.'}
                  </p>
                  {nextCursor && <p>Continue searching older saved sessions below.</p>}
                </div>
              )}
              {nextCursor && (
                <button
                  className="host-history-more"
                  disabled={loading}
                  onClick={() => void loadMoreSessions()}
                >
                  {loading ? 'Loading…' : 'Load more sessions'}
                </button>
              )}
            </div>
            <div className="host-history-preview">
              {!page && (
                <div className="host-history-empty">
                  {reading ? (
                    <>
                      <LoaderCircle size={26} className="spinning" />
                      <p>Reading the original conversation…</p>
                    </>
                  ) : (
                    <>
                      <History size={28} />
                      <strong>Select a conversation</strong>
                      <p>
                        Read its messages, tool results and subagent activity, then continue it in
                        Life.
                      </p>
                    </>
                  )}
                </div>
              )}
              {page && (
                <>
                  <div className="host-history-preview-header">
                    <div>
                      <strong>{page.session.title}</strong>
                      <span>
                        {page.session.workspace || 'Original project folder is unavailable'}
                      </span>
                    </div>
                    {page.session.parentRemoteId ? (
                      <button
                        className="host-history-more"
                        disabled={reading || page.session.parentRemoteId === 'subagent'}
                        onClick={() =>
                          void readSession(
                            `${page.session.provider}:${page.session.parentRemoteId}`,
                          )
                        }
                      >
                        Open parent conversation
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        disabled={reading}
                        title={
                          streamlinedWorkspace
                            ? 'Continue this conversation as an interactive Life thread'
                            : undefined
                        }
                        onClick={() => {
                          onImport(page)
                          onOpenChange(false)
                        }}
                      >
                        {streamlinedWorkspace && !imported
                          ? 'Bring to Life'
                          : page.session.lifePurpose === 'research'
                            ? 'Open in Research'
                            : imported
                              ? 'Open in Life'
                              : 'Resume in Life'}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                  <div className="host-history-messages">
                    {page.messages.map((message) => (
                      <MessageView
                        key={message.id}
                        message={message}
                        provider={page.session.provider}
                      />
                    ))}
                    {!page.messages.length && !page.nextCursor && (
                      <div className="host-history-empty">
                        <p>This saved session contains no visible conversation messages.</p>
                      </div>
                    )}
                    {page.subagents.length > 0 && (
                      <div className="host-history-subagents">
                        <strong>Saved subagent sessions</strong>
                        {page.subagents.map((agent) => (
                          <button key={agent.id} onClick={() => void readSession(agent.id)}>
                            {agent.agentName || agent.title}
                            <ArrowRight size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                    {page.nextCursor && (
                      <button
                        className="host-history-more"
                        disabled={reading}
                        onClick={() => void readSession(page.session.id, page.nextCursor)}
                      >
                        {reading ? 'Loading more messages…' : 'Load more of this conversation'}
                      </button>
                    )}
                  </div>
                  <p className="host-history-footnote">
                    The original provider session stays on this host. Continuing uses its existing
                    session ID.
                    {page.nextCursor
                      ? ' More messages remain available; importing keeps this history continuation visible.'
                      : ''}
                  </p>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
