/** File-backed, provider-neutral research records. Conclusions are recorded, never invented. */
export type ResearchOperation =
  | 'explore'
  | 'anti-abstraction'
  | 'abstraction'
  | 'ground'
  | 'constructive-interference'
  | 'counterfactual'
  | 'analogy'
  | 'constraint-inversion'
  | 'reverse-design'
  | 'morphological-search'
  | 'causal-intervention'
  | 'verify'
export interface ResearchRequirement {
  id: string
  parentId?: string
  statement: string
  acceptance: string
  rationale: string
  kind: 'requirement' | 'constraint' | 'component'
  priority: 'essential' | 'optional'
  atomic: boolean
  status: 'proposed' | 'grounded' | 'verified'
  assumptionIds: string[]
  evidenceIds: string[]
  updatedAt: number
}
export interface ResearchAssumption {
  id: string
  claim: string
  challenge: string
  consequence: string
  status: 'unverified' | 'supported' | 'refuted'
  requirementIds: string[]
  evidenceIds: string[]
  updatedAt: number
}
export interface ResearchEvidence {
  id: string
  kind: 'observation' | 'source' | 'experiment' | 'constraint' | 'counterexample'
  content: string
  source: string
  reliability: 'unverified' | 'reported' | 'reproduced'
  updatedAt: number
}
export interface ResearchCandidate {
  id: string
  title: string
  mechanism: string
  risks: string
  /** Other candidate mechanisms assembled into this composite. */
  componentCandidateIds: string[]
  /** Basic constituents, represented by requirement/component records. */
  constituentIds: string[]
  /** A proposed whole-level effect; this field never implies proof. */
  emergence: string
  status: 'proposed' | 'selected' | 'rejected'
  requirementIds: string[]
  assumptionIds: string[]
  evidenceIds: string[]
  updatedAt: number
}
export interface ResearchInteraction {
  id: string
  candidateIds: string[]
  kind: 'constructive' | 'compatible' | 'conflicting' | 'redundant' | 'unknown'
  mechanism: string
  evidenceIds: string[]
  updatedAt: number
}
export interface ResearchValidation {
  id: string
  title: string
  procedure: string
  expected: string
  actual: string
  outcome: 'pending' | 'pass' | 'fail' | 'inconclusive'
  requirementIds: string[]
  candidateIds: string[]
  evidenceIds: string[]
  /** Signature of the linked records at the time this result was recorded. */
  testedFingerprint?: string
  /** Preserve the original test time when its title or presentation is edited. */
  testedAt?: number
  updatedAt: number
}
export interface ResearchInquiry {
  id: string
  operation: ResearchOperation
  question: string
  premise: string
  intervention: string
  prediction: string
  result: string
  status: 'proposed' | 'tested' | 'rejected'
  requirementIds: string[]
  candidateIds: string[]
  evidenceIds: string[]
  updatedAt: number
}
export interface ResearchMethod {
  version: 1
  activeOperation: ResearchOperation
  requirements: ResearchRequirement[]
  assumptions: ResearchAssumption[]
  evidence: ResearchEvidence[]
  candidates: ResearchCandidate[]
  interactions: ResearchInteraction[]
  validations: ResearchValidation[]
  inquiries: ResearchInquiry[]
  /** Visible repair notices from malformed or legacy provider-authored files. */
  normalizationIssues: string[]
}
export interface ResearchMethodRows {
  requirements: ResearchRequirement
  assumptions: ResearchAssumption
  evidence: ResearchEvidence
  candidates: ResearchCandidate
  interactions: ResearchInteraction
  validations: ResearchValidation
  inquiries: ResearchInquiry
}
export type ResearchMethodCollection = keyof ResearchMethodRows
export type ResearchMethodAction =
  | {
      [K in ResearchMethodCollection]: {
        type: 'upsert'
        collection: K
        record: ResearchMethodRows[K]
      }
    }[ResearchMethodCollection]
  | { type: 'delete'; collection: ResearchMethodCollection; id: string }
  | { type: 'operation'; operation: ResearchOperation }
