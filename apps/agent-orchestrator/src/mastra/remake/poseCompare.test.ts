import { describe, it, expect } from 'vitest'
import { comparePose } from './poseCompare.js'
import type { BodyReading, ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'

const b = (o: Partial<BodyReading> = {}): BodyReading => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 2, knees: 'straight', arms: { left: 'down', right: 'down' }, knees_toward: 'center', feet_toward: 'center', legs_toward: 'center', leg_offset: 0, frames: 3, ...o })
const got = (main: Partial<BodyReading> | null, people = 1): ImagePose => ({ model: 'm', people, no_person: people === 0, main: main ? b(main) : null })

describe('comparePose', () => {
  it('passes a matching still and a neighbouring framing', () => {
    expect(comparePose(b(), 1, got({})).status).toBe('pass')
    expect(comparePose(b(), 1, got({ framing: 'knees_up' })).status).toBe('pass')
  })
  it('fails a far framing, a flipped leg side, a missing raised arm, and a 40° tilt', () => {
    expect(comparePose(b(), 1, got({ framing: 'chest_up' })).reason).toMatch(/framing/)
    expect(comparePose(b({ knees_toward: 'image-right' }), 1, got({ knees_toward: 'image-left' })).reason).toMatch(/image-right/)
    expect(comparePose(b({ arms: { left: 'down', right: 'raised' } }), 1, got({})).reason).toMatch(/right arm/)
    expect(comparePose(b({ torso_angle_deg: 0 }), 1, got({ torso_angle_deg: 40, orientation: 'diagonal' })).status).toBe('fail')
  })
  it('no person in the reference passes only an empty still', () => {
    expect(comparePose(null, 0, got(null, 0)).status).toBe('pass')
    expect(comparePose(null, 0, got({}, 1)).status).toBe('fail')
  })
  it('fails an empty still and an extra person', () => {
    expect(comparePose(b(), 1, got(null, 0)).status).toBe('fail')
    expect(comparePose(b(), 1, got({}, 2)).reason).toMatch(/extra person/)
    expect(comparePose(b(), 3, got({}, 3)).status).toBe('pass')
  })
  it('is unknown, never a pass, when the reference was not measured or the still hides what the reference shows', () => {
    expect(comparePose(null, null, got({})).status).toBe('unknown')
    expect(comparePose(b({ knees: 'bent' }), 1, got({ knees: 'unknown' })).status).toBe('unknown')
  })
  it('skips fields the reference itself could not read', () => {
    expect(comparePose(b({ knees: 'unknown', knees_toward: 'unknown' }), 1, got({ knees: 'bent', knees_toward: 'image-left' })).status).toBe('pass')
  })
})
