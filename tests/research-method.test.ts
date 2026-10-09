import { describe, expect, it } from 'vitest'
import {
  analyzeResearchMethod,
  applyResearchMethodAction,
  buildResearchMethodGraph,
  createResearchMethod,
  normalizeResearchMethod,
  RESEARCH_METHOD_LIMIT,
  researchOperationCatalog,
  researchOperations,
  researchSolutionBundles,
  validateResearchMethod,
} from '../src/shared/research-method'
import type {
  ResearchAssumption,
  ResearchCandidate,
  ResearchEvidence,
  ResearchInteraction,
  ResearchInquiry,
  ResearchMethod,
  ResearchRequirement,
  ResearchValidation,
} from '../src/shared/research-method'

const requirement = (
  id: string,
  changes: Partial<ResearchRequirement> = {},
): ResearchRequirement => ({
  id,
  statement: `Requirement ${id}`,
  acceptance: 'The measured response is below 20 ms in the reproducible test.',
  rationale: 'This latency threshold is independently observable and cannot be split further.',
  kind: 'requirement',
  priority: 'essential',
  atomic: true,
  status: 'grounded',
  assumptionIds: [],
  evidenceIds: [],
  updatedAt: 100,
  ...changes,
})
const assumption = (id: string, changes: Partial<ResearchAssumption> = {}): ResearchAssumption => ({
  id,
  claim: 'A stable monotonic clock exists on the host.',
  challenge: 'Measure drift while wall-clock adjustments occur.',
  consequence: 'A timing result cannot establish latency if the clock moves backward.',
  status: 'unverified',
  requirementIds: [],
  evidenceIds: [],
  updatedAt: 100,
  ...changes,
})
const evidence = (id: string, changes: Partial<ResearchEvidence> = {}): ResearchEvidence => ({
  id,
  kind: 'experiment',
  content: 'Three recorded trials completed in 14, 15 and 16 ms.',
  source: 'artifacts/latency-trials.csv',
  reliability: 'reproduced',
  updatedAt: 100,
  ...changes,
})
const candidate = (id: string, changes: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  id,
  title: `Candidate ${id}`,
  mechanism: 'Process independent requests concurrently with bounded worker ownership.',
  risks: 'Thread contention may remove the benefit.',
  componentCandidateIds: [],
  constituentIds: [],
  emergence: '',
  status: 'proposed',
  requirementIds: [],
  assumptionIds: [],
  evidenceIds: [],
  updatedAt: 100,
  ...changes,
})
const interaction = (
  id: string,
  changes: Partial<ResearchInteraction> = {},
): ResearchInteraction => ({
  id,
  candidateIds: ['a', 'b'],
  kind: 'unknown',
  mechanism: '',
  evidenceIds: [],
  updatedAt: 100,
  ...changes,
})
const validation = (id: string, changes: Partial<ResearchValidation> = {}): ResearchValidation => ({
  id,
  title: 'Measure end-to-end latency',
  procedure: 'Run three trials with an unchanged input fixture and record elapsed monotonic time.',
  expected: 'All trials complete within 20 ms.',
  actual: 'Three trials complete in 14, 15 and 16 ms.',
  outcome: 'pass',
  requirementIds: ['r'],
  candidateIds: [],
  evidenceIds: ['e'],
  updatedAt: 100,
  ...changes,
})
const method = (changes: Partial<ResearchMethod> = {}): ResearchMethod => ({
  ...createResearchMethod(),
  ...changes,
})
const inquiry = (id: string, changes: Partial<ResearchInquiry> = {}): ResearchInquiry => ({
  id,
  operation: 'causal-intervention',
  question: 'Does worker ownership cause the observed latency reduction?',
  premise: 'The input fixture and clock setup stay fixed.',
  intervention: 'Change the worker limit from one to two while measuring the same fixture.',
  prediction: 'Independent work overlaps and elapsed time decreases.',
  result: '',
  status: 'proposed',
  requirementIds: [],
  candidateIds: [],
  evidenceIds: [],
  updatedAt: 100,
  ...changes,
})