export const researchOperationCatalog: {
  id: ResearchOperation
  label: string
  description: string
  artifactGuidance: string
}[] = [
  {
    id: 'explore',
    label: 'Explore',
    description: 'Frame the goal and select a productive research direction.',
    artifactGuidance:
      'Record the goal, measurable acceptance, uncertainties and blockers. Do not manufacture evidence.',
  },
  {
    id: 'anti-abstraction',
    label: 'Anti-abstraction',
    description: 'Break a whole into its basic constituents and requirements.',
    artifactGuidance:
      'Create a parent-linked requirement/component tree. For each terminal constituent state its observable acceptance and why further decomposition is unnecessary at the chosen research granularity.',
  },
  {
    id: 'abstraction',
    label: 'Abstraction',
    description: 'Compose basic parts into higher-level assemblies and a proposed whole.',
    artifactGuidance:
      'Create composite candidates with constituentIds and componentCandidateIds. Explain the assembled mechanism and label emergence as a hypothesis until verified.',
  },
  {
    id: 'ground',
    label: 'Grounding',
    description: 'Separate facts, constraints and assumptions; inspect their support.',
    artifactGuidance:
      'Record sourced evidence and falsifiable assumptions, with challenges and consequences. A citation alone is not an observed or reproduced result.',
  },
  {
    id: 'constructive-interference',
    label: 'Constructive interference',
    description: 'Find contributions that strengthen each other when combined.',
    artifactGuidance:
      'Record pair or group interactions and their mechanism, then save a composite candidate. Contrast its measured or predicted performance with individual contributions; distinguish prediction from evidence.',
  },
  {
    id: 'counterfactual',
    label: 'Counterfactual',
    description: 'Ask what changes if a premise or constituent is absent or different.',
    artifactGuidance:
      'Create an inquiry with premise, intervention, predicted result and observed outcome, linking the assumptions and evidence being challenged.',
  },
  {
    id: 'analogy',
    label: 'Analogy transfer',
    description: 'Transfer a mechanism from another domain and test the mapping.',
    artifactGuidance:
      'Record the source-domain premise, target mapping as the intervention, predicted transfer and mismatch conditions. Create a candidate and an inquiry, never treat resemblance as proof.',
  },
  {
    id: 'constraint-inversion',
    label: 'Constraint inversion',
    description: 'Turn a limiting condition into a proposed resource or mechanism.',
    artifactGuidance:
      'Link the constraint requirement, state how the candidate uses it, and create an inquiry with the prediction and failure conditions.',
  },
  {
    id: 'reverse-design',
    label: 'Reverse design',
    description: 'Work backward from acceptance to the necessary mechanisms and prerequisites.',
    artifactGuidance:
      'Create prerequisite requirements and candidates traced to observable acceptance. Record uncertain backward links as inquiry premises.',
  },
  {
    id: 'morphological-search',
    label: 'Morphological search',
    description: 'Compare combinations of alternatives across independent design dimensions.',
    artifactGuidance:
      'Record dimensions and alternatives in inquiry premise/intervention fields, save promising composite candidates, and reject combinations with recorded conflicts. Report the explored scope.',
  },
  {
    id: 'causal-intervention',
    label: 'Causal intervention',
    description: 'Change one factor and measure which outcome actually changes.',
    artifactGuidance:
      'Create an inquiry with control, intervention, prediction and observed result; capture the procedure and sourced experimental evidence in a validation record.',
  },
  {
    id: 'verify',
    label: 'Verification',
    description: 'Test acceptance and interaction hypotheses with explicit procedures.',
    artifactGuidance:
      'Record expected and actual results, procedure, evidence and outcome. A claimed pass without observed/reproduced evidence is not verified.',
  },
]
export const researchOperations = researchOperationCatalog.map((row) => row.id)

const collections: ResearchMethodCollection[] = [
  'requirements',
  'assumptions',
  'evidence',
  'candidates',
  'interactions',
  'validations',
  'inquiries',
]
export const RESEARCH_METHOD_LIMIT = 300
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown, limit = 8000) =>
  typeof value === 'string' ? value.slice(0, limit) : ''
const identifier = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 240 &&
  value.trim() &&
  !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
const strings = (value: unknown) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .slice(0, RESEARCH_METHOD_LIMIT)
            .map(identifier)
            .filter((id): id is string => Boolean(id)),
        ),
      ]
    : []
const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback
const time = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
export function createResearchMethod(): ResearchMethod {
  return {
    version: 1,
    activeOperation: 'explore',
    requirements: [],
    assumptions: [],
    evidence: [],
    candidates: [],
    interactions: [],
    validations: [],
    inquiries: [],
    normalizationIssues: [],
  }
}

