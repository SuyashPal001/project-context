// A paid clip, checked before it is kept (spec §8, rule 10): the measured body at the
// clip's start and end against the reference look, the same person, no empty-hand action.
import type { PoseResult, BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import { evenTimes, type AskFn, type Img } from '../tools/tvcChecks.js'
import { duplicatedProps } from '../tools/propCount.js'
import { runGate, type CheckResult } from '../scorers/video/gate.js'
import { samePersonScorer, emptyHandScorer } from '../scorers/video/visionScorers.js'
import { comparePose } from './poseCompare.js'
import { personIn } from './looks.js'
import type { RemakeLook } from './types.js'

export interface ClipCheckDeps {
  poseClip: (path: string, seconds: number) => Promise<PoseResult>
  sample: (path: string, times: number[]) => Promise<Img[]>
  gate: typeof runGate
  /** the vision model, for counting objects (tools/propCount) */
  ask?: AskFn
}

const asImage = (people: number | null, main: BodyReading | null) => ({ model: 'clip', people: people ?? 0, no_person: (people ?? 0) === 0, main })

// checkEnd: false for a clip made from the start still only (Omni) — it was never given the end pose.
export async function checkClip(o: { clipPath: string; seconds: number; look: RemakeLook; portrait: Img | null; tenantId: string; checkEnd?: boolean; /** the approved start photo and the objects in view: each is counted per frame against it */ startImage?: Img; props?: string[] }, d: ClipCheckDeps): Promise<CheckResult> {
  try {
    const times = evenTimes(o.seconds, 4)
    const [pose, frames] = await Promise.all([d.poseClip(o.clipPath, o.seconds), d.sample(o.clipPath, times)])
    const m = pose.looks[0]
    // comparePose words its reasons for a still; this is a clip.
    const forClip = (r: CheckResult): CheckResult => ({ ...r, reason: r.reason.replace(/\bstill\b/g, 'clip') })
    const results: CheckResult[] = [
      { ...forClip(comparePose(o.look.start, o.look.people, asImage(m?.people ?? null, m?.main_start ?? null))), name: 'start pose' },
      ...(o.checkEnd === false ? [] : [{ ...forClip(comparePose(o.look.end, o.look.people, asImage(m?.people ?? null, m?.main_end ?? null))), name: 'end pose' }]),
    ]
    // against the approved start photo when given (same scene and size; it passed against the person sheet), else the portrait
    const who = o.startImage ?? o.portrait
    if (personIn(o.look) && who) results.push(await d.gate(samePersonScorer, 'same-person', { tenantId: o.tenantId, reference: who, frames }, times))
    results.push(await d.gate(emptyHandScorer, 'empty-hand', { tenantId: o.tenantId, frames }, times))
    if (o.startImage && o.props?.length && d.ask) results.push({ name: 'objects', evidenceTimes: times, ...(await duplicatedProps(d.ask, o.startImage, frames.map((img, i) => ({ t: times[i], img })), o.props)) })
    const fails = results.filter((r) => r.status === 'fail')
    if (fails.length) return { name: 'clip', status: 'fail', reason: fails.map((r) => `${r.name}: ${r.reason}`).join('; '), evidenceTimes: times }
    if (results.some((r) => r.status === 'unknown')) return { name: 'clip', status: 'unknown', reason: 'part of the clip could not be checked', evidenceTimes: times }
    return { name: 'clip', status: 'pass', reason: 'passed every check', evidenceTimes: times }
  } catch (err) {
    console.error('[remake] clip check failed:', err instanceof Error ? err.message : String(err))
    return { name: 'clip', status: 'unknown', reason: 'the clip could not be checked this time', evidenceTimes: [] }
  }
}
