import { describe, it, expect, vi } from 'vitest'
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { runGate } from './gate.js'
import { propCountScorer, samePersonScorer, poseLegsScorer, expressionScorer, emptyHandScorer } from './visionScorers.js'
import { CheckUnavailableError } from '../../tools/tvcChecks.js'

const img = { data: 'AA', mime: 'image/jpeg' }
const askReturning = (...vs: Array<Record<string, unknown>>) => { const f = vi.fn(); for (const v of vs) f.mockResolvedValueOnce(v); return f }

describe('runGate', () => {
  it('passes only on score 1 with status pass', async () => {
    const r = await runGate(propCountScorer, 'props', { ask: askReturning({ counts: [1, 1] }), frames: [img, img], prop: 'black remote', expected: 1 }, [0, 0.5])
    expect(r).toEqual({ name: 'props', status: 'pass', reason: expect.any(String), evidenceTimes: [0, 0.5] })
  })
  it('a check model that is down gives unknown, never pass', async () => {
    const ask = vi.fn(async () => { throw new CheckUnavailableError('down') })
    const r = await runGate(propCountScorer, 'props', { ask, frames: [img], prop: 'remote', expected: 1 }, [0])
    expect(r.status).toBe('unknown')
  })
  it('a junk reply (missing keys twice) gives unknown, never pass', async () => {
    const r = await runGate(samePersonScorer, 'face', { ask: askReturning({ nope: 1 }, { nope: 2 }), reference: img, frames: [img] }, [1])
    expect(r.status).toBe('unknown')
  })
})

describe('vision scorers', () => {
  it('prop count fails on a second remote', async () => {
    const r = await runGate(propCountScorer, 'props', { ask: askReturning({ counts: [1, 2] }), frames: [img, img], prop: 'black remote', expected: 1 }, [0, 0.5])
    expect(r.status).toBe('fail')
  })
  it('same person fails below 8/10', async () => {
    const r = await runGate(samePersonScorer, 'face', { ask: askReturning({ scores: [9, 6], differences: 'rounder jaw' }), reference: img, frames: [img, img] }, [1, 5])
    expect(r).toMatchObject({ status: 'fail' })
  })
  it('pose+legs judges the FEET side', async () => {
    const r = await runGate(poseLegsScorer, 'legs', { ask: askReturning({ feet: 'image-left', knees: 'image-right', same_pose: true, body_axis_same: true }), reference: img, frame: img, expectedFeet: 'image-left' }, [14.4])
    expect(r.status).toBe('pass')
  })
  it('pose+legs fails on a tilted body axis even when feet match', async () => {
    const r = await runGate(poseLegsScorer, 'legs', { ask: askReturning({ feet: 'image-right', knees: 'image-right', same_pose: true, body_axis_same: false }), reference: img, frame: img, expectedFeet: 'image-right' }, [11])
    expect(r.status).toBe('fail')
  })
  it('expression fails when the mouth differs', async () => {
    const r = await runGate(expressionScorer, 'expression', { ask: askReturning({ same_mouth: false, same_eyes: true, same_mood: false, what: 'smiling with teeth' }), reference: img, frame: img, expected: 'mouth closed, poised' }, [7])
    expect(r.status).toBe('fail')
  })
  it('empty hand action fails', async () => {
    const r = await runGate(emptyHandScorer, 'empty-hand', { ask: askReturning({ empty_hand_action: true, what: 'pinches air near shoulder' }), frames: [img, img] }, [9.5, 10])
    expect(r.status).toBe('fail')
  })
})

describe('nothing to look at is never a pass', () => {
  it('same person with no candidate frames is unknown', async () => {
    const ask = vi.fn()
    const r = await runGate(samePersonScorer, 'face', { ask, reference: img, frames: [] }, [])
    expect(r.status).toBe('unknown')
    expect(ask).not.toHaveBeenCalled()
  })
  it('prop count with no frames is unknown', async () => {
    const r = await runGate(propCountScorer, 'props', { ask: vi.fn(), frames: [], prop: 'remote', expected: 1 }, [])
    expect(r.status).toBe('unknown')
  })
  it('empty hand with no frames is unknown', async () => {
    const r = await runGate(emptyHandScorer, 'empty-hand', { ask: vi.fn(), frames: [] }, [])
    expect(r.status).toBe('unknown')
  })
})
