// ── PM intent routing ────────────────────────────────────────────────────────
// Simplified PM routing — just keyword detection, no session tracking or DB fetching.
// The pmWorkflow owns the entire flow from intent detection to completion.

const PM_SIGNALS = [
  // PRD
  'create a prd', 'write a prd', 'draft a prd', 'generate a prd',
  'product requirements', 'prd for', 'requirements document', 'i need a prd',
  'product spec', 'feature spec',
  // Roadmap / plan
  'create a roadmap', 'build a roadmap', 'write a roadmap',
  'generate a roadmap', 'generate roadmap', 'make a roadmap',
  'roadmap from', 'roadmap for',
  'create a plan', 'build a plan', 'generate a plan', 'generate plan',
  'project plan', 'release plan', 'execution plan',
  'create milestones', 'generate milestones', 'build milestones',
  'now generate', 'next step', 'next phase',
  // Tasks
  'create tasks', 'generate tasks', 'break down into tasks',
  'create a task list', 'generate a task list', 'break it down',
  'create subtasks', 'break down the', 'task breakdown',
]

export function isPmIntent(msg: string): boolean {
  const lower = msg.toLowerCase()
  return PM_SIGNALS.some(s => lower.includes(s))
}
