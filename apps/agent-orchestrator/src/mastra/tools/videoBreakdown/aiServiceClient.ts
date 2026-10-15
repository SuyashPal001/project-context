export async function aiService<T>(route: '/media/cuts' | '/media/hidden-cuts' | '/media/sound' | '/media/motion-peaks' | '/media/brightness-jumps' | '/media/coverage' | '/media/pose', body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const base = process.env.AI_SERVICE_URL ?? 'http://localhost:3004'
  const res = await fetchImpl(`${base}${route}`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`ai-service ${res.status}`)
  return await res.json() as T
}

export interface CutsResult { cuts: number[]; fades: Array<[number, number]>; duration_s: number }
export interface HiddenCutsResult { hidden_cuts: Array<{ from: string; to: string; at_s: number; covered_s: [number, number] }>; cover_threshold: number | null }
export interface SoundResult { curve_db: number[]; events: Array<{ at_s: number; change_db: number; kind: 'drop' | 'jump' }>; rhythm: Array<{ from_s: number; to_s: number; every_s: number }>; silent_from_s: number | null; bpm: number | null; beats_s: number[]; has_audio: boolean }
export type LegSide = 'image-left' | 'image-right' | 'center' | 'unknown'
export interface PoseLookResult { label: string; start_s: number; end_s: number; frames_used: number; leg_side_start: LegSide; leg_side_end: LegSide; leg_offset_start?: number | null; leg_offset_end?: number | null; body_angle_start?: number | null; body_angle_end: number | null }
export interface PoseMove { t_s: number; from_s: number; to_s: number; part: 'legs'; direction: 'image-left' | 'image-right'; strength: number }
export interface PoseResult { model: string; looks: PoseLookResult[]; moves: PoseMove[] }
