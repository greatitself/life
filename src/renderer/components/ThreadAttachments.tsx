import { useEffect, useRef, useState } from 'react'
import { Download, File, Image as ImageIcon, Paperclip, X } from 'lucide-react'
import {
  attachmentSize,
  getAttachmentFile,
  isPreviewImage,
  type DraftAttachment,
  type ThreadAttachment,
} from '../attachments'
import { errorText } from '../api'
import type { AttachmentUploadState } from '../draft-upload'
import { Modal } from './Modal'
import './thread-attachments.css'

export function AttachmentPicker({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className="icon-button attachment-picker"
        aria-label="Attach images or files"
        title="Attach images or files · up to 8 files, 10 MB each"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={17} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        disabled={disabled}
        aria-label="Choose images or files"
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files || []))
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}

function AttachmentCard({
  attachment,
  onRemove,
  disabled,
  uploadState,
  onRetry,
}: {
  attachment: ThreadAttachment | DraftAttachment
  uploadState?: AttachmentUploadState
  onRetry?: (id: string) => void
  onRemove?: (id: string) => void
  disabled?: boolean
}) {
  const file = 'file' in attachment ? attachment.file : undefined
  const image = isPreviewImage(attachment.mime)
  const [url, setUrl] = useState<string>()
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!image) return
    let disposed = false
    let objectUrl: string | undefined
    setUrl(undefined)
    setError('')
    void (async () => {
      const blob = file || (await getAttachmentFile(attachment.id))
      if (disposed) return
      if (!blob) throw new Error('This attachment is unavailable on this device.')
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    })().catch((reason) => {
      if (!disposed) setError(errorText(reason))
    })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.id, file, image])

  async function download() {
    setDownloading(true)
    setError('')
    try {
      const blob = file || (await getAttachmentFile(attachment.id))
      if (!blob) throw new Error('This attachment is unavailable on this device.')
      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = attachment.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setDownloading(false)
    }
  }

  const uploadPercent = Math.min(100, Math.max(0, Math.round(uploadState?.percent || 0)))
  const uploadStatusText = uploadState
    ? {
        waiting: 'Waiting for this thread’s connection and project',
        queued: 'Queued for upload',
        uploading: 'Uploading',
        ready: 'Uploaded · ready to send',
        error: uploadState.error ? 'Upload failed: ' + uploadState.error : 'Upload failed',
      }[uploadState.state]
    : ''

  return (
    <div
      className={`thread-attachment ${image ? 'thread-attachment-image life-square-image-attachment' : ''}`}
    >
      <div className={image ? 'life-image-attachment-frame' : 'life-file-attachment-row'}>
        <button
          type="button"
          className="thread-attachment-open"
          title={`${attachment.name} · ${attachmentSize(attachment.size)}${uploadState ? ` · ${uploadStatusText}` : ''}`}
          aria-label={`${image ? 'Preview' : 'Download'} ${attachment.name}`}
          disabled={downloading || (image && !url)}
          onClick={() => (image ? setOpen(true) : void download())}
        >
          {image && url ? (
            <img
              src={url}
              alt=""
              className="thread-attachment-thumbnail"
              onError={() =>
                setError('Image preview unavailable. You can still download this file.')
              }
            />
          ) : (
            <File size={23} aria-hidden="true" />
          )}
          <span className="thread-attachment-info">
            <strong>{attachment.name}</strong>
            <small>{attachmentSize(attachment.size)}</small>
          </span>
          {image ? (
            <ImageIcon size={14} aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}
        </button>
        {onRemove ? (
          <button
            type="button"
            className="icon-button thread-attachment-remove"
            aria-label={`Remove ${attachment.name}`}
            disabled={disabled}
            onClick={() => onRemove(attachment.id)}
          >
            <X size={14} />
          </button>
        ) : image ? (
          <button
            type="button"
            className="icon-button thread-attachment-remove"
            aria-label={`Download ${attachment.name}`}
            disabled={downloading}
            onClick={() => void download()}
          >
            <Download size={14} />
          </button>
        ) : null}
        {image && uploadState && uploadState.state !== 'ready' ? (
          <div className="life-image-upload-overlay">
            {uploadState.state === 'uploading' ? (
              <span
                className="life-image-upload-percent"
                role="progressbar"
                aria-label={`Uploading ${attachment.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadPercent}
                aria-valuetext={`${uploadPercent}% uploaded`}
              >
                {uploadPercent}%
              </span>
            ) : uploadState.state === 'error' ? (
              <div className="life-image-upload-failure">
                <span className="life-image-upload-label">Failed</span>
                {onRetry ? (
                  <button
                    type="button"
                    className="life-image-upload-retry"
                    aria-label={`Retry upload of ${attachment.name}`}
                    title={uploadStatusText}
                    disabled={disabled}
                    onClick={() => onRetry(attachment.id)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : (
              <span className="life-image-upload-label" title={uploadStatusText}>
                {uploadState.state === 'queued' ? 'Queued' : 'Waiting'}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {image && uploadState ? (
        <span
          className="life-attachment-status-only"
          role={uploadState.state === 'error' ? 'alert' : 'status'}
        >
          {attachment.name}: {uploadStatusText}
        </span>
      ) : null}
      {uploadState && !image ? (
        <div className="life-attachment-transfer" aria-live="polite">
          <span>
            {uploadState.state === 'ready'
              ? 'Uploaded · ready to send'
              : uploadState.state === 'uploading'
                ? `Uploading · ${uploadState.percent}%`
                : uploadState.state === 'queued'
                  ? 'Queued for upload'
                  : uploadState.state === 'error'
                    ? 'Upload failed'
                    : 'Waiting for this thread’s connection and project'}
          </span>
          {uploadState.state === 'uploading' ? (
            <progress
              value={uploadState.percent}
              max={100}
              aria-label={`Uploading ${attachment.name}`}
            />
          ) : null}
          {uploadState.state === 'error' ? (
            <>
              <small role="alert">{uploadState.error}</small>
              {onRetry ? (
                <button type="button" disabled={disabled} onClick={() => onRetry(attachment.id)}>
                  Retry upload
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <span className="thread-attachment-error" role="alert">
          {error}
        </span>
      ) : null}
      {image ? (
        <Modal
          open={open}
          onOpenChange={setOpen}
          title={attachment.name}
          description={attachmentSize(attachment.size)}
          className="attachment-preview-modal"
        >
          {url ? (
            <img className="attachment-preview-image" src={url} alt={attachment.name} />
          ) : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={downloading}
              onClick={() => void download()}
            >
              <Download size={15} /> Download
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </Modal>
      ) : null}
    </div>
  )
}

export function AttachmentList({
  attachments,
  onRemove,
  disabled,
  uploadStates,
  onRetry,
}: {
  attachments: Array<ThreadAttachment | DraftAttachment>
  uploadStates?: Record<string, AttachmentUploadState>
  onRetry?: (id: string) => void
  onRemove?: (id: string) => void
  disabled?: boolean
}) {
  if (!attachments.length) return null
  return (
    <div
      className={`thread-attachments ${onRemove ? 'draft-attachments' : 'message-attachments'}`}
      aria-label="Attachments"
    >
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          disabled={disabled}
          uploadState={uploadStates?.[attachment.id]}
          onRetry={onRetry}
        />
      ))}
    </div>
  )
}