/** Repair malformed foreign files deterministically and expose every removed relationship. */
export function normalizeResearchMethod(value: unknown): ResearchMethod {
  const input = object(value)
  const method = {
    ...input,
    ...createResearchMethod(),
    activeOperation: choice(
      input.activeOperation === 'decompose'
        ? 'anti-abstraction'
        : input.activeOperation === 'synthesize'
          ? 'abstraction'
          : input.activeOperation === 'challenge'
            ? 'counterfactual'
            : input.activeOperation,
      researchOperations,
      'explore',
    ),
  } as ResearchMethod
  const notices = Array.isArray(input.normalizationIssues)
    ? [
        ...new Set(
          input.normalizationIssues
            .slice(0, 80)
            .map((row) => text(row, 1000))
            .filter(Boolean),
        ),
      ]
    : []
  const notice = (message: string) => {
    if (notices.length < 80 && !notices.includes(message)) notices.push(message)
  }
  if (input.version !== undefined && input.version !== 1)
    notice('Unsupported research method version; known records were recovered for review.')
  for (const collection of collections) {
    const ids = new Set<string>()
    const rows = Array.isArray(input[collection]) ? (input[collection] as unknown[]) : []
    if (rows.length > RESEARCH_METHOD_LIMIT)
      notice(
        `${collection}: records after ${RESEARCH_METHOD_LIMIT} were omitted from the editable view.`,
      )
    const normalized: unknown[] = []
    for (const item of rows.slice(0, RESEARCH_METHOD_LIMIT)) {
      const row = object(item)
      const id = identifier(row.id)
      if (!id || ids.has(id)) {
        notice(`${collection}: a missing or duplicate record ID was omitted.`)
        continue
      }
      ids.add(id)
      const base = { ...row, id, updatedAt: time(row.updatedAt) }
      if (collection === 'requirements')
        normalized.push({
          ...base,
          parentId: identifier(row.parentId),
          statement: text(row.statement),
          acceptance: text(row.acceptance),
          rationale: text(row.rationale),
          kind: choice(row.kind, ['requirement', 'constraint', 'component'], 'requirement'),
          priority: choice(row.priority, ['essential', 'optional'], 'essential'),
          atomic: row.atomic === true,
          status: choice(row.status, ['proposed', 'grounded', 'verified'], 'proposed'),
          assumptionIds: strings(row.assumptionIds),
          evidenceIds: strings(row.evidenceIds),
        })
      else if (collection === 'assumptions')
        normalized.push({
          ...base,
          claim: text(row.claim),
          challenge: text(row.challenge),
          consequence: text(row.consequence),
          status: choice(row.status, ['unverified', 'supported', 'refuted'], 'unverified'),
          requirementIds: strings(row.requirementIds),
          evidenceIds: strings(row.evidenceIds),
        })
      else if (collection === 'evidence')
        normalized.push({
          ...base,
          kind: choice(
            row.kind,
            ['observation', 'source', 'experiment', 'constraint', 'counterexample'],
            'observation',
          ),
          content: text(row.content, 16000),
          source: text(row.source, 4000),
          reliability: choice(
            row.reliability,
            ['unverified', 'reported', 'reproduced'],
            'unverified',
          ),
        })
      else if (collection === 'candidates')
        normalized.push({
          ...base,
          title: text(row.title, 240),
          mechanism: text(row.mechanism),
          risks: text(row.risks),
          componentCandidateIds: strings(row.componentCandidateIds),
          constituentIds: strings(row.constituentIds),
          emergence: text(row.emergence),
          status: choice(row.status, ['proposed', 'selected', 'rejected'], 'proposed'),
          requirementIds: strings(row.requirementIds),
          assumptionIds: strings(row.assumptionIds),
          evidenceIds: strings(row.evidenceIds),
        })
      else if (collection === 'interactions')
        normalized.push({
          ...base,
          candidateIds: strings(row.candidateIds),
          kind: choice(
            row.kind,
            ['constructive', 'compatible', 'conflicting', 'redundant', 'unknown'],
            'unknown',
          ),
          mechanism: text(row.mechanism),
          evidenceIds: strings(row.evidenceIds),
        })
      else if (collection === 'validations')
        normalized.push({
          ...base,
          title: text(row.title, 240),
          procedure: text(row.procedure),
          expected: text(row.expected),
          actual: text(row.actual, 16000),
          outcome: choice(row.outcome, ['pending', 'pass', 'fail', 'inconclusive'], 'pending'),
          testedFingerprint: text(row.testedFingerprint, 240) || undefined,
          testedAt: typeof row.testedAt === 'number' ? time(row.testedAt) : undefined,
          requirementIds: strings(row.requirementIds),
          candidateIds: strings(row.candidateIds),
          evidenceIds: strings(row.evidenceIds),
        })
      else
        normalized.push({
          ...base,
          operation: choice(row.operation, researchOperations, 'explore'),
          question: text(row.question),
          premise: text(row.premise),
          intervention: text(row.intervention),
          prediction: text(row.prediction),
          result: text(row.result, 16000),
          status: choice(row.status, ['proposed', 'tested', 'rejected'], 'proposed'),
          requirementIds: strings(row.requirementIds),
          candidateIds: strings(row.candidateIds),
          evidenceIds: strings(row.evidenceIds),
        })
    }
    ;(method[collection] as unknown[]) = normalized
  }
  const ids = Object.fromEntries(
    collections.map((collection) => [collection, new Set(method[collection].map((row) => row.id))]),
  ) as Record<ResearchMethodCollection, Set<string>>
  const prune = (
    row: { id: string } & Record<string, unknown>,
    field: string,
    collection: ResearchMethodCollection,
  ) => {
    const original = row[field] as string[]
    row[field] = original.filter((id) => {
      if (ids[collection].has(id)) return true
      notice(`${row.id}: removed missing ${collection} link ${id}.`)
      return false
    })
  }
  for (const row of method.requirements) {
    if (row.parentId && !ids.requirements.has(row.parentId)) {
      notice(`${row.id}: removed missing parent ${row.parentId}.`)
      row.parentId = undefined
    }
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'assumptionIds',
      'assumptions',
    )
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
  }
  const parents = new Map(method.requirements.map((row) => [row.id, row]))
  for (const row of [...method.requirements].sort((a, b) => a.id.localeCompare(b.id))) {
    const visited = new Set([row.id])
    let parent = row.parentId
    while (parent) {
      if (visited.has(parent)) {
        notice(`${row.id}: removed cyclic requirement parent ${row.parentId}.`)
        row.parentId = undefined
        break
      }
      visited.add(parent)
      parent = parents.get(parent)?.parentId
    }
  }
  for (const row of method.assumptions) {
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'requirementIds',
      'requirements',
    )
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
  }
  for (const row of method.candidates) {
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'requirementIds',
      'requirements',
    )
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'assumptionIds',
      'assumptions',
    )
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'componentCandidateIds',
      'candidates',
    )
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'constituentIds',
      'requirements',
    )
  }
  for (const row of method.interactions) {
    prune(row as unknown as { id: string } & Record<string, unknown>, 'candidateIds', 'candidates')
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
  }
  for (const row of method.validations) {
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'requirementIds',
      'requirements',
    )
    prune(row as unknown as { id: string } & Record<string, unknown>, 'candidateIds', 'candidates')
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
  }
  method.interactions = method.interactions.filter((row) => {
    if (row.candidateIds.length >= 2) return true
    notice(`${row.id}: interaction with fewer than two surviving candidates was omitted.`)
    return false
  })
  const compositeRows = new Map(method.candidates.map((row) => [row.id, row]))
  for (const row of [...method.candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const visits = new Set<string>()
    const reaches = (id: string): boolean => {
      if (id === row.id) return true
      if (visits.has(id)) return false
      visits.add(id)
      return Boolean(compositeRows.get(id)?.componentCandidateIds.some(reaches))
    }
    row.componentCandidateIds = row.componentCandidateIds.filter((id) => {
      if (!reaches(id)) return true
      notice(`${row.id}: removed cyclic composite candidate ${id}.`)
      return false
    })
  }
  for (const row of method.inquiries) {
    prune(
      row as unknown as { id: string } & Record<string, unknown>,
      'requirementIds',
      'requirements',
    )
    prune(row as unknown as { id: string } & Record<string, unknown>, 'candidateIds', 'candidates')
    prune(row as unknown as { id: string } & Record<string, unknown>, 'evidenceIds', 'evidence')
  }
  method.normalizationIssues = notices
  return method
}

