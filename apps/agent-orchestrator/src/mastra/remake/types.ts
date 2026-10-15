import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
export type { ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'

export interface Brand { name: string; product: string; productPhotoFileId?: string; audience?: string; notes?: string }

/** One element of the breakdown and what the remake does with it (spec §6.2). */
export interface PlanLine { ref: string; action: 'keep' | 'swap' | 'drop'; to?: string; why?: string; auto?: boolean }

export interface RemakeLook {
  n: number                       // 1-based; ref index is n - 1 (overview.looks order)
  label: string; startS: number; endS: number
  outfit: string; expression: string; startPose: string; endPose: string
  measured: string | null         // the breakdown's plain "Measured:" line
  people: number | null; noPerson: boolean | null
  start: BodyReading | null; end: BodyReading | null
  moves: number
  guideStartS: number; guideEndS: number   // measured frames used as pose-only guides
  needsEndStill: boolean
}

export interface RemakeReference {
  setting: string
  props: Array<{ prop: string; where: string; when: string }>
  moments: Array<{ t_s: number; what: string }>
  musicMood: string
  videoFileId: string
  durationS: number; width: number; height: number
}

export interface RemakePlan {
  lines: PlanLine[]; looks: RemakeLook[]; reference: RemakeReference
  needsCasting: boolean; aspectRatio: '9:16' | '16:9' | '1:1'; warnings: string[]
}

export interface LedgerEntry { item: string; attempt: number; creditsMicro: string; outcome: 'kept' | 'retried' | 'failed' | 'blocked' }
export interface StillResult { look: number; kind: 'start' | 'end'; fileId: string | null; status: 'passed' | 'failed' | 'unchecked' | 'blocked'; reasons: string[] }
