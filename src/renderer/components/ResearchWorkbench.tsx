import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  FlaskConical,
  Pause,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Target,
} from 'lucide-react'
import type { Provider } from '../../shared/types'
import type { Thread } from '../state'
import type {
  ProblemStatus,
  ResearchGoal,
  ResearchProblem,
  ResearchWorkbenchState,
} from '../workbench'
import { GraphCanvas, type CanvasEdge, type CanvasNode } from './GraphCanvas'
import { Modal } from './Modal'
import { ProviderIcon } from './Icons'
import './research-goal-controls.css'
import { ResearchSidebarFilterDialog, useResearchSidebarFilters } from './ResearchSidebarFilters'
import { ResearchEditableMap } from './ResearchEditableMap'
import { ResearchMethodWorkbench } from './ResearchMethodWorkbench'

const statusLabel: Record<ProblemStatus, string> = {
  open: 'Open',
  blocked: 'Blocked',
  solved: 'Solved',
}
function StatusIcon({ status, size = 12 }: { status: ProblemStatus; size?: number }) {
  return status === 'solved' ? (
    <Check size={size} />
  ) : status === 'blocked' ? (
    <Pause size={size} />
  ) : (
    <Circle size={size} />
  )
}
function Menu({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode
  children: ReactNode
  label: string
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="life-workbench-menu"
          sideOffset={6}
          align="start"
          aria-label={label}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function ResearchGoalMenu({
  workbench,
  goals = workbench.goals,
  trigger,
}: {
  workbench: ResearchWorkbenchState
  goals?: ResearchGoal[]
  trigger: ReactNode
}) {
  return (
    <Menu label="Research goals" trigger={trigger}>
      {goals.map((item) => (
        <DropdownMenu.Item
          key={item.id}
          className="life-workbench-menu-item"
          onSelect={() => workbench.selectGoal(item.id)}
        >
          <Target size={14} />
          <span>{item.title}</span>
          {workbench.goal?.id === item.id ? <Check size={13} /> : null}
        </DropdownMenu.Item>
      ))}
      {!goals.length ? <div className="research-sidebar-empty">No matching goals</div> : null}
      {workbench.goal ? (
        <>
          <DropdownMenu.Separator className="life-workbench-menu-separator" />
          <DropdownMenu.Item className="life-workbench-menu-item" onSelect={workbench.editGoal}>
            <Pencil size={14} />
            <span>Edit goal</span>
          </DropdownMenu.Item>
        </>
      ) : null}
    </Menu>
  )
}
function ProblemCard({
  problem,
  goal,
  thread,
  selected,
  onSelect,
}: {
  problem: ResearchProblem
  goal: ResearchGoal
  thread?: Thread
  selected: boolean
  onSelect: () => void
}) {
  const working = Boolean(thread?.busy)
  const waiting = Boolean(thread?.pending.length)
  return (
    <button
      className={'thread-row thread-card research-problem-card' + (selected ? ' active' : '')}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="thread-card-project">
        <span className="research-problem-badge">
          <FlaskConical size={11} />
        </span>
        <span>{goal.title}</span>
        {working || waiting ? (
          <span className="research-problem-working" data-waiting={waiting}>
            <span className={'thread-run-ring' + (waiting ? ' is-waiting' : '')} />
            {waiting ? 'Needs input' : 'Working'}
          </span>
        ) : (
          <span className="research-problem-status" data-status={problem.status}>
            <StatusIcon status={problem.status} />
          </span>
        )}
      </span>
      <span className="thread-card-title">{problem.title}</span>
      <span className="thread-card-meta">
        <span>
          {statusLabel[problem.status]}
          {thread
            ? ' · ' +
              thread.messages.filter((message) => message.role === 'user').length +
              ' messages'
            : ''}
        </span>
        {thread ? <ProviderIcon provider={thread.provider} size={15} /> : null}
      </span>
    </button>
  )
}
export function ResearchSidebar({
  workbench,
  threads,
  footerTarget,
  onChooseWorkspace,
  filtersOpen,
  onFiltersOpenChange,
}: {
  workbench: ResearchWorkbenchState
  threads: Thread[]
  footerTarget: HTMLDivElement | null
  onChooseWorkspace: () => void
  filtersOpen: boolean
  onFiltersOpenChange: (open: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [solvedOpen, setSolvedOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const arrangement = useResearchSidebarFilters()
  const { filters } = arrangement
  const goal = workbench.goal
  const search = useDeferredValue(query.trim().toLocaleLowerCase())
  const threadById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads])
  const activity = (thread?: Thread) =>
    thread?.pending.length ? 'waiting' : thread?.busy ? 'running' : 'idle'
  const rank = (thread?: Thread) =>
    activity(thread) === 'waiting' ? 0 : activity(thread) === 'running' ? 1 : 2
  const turns = (thread?: Thread) =>
    thread?.messages.filter((message) => message.role === 'user').length || 0
  const updated = (problem: ResearchProblem) =>
    Math.max(problem.updatedAt, threadById.get(problem.threadId || '')?.updatedAt || 0)
  const accepts = (problem: ResearchProblem, parent: ResearchGoal) => {
    const thread = threadById.get(problem.threadId || '')
    if (filters.status !== 'all' && filters.status !== problem.status) return false
    if (filters.provider !== 'all' && thread?.provider !== filters.provider) return false
    if (filters.activity !== 'all' && activity(thread) !== filters.activity) return false
    return (
      !search ||
      [
        parent.title,
        parent.goal,
        problem.title,
        problem.description,
        problem.notes,
        ...(thread?.messages.map((message) => message.text) || []),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)
    )
  }
  const compare = (a: ResearchProblem, b: ResearchProblem) => {
    let order = 0
    if (filters.sort === 'title') order = a.title.localeCompare(b.title)
    else if (filters.sort === 'oldest') order = updated(a) - updated(b)
    else if (filters.sort === 'activity')
      order = rank(threadById.get(a.threadId || '')) - rank(threadById.get(b.threadId || ''))
    else if (filters.sort === 'messages')
      order = turns(threadById.get(b.threadId || '')) - turns(threadById.get(a.threadId || ''))
    else if (filters.sort === 'status')
      order =
        ['blocked', 'open', 'solved'].indexOf(a.status) -
        ['blocked', 'open', 'solved'].indexOf(b.status)
    return order || updated(b) - updated(a) || a.id.localeCompare(b.id)
  }
  const visible = goal
    ? goal.problems.filter((problem) => accepts(problem, goal)).sort(compare)
    : []
  const pending = visible.filter((problem) => problem.status !== 'solved')
  const solved = visible.filter((problem) => problem.status === 'solved')
  const filtered =
    filters.status !== 'all' ||
    filters.provider !== 'all' ||
    filters.activity !== 'all' ||
    Boolean(search)
  const goals = workbench.goals
    .filter(
      (item) =>
        !filtered ||
        item.problems.some((problem) => accepts(problem, item)) ||
        (filters.status === 'all' &&
          filters.provider === 'all' &&
          filters.activity === 'all' &&
          (item.title + ' ' + item.goal).toLocaleLowerCase().includes(search)),
    )
    .sort((a, b) => {
      if (filters.sort === 'title') return a.title.localeCompare(b.title)
      if (filters.sort === 'oldest') return a.updatedAt - b.updatedAt
      if (filters.sort === 'messages')
        return (
          b.problems.reduce(
            (sum, problem) => sum + turns(threadById.get(problem.threadId || '')),
            turns(threadById.get(b.threadId || '')),
          ) -
          a.problems.reduce(
            (sum, problem) => sum + turns(threadById.get(problem.threadId || '')),
            turns(threadById.get(a.threadId || '')),
          )
        )
      if (filters.sort === 'activity') {
        const aRank = Math.min(
          rank(threadById.get(a.threadId || '')),
          ...a.problems.map((problem) => rank(threadById.get(problem.threadId || ''))),
        )
        const bRank = Math.min(
          rank(threadById.get(b.threadId || '')),
          ...b.problems.map((problem) => rank(threadById.get(problem.threadId || ''))),
        )
        if (aRank !== bRank) return aRank - bRank
      }
      return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
    })
  useEffect(() => {
    if (workbench.problem?.status === 'solved' || filters.status === 'solved') setSolvedOpen(true)
  }, [workbench.problem?.id, workbench.problem?.status, filters.status])
  useEffect(() => {
    if (!workbench.storageConflict) setConflictOpen(false)
  }, [workbench.storageConflict])
  const card = (problem: ResearchProblem) =>
    goal ? (
      <ProblemCard
        key={problem.id}
        problem={problem}
        goal={goal}
        thread={threadById.get(problem.threadId || '')}
        selected={workbench.problem?.id === problem.id}
        onSelect={() => workbench.selectProblem(problem.id)}
      />
    ) : null
  const solvedSection =
    goal && solved.length ? (
      <div className="sidebar-arrangement-footer research-solved">
        <details
          className="life-thread-arrangement-section"
          open={solvedOpen}
          onToggle={(event) => setSolvedOpen(event.currentTarget.open)}
        >
          <summary>
            <ChevronDown size={13} />
            <span>Solved</span>
            <small>{solved.length}</small>
          </summary>
          <div className="sidebar-project-thread-group">{solved.map(card)}</div>
        </details>
      </div>
    ) : null
  function downloadLocalEdits() {
    const url = URL.createObjectURL(
      new Blob([workbench.exportLocal()], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'life-research-local-edits.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="research-sidebar">
      <div className="sidebar-navigation-toolbar">
        <label className="sidebar-inline-search">
          <Search size={15} />
          <input
            type="search"
            id="life-research-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search Research goals and problems"
          />
        </label>
        <div className="sidebar-navigation-actions" role="group" aria-label="Research actions">
          <button
            type="button"
            className="icon-button"
            aria-label="New goal"
            title="New goal"
            aria-haspopup="dialog"
            onClick={workbench.newGoal}
          >
            <Plus size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={
              'icon-button sidebar-filter-toggle' + (arrangement.customized ? ' selected' : '')
            }
            aria-label="Research filters and sorting"
            title="Filters and sorting"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={() => onFiltersOpenChange(true)}
          >
            <SlidersHorizontal size={16} />
            {arrangement.customized ? (
              <i className="sidebar-filter-dot" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      </div>

      {workbench.storageNotice ? (
        <div className="research-migration-notice" role="status">
          <p>{workbench.storageNotice}</p>
          <button type="button" onClick={downloadLocalEdits}>
            Download local edits
          </button>
        </div>
      ) : null}
      {filtered ? (
        <div className="sidebar-navigation-summary">
          <span role="status">
            {visible.length} of {goal?.problems.length || 0} problems · {goals.length} goals
          </span>
          <button
            type="button"
            onClick={() => {
              setQuery('')
              arrangement.reset()
            }}
          >
            Clear
          </button>
        </div>
      ) : null}

      {goal ? (
        <>
          <div className="research-problem-filters" aria-label="Problem status">
            {(['all', 'open', 'blocked'] as const).map((status) => (
              <button
                key={status}
                aria-pressed={filters.status === status}
                onClick={() => arrangement.setFilters((previous) => ({ ...previous, status }))}
              >
                {status === 'all' ? 'Problems' : statusLabel[status]}
              </button>
            ))}
          </div>
          <div className="research-problem-list">
            {pending.map(card)}
            {!visible.length ? (
              <div className="research-sidebar-empty">
                {filtered ? (
                  <span>No matching problems</span>
                ) : (
                  <button onClick={workbench.newProblem}>
                    <Plus size={14} /> Add problem
                  </button>
                )}
              </div>
            ) : null}
            {!footerTarget ? solvedSection : null}
          </div>
        </>
      ) : (
        <div className="research-sidebar-empty">
          <span>Use New goal beside search to get started.</span>
        </div>
      )}
      {footerTarget && solvedSection ? createPortal(solvedSection, footerTarget) : null}
      <ResearchSidebarFilterDialog
        open={filtersOpen}
        onOpenChange={onFiltersOpenChange}
        state={arrangement}
      />
      <Modal
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        title="Resolve Research edits"
        description="Life and the machine changed the same field. Independent changes are preserved when keeping your edits."
      >
        <p className="research-conflict-detail">{workbench.storageError}</p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={downloadLocalEdits}>
            Download local edits
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              workbench.resolveConflict('remote')
              setConflictOpen(false)
            }}
          >
            Use machine version
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              workbench.resolveConflict('local')
              setConflictOpen(false)
            }}
          >
            Keep my edits
          </button>
        </div>
      </Modal>
    </div>
  )
}
export function ResearchOverview({
  workbench,
  threads,
}: {
  workbench: ResearchWorkbenchState
  threads: Thread[]
}) {
  const goal = workbench.goal
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  if (!goal) {
    nodes.push({
      id: 'new',
      x: 0,
      y: 0,
      width: 294,
      height: 140,
      content: (
        <div className="research-goal-placeholder">
          <Target size={21} aria-hidden="true" />
          <strong>Start with a goal</strong>
          <p>Use New goal beside the sidebar search.</p>
        </div>
      ),
    })
  } else {
    const solved = goal.problems.filter((problem) => problem.status === 'solved').length
    nodes.push({
      id: 'goal',
      x: 0,
      y: -88,
      width: 294,
      height: 176,
      content: (
        <div className="research-goal-node" data-current={!workbench.problem}>
          <div className="research-goal-node-top">
            <Target size={15} />
            <span>Goal</span>
            <button aria-label="Edit goal" title="Edit goal" onClick={workbench.editGoal}>
              <Pencil size={13} />
            </button>
            <button aria-label="Add problem" title="Add problem" onClick={workbench.newProblem}>
              <Plus size={15} />
            </button>
          </div>
          <button
            type="button"
            className="research-goal-node-title"
            title={goal.title}
            aria-label={`Open goal conversation: ${goal.title}`}
            onClick={workbench.overview}
          >
            {goal.title}
          </button>
          <p title={goal.goal}>{goal.goal}</p>
          <div className="research-goal-progress">
            <div
              role="progressbar"
              aria-label="Solved problems"
              aria-valuenow={solved}
              aria-valuemin={0}
              aria-valuemax={Math.max(1, goal.problems.length)}
            >
              <span
                style={{
                  width: goal.problems.length ? (solved / goal.problems.length) * 100 + '%' : '0%',
                }}
              />
            </div>
            <span>
              {solved}/{goal.problems.length}
            </span>
          </div>
        </div>
      ),
    })
    goal.problems.forEach((problem, index) => {
      const thread = threads.find((thread) => thread.id === problem.threadId)
      const working = Boolean(thread?.busy || thread?.pending.length)
      const waiting = Boolean(thread?.pending.length)
      nodes.push({
        id: problem.id,
        x: 426,
        y: (index - (goal.problems.length - 1) / 2) * 132 - 52,
        width: 270,
        height: 104,
        content: (
          <button
            className="research-problem-node"
            data-status={problem.status}
            data-current={workbench.problem?.id === problem.id}
            aria-pressed={workbench.problem?.id === problem.id}
            onClick={() => workbench.selectProblem(problem.id)}
          >
            <span className="research-problem-node-status">
              {working ? (
                <>
                  <span className={'thread-run-ring' + (waiting ? ' is-waiting' : '')} />
                  <span>{waiting ? 'Needs input' : 'Working'}</span>
                </>
              ) : (
                <>
                  <StatusIcon status={problem.status} />
                  <span>{statusLabel[problem.status]}</span>
                </>
              )}
              {thread ? <ProviderIcon provider={thread.provider} size={14} /> : null}
            </span>
            <strong title={problem.title}>{problem.title}</strong>
            <small title={problem.description}>{problem.description}</small>
          </button>
        ),
      })
      edges.push({ from: 'goal', to: problem.id })
    })
  }
  return (
    <div className="life-research-overview">
      <ResearchMethodWorkbench
        workbench={workbench}
        map={
          <ResearchEditableMap
            map={workbench.map}
            workbench={workbench}
            fallback={
              <GraphCanvas
                nodes={nodes}
                edges={edges}
                fitKey={
                  (goal?.id || 'new') +
                  ':' +
                  (goal?.problems.map((problem) => problem.id).join('|') || '')
                }
                label="Research goal and problems"
              >
                {goal ? (
                  <div className="life-canvas-overlay">
                    <button
                      type="button"
                      className="life-canvas-add"
                      onClick={workbench.newProblem}
                    >
                      <Plus size={15} />
                      Add problem
                    </button>
                  </div>
                ) : null}
              </GraphCanvas>
            }
          />
        }
      />
    </div>
  )
}
function ProblemNotes({
  problem,
  goalId,
  workbench,
}: {
  problem: ResearchProblem
  goalId: string
  workbench: ResearchWorkbenchState
}) {
  const [notes, setNotes] = useState(problem.notes)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (document.activeElement !== input.current) setNotes(problem.notes)
  }, [problem.notes])
  return (
    <label className="research-findings">
      <span>Findings</span>
      <textarea
        ref={input}
        value={notes}
        maxLength={8000}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={() => {
          if (notes !== problem.notes) workbench.patchProblem(goalId, problem.id, { notes })
        }}
        placeholder="Record findings…"
        rows={3}
      />
    </label>
  )
}
export function ResearchProblemContext({ workbench }: { workbench: ResearchWorkbenchState }) {
  const { goal, problem } = workbench
  if (!goal || !problem) return null
  return (
    <div className="research-problem-context">
      <div className="research-problem-context-row">
        <button
          className="icon-button"
          aria-label="Back to research overview"
          title="Research overview"
          onClick={workbench.overview}
        >
          <ArrowLeft size={15} />
        </button>
        <span className="research-context-title">
          <small>{goal.title}</small>
          <strong>{problem.title}</strong>
        </span>
        <Menu
          label="Problem status"
          trigger={
            <button className="research-status-picker">
              <StatusIcon status={problem.status} />
              <span>{statusLabel[problem.status]}</span>
              <ChevronDown size={12} />
            </button>
          }
        >
          {(['open', 'blocked', 'solved'] as const).map((status) => (
            <DropdownMenu.Item
              key={status}
              className="life-workbench-menu-item"
              onSelect={() => workbench.patchProblem(goal.id, problem.id, { status })}
            >
              <StatusIcon status={status} size={14} />
              <span>{statusLabel[status]}</span>
              {problem.status === status ? <Check size={13} /> : null}
            </DropdownMenu.Item>
          ))}
        </Menu>
        <button
          className="icon-button"
          aria-label="Edit problem"
          title="Edit problem"
          onClick={workbench.editProblem}
        >
          <Pencil size={14} />
        </button>
      </div>
      <details className="research-problem-brief">
        <summary>
          <ChevronDown size={12} /> Brief &amp; findings
        </summary>
        <div>
          <p>{problem.description}</p>
          <ProblemNotes key={problem.id} problem={problem} goalId={goal.id} workbench={workbench} />
        </div>
      </details>
    </div>
  )
}
export function ResearchProblemStart({
  problem,
  goal,
  provider,
  onProvider,
}: {
  problem?: ResearchProblem
  goal?: ResearchGoal
  provider: Provider
  onProvider: (provider: Provider) => void
  onNewGoal: () => void
}) {
  return (
    <div className="research-problem-start">
      {problem ? <FlaskConical size={22} /> : <Target size={22} />}
      <h1>{problem?.title || goal?.title || 'Start with a goal'}</h1>
      <p>{problem?.description || goal?.goal || 'What do you want to discover or achieve?'}</p>
      {goal ? (
        <>
          <div className="research-provider-options" aria-label="Research provider">
            {(['codex', 'claude'] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={provider === item}
                onClick={() => onProvider(item)}
              >
                <ProviderIcon provider={item} size={16} />
                {item === 'codex' ? 'Codex' : 'Claude Code'}
              </button>
            ))}
          </div>
          <p className="research-agent-start-hint">
            {problem
              ? 'Discuss this problem and record findings as you go.'
              : 'Discuss your goal, explore evidence, and identify the next problems to investigate.'}
          </p>
        </>
      ) : (
        <p className="research-agent-start-hint">
          Use New goal beside the sidebar search to get started.
        </p>
      )}
    </div>
  )
}
function ResearchEditorForm({ workbench }: { workbench: ResearchWorkbenchState }) {
  const editor = workbench.editor!
  const goal = workbench.goals.find(
    (goal) => goal.id === (editor.kind === 'goal' ? editor.id : editor.goalId),
  )
  const problem = goal?.problems.find((problem) => problem.id === editor.id)
  const [title, setTitle] = useState(
    editor.kind === 'goal' ? goal?.title || '' : problem?.title || '',
  )
  const [detail, setDetail] = useState(
    editor.kind === 'goal' ? goal?.goal || '' : problem?.description || '',
  )
  return (
    <form
      className="research-editor-form"
      onSubmit={(event) => {
        event.preventDefault()
        workbench.saveEditor(title, detail)
      }}
    >
      <label>
        <span>Title</span>
        <input
          autoFocus
          required
          maxLength={160}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={editor.kind === 'goal' ? 'Research title' : 'Problem title'}
        />
      </label>
      <label>
        <span>{editor.kind === 'goal' ? 'Goal' : 'Problem'}</span>
        <textarea
          required
          maxLength={2000}
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          rows={5}
          placeholder={
            editor.kind === 'goal' ? 'What do you want to find out?' : 'What needs to be resolved?'
          }
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={workbench.closeEditor}>
          Cancel
        </button>
        <button className="button primary" type="submit" disabled={!title.trim() || !detail.trim()}>
          {editor.id ? 'Save' : editor.kind === 'goal' ? 'Create goal' : 'Add problem'}
        </button>
      </div>
    </form>
  )
}
export function ResearchDialogs({ workbench }: { workbench: ResearchWorkbenchState }) {
  const editor = workbench.editor
  if (!editor) return null
  const title =
    editor.kind === 'goal'
      ? editor.id
        ? 'Edit goal'
        : 'New goal'
      : editor.id
        ? 'Edit problem'
        : 'New problem'
  return (
    <Modal
      open={true}
      onOpenChange={(open) => {
        if (!open) workbench.closeEditor()
      }}
      title={title}
      description={
        editor.kind === 'goal'
          ? 'Define a goal for this research.'
          : 'Add a problem to your research goal.'
      }
    >
      <ResearchEditorForm
        key={[editor.kind, editor.goalId, editor.id].join(':')}
        workbench={workbench}
      />
    </Modal>
  )
}