export function validateResearchMethod(value: unknown): string[] {
  const input = object(value)
  const errors: string[] = []
  if (input.version !== 1) errors.push('Research method must use version 1.')
  if (!researchOperations.includes(input.activeOperation as ResearchOperation))
    errors.push('Choose a supported research operation.')
  const records = new Map<ResearchMethodCollection, Map<string, Record<string, unknown>>>()
  for (const collection of collections) {
    const table = new Map<string, Record<string, unknown>>()
    const rows = input[collection]
    if (!Array.isArray(rows) || rows.length > RESEARCH_METHOD_LIMIT)
      errors.push(`${collection} must contain at most ${RESEARCH_METHOD_LIMIT} records.`)
    else
      for (const value of rows) {
        const row = object(value)
        const id = identifier(row.id)
        if (!id || table.has(id)) errors.push(`${collection} needs unique, nonempty IDs.`)
        else table.set(id, row)
      }
    records.set(collection, table)
  }
  const references: Partial<
    Record<ResearchMethodCollection, Record<string, ResearchMethodCollection>>
  > = {
    requirements: { assumptionIds: 'assumptions', evidenceIds: 'evidence' },
    assumptions: { requirementIds: 'requirements', evidenceIds: 'evidence' },
    candidates: {
      requirementIds: 'requirements',
      assumptionIds: 'assumptions',
      evidenceIds: 'evidence',
      componentCandidateIds: 'candidates',
      constituentIds: 'requirements',
    },
    interactions: { candidateIds: 'candidates', evidenceIds: 'evidence' },
    validations: {
      requirementIds: 'requirements',
      candidateIds: 'candidates',
      evidenceIds: 'evidence',
    },
    inquiries: {
      requirementIds: 'requirements',
      candidateIds: 'candidates',
      evidenceIds: 'evidence',
    },
  }
  for (const [collection, table] of records)
    for (const [id, row] of table) {
      for (const [field, target] of Object.entries(references[collection] || {})) {
        if (
          !Array.isArray(row[field]) ||
          (row[field] as unknown[]).some(
            (ref) => typeof ref !== 'string' || !records.get(target)?.has(ref),
          )
        )
          errors.push(`${id}: ${field} contains a missing or invalid reference.`)
      }
      if (collection === 'interactions' && strings(row.candidateIds).length < 2)
        errors.push(`${id}: an interaction needs at least two distinct candidates.`)
      if (
        collection === 'requirements' &&
        row.parentId !== undefined &&
        !records.get('requirements')?.has(String(row.parentId))
      )
        errors.push(`${id}: requirement parent does not exist.`)
    }
  for (const [id, row] of records.get('requirements') || []) {
    const seen = new Set([id])
    let parent = row.parentId
    while (typeof parent === 'string') {
      if (seen.has(parent)) {
        errors.push(`${id}: requirement decomposition contains a cycle.`)
        break
      }
      seen.add(parent)
      parent = records.get('requirements')?.get(parent)?.parentId
    }
  }
  for (const [id, row] of records.get('candidates') || []) {
    const seen = new Set<string>()
    const reaches = (ref: string): boolean => {
      if (ref === id) return true
      if (seen.has(ref)) return false
      seen.add(ref)
      const child = records.get('candidates')?.get(ref)
      return Boolean(
        Array.isArray(child?.componentCandidateIds) &&
        child.componentCandidateIds.some((item) => typeof item === 'string' && reaches(item)),
      )
    }
    if (
      Array.isArray(row.componentCandidateIds) &&
      row.componentCandidateIds.some((item) => typeof item === 'string' && reaches(item))
    )
      errors.push(`${id}: candidate composition contains a cycle.`)
  }
  return [...new Set(errors)]
}

/** User edits reject broken links; deletion deliberately removes the affected links. */
export function applyResearchMethodAction(
  method: ResearchMethod,
  action: ResearchMethodAction,
): ResearchMethod {
  let next: ResearchMethod = { ...method }
  if (action.type === 'operation') next.activeOperation = action.operation
  else if (action.type === 'upsert') {
    const rows: unknown[] = [...method[action.collection]]
    const index = rows.findIndex((row) => (row as { id: string }).id === action.record.id)
    if (index < 0) rows.push(action.record)
    else rows[index] = action.record
    ;(next[action.collection] as unknown[]) = rows
  } else {
    ;(next[action.collection] as unknown[]) = method[action.collection].filter(
      (row) => row.id !== action.id,
    )
    next = normalizeResearchMethod(next)
    // An intentional deletion is not a corrupted-file warning.
    next.normalizationIssues = method.normalizationIssues
    if (action.collection === 'candidates')
      next.interactions = next.interactions.filter((row) => row.candidateIds.length >= 2)
  }
  if (
    action.type === 'upsert' &&
    action.collection === 'validations' &&
    action.record.outcome === 'pass'
  ) {
    const previous = method.validations.find((row) => row.id === action.record.id)
    const sameObservation =
      previous?.outcome === 'pass' &&
      previous.actual === action.record.actual &&
      previous.procedure === action.record.procedure &&
      JSON.stringify([...new Set(previous.evidenceIds)].sort()) ===
        JSON.stringify([...new Set(action.record.evidenceIds)].sort())
    next.validations = next.validations.map((row) =>
      row.id === action.record.id
        ? {
            ...row,
            testedFingerprint: sameObservation
              ? previous.testedFingerprint
              : researchValidationFingerprint(next, row),
            testedAt: sameObservation ? (previous.testedAt ?? previous.updatedAt) : row.updatedAt,
          }
        : row,
    )
  }
  const errors = validateResearchMethod(next)
  if (errors.length) throw new Error(errors[0])
  return normalizeResearchMethod(next)
}

