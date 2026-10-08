import { useEffect, useRef, useState } from 'react'
import {
  FolderKey,
  KeyRound,
  LoaderCircle,
  Server,
  ShieldCheck,
  Trash2,
  ArrowUpRight,
  Plus,
  Terminal,
  ChevronRight,
  FileCog,
  RefreshCw,
} from 'lucide-react'
import type {
  ConnectInput,
  ConnectionProfile,
  ConnectionState,
  SSHConfigHost,
  SSHConfigList,
} from '../../shared/types'
import { profileSchema } from '../../shared/validation'
import { api, desktop, errorText } from '../api'
import { Modal } from './Modal'

const blank = (): ConnectInput => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  auth: 'key',
  privateKeyPath: '',
  workspace: '~',
  password: '',
  passphrase: '',
})
export function ConnectionDialog({
  open,
  suspended = false,
  onOpenChange,
  profiles,
  refreshProfiles,
  connection,
  initialProfileId,
}: {
  open: boolean
  suspended?: boolean
  onOpenChange: (v: boolean) => void
  profiles: ConnectionProfile[]
  refreshProfiles: () => void
  connection: ConnectionState
  initialProfileId?: string
}) {
  const [input, setInput] = useState<ConnectInput>(blank)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [configList, setConfigList] = useState<SSHConfigList | null>(null)
  const [configHost, setConfigHost] = useState<SSHConfigHost | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const configGeneration = useRef(0)
  async function loadConfig(path = configPath) {
    if (!api) return
    const generation = ++configGeneration.current
    setConfigLoading(true)
    try {
      const result = await api.sshConfig.list(path || undefined)
      if (generation !== configGeneration.current) return
      setConfigList(result)
      setConfigPath(result.path)
    } catch (failure) {
      if (generation === configGeneration.current)
        setConfigList({ path, hosts: [], error: errorText(failure) })
    } finally {
      if (generation === configGeneration.current) setConfigLoading(false)
    }
  }
  useEffect(() => {
    if (open) {
      setError('')
      setSaved(false)
      const requestedProfile = profiles.find((profile) => profile.id === initialProfileId)
      if (requestedProfile) setInput({ ...requestedProfile, password: '', passphrase: '' })
      void loadConfig(requestedProfile?.sshConfig?.path || input.sshConfig?.path || configPath)
    } else {
      configGeneration.current++
      setInput((p) => ({ ...p, password: '', passphrase: '' }))
    }
  }, [open, initialProfileId])
  useEffect(() => {
    const source = input.sshConfig
    if (!open || !source || !api) {
      setConfigHost(null)
      return
    }
    let disposed = false
    api.sshConfig.resolve(source.alias, source.path).then(
      (host) => {
        if (!disposed) setConfigHost(host)
      },
      (failure) => {
        if (!disposed) setError(errorText(failure))
      },
    )
    return () => {
      disposed = true
    }
  }, [open, input.sshConfig?.alias, input.sshConfig?.path])
  const update = <K extends keyof ConnectInput>(key: K, value: ConnectInput[K]) => {
    setInput((p) => ({ ...p, [key]: value }))
    setError('')
    setSaved(false)
  }
  async function save(connect: boolean) {
    setError('')
    setSaved(false)
    const parsed = profileSchema.safeParse({
      ...input,
      name: input.name.trim() || input.host.trim(),
    })
    if (!parsed.success) {
      const field = String(parsed.error.issues[0].path[0])
      setError(
        (
          {
            host: 'Enter a valid hostname or IP address.',
            username:
              'Enter your SSH username using letters, numbers, dots, underscores, or hyphens.',
            port: 'Enter a port from 1 to 65535.',
            name: 'Enter a machine name of 100 characters or fewer.',
          } as Record<string, string>
        )[field] || parsed.error.issues[0].message,
      )
      return
    }
    if (input.auth === 'key' && !input.privateKeyPath && !input.sshConfig) {
      setError('Choose the private key on this computer.')
      return
    }
    if (connect && input.auth === 'password' && !input.password) {
      setError('Enter the SSH password to connect.')
      return
    }
    if (!api) {
      setError('Open Life on your computer to save connections and connect over SSH.')
      return
    }
    setSaving(true)
    try {
      await api.profiles.save(parsed.data)
      refreshProfiles()
      setSaved(true)
      if (connect) {
        await api.connection.connect({
          ...parsed.data,
          password: input.password,
          passphrase: input.passphrase,
        })
        setInput((p) => ({ ...p, password: '', passphrase: '' }))
        onOpenChange(false)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open && !suspended}
      onOpenChange={(v) => {
        if (!saving) onOpenChange(v)
      }}
      title="Connect a machine"
      description="Connect over SSH, then choose a project on your machine."
      className="connection-modal"
    >
      {!desktop ? (
        <div className="preview-notice">
          <Terminal size={16} />
          <span>Browser preview · SSH connections run in the desktop app.</span>
        </div>
      ) : null}
      {profiles.length ? (
        <div className="saved-profiles">
          <div className="eyebrow">Saved machines</div>
          <div className="profile-list">
            {profiles.map((p) => (
              <div className={`saved-profile ${input.id === p.id ? 'selected' : ''}`} key={p.id}>
                <button
                  disabled={saving}
                  onClick={() => {
                    setInput({ ...p, password: '', passphrase: '' })
                    setError('')
                    setSaved(false)
                  }}
                >
                  <Server size={17} />
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.username}@{p.host}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <button
                  className="icon-button"
                  disabled={saving}
                  aria-label={`Delete ${p.name}`}
                  onClick={async () => {
                    try {
                      await api?.profiles.remove(p.id)
                      refreshProfiles()
                      if (input.id === p.id) setInput(blank())
                    } catch (e) {
                      setError(errorText(e))
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              className="new-profile"
              disabled={saving}
              onClick={() => {
                setInput(blank())
                setConfigHost(null)
                setError('')
                setSaved(false)
              }}
            >
              <Plus size={16} /> New machine
            </button>
          </div>
        </div>
      ) : null}
      <section className="ssh-config-section" aria-label="SSH config hosts">
        <div className="eyebrow">
          <FileCog size={14} /> SSH config
        </div>
        <div className="input-with-button">
          <input
            aria-label="SSH config file path"
            placeholder="~/.ssh/config"
            value={configPath}
            disabled={saving || configLoading || !desktop}
            onChange={(event) => setConfigPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void loadConfig()
              }
            }}
          />
          <button
            type="button"
            aria-label="Reload SSH config"
            disabled={saving || configLoading || !desktop}
            onClick={() => void loadConfig()}
          >
            {configLoading ? (
              <LoaderCircle size={16} className="spinning" />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
        </div>
        <label className="ssh-config-host-label">
          Host alias
          <select
            aria-label="SSH config host alias"
            value={
              input.sshConfig && input.sshConfig.path === configList?.path
                ? input.sshConfig.alias
                : ''
            }
            disabled={saving || configLoading || !configList?.hosts.length}
            onChange={(event) => {
              const host = configList?.hosts.find((item) => item.alias === event.target.value)
              if (!host || !configList) return
              setInput({
                ...blank(),
                name: host.alias,
                host: host.host,
                port: host.port,
                username: host.username,
                auth: host.availableIdentityFiles.length ? 'key' : 'agent',
                privateKeyPath: host.availableIdentityFiles[0] || '',
                sshConfig: { alias: host.alias, path: configList.path },
              })
              setConfigHost(host)
              setError('')
              setSaved(false)
            }}
          >
            <option value="">
              {configLoading ? 'Reading SSH config…' : 'Choose a host from SSH config'}
            </option>
            {configList?.hosts.map((host) => (
              <option key={host.alias} value={host.alias}>
                {host.alias} · {host.username}@{host.host}:{host.port}
              </option>
            ))}
          </select>
        </label>
        {configList?.error ? (
          <p className="form-hint" role="status">
            {configList.error}
          </p>
        ) : null}
        {configList && !configLoading && !configList.error && !configList.hosts.length ? (
          <p className="form-hint">
            No concrete Host aliases found. Wildcard defaults still apply when resolving an alias.
          </p>
        ) : null}
        {input.sshConfig ? (
          <>
            <div className="ssh-config-source">
              <span>
                Linked to <strong>{input.sshConfig.alias}</strong>. Config is read again when
                connecting.
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={saving}
                onClick={() => {
                  setInput((previous) => ({ ...previous, sshConfig: undefined }))
                  setConfigHost(null)
                  setSaved(false)
                }}
              >
                Use manual settings
              </button>
            </div>
            {configHost ? (
              <details className="ssh-config-options">
                <summary>
                  Resolved config options ({Object.keys(configHost.options).length})
                </summary>
                <dl>
                  <dt>HostName</dt>
                  <dd>{configHost.host}</dd>
                  <dt>User / Port</dt>
                  <dd>
                    {configHost.username} / {configHost.port}
                  </dd>
                  <dt>IdentityFile</dt>
                  <dd>{configHost.identityFiles.join('\n') || 'None'}</dd>
                  <dt>IdentityAgent</dt>
                  <dd>{configHost.options.identityagent?.[0] || 'Default local SSH agent'}</dd>
                  <dt>ProxyJump</dt>
                  <dd>{configHost.proxyJump || 'None'}</dd>
                  <dt>IdentitiesOnly</dt>
                  <dd>{configHost.identitiesOnly ? 'Yes' : 'No'}</dd>
                </dl>
                <pre>
                  {Object.entries(configHost.options)
                    .map(([name, values]) => values.map((value) => `${name} ${value}`).join('\n'))
                    .join('\n')}
                </pre>
              </details>
            ) : null}
            {configHost?.unsupportedOptions.length ? (
              <div className="form-error" role="alert">
                This alias needs unsupported options: {configHost.unsupportedOptions.join(', ')}.
                Choose another alias or use manual settings.
              </div>
            ) : null}
            {configHost?.proxyJump ? (
              <p className="form-hint">
                Jump hosts use your local OpenSSH keys/agent and known_hosts. First connect to the
                jump host in OpenSSH to trust its key.
              </p>
            ) : null}
            <p className="form-hint">
              Life verifies the target host with its saved fingerprints. OpenSSH multiplexing,
              known_hosts policy, and automatic key loading into the agent are not applied to the
              target.
            </p>
          </>
        ) : null}
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(true)
        }}
      >
        <fieldset className="form-grid" disabled={saving}>
          <label className="full">
            Machine name <span>optional</span>
            <input
              placeholder="My development server"
              value={input.name}
              onChange={(e) => update('name', e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="host-field">
            Hostname or IP
            <input
              placeholder="dev.example.com"
              value={input.host}
              readOnly={Boolean(input.sshConfig)}
              onChange={(e) => update('host', e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label className="port-field">
            Port
            <input
              type="number"
              min="1"
              max="65535"
              value={input.port}
              readOnly={Boolean(input.sshConfig)}
              onChange={(e) => update('port', Number(e.target.value))}
              required
            />
          </label>
          <label className="full">
            Username
            <input
              placeholder="developer"
              value={input.username}
              readOnly={Boolean(input.sshConfig)}
              onChange={(e) => update('username', e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label className="full">
            Authentication
            <select
              value={input.auth}
              onChange={(e) => update('auth', e.target.value as ConnectInput['auth'])}
            >
              <option value="key">SSH private key</option>
              <option value="agent">SSH agent</option>
              <option value="password">Password</option>
            </select>
          </label>
          {input.auth === 'key' ? (
            <>
              <div className="form-field full">
                <label htmlFor="ssh-private-key">Private key on this computer</label>
                <div className="input-with-button">
                  <input
                    id="ssh-private-key"
                    placeholder="~/.ssh/id_ed25519"
                    value={input.privateKeyPath}
                    readOnly={Boolean(input.sshConfig)}
                    onChange={(e) => update('privateKeyPath', e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label="Choose SSH key file"
                    disabled={Boolean(input.sshConfig)}
                    onClick={async () => {
                      try {
                        const key = await api?.chooseKey()
                        if (key) update('privateKeyPath', key)
                        else if (!api) setError('File selection is available in the desktop app.')
                      } catch (e) {
                        setError(errorText(e))
                      }
                    }}
                  >
                    <FolderKey size={17} />
                  </button>
                </div>
                {input.sshConfig ? (
                  <small>
                    {configHost?.availableIdentityFiles.length || 0} existing configured keys will
                    be tried in order.
                  </small>
                ) : null}
              </div>
              <label className="full">
                Key passphrase <span>if required</span>
                <input
                  type="password"
                  placeholder="Passphrase for an encrypted key"
                  value={input.passphrase}
                  onChange={(e) => update('passphrase', e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          ) : input.auth === 'password' ? (
            <label className="full">
              SSH password
              <input
                type="password"
                placeholder="Your SSH password"
                value={input.password}
                onChange={(e) => update('password', e.target.value)}
                autoComplete="off"
              />
            </label>
          ) : (
            <div className="form-hint full">
              <KeyRound size={15} /> Uses keys loaded into your local SSH agent.
            </div>
          )}
        </fieldset>
        <div className="form-hint">
          <ShieldCheck size={15} /> Passwords and passphrases are never saved.
        </div>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {saved && !error ? (
          <div className="form-success" role="status">
            Connection profile saved.
          </div>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={() => void save(false)}
          >
            Save profile
          </button>
          <button type="submit" className="button primary" disabled={saving} aria-busy={saving}>
            {saving ? <LoaderCircle size={16} className="spinning" /> : <ArrowUpRight size={16} />}
            {connection.status === 'connecting' ? 'Connecting…' : 'Connect machine'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
