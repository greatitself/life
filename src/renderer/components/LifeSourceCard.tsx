import { useState } from 'react'
import { AlertCircle, Check, ChevronRight, FileCode2, LoaderCircle } from 'lucide-react'
import type { SourceChangeSummary } from '../source-presentation'
import { useBuiltinFeature } from '../builtin-extensions'
import './life-source-card.css'

export function LifeSourceCard({
  change,
  status,
  raw,
  malformed = false,
}: {
  change: SourceChangeSummary & { revision?: number }
  status: 'receiving' | 'proposed' | 'applied' | 'failed'
  raw?: string
  malformed?: boolean
}) {
  const [rawOpen, setRawOpen] = useState(false)
  const compact = useBuiltinFeature('compact-source-cards')
  const label = malformed
    ? 'Needs repair'
    : status === 'receiving'
      ? 'Receiving'
      : status === 'applied'
        ? 'Applied'
        : status === 'failed'
          ? 'Failed'
          : 'Proposed'
  const Icon =
    malformed || status === 'failed'
      ? AlertCircle
      : status === 'applied'
        ? Check
        : status === 'receiving'
          ? LoaderCircle
          : FileCode2
  const count = (value: number, noun: string) =>
    String(value) + ' ' + noun + (value === 1 ? '' : 's')
  return (
    <article className="life-source-card" aria-label="Life source change">
      <div className="life-source-card-heading">
        <FileCode2 size={16} aria-hidden="true" />
        <strong>Life change</strong>
        <span
          className="life-source-card-status"
          data-status={malformed ? 'failed' : status}
          role="status"
          aria-live="polite"
        >
          <Icon
            size={12}
            aria-hidden="true"
            className={status === 'receiving' && !malformed ? 'spinning' : undefined}
          />
          {label}
        </span>
      </div>
      <p className="life-source-card-description">{change.summary}</p>
      {change.files.length || change.dependencies.length ? (
        <details className="life-source-card-details" open>
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            <span>
              {[
                change.files.length ? count(change.files.length, 'file') : '',
                change.dependencies.length ? count(change.dependencies.length, 'package') : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <small>View changes</small>
          </summary>
          {change.files.length ? (
            <ul className="life-source-card-files" aria-label="Changed files">
              {change.files.map((file, index) => (
                <li key={file.path + ':' + index}>
                  <FileCode2 size={13} aria-hidden="true" />
                  <code title={file.path}>{file.path}</code>
                  <span>
                    {status === 'receiving'
                      ? 'Pending'
                      : file.kind === 'delete'
                        ? 'Delete'
                        : file.kind === 'edit'
                          ? 'Edit'
                          : 'Write'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {change.dependencies.length ? (
            <ul className="life-source-card-packages" aria-label="Required packages">
              {change.dependencies.map((dependency) => (
                <li key={dependency.name}>
                  <code>{dependency.name}</code>
                  <span>{dependency.version}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {change.baseRevision !== undefined || change.revision !== undefined ? (
            <p className="life-source-card-revision">
              {change.baseRevision !== undefined ? 'Based on revision ' + change.baseRevision : ''}
              {change.revision !== undefined
                ? (change.baseRevision !== undefined ? ' · ' : '') +
                  'Applied revision ' +
                  change.revision
                : ''}
            </p>
          ) : null}
        </details>
      ) : null}
      {raw !== undefined ? (
        <details
          className="life-source-card-raw"
          open={!compact || rawOpen}
          onToggle={(event) => setRawOpen(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={13} aria-hidden="true" />
            <span>View proposal JSON</span>
          </summary>
          {!compact || rawOpen ? (
            <pre>
              <code>{raw || 'Waiting for the proposal…'}</code>
            </pre>
          ) : null}
        </details>
      ) : null}
      <p className="life-source-card-note">
        {malformed
          ? 'The proposal needs repair. Its details remain available above.'
          : status === 'applied'
            ? 'Manage this change in Manage extensions.'
            : status === 'failed'
              ? 'This change could not be activated. See the error in this thread.'
              : status === 'receiving'
                ? 'Preparing the change…'
                : 'Life will validate this proposal before activating it.'}
      </p>
    </article>
  )
}