describe('research method records and explicit recovery', () => {
  it('exposes distinct research operators with concrete artifact guidance', () => {
    expect(new Set(researchOperations).size).toBe(12)
    expect(researchOperations).toEqual(
      expect.arrayContaining([
        'anti-abstraction',
        'abstraction',
        'constructive-interference',
        'counterfactual',
        'analogy',
        'constraint-inversion',
        'reverse-design',
        'morphological-search',
        'causal-intervention',
        'verify',
      ]),
    )
    expect(
      researchOperationCatalog.every(
        (operation) =>
          operation.label.trim() &&
          operation.description.trim() &&
          operation.artifactGuidance.trim(),
      ),
    ).toBe(true)
  })

  it.each([
    ['decompose', 'anti-abstraction'],
    ['synthesize', 'abstraction'],
    ['challenge', 'counterfactual'],
  ])(
    'migrates the legacy %s operator to %s without inventing records',
    (oldOperation, newOperation) => {
      const recovered = normalizeResearchMethod({
        ...createResearchMethod(),
        activeOperation: oldOperation,
      })
      expect(recovered.activeOperation).toBe(newOperation)
      expect(recovered.inquiries).toEqual([])
      expect(recovered.candidates).toEqual([])
    },
  )
  it('starts without invented requirements, evidence, candidates or conclusions', () => {
    const empty = createResearchMethod()
    expect(validateResearchMethod(empty)).toEqual([])
    expect(normalizeResearchMethod(undefined)).toEqual(empty)
    expect(normalizeResearchMethod({ unrelatedLegacyGoal: 'Solve everything' })).toMatchObject(
      empty,
    )
    expect(analyzeResearchMethod(empty)).toMatchObject({
      leafRequirementIds: [],
      readyRequirementIds: [],
      verifiedRequirementIds: [],
      coveredRequirementIds: [],
      uncoveredRequirementIds: [],
      findings: [],
    })
    expect(researchSolutionBundles(empty)).toEqual([])
  })

  it('recovers known records from a future version but visibly requires review', () => {
    const foreign = { ...method({ requirements: [requirement('r')] }), version: 91 }
    expect(validateResearchMethod(foreign)).toContain('Research method must use version 1.')
    const repaired = normalizeResearchMethod(foreign)
    expect(repaired.version).toBe(1)
    expect(repaired.requirements[0].statement).toBe('Requirement r')
    expect(repaired.normalizationIssues.join('\n')).toMatch(/version.*recovered/i)
    expect(analyzeResearchMethod(repaired).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'repair' })]),
    )
  })

  it('rejects duplicate, missing and control-character IDs instead of editing an ambiguous row', () => {
    const invalid = method({
      requirements: [requirement('r'), requirement('r'), requirement(''), requirement('bad\nid')],
    })
    expect(validateResearchMethod(invalid).join('\n')).toMatch(/unique, nonempty IDs/)
    const recovered = normalizeResearchMethod(invalid)
    expect(recovered.requirements.map((row) => row.id)).toEqual(['r'])
    expect(recovered.normalizationIssues.join('\n')).toMatch(/missing or duplicate record ID/)
  })

  it('rejects missing references, then recovery removes the links with visible explanations', () => {
    const broken = method({
      requirements: [
        requirement('r', {
          parentId: 'absent-parent',
          assumptionIds: ['missing-a'],
          evidenceIds: ['missing-e'],
        }),
      ],
      assumptions: [assumption('a', { requirementIds: ['missing-r'], evidenceIds: ['missing-e'] })],
      candidates: [
        candidate('c', {
          requirementIds: ['missing-r'],
          assumptionIds: ['missing-a'],
          evidenceIds: ['missing-e'],
        }),
      ],
      validations: [
        validation('v', {
          requirementIds: ['missing-r'],
          candidateIds: ['missing-c'],
          evidenceIds: ['missing-e'],
        }),
      ],
    })
    expect(validateResearchMethod(broken)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/requirement parent does not exist/),
        expect.stringMatching(/missing or invalid reference/),
      ]),
    )
    const repaired = normalizeResearchMethod(broken)
    expect(repaired.requirements[0].parentId).toBeUndefined()
    expect(repaired.requirements[0].assumptionIds).toEqual([])
    expect(repaired.candidates[0].requirementIds).toEqual([])
    expect(repaired.validations[0].candidateIds).toEqual([])
    expect(repaired.normalizationIssues.join('\n')).toContain('absent-parent')
    expect(repaired.normalizationIssues.join('\n')).toContain('missing-a')
    expect(repaired.normalizationIssues.join('\n')).toContain('missing-e')
    expect(validateResearchMethod(repaired)).toEqual([])
  })

  it('rejects a decomposition cycle and deterministically recovers an acyclic hierarchy', () => {
    const cyclic = method({
      requirements: [requirement('b', { parentId: 'a' }), requirement('a', { parentId: 'b' })],
    })
    expect(validateResearchMethod(cyclic).join('\n')).toMatch(/decomposition contains a cycle/)
    const recovered = normalizeResearchMethod(cyclic)
    expect(validateResearchMethod(recovered)).toEqual([])
    expect(recovered.normalizationIssues.join('\n')).toMatch(/cyclic requirement parent/)
    expect(recovered.requirements.find((row) => row.id === 'a')?.parentId).toBeUndefined()
    expect(normalizeResearchMethod(recovered)).toEqual(recovered)
  })

  it('rejects a self-parent instead of treating it as a basic requirement', () => {
    const self = method({ requirements: [requirement('r', { parentId: 'r' })] })
    expect(validateResearchMethod(self).join('\n')).toMatch(/cycle/)
    const repaired = normalizeResearchMethod(self)
    expect(repaired.requirements[0].parentId).toBeUndefined()
    expect(repaired.normalizationIssues.join('\n')).toMatch(/cyclic/)
  })

  it('recovers a dangling candidate interaction without leaving an invalid single-candidate relationship', () => {
    const broken = method({
      candidates: [candidate('a')],
      interactions: [interaction('i', { candidateIds: ['a', 'missing'] })],
    })
    expect(validateResearchMethod(broken).join('\n')).toMatch(/missing or invalid reference/)
    const repaired = normalizeResearchMethod(broken)
    expect(repaired.interactions).toEqual([])
    expect(repaired.normalizationIssues.join('\n')).toContain('i')
    expect(validateResearchMethod(repaired)).toEqual([])
  })

  it('bounds records at 300, exposes truncation, and keeps caller data intact', () => {
    const rows = Array.from({ length: RESEARCH_METHOD_LIMIT + 1 }, (_, i) => requirement(`r${i}`))
    const input = method({ requirements: rows })
    expect(RESEARCH_METHOD_LIMIT).toBe(300)
    expect(validateResearchMethod(input).join('\n')).toContain('at most 300 records')
    const recovered = normalizeResearchMethod(input)
    expect(recovered.requirements).toHaveLength(300)
    expect(recovered.requirements.at(-1)?.id).toBe('r299')
    expect(recovered.normalizationIssues.join('\n')).toMatch(/after 300.*omitted/)
    expect(input.requirements).toHaveLength(301)
    expect(input.normalizationIssues).toEqual([])
  })

  it('rejects an invalid upsert without mutating the existing research document', () => {
    const original = method({ requirements: [requirement('r')] })
    const snapshot = structuredClone(original)
    expect(() =>
      applyResearchMethodAction(original, {
        type: 'upsert',
        collection: 'requirements',
        record: requirement('child', { parentId: 'missing' }),
      }),
    ).toThrow(/parent/)
    expect(original).toEqual(snapshot)
  })

  it('updates an existing identity rather than inserting a duplicate', () => {
    const original = method({ requirements: [requirement('r')] })
    const updated = applyResearchMethodAction(original, {
      type: 'upsert',
      collection: 'requirements',
      record: requirement('r', { acceptance: 'A recorded trial completes below 10 ms.' }),
    })
    expect(updated.requirements).toHaveLength(1)
    expect(updated.requirements[0].acceptance).toContain('10 ms')
    expect(original.requirements[0].acceptance).toContain('20 ms')
  })

  it('removes deleted requirement links everywhere without reporting intentional deletion as corruption', () => {
    const original = method({
      requirements: [requirement('r'), requirement('child', { parentId: 'r' })],
      assumptions: [assumption('a', { requirementIds: ['r', 'child'] })],
      candidates: [candidate('c', { requirementIds: ['r', 'child'] })],
      validations: [
        validation('v', { requirementIds: ['r', 'child'], candidateIds: ['c'], evidenceIds: [] }),
      ],
      normalizationIssues: ['Previously recovered an unsupported version.'],
    })
    const updated = applyResearchMethodAction(original, {
      type: 'delete',
      collection: 'requirements',
      id: 'r',
    })
    expect(updated.requirements).toHaveLength(1)
    expect(updated.requirements[0].parentId).toBeUndefined()
    expect(updated.assumptions[0].requirementIds).toEqual(['child'])
    expect(updated.candidates[0].requirementIds).toEqual(['child'])
    expect(updated.validations[0].requirementIds).toEqual(['child'])
    expect(updated.normalizationIssues).toEqual(original.normalizationIssues)
    expect(validateResearchMethod(updated)).toEqual([])
    expect(original.requirements).toHaveLength(2)
  })

  it('removes deleted evidence from every scientific claim and validation', () => {
    const original = method({
      requirements: [requirement('r', { evidenceIds: ['e'] })],
      assumptions: [assumption('a', { evidenceIds: ['e'] })],
      evidence: [evidence('e')],
      candidates: [candidate('a', { requirementIds: ['r'], evidenceIds: ['e'] }), candidate('b')],
      interactions: [interaction('i', { kind: 'constructive', evidenceIds: ['e'] })],
      validations: [validation('v')],
    })
    const updated = applyResearchMethodAction(original, {
      type: 'delete',
      collection: 'evidence',
      id: 'e',
    })
    expect(updated.evidence).toEqual([])
    for (const collection of [
      'requirements',
      'assumptions',
      'candidates',
      'interactions',
      'validations',
    ] as const) {
      expect(updated[collection].every((row) => row.evidenceIds.length === 0)).toBe(true)
    }
    expect(analyzeResearchMethod(updated).verifiedRequirementIds).toEqual([])
    expect(updated.normalizationIssues).toEqual([])
  })

  it('deletes invalid candidate interactions and prunes surviving validation links', () => {
    const original = method({
      requirements: [requirement('r')],
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      interactions: [interaction('pair'), interaction('triple', { candidateIds: ['a', 'b', 'c'] })],
      validations: [validation('v', { candidateIds: ['a', 'b'], evidenceIds: [] })],
    })
    const updated = applyResearchMethodAction(original, {
      type: 'delete',
      collection: 'candidates',
      id: 'a',
    })
    expect(updated.interactions).toHaveLength(1)
    expect(updated.interactions[0]).toMatchObject({ id: 'triple', candidateIds: ['b', 'c'] })
    expect(updated.validations[0].candidateIds).toEqual(['b'])
    expect(validateResearchMethod(updated)).toEqual([])
  })
})

