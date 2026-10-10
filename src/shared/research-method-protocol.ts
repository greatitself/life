import { researchOperationCatalog, RESEARCH_METHOD_LIMIT } from './research-method'

const id = { type: 'string', minLength: 1, maxLength: 240 }
const ids = { type: 'array', items: id, uniqueItems: true, maxItems: RESEARCH_METHOD_LIMIT }
const text = { type: 'string', maxLength: 8000 }
const enumeration = (...values: string[]) => ({ type: 'string', enum: values })
const row = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: 'object',
  additionalProperties: true,
  properties: { id, updatedAt: { type: 'integer', minimum: 0 }, ...properties },
  required: [
    'id',
    'updatedAt',
    ...Object.keys(properties).filter((key) => !optional.includes(key)),
  ],
})
const definitions = {
  requirements: row(
    {
      parentId: id,
      statement: text,
      acceptance: text,
      rationale: text,
      kind: enumeration('requirement', 'constraint', 'component'),
      priority: enumeration('essential', 'optional'),
      atomic: { type: 'boolean' },
      status: enumeration('proposed', 'grounded', 'verified'),
      assumptionIds: ids,
      evidenceIds: ids,
    },
    ['parentId'],
  ),
  assumptions: row({
    claim: text,
    challenge: text,
    consequence: text,
    status: enumeration('unverified', 'supported', 'refuted'),
    requirementIds: ids,
    evidenceIds: ids,
  }),
  evidence: row({
    kind: enumeration('observation', 'source', 'experiment', 'constraint', 'counterexample'),
    content: { type: 'string', maxLength: 16000 },
    source: { type: 'string', maxLength: 4000 },
    reliability: enumeration('unverified', 'reported', 'reproduced'),
  }),
  candidates: row({
    title: { type: 'string', maxLength: 240 },
    mechanism: text,
    risks: text,
    componentCandidateIds: ids,
    constituentIds: ids,
    emergence: text,
    status: enumeration('proposed', 'selected', 'rejected'),
    requirementIds: ids,
    assumptionIds: ids,
    evidenceIds: ids,
  }),
  interactions: row({
    candidateIds: { ...ids, minItems: 2 },
    kind: enumeration('constructive', 'compatible', 'conflicting', 'redundant', 'unknown'),
    mechanism: text,
    evidenceIds: ids,
  }),
  validations: row(
    {
      title: { type: 'string', maxLength: 240 },
      procedure: text,
      expected: text,
      actual: { type: 'string', maxLength: 16000 },
      outcome: enumeration('pending', 'pass', 'fail', 'inconclusive'),
      requirementIds: ids,
      candidateIds: ids,
      evidenceIds: ids,
      testedFingerprint: { type: 'string', maxLength: 240 },
      testedAt: { type: 'integer', minimum: 0 },
    },
    ['testedFingerprint', 'testedAt'],
  ),
  inquiries: row({
    operation: enumeration(...researchOperationCatalog.map((operation) => operation.id)),
    question: text,
    premise: text,
    intervention: text,
    prediction: text,
    result: { type: 'string', maxLength: 16000 },
    status: enumeration('proposed', 'tested', 'rejected'),
    requirementIds: ids,
    candidateIds: ids,
    evidenceIds: ids,
  }),
}
export const researchMethodSchema =
  JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Life research method',
      description:
        'The method field of goal.json; stable references must exist in the same method.',
      type: 'object',
      additionalProperties: true,
      properties: {
        version: { const: 1 },
        activeOperation: enumeration(...researchOperationCatalog.map((operation) => operation.id)),
        normalizationIssues: {
          type: 'array',
          maxItems: 80,
          items: { type: 'string', maxLength: 1000 },
        },
        ...Object.fromEntries(
          Object.entries(definitions).map(([name, definition]) => [
            name,
            { type: 'array', maxItems: RESEARCH_METHOD_LIMIT, items: definition },
          ]),
        ),
      },
      required: ['version', 'activeOperation', ...Object.keys(definitions)],
    },
    null,
    2,
  ) + '\n'