type VerificationRecord = {
  collection: ResearchMethodCollection
  row: ResearchMethodRows[ResearchMethodCollection]
}
interface VerificationIndex {
  tables: Map<ResearchMethodCollection, Map<string, ResearchMethodRows[ResearchMethodCollection]>>
  signatures: Map<string, string>
}
function verificationIndex(method: ResearchMethod): VerificationIndex {
  return {
    tables: new Map(
      collections.map((collection) => [
        collection,
        new Map(method[collection].map((row) => [row.id, row])),
      ]),
    ),
    signatures: new Map(),
  }
}
function fingerprint(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index++)
    hash = Math.imul(hash ^ content.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}
/** Follow constituent mechanisms, prerequisites and their supporting assumptions. */
function researchVerificationRecords(
  method: ResearchMethod,
  validation: ResearchValidation,
  index = verificationIndex(method),
): VerificationRecord[] {
  const selected: Record<ResearchMethodCollection, Set<string>> = {
    requirements: new Set(validation.requirementIds),
    candidates: new Set(validation.candidateIds),
    evidence: new Set(validation.evidenceIds),
    assumptions: new Set(),
    interactions: new Set(),
    validations: new Set(),
    inquiries: new Set(),
  }
  const queue: { collection: ResearchMethodCollection; id: string }[] = [
    ...validation.requirementIds.map((id) => ({ collection: 'requirements' as const, id })),
    ...validation.candidateIds.map((id) => ({ collection: 'candidates' as const, id })),
  ]
  const visited = new Set<string>()
  const add = (collection: ResearchMethodCollection, ids: string[]) => {
    for (const id of ids) {
      selected[collection].add(id)
      queue.push({ collection, id })
    }
  }
  while (queue.length) {
    const entry = queue.pop()!
    const key = entry.collection + ':' + entry.id
    if (visited.has(key)) continue
    visited.add(key)
    const row = index.tables.get(entry.collection)?.get(entry.id)
    if (!row) continue
    if (entry.collection === 'requirements') {
      const requirement = row as ResearchRequirement
      add('requirements', requirement.parentId ? [requirement.parentId] : [])
      add('assumptions', [
        ...requirement.assumptionIds,
        ...method.assumptions
          .filter((row) => row.requirementIds.includes(requirement.id))
          .map((row) => row.id),
      ])
      add('evidence', requirement.evidenceIds)
    } else if (entry.collection === 'candidates') {
      const candidate = row as ResearchCandidate
      add('candidates', candidate.componentCandidateIds)
      add('requirements', [...candidate.requirementIds, ...candidate.constituentIds])
      add('assumptions', candidate.assumptionIds)
      add('evidence', candidate.evidenceIds)
    } else if (entry.collection === 'assumptions')
      add('evidence', (row as ResearchAssumption).evidenceIds)
  }
  return collections.flatMap((collection) =>
    [...selected[collection]]
      .sort((a, b) => a.localeCompare(b))
      .flatMap((id) => {
        const row = index.tables.get(collection)?.get(id)
        return row ? [{ collection, row }] : []
      }),
  )
}
function verificationFingerprint(records: VerificationRecord[], index: VerificationIndex): string {
  return (
    'v1-' +
    fingerprint(
      JSON.stringify(
        records.map(({ collection, row }) => {
          const key = collection + ':' + row.id
          let signature = index.signatures.get(key)
          if (!signature) {
            signature = fingerprint(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(row)
                    .filter(
                      ([field]) =>
                        field !== 'updatedAt' &&
                        (field !== 'status' || collection === 'assumptions'),
                    )
                    .sort(([a], [b]) => a.localeCompare(b)),
                ),
              ),
            )
            index.signatures.set(key, signature)
          }
          return [collection, row.id, signature]
        }),
      ),
    )
  )
}
/** Capture linked content transitively, retaining assumption truth states. */
export function researchValidationFingerprint(
  method: ResearchMethod,
  validation: ResearchValidation,
): string {
  const index = verificationIndex(method)
  return verificationFingerprint(researchVerificationRecords(method, validation, index), index)
}