describe('research readiness and scientific verification', () => {
  it('measures leaf requirements independently from broad parent abstractions', () => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [
          requirement('goal', { statement: 'Build a fast service', atomic: false }),
          requirement('latency', { parentId: 'goal' }),
          requirement('correctness', { parentId: 'goal' }),
        ],
      }),
    )
    expect(analysis.leafRequirementIds).toEqual(['latency', 'correctness'])
    expect(analysis.readyRequirementIds).toEqual(['latency', 'correctness'])
    expect(analysis.uncoveredRequirementIds).toEqual(['latency', 'correctness'])
  })

  it('requires an observable acceptance criterion and an irreducibility rationale', () => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [
          requirement('ready'),
          requirement('vague', { acceptance: '  ' }),
          requirement('splittable', { atomic: false }),
          requirement('unexplained', { rationale: '' }),
        ],
      }),
    )
    expect(analysis.readyRequirementIds).toEqual(['ready'])
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'requirement',
          id: 'vague',
          message: expect.stringMatching(/observable acceptance/),
        }),
        expect.objectContaining({
          kind: 'requirement',
          id: 'splittable',
          message: expect.stringMatching(/irreducible/),
        }),
        expect.objectContaining({
          kind: 'requirement',
          id: 'unexplained',
          message: expect.stringMatching(/irreducible/),
        }),
      ]),
    )
  })

  it('does not ground a requirement merely because its assumption is labelled supported', () => {
    const original = method({
      requirements: [requirement('r', { assumptionIds: ['a'] })],
      assumptions: [assumption('a', { status: 'supported' })],
    })
    expect(analyzeResearchMethod(original).readyRequirementIds).toEqual([])
    expect(analyzeResearchMethod(original).unsupportedAssumptionIds).toEqual(['a'])
    const grounded = method({
      ...original,
      assumptions: [assumption('a', { status: 'supported', evidenceIds: ['e'] })],
      evidence: [evidence('e')],
    })
    expect(analyzeResearchMethod(grounded).readyRequirementIds).toEqual(['r'])
    expect(analyzeResearchMethod(grounded).unsupportedAssumptionIds).toEqual([])
  })

  it.each([
    ['unverified evidence', { reliability: 'unverified' as const }],
    ['no recorded observation', { content: ' ' }],
    ['no provenance', { source: '' }],
  ])('does not count %s as a supported premise', (_label, changes) => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [requirement('r', { assumptionIds: ['a'] })],
        assumptions: [assumption('a', { status: 'supported', evidenceIds: ['e'] })],
        evidence: [evidence('e', changes)],
      }),
    )
    expect(analysis.readyRequirementIds).toEqual([])
    expect(analysis.unsupportedAssumptionIds).toEqual(['a'])
  })

  it('treats an assumption linked from its requirementIds as a real readiness dependency', () => {
    const input = method({
      requirements: [requirement('r', { assumptionIds: [] })],
      assumptions: [assumption('clock', { requirementIds: ['r'] })],
      evidence: [evidence('support')],
    })
    expect(analyzeResearchMethod(input).readyRequirementIds).toEqual([])
    const labelledSupported = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'assumptions',
      record: { ...input.assumptions[0], status: 'supported' },
    })
    expect(analyzeResearchMethod(labelledSupported).readyRequirementIds).toEqual([])
    const grounded = applyResearchMethodAction(labelledSupported, {
      type: 'upsert',
      collection: 'assumptions',
      record: { ...labelledSupported.assumptions[0], evidenceIds: ['support'] },
    })
    expect(analyzeResearchMethod(grounded).readyRequirementIds).toEqual(['r'])
    const refuted = applyResearchMethodAction(grounded, {
      type: 'upsert',
      collection: 'assumptions',
      record: { ...grounded.assumptions[0], status: 'refuted' },
    })
    expect(analyzeResearchMethod(refuted).readyRequirementIds).toEqual([])
    expect(refuted.requirements[0].assumptionIds).toEqual([])
    expect(input.assumptions[0].status).toBe('unverified')
  })

  it('keeps refuted assumptions visible even when they have reproduced evidence', () => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [requirement('r', { assumptionIds: ['a'] })],
        assumptions: [assumption('a', { status: 'refuted', evidenceIds: ['e'] })],
        evidence: [evidence('e')],
      }),
    )
    expect(analysis.readyRequirementIds).toEqual([])
    expect(analysis.refutedAssumptionIds).toEqual(['a'])
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assumption',
          id: 'a',
          message: expect.stringMatching(/refuted/),
        }),
      ]),
    )
  })

  it('does not treat manually marked verified requirements as measured success', () => {
    const analysis = analyzeResearchMethod(
      method({ requirements: [requirement('r', { status: 'verified' })] }),
    )
    expect(analysis.verifiedRequirementIds).toEqual([])
    expect(analysis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'r',
          message: expect.stringMatching(/without a passing, evidenced verification/),
        }),
      ]),
    )
  })

  it('recognizes a recorded pass only with procedure, expected result, actual result and sourced evidence', () => {
    const complete = method({
      requirements: [requirement('r')],
      evidence: [evidence('e')],
      validations: [validation('v')],
    })
    expect(analyzeResearchMethod(complete).verifiedRequirementIds).toEqual(['r'])
  })

  it.each([
    ['no procedure', { procedure: '' }],
    ['no prediction', { expected: '' }],
    ['no observed result', { actual: ' ' }],
    ['no evidence', { evidenceIds: [] }],
    ['a pending experiment', { outcome: 'pending' as const }],
    ['a failed experiment', { outcome: 'fail' as const }],
    ['an inconclusive experiment', { outcome: 'inconclusive' as const }],
  ])('does not report %s as verification', (_label, changes) => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [requirement('r')],
        evidence: [evidence('e')],
        validations: [validation('v', changes)],
      }),
    )
    expect(analysis.verifiedRequirementIds).toEqual([])
  })

  it('treats candidate coverage as a proposed mechanism, not proof that a requirement is satisfied', () => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [requirement('r')],
        candidates: [candidate('a', { requirementIds: ['r'], status: 'selected' })],
      }),
    )
    expect(analysis.coveredRequirementIds).toEqual(['r'])
    expect(analysis.uncoveredRequirementIds).toEqual([])
    expect(analysis.verifiedRequirementIds).toEqual([])
  })

  it('ignores rejected candidate coverage and preserves unsolved blockers', () => {
    const analysis = analyzeResearchMethod(
      method({
        requirements: [requirement('r')],
        candidates: [candidate('a', { requirementIds: ['r'], status: 'rejected' })],
      }),
      [
        { id: 'open', title: 'Clock precision', status: 'open' },
        { id: 'blocked', title: 'No measurement hardware', status: 'blocked' },
        { id: 'solved', title: 'Fixture selection', status: 'solved' },
      ],
    )
    expect(analysis.coveredRequirementIds).toEqual([])
    expect(analysis.uncoveredRequirementIds).toEqual(['r'])
    expect(analysis.unresolvedProblemIds).toEqual(['open', 'blocked'])
  })
})

