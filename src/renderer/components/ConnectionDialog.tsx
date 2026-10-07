import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import type { ConnectInput, ConnectionProfile, ConnectionState } from '../../shared/types'
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
  workspace: '~/projects',
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
}: {
  open: boolean
  suspended?: boolean
  onOpenChange: (v: boolean) => void
  profiles: ConnectionProfile[]
  refreshProfiles: () => void
  connection: ConnectionState
}) {
  const [input, setInput] = useState<ConnectInput>(blank)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (open) {
      setError('')
      setSaved(false)
    } else setInput((p) => ({ ...p, password: '', passphrase: '' }))
  }, [open])
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
            workspace: 'Enter the existing project directory on the remote machine.',
            name: 'Enter a machine name of 100 characters or fewer.',
          } as Record<string, string>
        )[field] || parsed.error.issues[0].message,
      )
      return
    }
    if (input.auth === 'key' && !input.privateKeyPath) {
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
      description="Your workspace and agents, one SSH connection away."
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
                setError('')
                setSaved(false)
              }}
            >
              <Plus size={16} /> New machine
            </button>
          </div>
        </div>
      ) : null}
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
              onChange={(e) => update('port', Number(e.target.value))}
              required
            />
          </label>
          <label className="full">
            Username
            <input
              placeholder="developer"
              value={input.username}
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
                    onChange={(e) => update('privateKeyPath', e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label="Choose SSH key file"
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
          <label className="full">
            Remote project directory
            <input
              aria-describedby="remote-project-hint"
              placeholder="~/projects/my-app"
              value={input.workspace}
              onChange={(e) => update('workspace', e.target.value)}
              required
            />
            <small id="remote-project-hint" aria-hidden="true">
              The existing project folder on the remote machine.
            </small>
          </label>
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