const operationInvocationInstructions =
  "Read the conversation's .life-context.json first. Its operation is the immutable operator selected for this submitted request, even when goal.json's activeOperation has since changed. Follow the user's literal request, the selected goal/problem, and the permission mode. The operator and research context are instruction-file metadata; never pretend they were user messages. An operator selection by itself does not authorize sending an invented request or continuing work."

const promptInvocationInstructions =
  "Read the conversation's .life-context.json for the selected goal/problem and file paths. The user's message determines the research approach. Historical operation and activeOperation fields do not select an approach for a message. Follow the user's literal request and permission mode; never add an approach or an invented continuation. Use this guide for structured research records when needed."

function methodGuide(invocationInstructions: string): string {
  return `# Life research method · version 1

This is a research workspace for Automated Abstraction and Anti-Abstraction Based Research.

The terminology is explicit: anti-abstraction breaks a whole into basic constituents (an atom into electrons, protons and neutrons). Abstraction composes constituents into higher-level assemblies and a proposed whole. Grounding and falsification are distinct tools, not alternative definitions of these terms.

${invocationInstructions}

Read the current goalFile and methodSchemaFile identified in that context. Store structured records in goal.json's method field with version 1, stable IDs and the bounded tables described in the schema. Preserve unrelated goal fields, problems, conversation links and unknown metadata. Each table supports up to ${RESEARCH_METHOD_LIMIT} records; goal.json remains bounded at 4 MB. Missing relationships and parent/composition cycles are invalid. Update updatedAt with the actual millisecond time when a record changes.

Start from the goal's success conditions and the obstacles to reaching them. Decompose requirements and components with parentId. State observable acceptance and why an atomic leaf needs no further decomposition at the chosen, explicitly justified research granularity. Basic is relative to the research question and discipline; do not claim ultimate physical irreducibility or that unexplored abstractions are proven facts.

Requirements and constraints are distinct records. Link assumptions and evidence. An assumption needs a falsification challenge and the consequence if it fails. Evidence records separate observation, cited source, experiment, constraint and counterexample. Mark reliability unverified until inspected, reported for sourced findings, and reproduced only for an observed/repeated result with an actual source or artifact. A pasted URL is not inspected evidence. Never fabricate observations, test results, citations or progress.

Candidate solutions claim coverage through requirementIds; coverage is not satisfaction. Explain their mechanism and risks. Save assembled solutions as composite candidates with componentCandidateIds for constituent mechanisms and constituentIds for basic components. Record emergence as a proposed whole-level effect until tested. Pair or group interactions can be constructive, compatible, conflicting, redundant or unknown; record their mechanism and supporting evidence. Constructive interaction is a hypothesis until reproduced evidence supports it. Do not manufacture a numerical synergy score.

Keep blockers in the existing problems array; optional requirementIds link obstacles to requirements. Work toward the selected problem only when problemId exists. The shared goal map and method may expose other problems but do not change this conversation's identity.

Verification records need a reproducible procedure, expected result, actual result, outcome and linked evidence. Passing observations require reproduced observation/experiment/counterexample evidence; mere citations do not verify success. Preserve results after a mechanism changes but regard them as stale. Life-created verifications capture a testedFingerprint automatically; provider-created records may omit it, in which case timestamps detect changes to linked records. Do not retain a previous fingerprint while claiming a new test was performed.

Alternative approaches are saved as inquiries with an operation, question, premise, intervention, prediction, result and evidence links. A tested inquiry requires an observed result and reproduced evidence. Explicitly say when a result is hypothetical, inconclusive or refuted. The following operators are tools available in Life, not claims of new scientific discoveries:

${researchOperationCatalog.map((operation) => `## ${operation.label} (${operation.id})\n\n${operation.description}\n\n${operation.artifactGuidance}`).join('\n\n')}

Use atomic replacements and wait while the context's lockFile exists before editing goalFile. Keep working artifacts in the current research goal/conversation directory. Life refreshes structured records and diagrams from files after turns complete. No research operation authorizes edits to Life's application source.
`
}

export const researchMethodGuide = methodGuide(operationInvocationInstructions)
export const promptResearchMethodGuide = methodGuide(promptInvocationInstructions)