describe('constructive interference hypotheses and research graph', () => {
  it('offers partial coverage bundles but never combines a recorded conflicting pair', () => {
    const bundles = researchSolutionBundles(
      method({
        requirements: [requirement('latency'), requirement('memory')],
        candidates: [
          candidate('a', { requirementIds: ['latency'] }),
          candidate('b', { requirementIds: ['memory'] }),
          candidate('c', { requirementIds: ['memory'], status: 'rejected' }),
        ],
        interactions: [
          interaction('conflict', {
            kind: 'conflicting',
            mechanism: 'The mechanisms require exclusive access to the same finite resource.',
          }),
        ],
      }),
      20,
    )
    expect(bundles).toHaveLength(2)
    expect(
      bundles.every(
        (bundle) => !(bundle.candidateIds.includes('a') && bundle.candidateIds.includes('b')),
      ),
    ).toBe(true)
    expect(bundles.every((bundle) => !bundle.candidateIds.includes('c'))).toBe(true)
    expect(bundles.every((bundle) => bundle.uncoveredRequirementIds.length === 1)).toBe(true)
  })

  it('surfaces untested pairs even when their union covers every requirement', () => {
    const bundles = researchSolutionBundles(
      method({
        requirements: [requirement('latency'), requirement('memory')],
        candidates: [
          candidate('a', { requirementIds: ['latency'] }),
          candidate('b', { requirementIds: ['memory'] }),
        ],
      }),
    )
    const joint = bundles.find((bundle) => bundle.candidateIds.length === 2)
    expect(joint).toMatchObject({
      coveredRequirementIds: ['latency', 'memory'],
      uncoveredRequirementIds: [],
      constructiveInteractionIds: [],
      untestedCandidatePairs: [['a', 'b']],
    })
  })

  it('does not promote an evidence-free constructive claim into a grounded benefit', () => {
    const ungrounded = method({
      requirements: [requirement('r')],
      candidates: [
        candidate('a', { requirementIds: ['r'] }),
        candidate('b', { requirementIds: ['r'] }),
      ],
      interactions: [
        interaction('synergy', {
          kind: 'constructive',
          mechanism: 'The combined process may reuse measurements.',
        }),
      ],
    })
    const joint = researchSolutionBundles(ungrounded).find(
      (bundle) => bundle.candidateIds.length === 2,
    )
    expect(joint?.constructiveInteractionIds).toEqual([])
    expect(joint?.untestedCandidatePairs).toEqual([['a', 'b']])
    expect(analyzeResearchMethod(ungrounded).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'synergy',
          message: expect.stringMatching(/grounded mechanism or experiment/),
        }),
      ]),
    )
  })

  it('recognizes a constructive interaction with an explicit mechanism and sourced evidence', () => {
    const grounded = method({
      requirements: [requirement('r')],
      candidates: [
        candidate('a', { requirementIds: ['r'] }),
        candidate('b', { requirementIds: ['r'] }),
      ],
      evidence: [evidence('e')],
      interactions: [
        interaction('synergy', {
          kind: 'constructive',
          mechanism: 'Shared clock setup removes one measured initialization delay.',
          evidenceIds: ['e'],
        }),
      ],
    })
    const joint = researchSolutionBundles(grounded).find(
      (bundle) => bundle.candidateIds.length === 2,
    )
    expect(joint?.constructiveInteractionIds).toEqual(['synergy'])
    expect(joint?.untestedCandidatePairs).toEqual([])
    expect(analyzeResearchMethod(grounded).verifiedRequirementIds).toEqual([])
  })

  it('bounds bundle enumeration and returns deterministic candidate ordering', () => {
    const input = method({
      requirements: [requirement('r')],
      candidates: Array.from({ length: 15 }, (_, index) =>
        candidate(`c${String(index).padStart(2, '0')}`, { requirementIds: ['r'] }),
      ),
    })
    expect(researchSolutionBundles(input, 1)).toHaveLength(1)
    expect(researchSolutionBundles(input, 0)).toEqual([])
    expect(researchSolutionBundles(input, 100)).toHaveLength(20)
    expect(researchSolutionBundles(input)).toEqual(
      researchSolutionBundles({ ...input, candidates: [...input.candidates].reverse() }),
    )
    expect(
      researchSolutionBundles(input, 20).every((bundle) =>
        bundle.candidateIds.every((id) => !['c12', 'c13', 'c14'].includes(id)),
      ),
    ).toBe(true)
  })

  it('keeps the supported maximum research graph responsive while ranking fully covered bundles', () => {
    const requirements = Array.from({ length: RESEARCH_METHOD_LIMIT }, (_, index) =>
      requirement(`requirement-${index}`),
    )
    const requirementIds = requirements.map((row) => row.id)
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`candidate-${String(index).padStart(2, '0')}`, { requirementIds }),
    )
    const pairs: [string, string][] = []
    for (let first = 0; first < candidates.length; first++) {
      for (let second = first + 1; second < candidates.length; second++) {
        pairs.push([candidates[first].id, candidates[second].id])
      }
    }
    const input = method({
      requirements,
      candidates,
      evidence: [evidence('observed-interactions')],
      interactions: Array.from({ length: RESEARCH_METHOD_LIMIT }, (_, index) =>
        interaction(`measured-interaction-${index}`, {
          candidateIds: pairs[index % pairs.length],
          kind: 'constructive',
          mechanism: 'The jointly measured mechanisms share setup without resource contention.',
          evidenceIds: ['observed-interactions'],
        }),
      ),
    })
    expect(validateResearchMethod(input)).toEqual([])

    const started = performance.now()
    const bundles = researchSolutionBundles(input, 6)
    const elapsedMs = performance.now() - started

    expect(bundles).toHaveLength(6)
    expect(bundles.every((bundle) => bundle.coveredRequirementIds.length === 300)).toBe(true)
    expect(bundles.every((bundle) => bundle.uncoveredRequirementIds.length === 0)).toBe(true)
    expect(bundles.every((bundle) => bundle.untestedCandidatePairs.length === 0)).toBe(true)
    expect(bundles[0].candidateIds).toEqual(candidates.map((row) => row.id))
    expect(bundles[0].constructiveInteractionIds).toHaveLength(300)
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('applies the twelve-candidate search bound after excluding rejected mechanisms', () => {
    const input = method({
      requirements: [requirement('r')],
      candidates: [
        ...Array.from({ length: 5 }, (_, index) =>
          candidate(`a-rejected-${index}`, { status: 'rejected', requirementIds: ['r'] }),
        ),
        ...Array.from({ length: 13 }, (_, index) =>
          candidate(`b-viable-${String(index).padStart(2, '0')}`, { requirementIds: ['r'] }),
        ),
      ],
    })
    const bundles = researchSolutionBundles(input, 20)
    const searchedIds = new Set(bundles.flatMap((bundle) => bundle.candidateIds))
    expect(searchedIds).toEqual(
      new Set(
        Array.from({ length: 12 }, (_, index) => `b-viable-${String(index).padStart(2, '0')}`),
      ),
    )
    expect(bundles.every((bundle) => bundle.coveredRequirementIds.length === 1)).toBe(true)
  })

  it('separates identical IDs across collections and links only actual graph nodes', () => {
    const input = method({
      requirements: [
        requirement('shared'),
        requirement('child', { parentId: 'shared', assumptionIds: ['shared'] }),
      ],
      assumptions: [assumption('shared', { requirementIds: ['shared'], evidenceIds: ['shared'] })],
      evidence: [evidence('shared')],
      candidates: [
        candidate('shared', {
          requirementIds: ['child'],
          assumptionIds: ['shared'],
          evidenceIds: ['shared'],
        }),
      ],
      validations: [
        validation('shared', {
          requirementIds: ['child'],
          candidateIds: ['shared'],
          evidenceIds: ['shared'],
        }),
      ],
    })
    const graph = buildResearchMethodGraph(input)
    const ids = new Set(graph.nodes.map((node) => node.id))
    expect(ids.size).toBe(graph.nodes.length)
    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
    expect(graph.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(['decomposes', 'depends-on', 'supports', 'addresses', 'tests']),
    )
    expect(
      buildResearchMethodGraph({ ...input, requirements: [...input.requirements].reverse() }),
    ).toEqual(graph)
  })

  it('includes assumption prerequisites and the evidence behind candidate interactions', () => {
    const input = method({
      requirements: [requirement('r')],
      assumptions: [assumption('a', { requirementIds: ['r'] })],
      evidence: [evidence('e')],
      candidates: [candidate('a'), candidate('b')],
      interactions: [interaction('i', { evidenceIds: ['e'] })],
    })
    expect(buildResearchMethodGraph(input).edges).toEqual(
      expect.arrayContaining([
        { from: 'requirements:r', to: 'assumptions:a', kind: 'depends-on' },
        { from: 'evidence:e', to: 'interactions:i', kind: 'supports' },
      ]),
    )
  })

  it('bounds a dense maximum-size graph without hiding the number of omitted relationships', () => {
    const ids = (prefix: string) =>
      Array.from({ length: RESEARCH_METHOD_LIMIT }, (_, index) => `${prefix}${index}`)
    const requirementIds = ids('r')
    const assumptionIds = ids('a')
    const evidenceIds = ids('e')
    const candidateIds = ids('c')
    const input = method({
      requirements: requirementIds.map((id) => requirement(id, { assumptionIds, evidenceIds })),
      assumptions: assumptionIds.map((id) => assumption(id, { requirementIds, evidenceIds })),
      evidence: evidenceIds.map((id) => evidence(id)),
      candidates: candidateIds.map((id) =>
        candidate(id, {
          requirementIds,
          constituentIds: requirementIds,
          assumptionIds,
          evidenceIds,
        }),
      ),
      interactions: ids('i').map((id) => interaction(id, { candidateIds, evidenceIds })),
      validations: ids('v').map((id) =>
        validation(id, { requirementIds, candidateIds, evidenceIds }),
      ),
      inquiries: ids('q').map((id) => inquiry(id, { requirementIds, candidateIds, evidenceIds })),
    })
    const selectedIds = new Set<string>()
    const prefixes = {
      requirements: 'r',
      assumptions: 'a',
      evidence: 'e',
      candidates: 'c',
      interactions: 'i',
      validations: 'v',
      inquiries: 'q',
    }
    for (const [collection, prefix] of Object.entries(prefixes)) {
      for (let index = 0; index < 20; index++) selectedIds.add(`${collection}:${prefix}${index}`)
    }

    const started = performance.now()
    const graph = buildResearchMethodGraph(input, { nodeIds: selectedIds, maxEdges: 1500 })
    const elapsedMs = performance.now() - started

    expect(graph.nodes).toHaveLength(140)
    expect(new Set(graph.nodes.map((node) => node.id))).toEqual(selectedIds)
    expect(graph.edges).toHaveLength(1500)
    expect(
      graph.edges.every((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to)),
    ).toBe(true)
    // The selected scope has 16 kinds of declared links, each joining 20 source and target records.
    expect(graph.totalRelationshipCount).toBe(16 * 20 * 20)
    expect(graph.omittedRelationshipCount).toBe(16 * 20 * 20 - 1500)
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('reports exact scoped counts even when the rendering limit admits no edges', () => {
    const input = method({
      requirements: [requirement('r')],
      candidates: [
        candidate('c', { requirementIds: ['r'] }),
        candidate('excluded', { requirementIds: ['r'] }),
      ],
    })
    const selectedIds = new Set(['requirements:r', 'candidates:c'])
    const graph = buildResearchMethodGraph(input, { nodeIds: selectedIds, maxEdges: 0 })
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([...selectedIds].sort())
    expect(graph.edges).toEqual([])
    expect(graph.totalRelationshipCount).toBe(1)
    expect(graph.omittedRelationshipCount).toBe(1)
    const allAdmitted = buildResearchMethodGraph(input, { nodeIds: selectedIds, maxEdges: 1500 })
    expect(allAdmitted.edges).toEqual([
      { from: 'candidates:c', to: 'requirements:r', kind: 'addresses' },
    ])
    expect(allAdmitted.totalRelationshipCount).toBe(1)
    expect(allAdmitted.omittedRelationshipCount).toBe(0)
  })
})