export interface ResearchMethodProblem {
  id: string
  title: string
  status: 'open' | 'blocked' | 'solved'
  requirementIds?: string[]
}
export interface ResearchMethodAnalysis {
  leafRequirementIds: string[]
  readyRequirementIds: string[]
  verifiedRequirementIds: string[]
  coveredRequirementIds: string[]
  uncoveredRequirementIds: string[]
  unsupportedAssumptionIds: string[]
  refutedAssumptionIds: string[]
  conflictInteractionIds: string[]
  unresolvedProblemIds: string[]
  findings: {
    kind:
      | 'requirement'
      | 'assumption'
      | 'candidate'
      | 'interaction'
      | 'validation'
      | 'inquiry'
      | 'repair'
    id?: string
    message: string
  }[]
}
export function analyzeResearchMethod(
  value: ResearchMethod,
  problems: ResearchMethodProblem[] = [],
): ResearchMethodAnalysis {
  const method = normalizeResearchMethod(value)
  const supportedEvidence = new Set(
    method.evidence
      .filter((row) => row.content.trim() && row.source.trim() && row.reliability !== 'unverified')
      .map((row) => row.id),
  )
  const children = new Set(
    method.requirements.flatMap((row) => (row.parentId ? [row.parentId] : [])),
  )
  const leaves = method.requirements.filter((row) => !children.has(row.id))
  const candidates = method.candidates.filter((row) => row.status !== 'rejected')
  const covered = new Set(candidates.flatMap((row) => row.requirementIds))
  const findings: ResearchMethodAnalysis['findings'] = method.normalizationIssues.map(
    (message) => ({ kind: 'repair', message }),
  )
  const observedEvidence = new Set(
    method.evidence
      .filter(
        (row) =>
          row.content.trim() &&
          row.source.trim() &&
          row.reliability === 'reproduced' &&
          (row.kind === 'experiment' ||
            row.kind === 'observation' ||
            row.kind === 'counterexample'),
      )
      .map((row) => row.id),
  )
  const verificationCache = new Map<string, { fingerprint: string; lastChanged: number }>()
  const verificationRecordsIndex = verificationIndex(method)
  const currentVerification = (row: ResearchValidation) => {
    const key = JSON.stringify([
      [...row.requirementIds].sort(),
      [...row.candidateIds].sort(),
      [...row.evidenceIds].sort(),
    ])
    const cached = verificationCache.get(key)
    if (cached) return cached
    const records = researchVerificationRecords(method, row, verificationRecordsIndex)
    const result = {
      fingerprint: verificationFingerprint(records, verificationRecordsIndex),
      lastChanged: Math.max(0, ...records.map(({ row: record }) => record.updatedAt)),
    }
    verificationCache.set(key, result)
    return result
  }
  const validationIsCurrent = (row: ResearchValidation) => {
    const current = currentVerification(row)
    return row.testedFingerprint
      ? row.testedFingerprint === current.fingerprint
      : current.lastChanged <= (row.testedAt ?? row.updatedAt)
  }
  const usableValidation = (row: ResearchValidation) =>
    row.outcome === 'pass' &&
    Boolean(
      row.procedure.trim() &&
      row.expected.trim() &&
      row.actual.trim() &&
      row.evidenceIds.some((id) => observedEvidence.has(id)) &&
      validationIsCurrent(row),
    )
  const verified = new Set(
    method.validations.filter(usableValidation).flatMap((row) => row.requirementIds),
  )
  const assumptions = new Map(method.assumptions.map((row) => [row.id, row]))
  const ready = leaves.filter(
    (row) =>
      row.atomic &&
      row.rationale.trim() &&
      row.acceptance.trim() &&
      [
        ...new Set([
          ...row.assumptionIds,
          ...method.assumptions
            .filter((assumption) => assumption.requirementIds.includes(row.id))
            .map((assumption) => assumption.id),
        ]),
      ].every((id) => {
        const assumption = assumptions.get(id)
        return (
          assumption?.status === 'supported' &&
          assumption.evidenceIds.some((evidenceId) => supportedEvidence.has(evidenceId))
        )
      }),
  )
  for (const row of leaves) {
    if (!row.acceptance.trim())
      findings.push({
        kind: 'requirement',
        id: row.id,
        message: 'Add an observable acceptance criterion.',
      })
    if (!row.atomic || !row.rationale.trim())
      findings.push({
        kind: 'requirement',
        id: row.id,
        message: 'Explain why this requirement is irreducible, or decompose it further.',
      })
    if (!covered.has(row.id))
      findings.push({
        kind: 'requirement',
        id: row.id,
        message: 'No candidate solution addresses this leaf requirement.',
      })
    if (row.status === 'verified' && !verified.has(row.id))
      findings.push({
        kind: 'requirement',
        id: row.id,
        message: 'Marked verified without a passing, evidenced verification.',
      })
  }
  for (const row of method.assumptions)
    if (row.status !== 'supported' || !row.evidenceIds.some((id) => supportedEvidence.has(id)))
      findings.push({
        kind: 'assumption',
        id: row.id,
        message:
          row.status === 'refuted'
            ? 'This assumption is refuted; revisit affected requirements and candidates.'
            : 'Ground or falsify this assumption with a sourced observation or experiment.',
      })
  for (const row of candidates)
    if (!row.requirementIds.length || !row.mechanism.trim())
      findings.push({
        kind: 'candidate',
        id: row.id,
        message: 'Describe the mechanism and link the requirements it addresses.',
      })
  for (const row of method.interactions) {
    if (row.kind === 'conflicting')
      findings.push({
        kind: 'interaction',
        id: row.id,
        message: 'These candidates conflict and cannot share an unqualified solution bundle.',
      })
    else if (
      row.kind === 'unknown' ||
      !row.mechanism.trim() ||
      !row.evidenceIds.some((id) => supportedEvidence.has(id))
    )
      findings.push({
        kind: 'interaction',
        id: row.id,
        message: 'The candidate interaction still needs a grounded mechanism or experiment.',
      })
  }
  for (const row of method.validations)
    if (row.outcome === 'pass' && !usableValidation(row))
      findings.push({
        kind: 'validation',
        id: row.id,
        message: validationIsCurrent(row)
          ? 'A passing result needs the procedure, expected and actual results, and sourced observed/reproduced evidence.'
          : 'Linked requirements, mechanisms or evidence changed after this result; repeat verification.',
      })
  for (const row of method.inquiries)
    if (
      row.status === 'tested' &&
      (!row.intervention.trim() ||
        !row.prediction.trim() ||
        !row.result.trim() ||
        !row.evidenceIds.some((id) => observedEvidence.has(id)))
    )
      findings.push({
        kind: 'inquiry',
        id: row.id,
        message:
          'A tested inquiry needs the intervention, prediction, observed result and reproduced evidence.',
      })
  return {
    leafRequirementIds: leaves.map((row) => row.id),
    readyRequirementIds: ready.map((row) => row.id),
    verifiedRequirementIds: leaves.filter((row) => verified.has(row.id)).map((row) => row.id),
    coveredRequirementIds: leaves.filter((row) => covered.has(row.id)).map((row) => row.id),
    uncoveredRequirementIds: leaves.filter((row) => !covered.has(row.id)).map((row) => row.id),
    unsupportedAssumptionIds: method.assumptions
      .filter(
        (row) =>
          row.status !== 'supported' || !row.evidenceIds.some((id) => supportedEvidence.has(id)),
      )
      .map((row) => row.id),
    refutedAssumptionIds: method.assumptions
      .filter((row) => row.status === 'refuted')
      .map((row) => row.id),
    conflictInteractionIds: method.interactions
      .filter((row) => row.kind === 'conflicting')
      .map((row) => row.id),
    unresolvedProblemIds: problems.filter((row) => row.status !== 'solved').map((row) => row.id),
    findings,
  }
}

