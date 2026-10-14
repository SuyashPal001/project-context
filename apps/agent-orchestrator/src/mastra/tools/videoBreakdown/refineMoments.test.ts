import { it, expect, vi } from 'vitest'
const ai = vi.fn()
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
import { limbBox, refineMoments } from './refineMoments.js'

it('maps limbs to the right part of the subject', () => {
  expect(limbBox('legs', [0.2, 0.1, 0.8, 0.9])).toEqual([0.2, 0.46, 0.8, 0.9])
  expect(limbBox('head', [0.2, 0.1, 0.8, 0.9])).toEqual([0.2, 0.1, 0.8, 0.26])
  expect(limbBox('right arm', null)).toEqual([0.1, 0.1, 0.9, 0.9])
})

it('writes measured times onto moments and moves, keeping unmeasured ones as they were', async () => {
  ai.mockResolvedValue({ items: [
    { id: 'm0', t_s_in: 1.5, t_s: 1.25, measured: true, strength: 9 },
    { id: 'l0-v0', t_s_in: 3.0, t_s: 3.3, measured: true, strength: 6 },
    { id: 'm1', t_s_in: 5.0, t_s: 5.0, measured: false, strength: 0 },
  ] })
  const overview = { subject_box: [0.2, 0.1, 0.8, 0.9], moments: [{ t_s: 1.5, what: 'points remote up', why_it_matters: '' }, { t_s: 5.0, what: 'blade covers', why_it_matters: '' }],
    looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 5, moves: [{ t_s: 3.0, limb: 'legs', direction: 'image-right', how: 'slide' }] }] } as any
  const r = await refineMoments('/m/a.mp4', overview, [[4.5, 6.1]])
  expect(r.overview.moments[0]).toMatchObject({ t_s: 1.25, measured: true })
  expect(r.overview.moments[1]).toMatchObject({ t_s: 5.0, measured: false })
  expect(r.overview.looks[0].moves![0]).toMatchObject({ t_s: 3.3, measured: true })
  expect(r).toMatchObject({ refined: 2, unmeasured: 1 })
  expect(ai.mock.calls[0][1].exclude).toEqual([[4.5, 6.1]])
})

it('leaves everything unmeasured when ai-service fails', async () => {
  ai.mockRejectedValue(new Error('ai-service 502'))
  const overview = { subject_box: null, moments: [{ t_s: 1, what: 'x', why_it_matters: '' }], looks: [] } as any
  const r = await refineMoments('/m/a.mp4', overview, [])
  expect(r.overview.moments[0]).toMatchObject({ t_s: 1, measured: false })
  expect(r.unmeasured).toBe(1)
})
