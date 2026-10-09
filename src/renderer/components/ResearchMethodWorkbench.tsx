import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  FlaskConical,
  GitBranch,
  Layers3,
  Link2,
  ListTree,
  Map as MapIcon,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import type { ResearchMethod, ResearchMethodAction } from '../../shared/research-method'
import {
  createResearchMethod,
  normalizeResearchMethod,
  analyzeResearchMethod,
  researchOperationCatalog,
  researchSolutionBundles,
  buildResearchMethodGraph,
} from '../../shared/research-method'
import { GraphCanvas, type CanvasNode } from './GraphCanvas'
import type { ResearchProblem, ResearchWorkbenchState } from '../workbench'
import { Modal } from './Modal'
import './research-method-workbench.css'

type MethodTab =
  'overview' | 'requirements' | 'grounding' | 'solutions' | 'approaches' | 'verification' | 'map'
type Collection =
  | 'requirements'
  | 'assumptions'
  | 'evidence'
  | 'candidates'
  | 'interactions'
  | 'validations'
  | 'inquiries'
type MethodRow = ResearchMethod[Collection][number]
type EditorState = { collection: Collection; record?: MethodRow; preset?: Record<string, unknown> }
type FormValues = Record<string, string | string[] | boolean>
const tabs: { id: MethodTab; title: string; icon: typeof Target }[] = [
  { id: 'overview', title: 'Overview', icon: Target },
  { id: 'requirements', title: 'Requirements', icon: ListTree },
  { id: 'grounding', title: 'Grounding', icon: ShieldCheck },
  { id: 'solutions', title: 'Solutions', icon: GitBranch },
  { id: 'approaches', title: 'Approaches', icon: FlaskConical },
  { id: 'verification', title: 'Verification', icon: ClipboardCheck },
  { id: 'map', title: 'Map', icon: MapIcon },
]
const operations = researchOperationCatalog.map((row) => ({
  value: row.id,
  label: row.label,
  detail: row.description,
}))
const singular: Record<Collection, string> = {
  requirements: 'requirement',
  assumptions: 'assumption',
  evidence: 'evidence',
  candidates: 'candidate',
  interactions: 'interaction',
  validations: 'verification',
  inquiries: 'inquiry',
}
const emptyHints: Record<Collection, { title: string; detail: string }> = {
  requirements: {
    title: 'Start with the irreducible requirements',
    detail:
      'State what must be true for the goal to succeed. Decompose broad requirements into smaller leaves with observable acceptance criteria.',
  },
  assumptions: {
    title: 'Make the assumptions visible',
    detail:
      'Record what a requirement or candidate relies on. Link evidence and write the counterexample that would challenge the claim.',
  },
  evidence: {
    title: 'Ground the research in reality',
    detail:
      'Keep observations, sources, experiments, constraints, and counterexamples together. A source is evidence to examine; it is not automatically proof.',
  },
  candidates: {
    title: 'Find mechanisms that satisfy the requirements',
    detail:
      'Describe how each candidate works, what it covers, and which assumptions or risks remain. Combine candidates only when the mechanism is clear.',
  },
  interactions: {
    title: 'Test how the solutions interact',
    detail:
      'Record complementary mechanisms, conflicts, and overlap. Unknown interactions stay unknown until investigated.',
  },
  inquiries: {
    title: 'Explore a new research approach',
    detail:
      'Turn a counterfactual, analogy, inverted constraint, or causal intervention into a testable inquiry. Keep the prediction separate from the observed result.',
  },
  validations: {
    title: 'Decide what would count as success',
    detail:
      'Link each test to requirements and candidates, state the expected result, and record what actually happened.',
  },
}
function rowLabel(row: MethodRow): string {
  if ('statement' in row) return row.statement
  if ('claim' in row) return row.claim
  if ('content' in row) return row.content
  if ('title' in row) return row.title
  if ('question' in row) return row.question
  return row.mechanism || 'Solution interaction'
}
function Badge({ children, state }: { children: ReactNode; state?: string }) {
  return (
    <span className="research-method-badge" data-state={state}>
      {children}
    </span>
  )
}
function Empty({ collection, onAdd }: { collection: Collection; onAdd: () => void }) {
  const hint = emptyHints[collection]
  return (
    <div className="research-method-empty">
      <div className="research-method-empty-icon">
        <Plus size={20} />
      </div>
      <strong>{hint.title}</strong>
      <p>{hint.detail}</p>
      <button type="button" className="button secondary" onClick={onAdd}>
        <Plus size={14} />
        Add {singular[collection]}
      </button>
    </div>
  )
}
function Detail({ title, children }: { title: string; children?: ReactNode }) {
  return children ? (
    <div className="research-method-detail">
      <span>{title}</span>
      <p>{children}</p>
    </div>
  ) : null
}
function LinkedLabels({ ids, rows, label }: { ids: string[]; rows: MethodRow[]; label: string }) {
  if (!ids.length) return null
  return (
    <div className="research-method-links" aria-label={label}>
      <Link2 size={12} aria-hidden="true" />
      <span>{label}:</span>
      {ids.map((id) => (
        <span key={id} className="research-method-link">
          {rowLabel(
            rows.find((row) => row.id === id) ||
              ({ id, content: 'Missing reference: ' + id } as MethodRow),
          )}
        </span>
      ))}
    </div>
  )
}
function RelationField({
  label,
  field,
  rows,
  values,
  setValues,
  omittedId,
}: {
  label: string
  field: string
  rows: MethodRow[]
  values: FormValues
  setValues: (values: FormValues) => void
  omittedId?: string
}) {
  const choices = rows.filter((row) => row.id !== omittedId)
  const selected = Array.isArray(values[field]) ? (values[field] as string[]) : []
  if (!choices.length)
    return <div className="research-method-form-hint">{label}: no records available yet.</div>
  return (
    <fieldset className="research-method-relations">
      <legend>{label}</legend>
      <div>
        {choices.map((row) => (
          <label key={row.id}>
            <input
              type="checkbox"
              checked={selected.includes(row.id)}
              onChange={(event) =>
                setValues({
                  ...values,
                  [field]: event.target.checked
                    ? [...selected, row.id]
                    : selected.filter((id) => id !== row.id),
                })
              }
            />
            <span>{rowLabel(row)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
function MethodEditor({
  editor,
  method,
  problems,
  onSave,
  onClose,
}: {
  editor: EditorState
  method: ResearchMethod
  problems: ResearchProblem[]
  onSave: (record: MethodRow) => boolean
  onClose: () => void
}) {
  const original = editor.record
  const id = useId()
  const [values, setValues] = useState<FormValues>(
    () => ({ ...editor.preset, ...(original || {}) }) as FormValues,
  )
  const [error, setError] = useState('')
  const collection = editor.collection
  function field(
    name: string,
    label: string,
    placeholder = '',
    required = false,
    multiline = true,
  ) {
    return (
      <label className="research-method-field" key={name}>
        <span>
          {label}
          {required ? ' *' : ''}
        </span>
        {multiline ? (
          <textarea
            rows={name === 'statement' || name === 'claim' || name === 'title' ? 2 : 3}
            required={required}
            maxLength={name === 'title' ? 240 : 8000}
            value={typeof values[name] === 'string' ? (values[name] as string) : ''}
            placeholder={placeholder}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
          />
        ) : (
          <input
            required={required}
            maxLength={8000}
            value={typeof values[name] === 'string' ? (values[name] as string) : ''}
            placeholder={placeholder}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
          />
        )}
      </label>
    )
  }
  function select(name: string, label: string, choices: string[], fallback: string) {
    return (
      <label className="research-method-field" key={name}>
        <span>{label}</span>
        <select
          value={typeof values[name] === 'string' ? (values[name] as string) : fallback}
          onChange={(event) => setValues({ ...values, [name]: event.target.value })}
        >
          {choices.map((choice) => (
            <option value={choice} key={choice}>
              {choice.replaceAll('-', ' ')}
            </option>
          ))}
        </select>
      </label>
    )
  }
  function relations(name: string, label: string, rows: MethodRow[]) {
    return (
      <RelationField
        key={name}
        field={name}
        label={label}
        rows={rows}
        values={values}
        setValues={setValues}
      />
    )
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`${original ? 'Edit' : 'Add'} ${singular[collection]}`}
      description="Keep the mechanism, evidence, and acceptance criteria explicit. These records are saved with this research goal."
      className="research-method-editor"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setError('')
          const identifier = original?.id || 'method-' + crypto.randomUUID()
          const base = { ...values, id: identifier, updatedAt: Date.now() }
          let record: MethodRow
          if (collection === 'requirements')
            record = {
              parentId: undefined,
              statement: '',
              acceptance: '',
              rationale: '',
              kind: 'requirement',
              priority: 'essential',
              atomic: false,
              status: 'proposed',
              assumptionIds: [],
              evidenceIds: [],
              ...base,
            } as MethodRow
          else if (collection === 'assumptions')
            record = {
              claim: '',
              challenge: '',
              consequence: '',
              status: 'unverified',
              requirementIds: [],
              evidenceIds: [],
              ...base,
            } as MethodRow
          else if (collection === 'evidence')
            record = {
              kind: 'observation',
              content: '',
              source: '',
              reliability: 'unverified',
              ...base,
            } as MethodRow
          else if (collection === 'candidates')
            record = {
              title: '',
              mechanism: '',
              risks: '',
              componentCandidateIds: [],
              constituentIds: [],
              emergence: '',
              status: 'proposed',
              requirementIds: [],
              assumptionIds: [],
              evidenceIds: [],
              ...base,
            } as MethodRow
          else if (collection === 'interactions')
            record = {
              candidateIds: [],
              kind: 'unknown',
              mechanism: '',
              evidenceIds: [],
              ...base,
            } as MethodRow
          else if (collection === 'inquiries')
            record = {
              operation: method.activeOperation,
              question: '',
              premise: '',
              intervention: '',
              prediction: '',
              result: '',
              status: 'proposed',
              requirementIds: [],
              candidateIds: [],
              evidenceIds: [],
              ...base,
            } as MethodRow
          else
            record = {
              title: '',
              procedure: '',
              expected: '',
              actual: '',
              outcome: 'pending',
              requirementIds: [],
              candidateIds: [],
              evidenceIds: [],
              ...base,
            } as MethodRow
          if (
            collection === 'interactions' &&
            'candidateIds' in record &&
            record.candidateIds.length < 2
          ) {
            setError('Select at least two candidates to record an interaction.')
            return
          }
          if (collection === 'requirements' && 'parentId' in record && record.parentId === '')
            record.parentId = undefined
          if (!onSave(record))
            setError(
              'The research record could not be saved. Review the storage notice and try again.',
            )
        }}
      >
        {collection === 'requirements' ? (
          <>
            {field('statement', 'Statement', 'What must be true for this goal to succeed?', true)}
            {field(
              'acceptance',
              'Acceptance criterion',
              'What observation or test would prove this requirement was satisfied?',
            )}
            {field(
              'rationale',
              'Why this is necessary',
              'How does this requirement contribute to the goal?',
            )}
            <label className="research-method-field">
              <span>Parent requirement</span>
              <select
                value={typeof values.parentId === 'string' ? values.parentId : ''}
                onChange={(event) => setValues({ ...values, parentId: event.target.value })}
              >
                <option value="">Goal · top-level requirement</option>
                {method.requirements
                  .filter((row) => row.id !== original?.id)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.statement}
                    </option>
                  ))}
              </select>
            </label>
            <div className="research-method-form-columns">
              {select('kind', 'Type', ['requirement', 'constraint', 'component'], 'requirement')}
              {select('priority', 'Priority', ['essential', 'optional'], 'essential')}
              {select('status', 'Status', ['proposed', 'grounded', 'verified'], 'proposed')}
            </div>
            <label className="research-method-checkbox">
              <input
                type="checkbox"
                checked={values.atomic === true}
                onChange={(event) => setValues({ ...values, atomic: event.target.checked })}
              />
              <span>Atomic requirement — this is a basic, independently testable leaf</span>
            </label>
            {relations('assumptionIds', 'Depends on assumptions', method.assumptions)}
            {relations('evidenceIds', 'Grounding evidence', method.evidence)}
            {original ? (
              <section className="research-method-inspector-trace">
                <h3>Trace this requirement</h3>
                <p>
                  The same requirement connects its constituents, reality checks, blockers,
                  candidate mechanisms, and verification.
                </p>
                <LinkedLabels
                  ids={method.requirements
                    .filter((row) => row.parentId === original.id)
                    .map((row) => row.id)}
                  rows={method.requirements}
                  label="Constituents"
                />
                <LinkedLabels
                  ids={method.candidates
                    .filter((row) => row.requirementIds.includes(original.id))
                    .map((row) => row.id)}
                  rows={method.candidates}
                  label="Candidate contributions"
                />
                <LinkedLabels
                  ids={method.inquiries
                    .filter((row) => row.requirementIds.includes(original.id))
                    .map((row) => row.id)}
                  rows={method.inquiries}
                  label="Inquiries"
                />
                {problems
                  .filter((problem) => problem.requirementIds?.includes(original.id))
                  .map((problem) => (
                    <div key={problem.id}>
                      <strong>
                        Blocker · {problem.status}: {problem.title}
                      </strong>
                      <p>{problem.description}</p>
                      {problem.notes ? <p>{problem.notes}</p> : null}
                    </div>
                  ))}
                {method.validations
                  .filter((row) => row.requirementIds.includes(original.id))
                  .map((row) => (
                    <div key={row.id}>
                      <strong>
                        Verification · {row.outcome}: {row.title}
                      </strong>
                      <Detail title="Procedure">{row.procedure}</Detail>
                      <Detail title="Expected result">{row.expected}</Detail>
                      <Detail title="Actual result">{row.actual || 'Not performed yet'}</Detail>
                    </div>
                  ))}
              </section>
            ) : null}
          </>
        ) : null}
        {collection === 'assumptions' ? (
          <>
            {field('claim', 'Claim', 'What are you assuming to be true?', true)}
            {field('challenge', 'Challenge or counterexample', 'What could falsify this claim?')}
            {field(
              'consequence',
              'Consequence if false',
              'Which part of the goal or solution would fail?',
            )}
            {select('status', 'Status', ['unverified', 'supported', 'refuted'], 'unverified')}
            {relations('requirementIds', 'Affected requirements', method.requirements)}
            {relations('evidenceIds', 'Supporting or challenging evidence', method.evidence)}
          </>
        ) : null}
        {collection === 'evidence' ? (
          <>
            {field(
              'content',
              'Evidence or observation',
              'Record exactly what was observed, reported, or reproduced.',
              true,
            )}
            {field(
              'source',
              'Source or provenance',
              'URL, file path, experiment, or observation conditions',
              false,
              false,
            )}
            <div className="research-method-form-columns">
              {select(
                'kind',
                'Evidence type',
                ['observation', 'source', 'experiment', 'constraint', 'counterexample'],
                'observation',
              )}
              {select(
                'reliability',
                'Verification state',
                ['unverified', 'reported', 'reproduced'],
                'unverified',
              )}
            </div>
          </>
        ) : null}
        {collection === 'candidates' ? (
          <>
            {field('title', 'Candidate title', 'A concrete solution approach', true, false)}
            {field(
              'mechanism',
              'Mechanism',
              'How does this approach satisfy the requirements?',
              true,
            )}
            {field(
              'risks',
              'Risks and trade-offs',
              'What can fail, and what does this approach give up?',
            )}
            {select('status', 'Status', ['proposed', 'selected', 'rejected'], 'proposed')}
            {relations('requirementIds', 'Requirements covered', method.requirements)}
            <RelationField
              field="componentCandidateIds"
              label="Component candidates"
              rows={method.candidates}
              values={values}
              setValues={setValues}
              omittedId={original?.id}
            />
            {relations('constituentIds', 'Basic constituents', method.requirements)}
            {field(
              'emergence',
              'Proposed emergent behavior',
              'What behavior does the whole have that the separate parts do not? This remains a hypothesis until tested.',
            )}
            {relations('assumptionIds', 'Assumptions relied on', method.assumptions)}
            {relations('evidenceIds', 'Evidence', method.evidence)}
          </>
        ) : null}
        {collection === 'interactions' ? (
          <>
            {relations('candidateIds', 'Candidates in this interaction', method.candidates)}
            {select(
              'kind',
              'Relationship',
              ['unknown', 'constructive', 'compatible', 'conflicting', 'redundant'],
              'unknown',
            )}
            {field(
              'mechanism',
              'Interaction mechanism',
              'Why do these approaches reinforce, interfere with, or duplicate each other?',
              true,
            )}
            {relations('evidenceIds', 'Evidence for this relationship', method.evidence)}
          </>
        ) : null}
        {collection === 'validations' ? (
          <>
            {field('title', 'Verification title', 'A reproducible check', true, false)}
            {field('procedure', 'Procedure', 'How should the check be performed?', true)}
            {field('expected', 'Expected result', 'What would count as a pass?', true)}
            {field(
              'actual',
              'Actual result',
              'Record what happened, including failures and inconclusive results.',
            )}
            {select('outcome', 'Outcome', ['pending', 'pass', 'fail', 'inconclusive'], 'pending')}
            {relations('requirementIds', 'Requirements checked', method.requirements)}
            {relations('candidateIds', 'Candidates checked', method.candidates)}
            {relations('evidenceIds', 'Results and evidence', method.evidence)}
          </>
        ) : null}
        {collection === 'inquiries' ? (
          <>
            <label className="research-method-field">
              <span>Research approach</span>
              <select
                value={
                  typeof values.operation === 'string' ? values.operation : method.activeOperation
                }
                onChange={(event) => setValues({ ...values, operation: event.target.value })}
              >
                {operations.map((row) => (
                  <option value={row.value} key={row.value}>
                    {row.label}
                  </option>
                ))}
              </select>
            </label>
            {field(
              'question',
              'Research question',
              'Which possibility or causal relationship are you investigating?',
              true,
            )}
            {field(
              'premise',
              'Premise',
              'Which starting condition, source-domain mechanism, or constraint is being examined?',
            )}
            {field(
              'intervention',
              'Intervention or transformation',
              'What do you change, remove, transfer, invert, or compose?',
              true,
            )}
            {field(
              'prediction',
              'Predicted result',
              'What should happen if this idea is useful? State a falsifiable prediction.',
            )}
            {field(
              'result',
              'Observed result',
              'What actually happened? Keep predictions distinct from observations.',
            )}
            {select('status', 'Status', ['proposed', 'tested', 'rejected'], 'proposed')}
            {relations('requirementIds', 'Related requirements', method.requirements)}
            {relations('candidateIds', 'Related candidates', method.candidates)}
            {relations('evidenceIds', 'Supporting or refuting evidence', method.evidence)}
          </>
        ) : null}
        {error ? (
          <p className="research-method-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Save {singular[collection]}
          </button>
        </div>
        <span className="sr-only" id={id}>
          Records are saved to the current goal.
        </span>
      </form>
    </Modal>
  )
}
function RowActions({
  collection,
  record,
  onEdit,
  onDelete,
  onDecompose,
}: {
  collection: Collection
  record: MethodRow
  onEdit: (editor: EditorState) => void
  onDelete: (collection: Collection, record: MethodRow) => void
  onDecompose?: () => void
}) {
  return (
    <div className="research-method-row-actions">
      {onDecompose ? (
        <button
          type="button"
          className="icon-button"
          aria-label={`Decompose requirement: ${rowLabel(record)}`}
          title="Add a child requirement"
          onClick={onDecompose}
        >
          <GitBranch size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className="icon-button"
        aria-label={`Edit ${singular[collection]}: ${rowLabel(record)}`}
        title="Edit"
        onClick={() => onEdit({ collection, record })}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Delete ${singular[collection]}: ${rowLabel(record)}`}
        title="Delete"
        onClick={() => onDelete(collection, record)}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}
function SectionHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <div className="research-method-section-heading">
      <div>
        {eyebrow ? <span className="research-method-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {action}
    </div>
  )
}
function AddButton({
  collection,
  onEdit,
}: {
  collection: Collection
  onEdit: (editor: EditorState) => void
}) {
  return (
    <button type="button" className="button secondary" onClick={() => onEdit({ collection })}>
      <Plus size={14} />
      {collection === 'interactions' ? 'Record interaction' : `Add ${singular[collection]}`}
    </button>
  )
}
function MethodProjection({
  method,
  projection,
  onEdit,
}: {
  method: ResearchMethod
  projection: string
  onEdit: (editor: EditorState) => void
}) {
  const groups: Collection[] =
    projection === 'requirements'
      ? ['requirements']
      : projection === 'grounding'
        ? ['requirements', 'assumptions', 'evidence']
        : projection === 'construction'
          ? ['requirements', 'candidates', 'interactions']
          : projection === 'verification'
            ? ['requirements', 'candidates', 'validations', 'evidence']
            : [
                'requirements',
                'assumptions',
                'candidates',
                'interactions',
                'inquiries',
                'validations',
                'evidence',
              ]
  const eligible = groups.flatMap((kind) =>
    [...method[kind]]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => ({ id: kind + ':' + row.id, kind, label: rowLabel(row) })),
  )
  const selected = eligible.length <= 250 ? eligible : ([] as typeof eligible)
  if (eligible.length > 250) {
    const byGroup = groups.map((group) => eligible.filter((node) => node.kind === group))
    for (let row = 0; selected.length < 250; row++) {
      let added = false
      for (const group of byGroup) {
        if (group[row] && selected.length < 250) {
          selected.push(group[row])
          added = true
        }
      }
      if (!added) break
    }
  }
  const ids = new Set(selected.map((node) => node.id))
  const nodeKey = selected.map((node) => node.id).join('|')
  const graph = useMemo(
    () => buildResearchMethodGraph(method, { nodeIds: ids, maxEdges: 1500 }),
    [method, projection, nodeKey],
  )
  const matchingEdges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  const visibleEdges = matchingEdges.slice(0, 1500)
  const totalRelationships = graph.totalRelationshipCount ?? matchingEdges.length
  const indices = new Map<Collection, number>()
  const nodes: CanvasNode[] = selected.map((node) => {
    const index = indices.get(node.kind) || 0
    indices.set(node.kind, index + 1)
    const row = method[node.kind].find((row) => node.id === node.kind + ':' + row.id)
    return {
      id: node.id,
      x: groups.indexOf(node.kind) * 320,
      y: index * 126,
      width: 250,
      height: 100,
      content: (
        <button
          type="button"
          className="research-method-graph-node"
          aria-label={`Inspect ${singular[node.kind]}: ${node.label}`}
          onClick={() => {
            if (row) onEdit({ collection: node.kind, record: row })
          }}
        >
          <span>{singular[node.kind]}</span>
          <strong>{node.label}</strong>
          <small>Open complete record</small>
        </button>
      ),
    }
  })
  if (!nodes.length)
    return (
      <div className="research-method-empty">
        <ListTree size={22} />
        <strong>No records in this projection yet</strong>
        <p>
          Add research records in the corresponding tools. This graph uses the same IDs and
          relationships as the tables.
        </p>
      </div>
    )
  return (
    <GraphCanvas
      nodes={nodes}
      edges={visibleEdges.map((edge) => ({ ...edge, label: edge.kind, arrow: true }))}
      label="Research method relationships"
      fitKey={projection + ':' + nodes.map((node) => node.id).join('|')}
    >
      {eligible.length > selected.length || totalRelationships > visibleEdges.length ? (
        <div className="research-method-graph-limit">
          Showing {selected.length} of {eligible.length} records, balanced across record types, and{' '}
          {visibleEdges.length} of {totalRelationships} relationships between the displayed records.
          Choose a narrower projection to inspect more; all records remain available in the tools.
        </div>
      ) : null}
    </GraphCanvas>
  )
}
export function ResearchMethodWorkbench({
  workbench,
  map,
}: {
  workbench: ResearchWorkbenchState
  map: ReactNode
}) {
  const goal = workbench.goal
  const [tab, setTab] = useState<MethodTab>('overview')
  const [query, setQuery] = useState('')
  const [requirementFilter, setRequirementFilter] = useState('all')
  const [editor, setEditor] = useState<EditorState>()
  const [deleting, setDeleting] = useState<{ collection: Collection; record: MethodRow }>()
  const [selectedPair, setSelectedPair] = useState<[string, string]>()
  const [blockerLinksOpen, setBlockerLinksOpen] = useState<string>()
  const [projection, setProjection] = useState('custom')
  const method = useMemo(
    () => normalizeResearchMethod(goal?.method || createResearchMethod()),
    [goal?.method],
  )
  useEffect(() => {
    setEditor(undefined)
    setDeleting(undefined)
    setSelectedPair(undefined)
    setBlockerLinksOpen(undefined)
    setQuery('')
    setRequirementFilter('all')
  }, [goal?.id])
  const parents = new Set(method.requirements.map((row) => row.parentId).filter(Boolean))
  const analysis = useMemo(
    () => analyzeResearchMethod(method, goal?.problems),
    [method, goal?.problems],
  )
  const bundles = useMemo(
    () => (tab === 'solutions' ? researchSolutionBundles(method, 6) : []),
    [method, tab],
  )
  const leaves = method.requirements.filter((row) => !parents.has(row.id))
  const covered = new Set(
    method.candidates
      .filter((row) => row.status !== 'rejected')
      .flatMap((row) => row.requirementIds),
  )
  const checked = new Set(analysis.verifiedRequirementIds)
  const ungrounded = method.assumptions.filter((row) =>
    analysis.unsupportedAssumptionIds.includes(row.id),
  )
  const openProblems = goal?.problems.filter((row) => row.status !== 'solved') || []
  const matching = (row: MethodRow) =>
    !query.trim() ||
    JSON.stringify(row).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  function save(record: MethodRow) {
    if (!editor) return false
    const action = { type: 'upsert', collection: editor.collection, record } as ResearchMethodAction
    const result = workbench.methodAction(action)
    if (result) setEditor(undefined)
    return result
  }
  function showTab(next: MethodTab, filter = 'all') {
    setTab(next)
    setQuery('')
    setRequirementFilter(filter)
  }
  const edit = (value: EditorState) => setEditor(value)
  const remove = (collection: Collection, record: MethodRow) => setDeleting({ collection, record })
  const operation = operations.find((row) => row.value === method.activeOperation) || operations[0]
  function combine(candidateIds: string[]) {
    const components = method.candidates.filter((row) => candidateIds.includes(row.id))
    edit({
      collection: 'candidates',
      preset: {
        title: components.map((row) => row.title).join(' + '),
        componentCandidateIds: candidateIds,
        constituentIds: [...new Set(components.flatMap((row) => row.constituentIds))],
        requirementIds: [...new Set(components.flatMap((row) => row.requirementIds))],
        assumptionIds: [...new Set(components.flatMap((row) => row.assumptionIds))],
        evidenceIds: [...new Set(components.flatMap((row) => row.evidenceIds))],
        status: 'proposed',
      },
    })
  }
  if (!goal)
    return (
      <div className="research-method-workbench research-method-welcome">
        <div className="research-method-welcome-mark">
          <Layers3 size={32} strokeWidth={1.3} />
        </div>
        <span className="research-method-eyebrow">Life Research</span>
        <h1>From a goal to a grounded solution.</h1>
        <p>
          Break the goal into basic requirements. Challenge the abstractions against reality.
          Combine solutions whose mechanisms reinforce one another, then verify the result.
        </p>
        <button type="button" className="button primary" onClick={workbench.newGoal}>
          <Plus size={15} />
          Create research goal
        </button>
        <div className="research-method-principles">
          {[
            {
              icon: ListTree,
              title: 'Anti-abstraction',
              detail: 'Break a whole into basic constituents and requirements.',
            },
            {
              icon: ShieldCheck,
              title: 'Ground',
              detail: 'Expose assumptions and collect evidence.',
            },
            {
              icon: GitBranch,
              title: 'Abstraction',
              detail: 'Compose parts into wholes with proposed emergent behavior.',
            },
            {
              icon: ClipboardCheck,
              title: 'Verify',
              detail: 'Keep the procedure and actual result connected.',
            },
          ].map(({ icon: Icon, title, detail }) => (
            <div key={title}>
              <Icon size={18} />
              <strong>{title}</strong>
              <span>{detail}</span>
            </div>
          ))}
        </div>
      </div>
    )
  return (
    <div className="research-method-workbench">
      <header className="research-method-goal">
        <div className="research-method-goal-icon">
          <Target size={18} />
        </div>
        <div>
          <span className="research-method-eyebrow">Research goal</span>
          <h1>{goal.title}</h1>
          <p tabIndex={0} aria-label="Research goal brief">
            {goal.goal}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Edit research goal"
          onClick={workbench.editGoal}
        >
          <Pencil size={15} />
        </button>
      </header>
      <div className="research-method-operation">
        <label>
          <FlaskConical size={14} />
          <span>Research operation</span>
          <select
            aria-label="Research operation"
            value={method.activeOperation}
            onChange={(event) =>
              workbench.methodAction({
                type: 'operation',
                operation: event.target.value as ResearchMethod['activeOperation'],
              })
            }
          >
            {operations.map((row) => (
              <option value={row.value} key={row.value}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <span>{operation.detail}</span>
      </div>
      <nav className="research-method-tabs" aria-label="Research tools">
        {tabs.map(({ id, title, icon: Icon }) => (
          <button
            type="button"
            key={id}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => showTab(id)}
          >
            <Icon size={14} />
            <span>{title}</span>
            {id === 'requirements' && method.requirements.length ? (
              <small>{method.requirements.length}</small>
            ) : id === 'solutions' && method.candidates.length ? (
              <small>{method.candidates.length}</small>
            ) : null}
          </button>
        ))}
      </nav>
      <div className={'research-method-body' + (tab === 'map' ? ' research-method-map-body' : '')}>
        {method.normalizationIssues.length ? (
          <details className="research-method-notice">
            <summary>
              <CircleHelp size={14} />
              Some research records need review ({method.normalizationIssues.length})
            </summary>
            <ul>
              {method.normalizationIssues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {tab !== 'overview' && tab !== 'map' ? (
          <label className="research-method-search">
            <Search size={14} />
            <input
              aria-label="Search research records"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${tab === 'grounding' ? 'assumptions and evidence' : tab === 'solutions' ? 'candidates and interactions' : tab}…`}
            />
            {query ? (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear research search"
                onClick={() => setQuery('')}
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
        ) : null}
        {tab === 'overview' ? (
          <>
            <div className="research-method-metrics">
              {[
                {
                  count: leaves.length,
                  label: 'Basic requirements',
                  detail: `${leaves.filter((row) => row.atomic).length} marked atomic`,
                  target: 'requirements',
                },
                {
                  count: method.evidence.length,
                  label: 'Evidence records',
                  detail: `${ungrounded.length} assumptions need grounding`,
                  target: 'grounding',
                },
                {
                  count: method.candidates.length,
                  label: 'Candidate solutions',
                  detail: `${method.interactions.filter((row) => row.kind === 'constructive').length} recorded constructive relationships`,
                  target: 'solutions',
                },
                {
                  count: `${leaves.filter((row) => checked.has(row.id)).length}/${leaves.length}`,
                  label: 'Leaves verified',
                  detail: `${method.validations.filter((row) => row.outcome === 'pending').length} planned checks`,
                  target: 'verification',
                },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => showTab(item.target as MethodTab)}
                >
                  <strong>{item.count}</strong>
                  <span>{item.label}</span>
                  <small>{item.detail}</small>
                </button>
              ))}
            </div>
            {analysis.findings.length ? (
              <section className="research-method-findings" aria-label="Research record checks">
                <SectionHeader
                  title="Research record checks"
                  detail="Claims without the required evidence remain visible. Open a record to inspect or repair its trace."
                />
                <div>
                  {analysis.findings.map((finding, index) => (
                    <button
                      type="button"
                      key={`${finding.kind}:${finding.id}:${index}`}
                      onClick={() => {
                        const collection: Collection | undefined =
                          finding.kind === 'requirement'
                            ? 'requirements'
                            : finding.kind === 'assumption'
                              ? 'assumptions'
                              : finding.kind === 'candidate'
                                ? 'candidates'
                                : finding.kind === 'interaction'
                                  ? 'interactions'
                                  : finding.kind === 'validation'
                                    ? 'validations'
                                    : finding.kind === 'inquiry'
                                      ? 'inquiries'
                                      : undefined
                        const record = collection
                          ? method[collection].find((row) => row.id === finding.id)
                          : undefined
                        if (collection && record) edit({ collection, record })
                      }}
                    >
                      <CircleHelp size={13} />
                      <span>
                        {finding.message}
                        {finding.id ? (
                          <small>
                            {rowLabel(
                              (finding.kind === 'requirement'
                                ? method.requirements
                                : finding.kind === 'assumption'
                                  ? method.assumptions
                                  : finding.kind === 'candidate'
                                    ? method.candidates
                                    : finding.kind === 'interaction'
                                      ? method.interactions
                                      : finding.kind === 'validation'
                                        ? method.validations
                                        : method.inquiries
                              ).find((row) => row.id === finding.id) ||
                                ({ id: finding.id, content: finding.id } as MethodRow),
                            )}
                          </small>
                        ) : null}
                      </span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="research-method-overview-columns">
              <section className="research-method-next">
                <SectionHeader
                  eyebrow="Trace the gaps"
                  title="What needs attention"
                  detail="These are derived from the records, not estimated confidence scores."
                />
                {[
                  {
                    count: leaves.filter((row) => !analysis.readyRequirementIds.includes(row.id))
                      .length,
                    text: 'Make leaf requirements atomic and testable',
                    target: 'requirements',
                    filter: 'acceptance',
                  },
                  {
                    count: ungrounded.length,
                    text: 'Ground assumptions with evidence',
                    target: 'grounding',
                  },
                  {
                    count: leaves.filter((row) => !covered.has(row.id)).length,
                    text: 'Find candidates for uncovered requirements',
                    target: 'requirements',
                    filter: 'uncovered',
                  },
                  {
                    count: openProblems.length,
                    text: 'Investigate unresolved blockers',
                    target: 'requirements',
                    filter: 'blocked',
                  },
                  {
                    count: method.interactions.filter(
                      (row) => row.kind === 'unknown' || !row.evidenceIds.length,
                    ).length,
                    text: 'Test solution interactions',
                    target: 'solutions',
                  },
                  {
                    count: leaves.filter((row) => !checked.has(row.id)).length,
                    text: 'Verify the leaf requirements',
                    target: 'verification',
                  },
                ].map((item) => (
                  <button
                    key={item.text}
                    type="button"
                    onClick={() => showTab(item.target as MethodTab, item.filter)}
                  >
                    <span className="research-method-gap-count" data-clear={item.count === 0}>
                      {item.count === 0 ? <Check size={12} /> : item.count}
                    </span>
                    <span>{item.text}</span>
                    <ChevronRight size={13} />
                  </button>
                ))}
              </section>
              <section className="research-method-cycle">
                <SectionHeader
                  eyebrow="The research loop"
                  title="Abstraction ↔ reality"
                  detail="A solution is only as useful as the requirements and evidence behind it."
                />
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Anti-abstraction: whole → parts</strong>
                      <p>Trace requirements down to basic, independently testable leaves.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Ground the constituent model</strong>
                      <p>
                        Inspect assumptions, constraints, counterexamples, and failure consequences.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Abstraction: parts → whole</strong>
                      <p>
                        Construct assemblies and test reinforcing interactions; keep conflicts
                        explicit.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>04</span>
                    <div>
                      <strong>Close the loop with evidence</strong>
                      <p>Record the procedure, expected outcome, and actual outcome.</p>
                    </div>
                  </li>
                </ol>
                <p className="research-method-automation-hint">
                  Choose an operation above and give your instruction in the research conversation.
                  The operation is saved in research files; your message is sent exactly as written.
                </p>
              </section>
            </div>
            <section className="research-method-map-preview">
              <div>
                <span>
                  <MapIcon size={14} />
                  Your research map
                </span>
                <button type="button" onClick={() => showTab('map')}>
                  Expand map <ArrowRight size={12} />
                </button>
              </div>
              <div className="research-method-map-preview-content">{map}</div>
            </section>
          </>
        ) : null}
        {tab === 'requirements' ? (
          <>
            <SectionHeader
              eyebrow="Anti-abstraction · whole to constituents"
              title="Requirements & constraints"
              detail="Break broad requirements into smaller children. Each leaf needs a concrete acceptance criterion."
              action={<AddButton collection="requirements" onEdit={edit} />}
            />
            <div className="research-method-filters" aria-label="Requirement filters">
              {[
                ['all', 'All'],
                ['atomic', 'Atomic leaves'],
                ['acceptance', 'Needs acceptance'],
                ['uncovered', 'Uncovered'],
                ['blocked', 'Blockers'],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={requirementFilter === value}
                  onClick={() => setRequirementFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {!method.requirements.length && requirementFilter !== 'blocked' ? (
              <Empty collection="requirements" onAdd={() => edit({ collection: 'requirements' })} />
            ) : null}
            <div className="research-method-records">
              {method.requirements
                .filter(
                  (row) =>
                    matching(row) &&
                    (requirementFilter === 'all' ||
                      (requirementFilter === 'atomic' && row.atomic && !parents.has(row.id)) ||
                      (requirementFilter === 'acceptance' &&
                        !parents.has(row.id) &&
                        !analysis.readyRequirementIds.includes(row.id)) ||
                      (requirementFilter === 'uncovered' && !covered.has(row.id)) ||
                      (requirementFilter === 'blocked' &&
                        openProblems.some((problem) => problem.requirementIds?.includes(row.id)))),
                )
                .map((row) => {
                  let depth = 0
                  let parent = row.parentId
                  const visited = new Set([row.id])
                  while (parent && !visited.has(parent) && depth < 12) {
                    visited.add(parent)
                    depth++
                    parent = method.requirements.find((item) => item.id === parent)?.parentId
                  }
                  const parentRow = method.requirements.find((item) => item.id === row.parentId)
                  return (
                    <article
                      key={row.id}
                      className="research-method-record research-method-requirement"
                      data-record-id={row.id}
                      data-collection="requirements"
                      style={{ '--requirement-depth': Math.min(depth, 4) } as React.CSSProperties}
                    >
                      <div className="research-method-record-heading">
                        <div>
                          <div className="research-method-record-meta">
                            <Badge state={row.status}>{row.status}</Badge>
                            {row.status === 'verified' && !checked.has(row.id) ? (
                              <Badge>Verification incomplete</Badge>
                            ) : null}
                            <Badge>{row.kind}</Badge>
                            {row.atomic ? <Badge>atomic</Badge> : null}
                            {row.priority === 'optional' ? <Badge>optional</Badge> : null}
                            <span>
                              {checked.has(row.id)
                                ? 'Passing verification'
                                : covered.has(row.id)
                                  ? 'Candidate linked'
                                  : 'No candidate linked'}
                            </span>
                          </div>
                          <h3>
                            <button
                              type="button"
                              className="research-method-record-title"
                              aria-label={`Inspect requirement: ${row.statement}`}
                              onClick={() => edit({ collection: 'requirements', record: row })}
                            >
                              {row.statement}
                            </button>
                          </h3>
                        </div>
                        <RowActions
                          collection="requirements"
                          record={row}
                          onEdit={edit}
                          onDelete={remove}
                          onDecompose={() =>
                            edit({ collection: 'requirements', preset: { parentId: row.id } })
                          }
                        />
                      </div>
                      {parentRow ? (
                        <div className="research-method-parent">
                          <GitBranch size={12} />
                          <span>Part of: {parentRow.statement}</span>
                        </div>
                      ) : null}
                      <Detail title="Acceptance criterion">
                        {row.acceptance || (
                          <span className="research-method-missing">Not defined yet</span>
                        )}
                      </Detail>
                      <Detail title="Rationale">{row.rationale}</Detail>
                      <LinkedLabels
                        ids={row.assumptionIds}
                        rows={method.assumptions}
                        label="Assumptions"
                      />
                      <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                    </article>
                  )
                })}
            </div>
            <SectionHeader
              eyebrow="Obstacles to construction"
              title="Problems & blockers"
              detail="Keep obstacles connected to the requirements they prevent. Each problem has its own research conversation."
              action={
                <button type="button" className="button secondary" onClick={workbench.newProblem}>
                  <Plus size={14} />
                  Add problem
                </button>
              }
            />
            <div className="research-method-records">
              {goal.problems.map((problem) => (
                <article className="research-method-record" key={problem.id}>
                  <div className="research-method-record-heading">
                    <div>
                      <Badge state={problem.status}>{problem.status}</Badge>
                      <h3>{problem.title}</h3>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => workbench.selectProblem(problem.id)}
                    >
                      Investigate <ArrowRight size={12} />
                    </button>
                  </div>
                  <p>{problem.description}</p>
                  {problem.notes ? <Detail title="Findings">{problem.notes}</Detail> : null}
                  {goal.problems.length * method.requirements.length > 1000 ? (
                    <>
                      <LinkedLabels
                        ids={problem.requirementIds || []}
                        rows={method.requirements}
                        label="Affected requirements"
                      />
                      <button
                        type="button"
                        className="button secondary research-method-compose"
                        aria-expanded={blockerLinksOpen === problem.id}
                        onClick={() =>
                          setBlockerLinksOpen((previous) =>
                            previous === problem.id ? undefined : problem.id,
                          )
                        }
                      >
                        Link affected requirements <Link2 size={12} />
                      </button>
                    </>
                  ) : null}
                  {goal.problems.length * method.requirements.length <= 1000 ||
                  blockerLinksOpen === problem.id ? (
                    <fieldset className="research-method-blocker-links">
                      <legend>Affected requirements</legend>
                      {method.requirements.length ? (
                        method.requirements.map((row) => (
                          <label key={row.id}>
                            <input
                              type="checkbox"
                              checked={problem.requirementIds?.includes(row.id) || false}
                              onChange={(event) =>
                                workbench.patchProblem(goal.id, problem.id, {
                                  requirementIds: event.target.checked
                                    ? [...(problem.requirementIds || []), row.id]
                                    : (problem.requirementIds || []).filter((id) => id !== row.id),
                                })
                              }
                            />
                            <span>{row.statement}</span>
                          </label>
                        ))
                      ) : (
                        <span>Add requirements to link this blocker.</span>
                      )}
                    </fieldset>
                  ) : null}
                </article>
              ))}
            </div>
          </>
        ) : null}
        {tab === 'grounding' ? (
          <>
            <SectionHeader
              eyebrow="Grounding"
              title="Assumptions & reality checks"
              detail="Make hidden dependencies explicit. Record what would disprove each claim and what would fail if it were false."
              action={<AddButton collection="assumptions" onEdit={edit} />}
            />
            {!method.assumptions.length ? (
              <Empty collection="assumptions" onAdd={() => edit({ collection: 'assumptions' })} />
            ) : null}
            <div className="research-method-records">
              {method.assumptions.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="assumptions"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <Badge state={row.status}>{row.status}</Badge>
                      <h3>{row.claim}</h3>
                    </div>
                    <RowActions
                      collection="assumptions"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Challenge / counterexample">
                    {row.challenge || (
                      <span className="research-method-missing">No challenge recorded</span>
                    )}
                  </Detail>
                  <Detail title="Consequence if false">{row.consequence}</Detail>
                  <LinkedLabels
                    ids={row.requirementIds}
                    rows={method.requirements}
                    label="Requirements"
                  />
                  <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                </article>
              ))}
            </div>
            <SectionHeader
              title="Evidence ledger"
              detail="Separate observation from interpretation. Keep provenance and verification state with every record."
              action={<AddButton collection="evidence" onEdit={edit} />}
            />
            {!method.evidence.length ? (
              <Empty collection="evidence" onAdd={() => edit({ collection: 'evidence' })} />
            ) : null}
            <div className="research-method-records">
              {method.evidence.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="evidence"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <div className="research-method-record-meta">
                        <Badge>{row.kind}</Badge>
                        <Badge state={row.reliability}>{row.reliability}</Badge>
                      </div>
                      <p>{row.content}</p>
                    </div>
                    <RowActions
                      collection="evidence"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Source / provenance">
                    {row.source || (
                      <span className="research-method-missing">No provenance recorded</span>
                    )}
                  </Detail>
                </article>
              ))}
            </div>
          </>
        ) : null}
        {tab === 'solutions' ? (
          <>
            <SectionHeader
              eyebrow="Constructive interference"
              title="Candidate mechanisms"
              detail="Explain how each solution works. Requirements covered by a candidate are proposals until a linked verification passes."
              action={<AddButton collection="candidates" onEdit={edit} />}
            />
            {!method.candidates.length ? (
              <Empty collection="candidates" onAdd={() => edit({ collection: 'candidates' })} />
            ) : null}
            <div className="research-method-records">
              {method.candidates.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="candidates"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <Badge state={row.status}>{row.status}</Badge>
                      <h3>{row.title}</h3>
                    </div>
                    <RowActions
                      collection="candidates"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Mechanism">{row.mechanism}</Detail>
                  <Detail title="Risks & trade-offs">{row.risks}</Detail>
                  <Detail title="Proposed emergent behavior">{row.emergence}</Detail>
                  <LinkedLabels
                    ids={row.componentCandidateIds}
                    rows={method.candidates}
                    label="Component candidates"
                  />
                  <LinkedLabels
                    ids={row.constituentIds}
                    rows={method.requirements}
                    label="Basic constituents"
                  />
                  <LinkedLabels
                    ids={row.requirementIds}
                    rows={method.requirements}
                    label="Coverage"
                  />
                  <LinkedLabels
                    ids={row.assumptionIds}
                    rows={method.assumptions}
                    label="Assumptions"
                  />
                  <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                </article>
              ))}
            </div>
            <SectionHeader
              title="Solution interactions"
              detail="A constructive relationship needs a mechanism. Conflicts and unknowns stay visible; evidence is recorded separately."
              action={<AddButton collection="interactions" onEdit={edit} />}
            />
            {bundles.length ? (
              <section className="research-method-bundles">
                <SectionHeader
                  title="Candidate assemblies"
                  detail="Combinations of up to 12 non-rejected candidates are evaluated. Coverage is proposed; untested interactions and missing requirements remain visible."
                />
                {bundles.map((bundle) => (
                  <article key={bundle.candidateIds.join('|')} className="research-method-record">
                    <h3>
                      {bundle.candidateIds
                        .map((id) => method.candidates.find((row) => row.id === id)?.title)
                        .join(' + ')}
                    </h3>
                    <div className="research-method-record-meta">
                      <Badge>{bundle.coveredRequirementIds.length} leaf requirements covered</Badge>
                      <Badge>{bundle.uncoveredRequirementIds.length} uncovered</Badge>
                      <Badge>{bundle.untestedCandidatePairs.length} untested pairs</Badge>
                      <Badge>
                        {bundle.constructiveInteractionIds.length} evidenced constructive
                        interactions
                      </Badge>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => combine(bundle.candidateIds)}
                    >
                      Compose candidate <Plus size={13} />
                    </button>
                  </article>
                ))}
              </section>
            ) : null}
            {method.candidates.length >= 2 ? (
              <div className="research-method-matrix-scroll">
                <table
                  className="research-method-matrix"
                  aria-label="Constructive interference matrix"
                >
                  <thead>
                    <tr>
                      <th scope="col">Candidate</th>
                      {method.candidates.slice(0, 12).map((row) => (
                        <th scope="col" key={row.id}>
                          {row.title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {method.candidates.slice(0, 12).map((left) => (
                      <tr key={left.id}>
                        <th scope="row">{left.title}</th>
                        {method.candidates.slice(0, 12).map((right) => {
                          const relations = method.interactions.filter(
                            (row) =>
                              row.candidateIds.includes(left.id) &&
                              row.candidateIds.includes(right.id),
                          )
                          const relation =
                            relations.find((row) => row.kind === 'conflicting') || relations[0]
                          const kinds = new Set(relations.map((row) => row.kind))
                          const pairLabel =
                            relation?.kind === 'conflicting'
                              ? 'conflicting'
                              : kinds.size > 1
                                ? 'mixed'
                                : relation?.kind || 'unknown'
                          return (
                            <td key={right.id}>
                              {left.id === right.id ? (
                                <span aria-label="Same candidate">—</span>
                              ) : (
                                <button
                                  type="button"
                                  data-kind={pairLabel}
                                  aria-label={`Interaction: ${left.title} and ${right.title}`}
                                  onClick={() =>
                                    relations.length > 1
                                      ? setSelectedPair([left.id, right.id])
                                      : edit(
                                          relation
                                            ? { collection: 'interactions', record: relation }
                                            : {
                                                collection: 'interactions',
                                                preset: { candidateIds: [left.id, right.id] },
                                              },
                                        )
                                  }
                                >
                                  {pairLabel}
                                  {relations.length > 1 ? ` · ${relations.length}` : ''}
                                </button>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {method.candidates.length > 12 ? (
                  <p>
                    Showing the first 12 candidates in the matrix. All recorded interactions appear
                    below.
                  </p>
                ) : null}
              </div>
            ) : null}
            {!method.interactions.length ? (
              <Empty collection="interactions" onAdd={() => edit({ collection: 'interactions' })} />
            ) : null}
            <div className="research-method-records">
              {method.interactions.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="interactions"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <Badge state={row.kind}>{row.kind}</Badge>
                      <h3>
                        {row.candidateIds
                          .map(
                            (id) =>
                              method.candidates.find((candidate) => candidate.id === id)?.title ||
                              'Missing candidate',
                          )
                          .join(' + ')}
                      </h3>
                    </div>
                    <RowActions
                      collection="interactions"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Interaction mechanism">{row.mechanism}</Detail>
                  <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                  <button
                    type="button"
                    className="button secondary research-method-compose"
                    onClick={() => combine(row.candidateIds)}
                  >
                    Combine solutions <GitBranch size={13} />
                  </button>
                </article>
              ))}
            </div>
          </>
        ) : null}
        {tab === 'approaches' ? (
          <>
            <SectionHeader
              eyebrow="Expand the search"
              title="Research approaches"
              detail="Choose an operator, then make its premise, intervention, prediction, and outcome inspectable. Approaches are hypotheses until tested."
              action={<AddButton collection="inquiries" onEdit={edit} />}
            />
            <div className="research-method-operator-catalog">
              {researchOperationCatalog.map((operator) => (
                <article key={operator.id} data-selected={method.activeOperation === operator.id}>
                  <h3>{operator.label}</h3>
                  <p>{operator.description}</p>
                  <details>
                    <summary>Expected research artifacts</summary>
                    <p>{operator.artifactGuidance}</p>
                  </details>
                  <div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        workbench.methodAction({ type: 'operation', operation: operator.id })
                      }
                      aria-pressed={method.activeOperation === operator.id}
                    >
                      {method.activeOperation === operator.id ? (
                        <Check size={13} />
                      ) : (
                        <ArrowRight size={13} />
                      )}
                      Select operation
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Create ${operator.label} inquiry`}
                      onClick={() =>
                        edit({ collection: 'inquiries', preset: { operation: operator.id } })
                      }
                    >
                      <Plus size={13} />
                      Create inquiry
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <SectionHeader
              title="Inquiry notebook"
              detail="Predictions and observations stay separate. Link each inquiry to the requirements, candidates, and evidence it investigates."
            />
            {!method.inquiries.length ? (
              <Empty
                collection="inquiries"
                onAdd={() =>
                  edit({ collection: 'inquiries', preset: { operation: method.activeOperation } })
                }
              />
            ) : null}
            <div className="research-method-records">
              {method.inquiries.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="inquiries"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <Badge>
                        {researchOperationCatalog.find((operator) => operator.id === row.operation)
                          ?.label || row.operation}
                      </Badge>
                      <Badge state={row.status}>{row.status}</Badge>
                      <h3>{row.question}</h3>
                    </div>
                    <RowActions
                      collection="inquiries"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Premise">{row.premise}</Detail>
                  <Detail title="Intervention or transformation">{row.intervention}</Detail>
                  <div className="research-method-result-columns">
                    <Detail title="Predicted result">{row.prediction}</Detail>
                    <Detail title="Observed result">
                      {row.result || (
                        <span className="research-method-missing">Not tested yet</span>
                      )}
                    </Detail>
                  </div>
                  <LinkedLabels
                    ids={row.requirementIds}
                    rows={method.requirements}
                    label="Requirements"
                  />
                  <LinkedLabels
                    ids={row.candidateIds}
                    rows={method.candidates}
                    label="Candidates"
                  />
                  <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                </article>
              ))}
            </div>
          </>
        ) : null}
        {tab === 'verification' ? (
          <>
            <SectionHeader
              eyebrow="Close the loop"
              title="Verification & falsification"
              detail="A check is meaningful when its procedure, expected result, and actual result are explicit. Failed and inconclusive checks remain part of the research."
              action={<AddButton collection="validations" onEdit={edit} />}
            />
            {!method.validations.length ? (
              <Empty collection="validations" onAdd={() => edit({ collection: 'validations' })} />
            ) : null}
            <div className="research-method-records">
              {method.validations.filter(matching).map((row) => (
                <article
                  className="research-method-record"
                  key={row.id}
                  data-record-id={row.id}
                  data-collection="validations"
                >
                  <div className="research-method-record-heading">
                    <div>
                      <Badge state={row.outcome}>{row.outcome}</Badge>
                      {row.outcome === 'pass' &&
                      analysis.findings.some(
                        (finding) => finding.kind === 'validation' && finding.id === row.id,
                      ) ? (
                        <Badge>Verification evidence incomplete</Badge>
                      ) : null}
                      <h3>{row.title}</h3>
                    </div>
                    <RowActions
                      collection="validations"
                      record={row}
                      onEdit={edit}
                      onDelete={remove}
                    />
                  </div>
                  <Detail title="Procedure">{row.procedure}</Detail>
                  <div className="research-method-result-columns">
                    <Detail title="Expected result">{row.expected}</Detail>
                    <Detail title="Actual result">
                      {row.actual || (
                        <span className="research-method-missing">Not performed yet</span>
                      )}
                    </Detail>
                  </div>
                  <LinkedLabels
                    ids={row.requirementIds}
                    rows={method.requirements}
                    label="Requirements"
                  />
                  <LinkedLabels
                    ids={row.candidateIds}
                    rows={method.candidates}
                    label="Candidates"
                  />
                  <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                </article>
              ))}
            </div>
          </>
        ) : null}
        {tab === 'map' ? (
          <>
            <div className="research-method-projection">
              <label>
                Graph projection
                <select
                  aria-label="Graph projection"
                  value={projection}
                  onChange={(event) => setProjection(event.target.value)}
                >
                  <option value="custom">Custom research map</option>
                  <option value="requirements">Anti-abstraction · constituents</option>
                  <option value="grounding">Grounding relationships</option>
                  <option value="construction">Abstraction · solution assemblies</option>
                  <option value="verification">Verification trace</option>
                  <option value="all">All method relationships</option>
                </select>
              </label>
              <span>Method projections open the same records; your custom map is kept.</span>
            </div>
            {projection === 'custom' ? (
              map
            ) : (
              <MethodProjection method={method} projection={projection} onEdit={edit} />
            )}
          </>
        ) : null}
      </div>
      {selectedPair ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setSelectedPair(undefined)
          }}
          title="Interaction observations"
          description="Every recorded observation for this pair is shown. A conflicting observation stays visible even when another observation is constructive."
        >
          {method.interactions
            .filter((row) => selectedPair.every((id) => row.candidateIds.includes(id)))
            .map((row) => (
              <article className="research-method-record research-method-pair-record" key={row.id}>
                <Badge state={row.kind}>{row.kind}</Badge>
                <Detail title="Interaction mechanism">{row.mechanism}</Detail>
                <LinkedLabels ids={row.evidenceIds} rows={method.evidence} label="Evidence" />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setSelectedPair(undefined)
                    edit({ collection: 'interactions', record: row })
                  }}
                >
                  Edit observation <Pencil size={12} />
                </button>
              </article>
            ))}
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              const pair = selectedPair
              setSelectedPair(undefined)
              edit({ collection: 'interactions', preset: { candidateIds: pair } })
            }}
          >
            <Plus size={13} />
            Add observation for this pair
          </button>
        </Modal>
      ) : null}
      {editor ? (
        <MethodEditor
          key={`${goal.id}:${editor.collection}:${editor.record?.id || 'new'}:${JSON.stringify(editor.preset)}`}
          editor={editor}
          method={method}
          problems={goal.problems}
          onSave={save}
          onClose={() => setEditor(undefined)}
        />
      ) : null}
      {deleting ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined)
          }}
          title={`Delete ${singular[deleting.collection]}?`}
          description="This record will be removed from this goal. Linked references will be cleaned up; other research records and conversations are kept."
        >
          <p className="research-method-delete-preview">{rowLabel(deleting.record)}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                if (
                  workbench.methodAction({
                    type: 'delete',
                    collection: deleting.collection,
                    id: deleting.record.id,
                  })
                )
                  setDeleting(undefined)
              }}
            >
              Delete {singular[deleting.collection]}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
