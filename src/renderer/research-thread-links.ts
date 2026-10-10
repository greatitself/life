import type { ResearchRecord } from './workbench'

export interface ResearchThreadLink {
  goalId: string
  problemId?: string
}

export function beginResearchThreadUnlink(
  threadId: string,
  scopeKey: string,
  update: (change: (previous: ResearchRecord) => ResearchRecord, scopeKey: string) => boolean,
): (() => boolean) | undefined {
  let removed: ResearchThreadLink[] = []
  const saved = update((previous) => {
    const result = unlinkResearchThread(previous, threadId)
    removed = result.links
    return result.record
  }, scopeKey)
  if (!saved) return
  return () =>
    update((previous) => restoreResearchThreadLinks(previous, threadId, removed), scopeKey)
}

/** Remember only links actually removed, without retaining a stale workspace snapshot. */
export function unlinkResearchThread(record: ResearchRecord, threadId: string) {
  const links: ResearchThreadLink[] = []
  const goals = record.goals.map((goal) => {
    const unlinkGoal = goal.threadId === threadId
    if (unlinkGoal) links.push({ goalId: goal.id })
    const problems = goal.problems.map((problem) => {
      if (problem.threadId !== threadId) return problem
      links.push({ goalId: goal.id, problemId: problem.id })
      return { ...problem, threadId: undefined }
    })
    if (!unlinkGoal && problems.every((problem, index) => problem === goal.problems[index]))
      return goal
    return { ...goal, ...(unlinkGoal ? { threadId: undefined } : {}), problems }
  })
  return { record: links.length ? { ...record, goals } : record, links }
}

/** A failed deletion restores its own empty links and preserves all intervening edits. */
export function restoreResearchThreadLinks(
  record: ResearchRecord,
  threadId: string,
  links: ResearchThreadLink[],
): ResearchRecord {
  const byGoal = new Map<string, { goal: boolean; problems: Set<string> }>()
  for (const link of links) {
    let target = byGoal.get(link.goalId)
    if (!target) {
      target = { goal: false, problems: new Set() }
      byGoal.set(link.goalId, target)
    }
    if (link.problemId === undefined) target.goal = true
    else target.problems.add(link.problemId)
  }
  let changed = false
  const goals = record.goals.map((goal) => {
    const target = byGoal.get(goal.id)
    if (!target) return goal
    const restoreGoal = target.goal && goal.threadId === undefined
    const problems = goal.problems.map((problem) => {
      if (!target.problems.has(problem.id) || problem.threadId !== undefined) return problem
      return { ...problem, threadId }
    })
    if (!restoreGoal && problems.every((problem, index) => problem === goal.problems[index]))
      return goal
    changed = true
    return { ...goal, ...(restoreGoal ? { threadId } : {}), problems }
  })
  return changed ? { ...record, goals } : record
}
