// Cost-meter labels for every video check call (review M4).
export const VIDEO_CHECK_COST = { agentId: 'video-check', workflowId: 'video-checks' }

// evidenceFileIds: Drive images (reference | remake) a person can open to see why (spec §8).
export interface CheckResult { name: string; status: 'pass' | 'fail' | 'unknown'; reason: string; evidenceTimes: number[]; evidenceFileIds?: string[] }

type RunnableScorer = { run: (r: { input: unknown; output: unknown }) => Promise<{ score: number; analyzeStepResult?: unknown }> }

// The blocking money gate: call the Mastra scorer directly (live evals are async
// and can't block spend). Unknown is never a pass (spec §8 checker rules).
export async function runGate(scorer: RunnableScorer, name: string, input: unknown, evidenceTimes: number[]): Promise<CheckResult> {
  try {
    const r = await scorer.run({ input, output: null })
    const a = (r.analyzeStepResult ?? {}) as { status?: 'pass' | 'fail' | 'unknown'; reason?: string }
    const status = a.status === 'unknown' ? 'unknown' : r.score === 1 && a.status === 'pass' ? 'pass' : 'fail'
    return { name, status, reason: a.reason ?? '', evidenceTimes }
  } catch (err) {
    return { name, status: 'unknown', reason: err instanceof Error ? err.message : String(err), evidenceTimes }
  }
}