export interface ResearchSolutionBundle {
  candidateIds: string[]
  coveredRequirementIds: string[]
  uncoveredRequirementIds: string[]
  constructiveInteractionIds: string[]
  untestedCandidatePairs: [string, string][]
}
/** Enumerate bounded hypotheses, excluding recorded conflicts. Coverage is not proof of success. */
export function researchSolutionBundles(
  value: ResearchMethod,
  limit = 8,
): ResearchSolutionBundle[] {
  const resultLimit = Math.max(0, Math.min(20, Math.floor(limit)))
  if (!resultLimit) return []
  const method = normalizeResearchMethod(value)
  const parents = new Set(
    method.requirements.flatMap((row) => (row.parentId ? [row.parentId] : [])),
  )
  const leafIds = method.requirements.filter((row) => !parents.has(row.id)).map((row) => row.id)
  const leafBits = new Map(leafIds.map((id, index) => [id, 1n << BigInt(index)]))
  const candidates = method.candidates
    .filter((row) => row.status !== 'rejected')
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 12)
  const candidateIndices = new Map(candidates.map((row, index) => [row.id, index]))
  const candidateCoverage = candidates.map((row) =>
    row.requirementIds.reduce((mask, id) => mask | (leafBits.get(id) || 0n), 0n),
  )
  const groundedEvidence = new Set(
    method.evidence
      .filter((row) => row.content.trim() && row.source.trim() && row.reliability === 'reproduced')
      .map((row) => row.id),
  )
  const pairs: { left: number; right: number; mask: number; bit: bigint }[] = []
  for (let left = 0; left < candidates.length; left++)
    for (let right = left + 1; right < candidates.length; right++)
      pairs.push({ left, right, mask: (1 << left) | (1 << right), bit: 1n << BigInt(pairs.length) })
  const groups = new Map<number, { mask: number; knownPairs: bigint; constructiveIds: string[] }>()
  const conflictMasks: number[] = []
  for (const row of method.interactions) {
    if (row.candidateIds.some((id) => !candidateIndices.has(id))) continue
    const mask = row.candidateIds.reduce((bits, id) => bits | (1 << candidateIndices.get(id)!), 0)
    if (row.kind === 'conflicting') {
      conflictMasks.push(mask)
      continue
    }
    if (
      row.kind === 'unknown' ||
      !row.mechanism.trim() ||
      !row.evidenceIds.some((id) => groundedEvidence.has(id))
    )
      continue
    const group = groups.get(mask) || { mask, knownPairs: 0n, constructiveIds: [] }
    group.knownPairs = pairs.reduce(
      (bits, pair) => ((mask & pair.mask) === pair.mask ? bits | pair.bit : bits),
      group.knownPairs,
    )
    if (row.kind === 'constructive') group.constructiveIds.push(row.id)
    groups.set(mask, group)
  }
  const knownGroups = [...groups.values()]
  const countCache = new Map<bigint, number>([[0n, 0]])
  const count = (bits: bigint) => {
    const cached = countCache.get(bits)
    if (cached !== undefined) return cached
    const value = bits.toString(2).replace(/0/g, '').length
    countCache.set(bits, value)
    return value
  }
  const maximum = 1 << candidates.length
  const coverages: bigint[] = Array(maximum).fill(0n)
  const candidateCounts = new Uint8Array(maximum)
  const pairFlags: bigint[] = Array(maximum).fill(0n)
  type Ranked = {
    mask: number
    coverage: bigint
    coverageCount: number
    unknownPairs: bigint
    unknownCount: number
    constructiveCount: number
    candidateCount: number
    signature?: string
  }
  const signature = (row: Ranked) =>
    row.signature ??
    (row.signature = candidates
      .filter((_candidate, index) => Boolean(row.mask & (1 << index)))
      .map((candidate) => candidate.id)
      .join('\0'))
  const compare = (a: Ranked, b: Ranked) =>
    b.coverageCount - a.coverageCount ||
    a.unknownCount - b.unknownCount ||
    b.constructiveCount - a.constructiveCount ||
    a.candidateCount - b.candidateCount ||
    signature(a).localeCompare(signature(b))
  const best: Ranked[] = []
  for (let mask = 1; mask < maximum; mask++) {
    const bit = mask & -mask
    const index = Math.log2(bit)
    const previous = mask ^ bit
    coverages[mask] = coverages[previous] | candidateCoverage[index]
    candidateCounts[mask] = candidateCounts[previous] + 1
    pairFlags[mask] = pairs.reduce(
      (bits, pair) =>
        (mask & pair.mask) === pair.mask && pair.mask & bit ? bits | pair.bit : bits,
      pairFlags[previous],
    )
    if (!coverages[mask] || conflictMasks.some((conflict) => (mask & conflict) === conflict))
      continue
    let known = 0n
    let constructiveCount = 0
    for (const group of knownGroups)
      if ((mask & group.mask) === group.mask) {
        known |= group.knownPairs
        constructiveCount += group.constructiveIds.length
      }
    const unknownPairs = pairFlags[mask] & ~known
    const ranked: Ranked = {
      mask,
      coverage: coverages[mask],
      coverageCount: count(coverages[mask]),
      unknownPairs,
      unknownCount: count(unknownPairs),
      constructiveCount,
      candidateCount: candidateCounts[mask],
    }
    if (best.length === resultLimit && compare(ranked, best[best.length - 1]) >= 0) continue
    const at = best.findIndex((row) => compare(ranked, row) < 0)
    if (at < 0) best.push(ranked)
    else best.splice(at, 0, ranked)
    if (best.length > resultLimit) best.pop()
  }
  return best.map((row) => ({
    candidateIds: candidates
      .filter((_candidate, index) => Boolean(row.mask & (1 << index)))
      .map((candidate) => candidate.id),
    coveredRequirementIds: leafIds.filter((id) => Boolean(row.coverage & leafBits.get(id)!)),
    uncoveredRequirementIds: leafIds.filter((id) => !(row.coverage & leafBits.get(id)!)),
    constructiveInteractionIds: knownGroups
      .filter((group) => (row.mask & group.mask) === group.mask)
      .flatMap((group) => group.constructiveIds),
    untestedCandidatePairs: pairs
      .filter((pair) => Boolean(row.unknownPairs & pair.bit))
      .map((pair) => [candidates[pair.left].id, candidates[pair.right].id]),
  }))
}

