# Anti-abstraction, abstraction, and research methods

Life Research follows one traceable question: **what must be true for this goal to succeed, and what evidence shows that the proposed solution makes it true?** A goal contains structured work, linked conversations, and machine-backed files. It is more than a collection of agent chats.

Life uses the researcher's requested definitions: **anti-abstraction** breaks a whole into its constituents, while **abstraction** composes constituents into a higher-order whole. Breaking an atom into electrons, protons, and neutrons illustrates anti-abstraction; composing those constituents into an atom illustrates abstraction. In goal research, anti-abstraction decomposes the intended outcome into basic requirements, and abstraction assembles contributions into a candidate solution.

**Grounding** is a separate step that connects requirements and explanations to concrete constraints, observations, counterexamples, and experiments. **Constructive interference** examines contributions that may help each other, records why their combination could work, and tests the combined effect. These are working research terms; Life does not claim a new scientific law or assign an invented synergy score.

## Work from a goal to a verified result

1. Write the goal and its success criteria. Record its scope, relevant constraints, and what would count as failure.
2. Use anti-abstraction to decompose the goal into a requirement tree. Give each leaf an acceptance criterion: an observable condition or a reproducible test. Decompose again when a requirement still combines independent outcomes.
3. Ground the leaves. Separate assumptions from evidence, link sources or observations, record counterexamples, and name constraints that a solution must respect.
4. Record problems preventing progress. Link each blocker to the requirements it obstructs and keep its investigation conversation attached to the problem.
5. Explore candidate solutions. State each candidate's mechanism, the requirements it could satisfy, the assumptions it depends on, and the tradeoffs it creates.
6. Use abstraction to compose a candidate from contributions. Compare their interactions and mark pairs as complementary, conflicting, redundant, or untested. Explain the proposed constructive interference and tradeoffs, then verify the combination.
7. Design and run verification. Record the procedure, expected result, observed result, evidence, and outcome. A failed or inconclusive result becomes useful research material rather than disappearing from the goal.
8. Review the trace. Resolve uncovered requirements and unsupported assumptions, revisit failed tests, and describe the evidence supporting a final decision.

The process is iterative. A counterexample can change a requirement, a test can invalidate a candidate, and a candidate can expose a missing constraint. Decomposing a requirement does not itself prove that its leaves are correct or that satisfying every leaf guarantees the original goal.

## Tools and their purpose

| Tool                | What it records                                                              | What the researcher can do                                                                        |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Goal overview       | Goal, success criteria, scope, current research gaps                         | Edit the intended outcome and navigate to missing or unresolved work                              |
| Requirement tree    | Parent and child requirements, acceptance criteria, verification state       | Add, edit, split, reparent, and inspect a requirement without losing its links                    |
| Grounding register  | Assumptions, evidence, constraints, and counterexamples                      | Link concrete observations to requirements and distinguish a claim from support for it            |
| Problems            | Blockers and unknowns linked to requirements                                 | Open an investigation, record findings, and mark a problem solved when its resolution is recorded |
| Candidate solutions | Mechanisms, requirement coverage, supporting evidence, risks                 | Compare alternatives and identify what each candidate leaves unresolved                           |
| Interference review | Pairwise compatibility, conflict, redundancy, and unknown interactions       | Explain relationships, inspect tradeoffs, and propose a combination for verification              |
| Inquiries           | A selected approach, question, premise, intervention, prediction, and result | Compare alternative research approaches through recorded hypotheses and tests                     |
| Verification        | Procedure, expected and observed results, outcome, evidence links            | Plan a test, record a result, and follow it back to requirements and candidates                   |
| Research map        | A graph projection of saved research or a researcher-authored map            | Follow relationships spatially and inspect the same records used in the workbench                 |

Use the workbench for editing and the map for tracing relationships. A graph node represents a saved record; selecting it should open that record or its investigation. Custom HTML, Mermaid, and JSON maps remain available alongside generated projections.

Evidence needs a source or an observed result. Record what was inspected or observed and which conclusion it supports; a source link alone does not prove a claim. An agent-written assertion remains an assumption until it has support. A completed conversation, a solved blocker, or a candidate marked ready does not silently mark the goal verified. Counts describe saved records and outcomes; they are not a probability of success. Candidate coverage means a solution addresses a requirement, rather than proving that it satisfies the requirement.

For example, a researcher could define a goal as reducing an experiment's runtime while preserving its accepted result quality. Its leaves might specify a reproducible baseline, an agreed output-comparison rule, and a measured runtime limit. Caching and parallel execution are separate candidates. Combining them creates a new candidate that references both contributions; an interaction review records whether stale cached inputs or scheduling overhead could undermine the combination. A benchmark records the observed runtime and output comparison. Before that benchmark runs, the combination remains a hypothesis.

## Provider-backed research operations

Structured editing and provider-backed analysis have different effects. Adding a requirement is a saved edit. Running a decomposition asks the selected Codex or Claude Code provider to investigate and update the research files.

Useful explicit operations are:

| Operation                 | Expected research work                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Explore                   | Frame the goal, identify uncertainties and blockers, and select a productive research direction               |
| Anti-abstraction          | Identify constituent outcomes, split compound requirements, and propose testable leaves                       |
| Abstraction               | Compose selected contributions into a higher-order candidate with a stated mechanism                          |
| Grounding                 | Inspect facts, assumptions, constraints, and counterexamples, and record their support                        |
| Constructive interference | Examine constructive, compatible, conflicting, redundant, and unknown interactions, and propose a combination |
| Verification              | Record procedures, expected and observed outcomes, and evidence tied to requirements and candidates           |

