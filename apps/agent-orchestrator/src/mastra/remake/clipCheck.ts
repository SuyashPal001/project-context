// A paid clip, checked before it is kept (spec §8, rule 10): the measured body at the
// clip's start and end against the reference look, the same person, no empty-hand action.
import type { PoseResult, BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import { evenTimes, type Img } from '../tools/tvcChecks.js'
import { runGate, type CheckResult } from '../scorers/video/gate.js'
import { samePersonScorer, emptyHandScorer } from '../scorers/video/visionScorers.js'
import { comparePose } from './poseCompare.js'
import { personIn } from './looks.js'
import type { RemakeLook } from './types.js'

export interface ClipCheckDeps {
  poseClip: (path: string, seconds: number) => Promise<PoseResult>
  sample: (path: string, times: number[]) => Promise<Img[]>
  gate: typeof runGate
}

const asImage = (people: number | null, main: BodyReading | null) => ({ model: 'clip', people: people ?? 0, no_person: (people ?? 0) === 0, main })

export async function checkClip(o: { clipPath: string; seconds: number; look: RemakeLook; portrait: Img | null; tenantId: string }, d: ClipCheckDeps): Promise<CheckResult> {
  try {
    const times = evenTimes(o.seconds, 4)
    const [pose, frames] = await Promise.all([d.poseClip(o.clipPath, o.seconds), d.sample(o.clipPath, times)])
    const m = pose.looks[0]
    const results: CheckResult[] = [
      { ...comparePose(o.look.start, o.look.people, asImage(m?.people ?? null, m?.main_start ?? null)), name: 'start pose' },
      { ...comparePose(o.look.end, o.look.people, asImage(m?.people ?? null, m?.main_end ?? null)), name: 'end pose' },
    ]
    if (personIn(o.look) && o.portrait) results.push(await d.gate(samePersonScorer, 'same-person', { tenantId: o.tenantId, reference: o.portrait, frames }, times))
    results.push(await d.gate(emptyHandScorer, 'empty-hand', { tenantId: o.tenantId, frames }, times))
    const fails = results.filter((r) => r.status === 'fail')
    if (fails.length) return { name: 'clip', status: 'fail', reason: fails.map((r) => `${r.name}: ${r.reason}`).join('; '), evidenceTimes: times }
    if (results.some((r) => r.status === 'unknown')) return { name: 'clip', status: 'unknown', reason: 'part of the clip could not be checked', evidenceTimes: times }
    return { name: 'clip', status: 'pass', reason: 'passed every check', evidenceTimes: times }
  } catch (err) {
    console.error('[remake] clip check failed:', err instanceof Error ? err.message : String(err))
    return { name: 'clip', status: 'unknown', reason: 'the clip could not be checked this time', evidenceTimes: [] }
  }
}