export interface ResearchMethodGraph {
  nodes: { id: string; kind: ResearchMethodCollection; label: string }[]
  edges: {
    from: string
    to: string
    kind:
      'decomposes' | 'composes' | 'depends-on' | 'supports' | 'addresses' | 'interacts' | 'tests'
  }[]
  /** Count within the explicitly selected node scope, before the rendering limit. */
  totalRelationshipCount?: number
  omittedRelationshipCount?: number
}
export function buildResearchMethodGraph(
  value: ResearchMethod,
  options?: { nodeIds?: ReadonlySet<string>; maxEdges?: number },
): ResearchMethodGraph {
  const method = normalizeResearchMethod(value)
  const nodes: ResearchMethodGraph['nodes'] = []
  const edges: ResearchMethodGraph['edges'] = []
  const key = (collection: ResearchMethodCollection, id: string) => collection + ':' + id
  const included = (collection: ResearchMethodCollection, id: string) =>
    !options?.nodeIds || options.nodeIds.has(key(collection, id))
  const limit =
    options?.maxEdges === undefined ? Infinity : Math.max(0, Math.floor(options.maxEdges))
  let totalRelationshipCount = 0
  const edge = (from: string, to: string, kind: ResearchMethodGraph['edges'][number]['kind']) => {
    if (options?.nodeIds && (!options.nodeIds.has(from) || !options.nodeIds.has(to))) return
    totalRelationshipCount++
    if (edges.length < limit) edges.push({ from, to, kind })
  }
  for (const collection of collections)
    for (const row of [...method[collection]].sort((a, b) => a.id.localeCompare(b.id)))
      if (included(collection, row.id))
        nodes.push({
          id: key(collection, row.id),
          kind: collection,
          label:
            'statement' in row
              ? row.statement
              : 'claim' in row
                ? row.claim
                : 'title' in row
                  ? row.title
                  : 'content' in row
                    ? row.content
                    : 'question' in row
                      ? row.question
                      : row.mechanism,
        })
  for (const row of method.requirements) {
    if (!included('requirements', row.id)) continue
    if (row.parentId)
      edge(key('requirements', row.parentId), key('requirements', row.id), 'decomposes')
    for (const id of row.assumptionIds)
      edge(key('requirements', row.id), key('assumptions', id), 'depends-on')
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('requirements', row.id), 'supports')
  }
  for (const row of method.assumptions) {
    if (!included('assumptions', row.id)) continue
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('assumptions', row.id), 'supports')
    for (const id of row.requirementIds)
      edge(key('requirements', id), key('assumptions', row.id), 'depends-on')
  }
  for (const row of method.candidates) {
    if (!included('candidates', row.id)) continue
    for (const id of row.componentCandidateIds)
      edge(key('candidates', id), key('candidates', row.id), 'composes')
    for (const id of row.constituentIds)
      edge(key('requirements', id), key('candidates', row.id), 'composes')
    for (const id of row.requirementIds)
      edge(key('candidates', row.id), key('requirements', id), 'addresses')
    for (const id of row.assumptionIds)
      edge(key('candidates', row.id), key('assumptions', id), 'depends-on')
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('candidates', row.id), 'supports')
  }
  for (const row of method.interactions) {
    if (!included('interactions', row.id)) continue
    for (const id of row.candidateIds)
      edge(key('interactions', row.id), key('candidates', id), 'interacts')
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('interactions', row.id), 'supports')
  }
  for (const row of method.validations) {
    if (!included('validations', row.id)) continue
    for (const id of row.requirementIds)
      edge(key('validations', row.id), key('requirements', id), 'tests')
    for (const id of row.candidateIds)
      edge(key('validations', row.id), key('candidates', id), 'tests')
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('validations', row.id), 'supports')
  }
  for (const row of method.inquiries) {
    if (!included('inquiries', row.id)) continue
    for (const id of row.requirementIds)
      edge(key('inquiries', row.id), key('requirements', id), 'tests')
    for (const id of row.candidateIds)
      edge(key('inquiries', row.id), key('candidates', id), 'tests')
    for (const id of row.evidenceIds)
      edge(key('evidence', id), key('inquiries', row.id), 'supports')
  }
  return {
    nodes,
    edges: edges.sort((a, b) =>
      (a.from + '\0' + a.to + '\0' + a.kind).localeCompare(b.from + '\0' + b.to + '\0' + b.kind),
    ),
    ...(options
      ? {
          totalRelationshipCount,
          omittedRelationshipCount: Math.max(0, totalRelationshipCount - edges.length),
        }
      : {}),
  }
}
