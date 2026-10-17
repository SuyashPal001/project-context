export async function aiService<T>(route: '/media/cuts' | '/media/hidden-cuts' | '/media/sound' | '/media/motion-peaks' | '/media/brightness-jumps' | '/media/coverage' | '/media/pose' | '/media/pose-image' | '/media/fan-sweep', body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
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
type Toward = LegSide | 'image-up' | 'image-down'
// One person's measured body reading (ai-service /media/pose).
export interface BodyReading {
  framing: 'full_body' | 'knees_up' | 'waist_up' | 'chest_up' | 'face' | 'unknown'
  orientation: 'vertical' | 'diagonal' | 'horizontal' | 'unknown'
  torso_angle_deg: number | null
  knees: 'straight' | 'bent' | 'unknown'
  arms: { left: 'raised' | 'mid' | 'down' | 'unknown'; right: 'raised' | 'mid' | 'down' | 'unknown' }
  knees_toward: Toward; feet_toward: Toward; legs_toward: Toward
  leg_offset: number | null; frames: number
  // front / back / side to the camera, from the shoulder order (absent on older readings)
  facing?: 'front' | 'back' | 'side' | 'unknown'
}
export interface PoseKeyFrame { t_s: number; people: Array<{ box: number[]; keypoints: number[][] }> }
export interface PoseLookResult {
  label: string; start_s: number; end_s: number; frames_used: number
  people: number | null; people_max: number | null; no_person: boolean | null
  main_start: BodyReading | null; main_end: BodyReading | null
  leg_side_start: LegSide; leg_side_end: LegSide; body_angle_end: number | null
  key_frames: PoseKeyFrame[]
}
export interface PoseMove { t_s: number; from_s: number; to_s: number; area: 'upper' | 'lower'; direction: 'image-left' | 'image-right' | 'image-up' | 'image-down'; strength: number }
export interface CameraMove { t_s: number; from_s: number; to_s: number; direction: 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down'; strength: number }
export interface PoseResult { model: string; looks: PoseLookResult[]; moves: PoseMove[]; camera_moves: CameraMove[] }
export interface ImagePose { model: string; people: number; no_person: boolean; main: Omit<BodyReading, 'frames'> | null; /** the main person's box in frame fractions [x0,y0,x1,y1] */ box?: number[]; /** false when something hides the head: the box's top is then not the head */ head_seen?: boolean; /** the head box in frame fractions, null when no head point is seen */ head?: number[] | null; /** shoulders to ankles in frame heights, null unless all four are seen */ body_len?: number | null; /** midway between shoulders and ankles [x,y] in frame fractions */ body_mid?: number[] | null }
