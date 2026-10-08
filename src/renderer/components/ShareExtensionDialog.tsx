import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, FileCode2, Globe, LoaderCircle, Package } from 'lucide-react'
import type { LifePortableExtension, LifePublishedExtension } from '../../shared/extension-sharing'
import { serializePortableExtension } from '../../shared/extension-sharing'
import { api, errorText } from '../api'
import { Modal } from './Modal'

/** Show the exact payload that will leave this computer before sharing or installing it. */
export const ExtensionBundlePreview = memo(function ExtensionBundlePreview({
  bundle,
}: {
  bundle: LifePortableExtension
}) {
  const extension = bundle.extension
  let code = ''
  let previewError = ''
  try {
    code = serializePortableExtension(bundle)
  } catch (error) {
    previewError = errorText(error)
  }
  const files =
    bundle.kind === 'source'
      ? bundle.extension.files.map((file) => ({ path: file.path, operation: file.kind }))
      : [
          { path: 'renderer.html', operation: 'code' },
          { path: 'renderer.css', operation: 'code' },
          { path: 'renderer.js', operation: 'code' },
          ...(bundle.extension.hostCSS ? [{ path: 'host.css', operation: 'code' }] : []),
          ...(bundle.extension.main ? [{ path: 'main.js', operation: 'local code' }] : []),
        ]
  const dependencies = bundle.kind === 'source' ? Object.entries(bundle.extension.dependencies) : []
  return (
    <div className="extension-bundle-preview">
      <div className="extension-bundle-heading">
        <Package size={18} />
        <div>
          <strong>{extension.name}</strong>
          <span>
            {bundle.kind === 'source' ? 'Interface source' : 'Runtime extension'} · v
            {extension.version}
          </span>
        </div>
        <code>{extension.id}</code>
      </div>
      {extension.description ? <p>{extension.description}</p> : null}
      {bundle.kind === 'source' ? (
        <p>Includes before and after file contents used to merge this extension.</p>
      ) : null}
      <div className="extension-bundle-files" aria-label="Included files">
        {files.map((file) => (
          <div key={file.path}>
            <FileCode2 size={13} /> <code>{file.path}</code> <span>{file.operation}</span>
          </div>
        ))}
      </div>
      {dependencies.length ? (
        <div className="extension-bundle-dependencies" aria-label="Required dependencies">
          <span>Dependencies</span>
          {dependencies.map(([name, version]) => (
            <code key={name}>
              {name}@{version}
            </code>
          ))}
        </div>
      ) : null}
      {previewError ? (
        <div className="form-error" role="alert">
          {previewError}
        </div>
      ) : (
        <details className="extension-output">
          <summary>Review complete extension code</summary>
          <pre>{code}</pre>
        </details>
      )}
    </div>
  )
})

export function ShareExtensionDialog({
  bundle,
  onOpenChange,
}: {
  bundle: LifePortableExtension | undefined
  onOpenChange: (open: boolean) => void
}) {
  const [token, setToken] = useState('')
  const [description, setDescription] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<LifePublishedExtension | undefined>(undefined)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const request = useRef(0)
  const publication = useRef(false)
  const bundleError = useMemo(() => {
    if (!bundle) return ''
    try {
      serializePortableExtension(bundle)
      return ''
    } catch (failure) {
      return errorText(failure)
    }
  }, [bundle])

  useEffect(() => {
    request.current++
    publication.current = false
    setToken('')
    setDescription((bundle?.extension.description || '').slice(0, 1000))
    setPublished(undefined)
    setPublishing(false)
    setError('')
    setCopied(false)
    return () => {
      request.current++
    }
  }, [bundle])

  function close(open: boolean) {
    // A public POST may already be committed. Keep its result visible until it settles.
    if (!open && publication.current) return
    if (!open) {
      request.current++
      setToken('')
      setPublishing(false)
    }
    onOpenChange(open)
  }

  async function publish() {
    if (!api || !bundle || publication.current || !token.trim() || bundleError) return
    const generation = ++request.current
    publication.current = true
    setPublishing(true)
    setError('')
    try {
      const result = await api.extensionSharing.publish({
        bundle,
        token: token.trim(),
        description: description.trim(),
      })
      if (generation !== request.current) return
      setPublished(result)
      setToken('')
    } catch (failure) {
      if (generation === request.current) setError(errorText(failure))
    } finally {
      if (generation === request.current) {
        publication.current = false
        setPublishing(false)
      }
    }
  }

  return (
    <Modal
      open={Boolean(bundle)}
      onOpenChange={close}
      title="Share extension publicly"
      description="Publish a portable copy as a public GitHub Gist. Other Life users can preview and install it from its link."
      className="extension-share-modal"
    >
      {bundle ? <ExtensionBundlePreview bundle={bundle} /> : null}
      {published ? (
        <div className="extension-published" role="status">
          <div>
            <Check size={17} /> <strong>Your extension is public.</strong>
          </div>
          <code>{published.url}</code>
          <div className="extension-published-actions">
            <button
              className="button primary"
              onClick={() => {
                void navigator.clipboard.writeText(published.url).then(
                  () => setCopied(true),
                  (failure) => setError(errorText(failure)),
                )
              }}
            >
              <Copy size={13} /> {copied ? 'Link copied' : 'Copy link'}
            </button>
            <button
              className="button secondary"
              onClick={() => {
                void api?.extensionSharing
                  .openPublic(published.url)
                  .catch((failure) => setError(errorText(failure)))
              }}
            >
              <ExternalLink size={13} /> Open public page
            </button>
          </div>
        </div>
      ) : (
        <form
          className="extension-share-form"
          onSubmit={(event) => {
            event.preventDefault()
            void publish()
          }}
        >
          <p className="extension-public-notice">
            <Globe size={15} /> Anyone can view this code. Review the included files for private
            data before publishing.
          </p>
          <label htmlFor="extension-share-description">Description</label>
          <input
            id="extension-share-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={1000}
            disabled={publishing || Boolean(bundleError)}
          />
          <label htmlFor="extension-share-token">GitHub token</label>
          <input
            id="extension-share-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={publishing || Boolean(bundleError)}
            placeholder="Token with permission to create Gists"
          />
          <span className="extension-caption">
            Use a classic token with the gist scope or a fine-grained token with Gists write access.
            Life uses it for this publication and does not save or include it in the extension.
          </span>
          <div className="extension-share-footer">
            <button
              className="button secondary"
              type="button"
              disabled={publishing}
              onClick={() => close(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={!api || !token.trim() || publishing || Boolean(bundleError)}
            >
              {publishing ? <LoaderCircle size={14} className="spinning" /> : <Globe size={14} />}
              {publishing ? 'Publishing…' : 'Publish publicly'}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  )
}
