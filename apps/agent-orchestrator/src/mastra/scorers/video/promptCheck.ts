import { createScorer } from '@mastra/core/evals'
import { askChecked, gatewayAsk, CheckUnavailableError, type AskFn } from '../../tools/tvcChecks.js'
import { checkModel } from '../../tools/videoBreakdown/models.js'
import { VIDEO_CHECK_COST } from './gate.js'

const NO_SMILE = /mouth (gently )?closed|no smile|not smiling|lips (closed|together)|serious|neutral/i
const SMILE_WORDS = /\b(smil\w*|laugh\w*|grin\w*|teeth)\b/i
const NEGATION = /\b(no|not|without|never|don'?t|doesn'?t|isn'?t|nor)\b/i
const CLAUSES = /[.;,!?]|\bthen\b|\bbut\b/i

// A smile word counts only in a clause that does not negate it first
// ("mouth closed, no smile" is faithful, not a smile; review I2).
function positiveSmile(prompt: string): string | null {
  for (const clause of prompt.split(CLAUSES)) {
    const m = clause.match(SMILE_WORDS)
    if (m && !NEGATION.test(clause.slice(0, m.index))) return m[0]
  }
  return null
}

// Free, no model call: the exact mistake the spike paid for (spec §7.1).
export function precheckPrompt(prompt: string, look: { expression?: string }): string[] {
  const issues: string[] = []
  const word = positiveSmile(prompt)
  if (look.expression && NO_SMILE.test(look.expression) && word) {
    issues.push(`prompt asks for "${word}" but the reference expression is "${look.expression}"`)
  }
  return issues
}

type Input = { ask?: AskFn; tenantId?: string; prompt: string; planLine: string; look: Record<string, unknown> & { expression?: string }; startFrameObjects: string[]; keyMoments: string[] }
const EMPTY = { invented: [], contradicts: [], missing: [], hand_on_absent_object: [] }

export const promptCheckScorer = createScorer({ id: 'video-prompt-check', name: 'video-prompt-check', description: 'Blocks a paid generation prompt that invents, contradicts or drops what the reference/plan says' })
  .analyze(async ({ run }) => {
    const input = run.input as Input
    const pre = precheckPrompt(input.prompt, input.look)
    if (pre.length) return { status: 'fail', reason: pre.join('; '), ...EMPTY, invented: pre }
    const ask = input.ask ?? gatewayAsk(input.tenantId ?? '', fetch, checkModel(), VIDEO_CHECK_COST)
    try {
      const v = await askChecked(ask, [{ text: `You check a video-generation prompt BEFORE money is spent.
PLAN LINE (what this generation must do): ${input.planLine}
REFERENCE LOOK (expression, poses, moves, leg side): ${JSON.stringify(input.look)}
KEY MOMENTS that must happen: ${JSON.stringify(input.keyMoments)}
OBJECTS visible in the start frame: ${JSON.stringify(input.startFrameObjects)}
PROMPT: ${input.prompt}
Notes: a person's identity and looks come from a reference image, not from words, so never list a missing description of a person. Body words marked "measured" (body_measured, body_at_start, body_at_end) are measured from the reference frames and are correct; the rough pose text may be less exact.
List problems in the PROMPT only:
- invented: things the prompt adds that the reference/plan does not show (an expression, an effect, an action, or the name of a real person or a character)
- contradicts: things that conflict with the plan or look (directions are image-left/right)
- missing: key moments or plan items the prompt leaves out
- hand_on_absent_object: hand actions on objects NOT in the start-frame list
Reply ONLY JSON {"invented":[],"contradicts":[],"missing":[],"hand_on_absent_object":[]}` }], [{ key: 'invented', type: 'array' }, { key: 'contradicts', type: 'array' }, { key: 'missing', type: 'array' }, { key: 'hand_on_absent_object', type: 'array' }])
      const all = ['invented', 'contradicts', 'missing', 'hand_on_absent_object'].flatMap((k) => (v[k] as unknown[]).map((x) => `${k}: ${String(x)}`))
      return { status: all.length ? 'fail' : 'pass', reason: all.join('; ') || 'prompt matches plan and reference', ...v }
    } catch (err) {
      if (err instanceof CheckUnavailableError) return { status: 'unknown', reason: err.message, ...EMPTY }
      throw err
    }
  })
  .generateScore(({ results }) => ((results.analyzeStepResult as { status: string }).status === 'pass' ? 1 : 0))
  .generateReason(({ results }) => (results.analyzeStepResult as { reason: string }).reason)
