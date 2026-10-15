import { it, expect, vi } from 'vitest'
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { precheckPrompt, promptCheckScorer } from './promptCheck.js'
import { runGate } from './gate.js'
import { CheckUnavailableError } from '../../tools/tvcChecks.js'

const look = { expression: 'mouth gently closed, poised, no smile', leg_side: 'image-right' }
it('blocks a smile against a closed-mouth expression without any model call', async () => {
  expect(precheckPrompt('She smiles warmly and laughs', look)).toEqual(expect.arrayContaining([expect.stringMatching(/smile/i)]))
  const ask = vi.fn()
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'She smiles at the camera.', planLine: 'look 2 hold', look, startFrameObjects: [], keyMoments: [] }, [])
  expect(r.status).toBe('fail')
  expect(ask).not.toHaveBeenCalled()
})
it('blocks on any judge finding', async () => {
  const ask = vi.fn(async () => ({ invented: [], contradicts: ['legs drift LEFT but plan says image-right'], missing: [], hand_on_absent_object: [] }))
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'legs drift to the left', planLine: 'legs right', look, startFrameObjects: ['remote'], keyMoments: [] }, [])
  expect(r).toMatchObject({ status: 'fail', reason: expect.stringMatching(/image-right/) })
})
it('passes a clean prompt', async () => {
  const ask = vi.fn(async () => ({ invented: [], contradicts: [], missing: [], hand_on_absent_object: [] }))
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'she holds still, mouth closed', planLine: 'hold', look, startFrameObjects: [], keyMoments: [] }, [])
  expect(r.status).toBe('pass')
})
it('a judge that is down gives unknown, never pass', async () => {
  const ask = vi.fn(async () => { throw new CheckUnavailableError('gateway 503') })
  const r = await runGate(promptCheckScorer, 'prompt', { ask, prompt: 'she holds still', planLine: 'hold', look, startFrameObjects: [], keyMoments: [] }, [])
  expect(r.status).toBe('unknown')
})
it('does not block a prompt that says the smile is absent (review I2)', () => {
  expect(precheckPrompt('Mouth closed, no smile, poised gaze', look)).toEqual([])
  expect(precheckPrompt('She does not smile; lips together', look)).toEqual([])
  expect(precheckPrompt('calm face without smiling or showing teeth', look)).toEqual([])
})
it('still blocks a positive smile next to a negated one', () => {
  expect(precheckPrompt('no grin at first, then she smiles', look)).not.toEqual([])
})
it('treats "poised" alone as not a no-smile expression (review I2)', () => {
  expect(precheckPrompt('she smiles softly', { expression: 'poised, soft smile' })).toEqual([])
})
