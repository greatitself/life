import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowUpRight, GitPullRequest, RefreshCw } from 'lucide-react'
import type { ConnectionState } from '../../shared/types'
import type { Thread } from '../state'
import { api, errorText } from '../api'

interface PullRequest {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  author?: { login: string }
  body: string
}
const githubPull = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)\/?$/
export function PullRequestSurface({
  connection,
  thread,
  linked,
  active,
  refreshKey,
}: {
  connection: ConnectionState
  thread?: Thread
  linked: boolean
  active: boolean
  refreshKey: number
}) {
  const [selectedLink, setSelectedLink] = useState<string>()
  const [pull, setPull] = useState<PullRequest>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const links = useMemo(() => {
    const text = thread?.messages.map((message) => message.text).join('\n') || ''
    return [
      ...new Set(
        [
          ...text.matchAll(/https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/\d+/g),
        ].map((match) => match[0]),
      ),
    ]
  }, [thread?.messages])
  useEffect(() => {
    setSelectedLink(undefined)
  }, [thread?.id])
  useEffect(() => {
    setPull(undefined)
    setError('')
    setBusy(false)
    if (
      !active ||
      !api ||
      connection.status !== 'connected' ||
      !connection.workspace ||
      (linked && !selectedLink)
    )
      return
    const bridge = api
    let valid = true
    const match = selectedLink?.match(githubPull)
    const target = linked && match ? `${match[3]} --repo ${match[1]}/${match[2]}` : ''
    const command = `gh pr view ${target} --json number,title,url,state,isDraft,headRefName,baseRefName,author,body`
    setBusy(true)
    void bridge.connection
      .execute({ command, workspace: connection.workspace, timeoutMs: 30000 })
      .then((output) => {
        const value = JSON.parse(output.trim()) as PullRequest
        if (
          typeof value.title !== 'string' ||
          typeof value.url !== 'string' ||
          !githubPull.test(value.url)
        )
          throw new Error('GitHub CLI did not return a pull request.')
        if (valid) setPull(value)
      })
      .catch((error) => {
        if (valid) setError(errorText(error))
      })
      .finally(() => {
        if (valid) setBusy(false)
      })
    return () => {
      valid = false
    }
  }, [
    active,
    linked,
    selectedLink,
    connection.status,
    connection.workspace,
    connection.profile?.id,
    refresh,
    refreshKey,
  ])
  const connected = connection.status === 'connected' && Boolean(connection.workspace)
  return (
    <div className="surface-pull-requests">
      <div className="surface-section-heading">
        {linked && selectedLink ? (
          <button
            className="icon-button"
            aria-label="Back to linked pull requests"
            onClick={() => setSelectedLink(undefined)}
          >
            <ArrowLeft size={15} />
          </button>
        ) : (
          <GitPullRequest size={16} />
        )}
        <strong>{linked ? 'Linked pull requests' : 'Pull request'}</strong>
        <button
          className="icon-button"
          aria-label="Refresh pull request"
          disabled={!connected || busy || (linked && !selectedLink)}
          onClick={() => setRefresh((current) => current + 1)}
        >
          <RefreshCw size={15} className={busy ? 'spinning' : ''} />
        </button>
      </div>
      {linked && !selectedLink ? (
        links.length ? (
          <div className="surface-linked-list">
            {links.map((url) => (
              <button key={url} onClick={() => setSelectedLink(url)}>
                <GitPullRequest size={16} />
                <span>{url.replace('https://github.com/', '')}</span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="surface-empty">
            Pull request links shared in this thread will appear here.
          </div>
        )
      ) : !connected ? (
        <div className="surface-empty">
          Connect a machine and select a project to read its pull requests.
        </div>
      ) : busy ? (
        <div className="surface-empty" role="status">
          Loading pull request…
        </div>
      ) : error ? (
        <div className="surface-empty" role="alert">
          <p>{error}</p>
          <p>
            Pull request details use GitHub CLI on the connected machine. It needs to be installed
            and signed in.
          </p>
          <button className="button secondary" onClick={() => setRefresh((current) => current + 1)}>
            Try again
          </button>
          {selectedLink ? (
            <a href={selectedLink} target="_blank" rel="noreferrer">
              Open on GitHub <ArrowUpRight size={14} />
            </a>
          ) : null}
        </div>
      ) : pull ? (
        <div className="surface-pull-detail">
          <div className="surface-pull-state">
            #{pull.number} · {pull.isDraft ? 'Draft' : pull.state}{' '}
            {pull.author?.login ? `· ${pull.author.login}` : ''}
          </div>
          <h2>{pull.title}</h2>
          <p className="surface-pull-branches">
            {pull.headRefName} → {pull.baseRefName}
          </p>
          <a href={pull.url} target="_blank" rel="noreferrer">
            Open on GitHub <ArrowUpRight size={14} />
          </a>
          <pre>{pull.body || 'No description provided.'}</pre>
        </div>
      ) : (
        <div className="surface-empty">No pull request loaded.</div>
      )}
    </div>
  )
}
