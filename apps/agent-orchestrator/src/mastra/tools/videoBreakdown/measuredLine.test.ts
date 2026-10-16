import { it, expect } from 'vitest'
import { measuredLine } from './measuredLine.js'

const body = (o: Record<string, unknown> = {}) => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 2, knees: 'bent', arms: { left: 'down', right: 'raised' }, knees_toward: 'image-right', feet_toward: 'center', legs_toward: 'image-right', leg_offset: 0.3, frames: 5, ...o })
const look = (o: Record<string, unknown> = {}) => ({ label: 'a', start_s: 0, end_s: 5, frames_used: 20, people: 1, people_max: 1, no_person: false, main_start: body({ knees_toward: 'center', legs_toward: 'center' }), main_end: body(), leg_side_start: 'center', leg_side_end: 'image-right', body_angle_end: 2, key_frames: [], ...o }) as any

it('says what was measured, in plain words, with the moves inside the look', () => {
  const line = measuredLine(look(), [{ t_s: 1.23, from_s: 1, to_s: 1.5, area: 'upper', direction: 'image-up + image-right', strength: 0.09 }, { t_s: 7, from_s: 7, to_s: 7.2, area: 'lower', direction: 'image-left', strength: 0.05 }] as any)
  expect(line).toBe('Measured: 1 person, full body, upright in frame, knees bent, right arm raised, knees fall to image-right (at the start: center); moves: upper body up and right at 1.2s')
})

it('no person', () => {
  expect(measuredLine(look({ people: 0, no_person: true, main_start: null, main_end: null }), [])).toBe('Measured: no person in shot')
})

it('a group, lying sideways, nothing readable about the legs', () => {
  const line = measuredLine(look({ people: 4, main_end: body({ orientation: 'horizontal', knees: 'unknown', knees_toward: 'unknown', arms: { left: 'unknown', right: 'unknown' }, framing: 'waist_up' }), main_start: null }), [])
  expect(line).toBe('Measured: 4 people; main person: waist up, sideways in frame')
})

it('nothing readable at all', () => {
  expect(measuredLine(look({ people: null, no_person: null, main_start: null, main_end: null, frames_used: 0 }), [])).toBe('Measured: body not readable in this part')
})
