import { describe, it, expect, vi } from 'vitest'
import { checkClip } from './clipCheck.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

const look = remakeLooks(breakdown())[1] // start: knees bent; end: straight
const img = { data: 'AA', mime: 'image/jpeg' }
const poseLook = (start = body({ knees: 'bent' }), end = body(), people: number | null = 1) => ({ model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people, people_max: people, no_person: people === 0, main_start: start, main_end: end, leg_side_start: 'center' as const, leg_side_end: 'center' as const, body_angle_end: 0, key_frames: [] }] })
const pass = (name: string) => ({ name, status: 'pass' as const, reason: '', evidenceTimes: [] })
const deps = (o: Record<string, unknown> = {}) => ({ poseClip: vi.fn(async () => poseLook()), sample: vi.fn(async () => [img, img, img, img]), gate: vi.fn(async (_s: unknown, name: string) => pass(name)), ...o })

describe('checkClip', () => {
  it('passes a clip whose measured start and end bodies match the reference look', async () => {
    const d = deps()
    expect((await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, d as never)).status).toBe('pass')
    expect(d.gate).toHaveBeenCalledTimes(2) // same person + empty hand
  })
  it('fails when the clip ends in the wrong pose (rule 5: a move must reach its end pose)', async () => {
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ poseClip: vi.fn(async () => poseLook(body({ knees: 'bent' }), body({ knees: 'bent' }))) }) as never)
    expect(r.status).toBe('fail')
    expect(r.reason).toMatch(/knees/)
  })
  it('fails an empty hand and a different person', async () => {
    const gate = vi.fn(async (_s: unknown, name: string) => (name === 'empty-hand' ? { ...pass(name), status: 'fail' as const, reason: 'hand pinches empty air' } : pass(name)))
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ gate }) as never)
    expect(r).toMatchObject({ status: 'fail', reason: expect.stringMatching(/empty air/) })
  })
  it('a measurement outage is unknown with plain words, never a pass', async () => {
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ poseClip: vi.fn(async () => { throw new Error('ai-service 500') }) }) as never)
    expect(r.status).toBe('unknown')
    expect(r.reason).not.toMatch(/ai-service/)
  })
  it('no portrait or no person: no same-person check', async () => {
    const d = deps()
    await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: null, tenantId: 't' }, d as never)
    expect(d.gate).toHaveBeenCalledTimes(1)
  })
})

// Two remotes (Omni, 2026-10-17): the clip check counts the look's objects against the approved start photo.
describe('checkClip counts the objects', () => {
  it('a doubled object fails the clip', async () => {
    const ask = vi.fn(async (parts: Array<{ image?: { data: string } }>) => ({ counts: { 'TV remote': parts[0].image?.data === 'START' ? 1 : 2 } }))
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't', startImage: { data: 'START', mime: 'image/png' }, props: ['TV remote'] }, deps({ ask }) as never)
    expect(r.status).toBe('fail')
    expect(r.reason).toMatch(/objects: an object appears more often than in the start photo: 2 TV remote/)
  })
  it('no objects in view or no start photo: no count', async () => {
    const ask = vi.fn()
    await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't', props: ['TV remote'] }, deps({ ask }) as never)
    expect(ask).not.toHaveBeenCalled()
  })
})

// fan run real23: Omni clips from photos that passed the face check scored 3/10 against the studio sheet: a
// small face lying on a rug against a big front photo. The clip is checked against its own start photo,
// which already passed against the sheet: that measures whether the face changes in the clip.
describe('checkClip same person', () => {
  it('the reference is the approved start photo when given', async () => {
    const d = deps()
    const start = { data: 'START', mime: 'image/png' }
    await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't', startImage: start }, d as never)
    const call = (d.gate as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === 'same-person')!
    expect(call[2].reference).toBe(start)
  })
})

// fan run real23: look 2's clip failed "right arm raised, not in the reference" though its approved start photo
// has the arm raised (copied from the original frame); the clip was compared with the look's first-second
// average. A clip is compared with the photos it was made from, which the user approved.
describe('checkClip pose', () => {
  it('the start and end photos\' poses are the reference when given', async () => {
    const d = deps({ poseClip: vi.fn(async () => poseLook(body({ knees: 'straight' }), body({ knees: 'bent' }))) })
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: null, tenantId: 't', startPose: body({ knees: 'straight' }), endPose: body({ knees: 'bent' }) }, d as never)
    expect(r.status).toBe('pass')
  })
})