describe('abstraction assemblies and exploratory inquiries', () => {
  it('preserves a composite mechanism and its proposed emergence without calling it verified', () => {
    const input = method({
      requirements: [requirement('r'), requirement('part', { parentId: 'r', kind: 'component' })],
      candidates: [
        candidate('primitive', { requirementIds: ['part'] }),
        candidate('assembly', {
          requirementIds: ['part'],
          constituentIds: ['part'],
          componentCandidateIds: ['primitive'],
          emergence: 'The shared initialization may lower total latency beyond individual parts.',
        }),
      ],
    })
    expect(validateResearchMethod(input)).toEqual([])
    const recovered = normalizeResearchMethod(input)
    expect(recovered.candidates[1]).toMatchObject({
      constituentIds: ['part'],
      componentCandidateIds: ['primitive'],
      emergence: expect.stringContaining('may lower'),
    })
    expect(analyzeResearchMethod(recovered).verifiedRequirementIds).toEqual([])
    const graph = buildResearchMethodGraph(input)
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: 'candidates:primitive', to: 'candidates:assembly', kind: 'composes' },
        { from: 'requirements:part', to: 'candidates:assembly', kind: 'composes' },
      ]),
    )
  })

  it('rejects candidate composition cycles and visibly recovers an acyclic assembly', () => {
    const broken = method({
      candidates: [
        candidate('a', { componentCandidateIds: ['b'] }),
        candidate('b', { componentCandidateIds: ['a'] }),
      ],
    })
    expect(validateResearchMethod(broken).join('\n')).toMatch(/composition contains a cycle/)
    const repaired = normalizeResearchMethod(broken)
    expect(validateResearchMethod(repaired)).toEqual([])
    expect(repaired.normalizationIssues.join('\n')).toMatch(/cyclic composite candidate/)
    expect(normalizeResearchMethod(repaired)).toEqual(repaired)
  })

  it('rejects a candidate containing itself and missing primitive constituents', () => {
    const broken = method({
      candidates: [
        candidate('a', {
          componentCandidateIds: ['a', 'missing-candidate'],
          constituentIds: ['missing-component'],
        }),
      ],
    })
    expect(validateResearchMethod(broken)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/composition contains a cycle/),
        expect.stringMatching(/missing or invalid reference/),
      ]),
    )
    const repaired = normalizeResearchMethod(broken)
    expect(repaired.candidates[0].componentCandidateIds).toEqual([])
    expect(repaired.candidates[0].constituentIds).toEqual([])
    expect(repaired.normalizationIssues.join('\n')).toContain('missing-component')
    expect(validateResearchMethod(repaired)).toEqual([])
  })

  it('deletes assembly constituents and inquiry references without deleting surviving research', () => {
    const original = method({
      requirements: [requirement('r')],
      evidence: [evidence('e')],
      candidates: [
        candidate('a'),
        candidate('assembly', { componentCandidateIds: ['a'], constituentIds: ['r'] }),
      ],
      inquiries: [inquiry('q', { requirementIds: ['r'], candidateIds: ['a'], evidenceIds: ['e'] })],
    })
    const noPrimitive = applyResearchMethodAction(original, {
      type: 'delete',
      collection: 'candidates',
      id: 'a',
    })
    expect(noPrimitive.candidates[0].componentCandidateIds).toEqual([])
    expect(noPrimitive.inquiries[0].candidateIds).toEqual([])
    const noConstituent = applyResearchMethodAction(noPrimitive, {
      type: 'delete',
      collection: 'requirements',
      id: 'r',
    })
    expect(noConstituent.candidates[0].constituentIds).toEqual([])
    expect(noConstituent.inquiries[0].requirementIds).toEqual([])
    const noEvidence = applyResearchMethodAction(noConstituent, {
      type: 'delete',
      collection: 'evidence',
      id: 'e',
    })
    expect(noEvidence.inquiries[0].evidenceIds).toEqual([])
    expect(noEvidence.inquiries[0].question).toBe(original.inquiries[0].question)
    expect(noEvidence.normalizationIssues).toEqual([])
    expect(validateResearchMethod(noEvidence)).toEqual([])
  })

  it('stores inquiries for different operators with their original premise and intervention', () => {
    const queries = researchOperations.map((operation, index) =>
      inquiry(`q${index}`, { operation }),
    )
    const input = method({ inquiries: queries })
    expect(validateResearchMethod(input)).toEqual([])
    const recovered = normalizeResearchMethod(input)
    expect(recovered.inquiries.map((row) => row.operation)).toEqual(researchOperations)
    expect(recovered.inquiries[0].premise).toBe(queries[0].premise)
    expect(recovered.inquiries[0].intervention).toBe(queries[0].intervention)
    expect(recovered.inquiries.every((row) => row.result === '' && row.status === 'proposed')).toBe(
      true,
    )
  })

  it('requires observed evidence before accepting a tested inquiry label', () => {
    const untested = method({
      inquiries: [inquiry('q', { status: 'tested', result: 'Latency decreased.' })],
    })
    expect(analyzeResearchMethod(untested).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'inquiry',
          id: 'q',
          message: expect.stringMatching(/reproduced evidence/),
        }),
      ]),
    )
    const tested = method({
      evidence: [evidence('e')],
      inquiries: [
        inquiry('q', {
          status: 'tested',
          result: 'Three measured trials were below the acceptance threshold.',
          evidenceIds: ['e'],
        }),
      ],
    })
    expect(
      analyzeResearchMethod(tested).findings.filter((finding) => finding.kind === 'inquiry'),
    ).toEqual([])
    expect(analyzeResearchMethod(tested).verifiedRequirementIds).toEqual([])
  })

  it.each([
    ['missing intervention', { intervention: '' }],
    ['missing prediction', { prediction: '' }],
    ['missing observed outcome', { result: ' ' }],
  ])('does not accept a tested inquiry with %s', (_label, changes) => {
    const input = method({
      evidence: [evidence('e')],
      inquiries: [
        inquiry('q', {
          status: 'tested',
          result: 'Measured latency decreased.',
          evidenceIds: ['e'],
          ...changes,
        }),
      ],
    })
    expect(analyzeResearchMethod(input).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'inquiry', id: 'q' })]),
    )
  })

  it('bounds inquiries at the same 300-record limit as requirements', () => {
    const input = method({
      inquiries: Array.from({ length: 301 }, (_, index) => inquiry(`q${index}`)),
    })
    expect(validateResearchMethod(input).join('\n')).toContain(
      'inquiries must contain at most 300 records',
    )
    const recovered = normalizeResearchMethod(input)
    expect(recovered.inquiries).toHaveLength(300)
    expect(recovered.normalizationIssues.join('\n')).toContain('inquiries: records after 300')
  })
})