In the web app, describe the desired approach in the prompt. There is no next-message operation selector, and stored selections do not guide new or queued requests. Life sends the researcher's text unchanged to the provider; it does not append a research preamble or an invented continuation. Stable goal/problem IDs and file paths are available through native `AGENTS.md`/`CLAUDE.md` instructions and context files. The legacy desktop operation selector still records its selection as context metadata.

Each request uses the goal/problem context selected when it was submitted. Later navigation must not redirect running or queued research. Selected record IDs belong to that invocation rather than a mutable global instruction file shared by concurrent investigations.

The provider can work through normal tools and subagents, and its activity stays visible in the associated Research conversation. Analysis requires an available, authenticated provider and the applicable permissions. Life must show the real provider result, preserve unresolved questions, and leave failed work recoverable. There is no simulated automation or success message for an analysis that did not run.

## Explore with more than one approach

Decomposition and composition form one approach. A researcher can also select a different operator to generate alternatives or challenge a proposed explanation. Each operator produces inspectable research artifacts and a way to test its conclusions.

| Approach                | What it does                                                                             | Useful output and reality check                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Counterfactual analysis | Ask what would change if a relevant assumption, mechanism, or constraint were different  | Contrasting scenarios, exposed dependencies, and a test distinguishing the scenarios                       |
| Analogy transfer        | Compare another system with similar relationships rather than matching surface labels    | A mapping, the limits of the analogy, and evidence needed before transferring a mechanism                  |
| Constraint inversion    | Examine whether a limiting condition can become a useful resource or mechanism           | A candidate linked to the real constraint, its predicted benefit, and conditions where the inversion fails |
| Reverse design          | Work backward from an observed or desired result to the conditions that could produce it | Necessary-condition hypotheses and tests that eliminate incompatible explanations                          |
| Morphological search    | Enumerate alternatives for separate subfunctions and inspect their combinations          | A combination matrix, incompatible pairs, and selected candidates for testing                              |
| Causal intervention     | Identify a controlled change that could distinguish causal explanations                  | Control, intervention, predicted observations, competing explanations, and a recorded experiment           |

These approaches can be combined. For example, anti-abstraction can expose subfunctions for morphological search, analogy transfer can suggest a contribution, and causal intervention can test whether that contribution causes the observed improvement. An operator's unfamiliar name does not make its result novel or validated. Novelty and validity require comparison and evidence recorded in the research.

## Storage and traceability

Research remains independent of Agents projects. Its machine-backed root is `<machine-home>/.life/research`. The existing `goal.json` is the durable goal record; method data belongs to that goal with a versioned schema and stable record IDs. Large source material can remain in related files with references from the evidence records.

Overview and problem conversations use isolated native context files. A problem conversation works in its own stable directory while its instructions identify the shared goal file and the exact selected problem. Concurrent problems must not overwrite a shared selected-problem instruction file.

The Research root's `.life-method.md` guide and `.life-method-schema.json` describe the native file protocol. Each conversation's `.life-context.json` points to those files and the exact goal/problem metadata. A submitted operation also receives an immutable `.life-invocations/<invocation-id>.json` snapshot in that conversation directory. Its operator and execution identity stay associated with that request when the next selected operation changes. Native `AGENTS.md` and `CLAUDE.md` load this context; the user's message is sent unchanged.

Changes use existing atomic writes and conflict detection. An offline edit remains cached and pending; reconnecting does not overwrite a competing machine edit silently. User-authored maps, instructions, artifacts, provider history, and unknown metadata remain preserved. Exporting the saved research should preserve records and links, not only the rendered graph.

Every relationship uses IDs, including requirement parents, problem-to-requirement links, candidate coverage, grounding links, candidate interactions, and verification links. Renaming a record should not break its references. Deleting a referenced record must make the affected links visible and remove or repair them deliberately.

## Implementation contract

The model and interface use the same persisted data. A method view must not maintain a second independent copy of the goal or a graph-only representation of its relationships.

- A requirement or component has a stable ID, statement, optional parent ID, and acceptance criterion. Leaves are derived from the tree; a separate basic/atomic declaration needs a rationale and does not erase existing children. Parent cycles and self-links are rejected.
- A grounding record identifies its kind, claim or observation, source, linked requirement IDs, and support state. Unverified records remain visibly unverified.
- A candidate identifies its mechanism, coverage, dependencies, tradeoffs, and support. A composite candidate retains links to its contributing candidates and constituent requirements/components, and states the combined mechanism and hypothesized whole-level effect. An interaction identifies at least two distinct candidates, its relationship, an explanatory rationale, and supporting evidence; verification can test the candidates and their combination.
- A verification identifies what it tests, its procedure, expected result, observed result, and a pending, passed, failed, or inconclusive outcome. A plan is not a passed result.
- A passed result supports its recorded configuration and acceptance criterion. Later edits to the tested mechanism or criterion need a visible review before that result can support a new conclusion.
- An inquiry identifies the selected approach, question, premise, intervention, prediction, result, and linked requirements, candidates, and evidence. Proposed, tested, and rejected inquiries remain inspectable.
- Derived research gaps are reproducible checks over saved data: missing leaf acceptance criteria, unsupported assumptions, uncovered requirements, unresolved blockers, and untested interactions. They are not inferred scientific confidence.
- Existing goals without method data open normally with an empty method workspace. Existing problem conversations and custom maps remain usable. Model limits, invalid references, save conflicts, and failed provider operations have actionable messages.
- The interface uses Life's neutral light and dark themes. Relation labels and status text carry meaning without relying on color. Tables and inspectors provide a usable alternative to the graph; keyboard access and small-window layouts remain supported.

The distinctive element is the requirement-to-evidence trace: selecting a basic requirement should show its grounding, blockers, candidate contributions, and tests together. This keeps rich tools connected to the research question instead of turning the panel into unrelated dashboards.
