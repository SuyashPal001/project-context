// Test-only fixtures for the remake modules (not imported by production code).
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'

export const body = (o: Partial<BodyReading> = {}): BodyReading => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 0, knees: 'straight', arms: { left: 'down', right: 'down' }, knees_toward: 'center', feet_toward: 'center', legs_toward: 'center', leg_offset: 0, frames: 3, ...o })

export function breakdown(o: Partial<Breakdown> = {}): Breakdown {
  return {
    video: { fileId: 'vid', durationS: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, caption: null, song: null, youtubeUrl: null, platform: 'upload', tooLong: false },
    overview: {
      format: 'f', layout: 'full frame', change_style: ['hard_cuts'],
      looks: [
        { label: 'a', approx_start_s: 0, approx_end_s: 4, outfit: 'red dress', expression: 'mouth closed', start_pose: 'stands', end_pose: 'stands', moves: [], measured: 'Measured: 1 person, full body' },
        { label: 'b', approx_start_s: 4, approx_end_s: 10, outfit: 'blue suit', expression: 'smiles', start_pose: 'sits', end_pose: 'stands', moves: [{ t_s: 6, limb: 'legs', direction: 'up', how: 'stands up' }] },
      ],
      subject_box: null, story: { setup: 's', cause: 'c', payoff: 'p' },
      moments: [{ t_s: 6, what: 'stands up', why_it_matters: 'payoff' }], setting: { floor: 'wood' },
      props: [{ prop: 'remote', where: 'left', when: 'all' }], trick: 'cut', sound: '', voice_lines: null, on_screen_text: ['SALE'],
      music: { mood: 'upbeat', genre: 'pop', instruments: '', has_vocals: true, song_name: null },
      keep_for_clone: [], swap_for_clone: [], never_copy: [],
    },
    measured: true, cuts: { cuts: [4], fades: [], duration_s: 10 }, hidden_cuts: [], sound: null,
    pose: { model: 'm', moves: [], camera_moves: [], looks: [
      { label: 'a', start_s: 0, end_s: 4.1, frames_used: 20, people: 1, people_max: 1, no_person: false, main_start: body(), main_end: body(), leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [{ t_s: 0.2, people: [] }, { t_s: 3.9, people: [] }] },
      { label: 'b', start_s: 4.1, end_s: 10, frames_used: 30, people: 1, people_max: 1, no_person: false, main_start: body({ knees: 'bent' }), main_end: body(), leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [] },
    ] },
    shots: [], sound_arc: '', short_shot_check: { checked: 0, status: 'ok' }, warnings: [],
    ...o,
  } as Breakdown
}