describe('verification freshness after research edits', () => {
  const recordedPass = () =>
    applyResearchMethodAction(
      method({
        requirements: [requirement('r')],
        evidence: [evidence('e')],
        candidates: [candidate('a', { requirementIds: ['r'] })],
      }),
      {
        type: 'upsert',
        collection: 'validations',
        record: validation('v', { candidateIds: ['a'] }),
      },
    )

  it('captures linked content when a passing validation is recorded', () => {
    const input = recordedPass()
    expect(input.validations[0].testedFingerprint).toMatch(/^v1-[0-9a-f]+$/)
    expect(analyzeResearchMethod(input).verifiedRequirementIds).toEqual(['r'])
    expect(normalizeResearchMethod(JSON.parse(JSON.stringify(input)))).toEqual(input)
  })

  it('reviews 300 dense stale passing validations responsively without awarding verification', () => {
    const requirements = Array.from({ length: RESEARCH_METHOD_LIMIT }, (_, index) =>
      requirement(`r${index}`),
    )
    const requirementIds = requirements.map((row) => row.id)
    const input = method({
      requirements,
      evidence: [evidence('e')],
      validations: Array.from({ length: RESEARCH_METHOD_LIMIT }, (_, index) =>
        validation(`v${index}`, {
          requirementIds,
          evidenceIds: ['e'],
          testedFingerprint: 'v1-recorded-before-the-linked-content-changed',
        }),
      ),
    })

    const started = performance.now()
    const analysis = analyzeResearchMethod(input)
    const elapsedMs = performance.now() - started

    expect(analysis.leafRequirementIds).toHaveLength(300)
    expect(analysis.verifiedRequirementIds).toEqual([])
    const staleFindings = analysis.findings.filter((finding) => finding.kind === 'validation')
    expect(staleFindings).toHaveLength(300)
    expect(
      staleFindings.every((finding) => /changed after.*repeat verification/.test(finding.message)),
    ).toBe(true)
    expect(new Set(staleFindings.map((finding) => finding.id))).toEqual(
      new Set(input.validations.map((row) => row.id)),
    )
    expect(elapsedMs).toBeLessThan(1000)
  })

  it.each([
    [
      'acceptance',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'requirements',
          record: { ...input.requirements[0], acceptance: 'Every trial must complete below 5 ms.' },
        }),
    ],
    [
      'mechanism',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'candidates',
          record: {
            ...input.candidates[0],
            mechanism: 'Run requests serially through a new queue.',
          },
        }),
    ],
    [
      'observations',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'evidence',
          record: { ...input.evidence[0], content: 'A corrected trial takes 35 ms.' },
        }),
    ],
  ])('requires repeat verification when linked %s changes', (_label, update) => {
    const before = recordedPass()
    const edited = update(before)
    expect(edited.validations[0].testedFingerprint).toBe(before.validations[0].testedFingerprint)
    expect(analyzeResearchMethod(edited).verifiedRequirementIds).toEqual([])
    expect(analyzeResearchMethod(edited).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'validation',
          id: 'v',
          message: expect.stringMatching(/changed after.*repeat verification/),
        }),
      ]),
    )
  })

  it('keeps a fingerprint current across status labels, timestamps, unrelated records and record ordering', () => {
    const before = recordedPass()
    const edited = method({
      ...before,
      requirements: [
        requirement('unrelated'),
        { ...before.requirements[0], status: 'verified', updatedAt: 900 },
      ],
      candidates: [{ ...before.candidates[0], status: 'selected', updatedAt: 1000 }],
      evidence: [evidence('unrelated-e'), before.evidence[0]],
    })
    expect(analyzeResearchMethod(edited).verifiedRequirementIds).toEqual(['r'])
  })

  const recordedCompositePass = () =>
    applyResearchMethodAction(
      method({
        requirements: [
          requirement('goal', {
            statement: 'Provide reproducible low-latency responses.',
            atomic: false,
          }),
          requirement('r', { parentId: 'goal', assumptionIds: ['clock'] }),
          requirement('part', { kind: 'component' }),
        ],
        assumptions: [assumption('clock', { status: 'supported', evidenceIds: ['support'] })],
        evidence: [evidence('e'), evidence('support')],
        candidates: [
          candidate('primitive', { constituentIds: ['part'] }),
          candidate('assembly', { requirementIds: ['r'], componentCandidateIds: ['primitive'] }),
        ],
      }),
      {
        type: 'upsert',
        collection: 'validations',
        record: validation('v', { candidateIds: ['assembly'] }),
      },
    )

  it.each([
    [
      'a constituent mechanism',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'candidates',
          record: {
            ...input.candidates[0],
            mechanism: 'Replace concurrent workers with a serial queue.',
          },
        }),
    ],
    [
      'a basic constituent requirement',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'requirements',
          record: { ...input.requirements[2], acceptance: 'Use no more than one worker.' },
        }),
    ],
    [
      'a prerequisite parent',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'requirements',
          record: {
            ...input.requirements[0],
            statement: 'Provide reproducible responses without shared state.',
          },
        }),
    ],
    [
      'an underlying assumption',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'assumptions',
          record: { ...input.assumptions[0], claim: 'The clock jumps backward under load.' },
        }),
    ],
    [
      'a refuted assumption state',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'assumptions',
          record: { ...input.assumptions[0], status: 'refuted' },
        }),
    ],
    [
      'supporting evidence outside the direct validation',
      (input: ResearchMethod) =>
        applyResearchMethodAction(input, {
          type: 'upsert',
          collection: 'evidence',
          record: {
            ...input.evidence[1],
            content: 'The timing source was observed moving backward.',
          },
        }),
    ],
  ])('invalidates composite verification after changing %s', (_label, update) => {
    const input = recordedCompositePass()
    expect(analyzeResearchMethod(input).verifiedRequirementIds).toEqual(['r'])
    const edited = update(input)
    expect(analyzeResearchMethod(edited).verifiedRequirementIds).toEqual([])
    expect(analyzeResearchMethod(edited).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'validation',
          id: 'v',
          message: expect.stringMatching(/repeat verification/),
        }),
      ]),
    )
  })

  it('invalidates proof when an inverse-linked assumption or its supporting evidence changes', () => {
    const input = applyResearchMethodAction(
      method({
        requirements: [requirement('r', { assumptionIds: [] })],
        assumptions: [
          assumption('clock', {
            requirementIds: ['r'],
            status: 'supported',
            evidenceIds: ['support'],
          }),
        ],
        evidence: [evidence('e'), evidence('support')],
      }),
      { type: 'upsert', collection: 'validations', record: validation('v') },
    )
    expect(analyzeResearchMethod(input).verifiedRequirementIds).toEqual(['r'])
    const changedClaim = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'assumptions',
      record: {
        ...input.assumptions[0],
        claim: 'The timing source has a different resolution than assumed.',
      },
    })
    const refuted = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'assumptions',
      record: { ...input.assumptions[0], status: 'refuted' },
    })
    const changedSupport = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'evidence',
      record: {
        ...input.evidence[1],
        content: 'The timing source moves backward under the measured workload.',
      },
    })
    for (const changed of [changedClaim, refuted, changedSupport]) {
      expect(changed.validations[0].testedFingerprint).toBe(input.validations[0].testedFingerprint)
      expect(analyzeResearchMethod(changed).verifiedRequirementIds).toEqual([])
      expect(analyzeResearchMethod(changed).findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'validation',
            id: 'v',
            message: expect.stringMatching(/repeat verification/),
          }),
        ]),
      )
    }
    expect(input.requirements[0].assumptionIds).toEqual([])
  })

  it('does not refresh a stale pass when only the validation title is edited', () => {
    const input = recordedPass()
    const changed = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'requirements',
      record: { ...input.requirements[0], acceptance: 'Each response completes within 5 ms.' },
    })
    const retitled = applyResearchMethodAction(changed, {
      type: 'upsert',
      collection: 'validations',
      record: { ...changed.validations[0], title: 'Renamed latency measurement', updatedAt: 500 },
    })
    expect(retitled.validations[0].testedFingerprint).toBe(input.validations[0].testedFingerprint)
    expect(retitled.validations[0].testedAt).toBe(input.validations[0].testedAt)
    expect(analyzeResearchMethod(retitled).verifiedRequirementIds).toEqual([])
  })

  it('does not reinterpret an unchanged observation when only the expected result is edited', () => {
    const input = recordedPass()
    const changed = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'requirements',
      record: { ...input.requirements[0], acceptance: 'Each response completes within 5 ms.' },
    })
    const reinterpreted = applyResearchMethodAction(changed, {
      type: 'upsert',
      collection: 'validations',
      record: {
        ...changed.validations[0],
        expected: 'Each response completes within 5 ms.',
        updatedAt: 500,
      },
    })
    expect(reinterpreted.validations[0].testedFingerprint).toBe(
      input.validations[0].testedFingerprint,
    )
    expect(analyzeResearchMethod(reinterpreted).verifiedRequirementIds).toEqual([])
  })

  it('does not treat reordering identical evidence links as a fresh observation', () => {
    const base = method({
      requirements: [requirement('r')],
      evidence: [evidence('e'), evidence('e2')],
    })
    const input = applyResearchMethodAction(base, {
      type: 'upsert',
      collection: 'validations',
      record: validation('v', { evidenceIds: ['e', 'e2'] }),
    })
    const changed = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'requirements',
      record: {
        ...input.requirements[0],
        acceptance: 'A different acceptance bound must now hold.',
      },
    })
    const reordered = applyResearchMethodAction(changed, {
      type: 'upsert',
      collection: 'validations',
      record: { ...changed.validations[0], evidenceIds: ['e2', 'e'], updatedAt: 700 },
    })
    expect(reordered.validations[0].testedFingerprint).toBe(input.validations[0].testedFingerprint)
    expect(analyzeResearchMethod(reordered).verifiedRequirementIds).toEqual([])
  })

  it('preserves a legacy observation time when an old passing record is retitled', () => {
    const legacy = method({
      requirements: [requirement('r', { updatedAt: 200 })],
      evidence: [evidence('e')],
      validations: [validation('v')],
    })
    expect(analyzeResearchMethod(legacy).verifiedRequirementIds).toEqual([])
    const retitled = applyResearchMethodAction(legacy, {
      type: 'upsert',
      collection: 'validations',
      record: { ...legacy.validations[0], title: 'Title edited later', updatedAt: 900 },
    })
    expect(retitled.validations[0].testedFingerprint).toBeUndefined()
    expect(retitled.validations[0].testedAt).toBe(100)
    expect(analyzeResearchMethod(retitled).verifiedRequirementIds).toEqual([])
  })

  it('records fresh proof when the observation is actually replaced', () => {
    const input = recordedPass()
    const changed = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'requirements',
      record: { ...input.requirements[0], acceptance: 'Each response completes within 5 ms.' },
    })
    const retested = applyResearchMethodAction(changed, {
      type: 'upsert',
      collection: 'validations',
      record: {
        ...changed.validations[0],
        actual: 'A new three-trial run measured 3, 4 and 4 ms.',
        updatedAt: 900,
      },
    })
    expect(retested.validations[0].testedFingerprint).not.toBe(
      input.validations[0].testedFingerprint,
    )
    expect(retested.validations[0].testedAt).toBe(900)
    expect(analyzeResearchMethod(retested).verifiedRequirementIds).toEqual(['r'])
  })

  it('allows an explicitly pending-then-passing retest to record the same observed values again', () => {
    const input = recordedPass()
    const changed = applyResearchMethodAction(input, {
      type: 'upsert',
      collection: 'requirements',
      record: { ...input.requirements[0], acceptance: 'Each trial must complete within 18 ms.' },
    })
    const pending = applyResearchMethodAction(changed, {
      type: 'upsert',
      collection: 'validations',
      record: { ...changed.validations[0], outcome: 'pending', updatedAt: 800 },
    })
    expect(analyzeResearchMethod(pending).verifiedRequirementIds).toEqual([])
    const passed = applyResearchMethodAction(pending, {
      type: 'upsert',
      collection: 'validations',
      record: { ...pending.validations[0], outcome: 'pass', updatedAt: 900 },
    })
    expect(passed.validations[0].testedFingerprint).not.toBe(input.validations[0].testedFingerprint)
    expect(analyzeResearchMethod(passed).verifiedRequirementIds).toEqual(['r'])
  })
  it('uses timestamps conservatively for old validation records without a fingerprint', () => {
    const legacy = method({
      requirements: [requirement('r')],
      evidence: [evidence('e')],
      validations: [validation('v')],
    })
    expect(analyzeResearchMethod(legacy).verifiedRequirementIds).toEqual(['r'])
    const changed = method({ ...legacy, requirements: [requirement('r', { updatedAt: 101 })] })
    expect(analyzeResearchMethod(changed).verifiedRequirementIds).toEqual([])
  })

  it.each([
    ['a reported citation', { kind: 'source' as const, reliability: 'reported' as const }],
    ['a reproduced citation without an observed experiment', { kind: 'source' as const }],
    ['a reported experiment', { reliability: 'reported' as const }],
    ['a recorded constraint', { kind: 'constraint' as const }],
  ])('does not count %s as observed verification evidence', (_label, changes) => {
    const input = method({
      requirements: [requirement('r')],
      evidence: [evidence('e', changes)],
      validations: [validation('v')],
    })
    expect(analyzeResearchMethod(input).verifiedRequirementIds).toEqual([])
  })
})
