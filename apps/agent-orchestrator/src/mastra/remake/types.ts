import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
export type { ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'

export interface Brand { name: string; product: string; productPhotoFileId?: string; audience?: string; notes?: string }

/** One element of the breakdown and what the remake does with it (spec §6.2). */
export interface PlanLine { ref: string; action: 'keep' | 'swap' | 'drop'; to?: string; why?: string; auto?: boolean }

export interface RemakeLook {
  n: number                       // 1-based shot order (slots, clips, joining)
  ref?: number                    // the outfit look's index in overview.looks (plan lines); n - 1 when absent
  label: string; startS: number; endS: number
  outfit: string; expression: string; startPose: string; endPose: string
  /** hair, jewellery, makeup in this look (person vs styling, 2026-10-16) */
  styling?: string
  measured: string | null         // the breakdown's plain "Measured:" line
  people: number | null; noPerson: boolean | null
  // false when the people count was not measured, or a person shows only part of the time:
  // stills for such a look are never paid for (spec §8a: no paid value from a guess)
  measuredPeople: boolean
  start: BodyReading | null; end: BodyReading | null
  moves: number
  moveLines: string[]     // "at 1.2s: upper body moves up and right" (times from the look's start)
  cameraLines: string[]   // "at 0.5s: the camera pans right"
  guideStartS: number; guideEndS: number   // measured frames used as pose-only guides
  needsEndStill: boolean
  continues?: boolean             // a later part of a long shot: starts from the previous look's end still
}

export interface RemakeReference {
  setting: string
  props: Array<{ prop: string; where: string; when: string; trick?: boolean }>
  moments: Array<{ t_s: number; what: string }>
  /** Other people the story needs; each is cast as a new person. Missing on older plans. */
  characters?: Array<{ who: string; when: string; where: string }>
  musicMood: string
  music: { mood: string; genre: string; instruments: string; hasVocals: boolean | null; songName: string | null }
  videoFileId: string
  durationS: number; width: number; height: number
  /** The original's trick is a fan-blade wipe at measured hidden cuts: the looks are joined with the fan
   *  (ai-service media/sweep.py), timed from these covered spans. Missing for any other trick. */
  wipe?: { kind: 'fan'; covered: number[][] }
}

export interface RemakePlan {
  lines: PlanLine[]; looks: RemakeLook[]; reference: RemakeReference
  needsCasting: boolean; aspectRatio: '9:16' | '16:9' | '1:1'; warnings: string[]
}

export interface LedgerEntry { item: string; attempt: number; creditsMicro: string; outcome: 'kept' | 'retried' | 'failed' | 'blocked' }
/** One paid try at a still: the user sees every one, failed or kept, with why and what it cost. */
export interface StillTry { fileId: string; kept: boolean; why: string[]; creditsMicro: string }
export interface StillResult { look: number; kind: 'start' | 'end'; fileId: string | null; status: 'passed' | 'warned' | 'failed' | 'unchecked' | 'blocked'; reasons: string[]; tries?: StillTry[] }
