import { describe, it, expect, vi } from 'vitest'
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
import {
  type AskFn, type AskPart, type Img, CheckUnavailableError, gatewayAsk, parseJsonObject, evenTimes, lastTimes,
  productQuestion, checkProduct, checkGlitches, checkExtras, checkLeadClone, checkLeadFace, checkAction, trimStartFor,
  runNarrowClipChecks, runStillChecks, chooseTextPosition, chooseCardColumn, faceBoxes, PRO_CHECK_MODEL,
} from './tvcChecks.js'

const img = (n: string): Img => ({ data: n, mime: 'image/jpeg' })
const lastText = (parts: AskPart[]) => (parts[parts.length - 1] as { text: string }).text
// A fake model: answers by which question it was asked.
function fakeAsk(answer: (q: string, parts: AskPart[]) => Record<string, unknown>): AskFn & { calls: AskPart[][] } {
  const calls: AskPart[][] = []
  const fn = (async (parts: AskPart[]) => { calls.push(parts); return answer(lastText(parts), parts) }) as AskFn & { calls: AskPart[][] }
  fn.calls = calls
  return fn
}

describe('gatewayAsk', () => {
  it('posts one Pro question with the frames as data URIs and parses the JSON', async () => {
    let body: { model: string; messages: Array<{ content: Array<{ type: string }> }> } | null = null
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"visible":true}\n```' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch
    const v = await gatewayAsk('t1', fetchImpl)([{ image: img('AAA') }, { text: 'q' }])
    expect(v).toEqual({ visible: true })
    expect(body!.model).toBe(PRO_CHECK_MODEL)
    expect(body!.messages[0].content.map((c) => c.type)).toEqual(['image_url', 'text'])
  })
  it('retries once and then throws CheckUnavailableError (never a pass)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(gatewayAsk('t1', fetchImpl)([{ text: 'q' }])).rejects.toBeInstanceOf(CheckUnavailableError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('parseJsonObject ignores arrays and junk', () => {
    expect(parseJsonObject('[1]')).toBeNull()
    expect(parseJsonObject('no json')).toBeNull()
    expect(parseJsonObject('x {"a":1} y')).toEqual({ a: 1 })
  })
})

describe('frame times', () => {
  it('spreads frames evenly and takes the last three near the end', () => {
    expect(evenTimes(3, 2)).toEqual([1, 2])
    expect(lastTimes(3)).toEqual([2.25, 2.64, 2.9])
  })
})

describe('product check (C1–C3)', () => {
  it('asks material, shape and cap for close shots, only colour and label for wide shots', () => {
    expect(productQuestion('close')).toMatch(/glass vs plastic/)
    expect(productQuestion('close')).toMatch(/cap or closure/)
    expect(productQuestion('wide')).not.toMatch(/glass vs plastic|shape/)
    expect(productQuestion('wide')).toMatch(/label colour/)
    expect(productQuestion('close', 'the bottle has no cap')).toMatch(/the bottle has no cap/)
  })
  it('fails when the product must be visible and one frame lacks it (the vanished bottle)', async () => {
    let i = 0
    const ask = fakeAsk(() => (i++ === 2 ? { visible: false, same: true } : { visible: true, same: true }))
    const r = await checkProduct(ask, img('P'), [img('1'), img('2'), img('3'), img('4'), img('5')], { scale: 'medium', mustBeVisible: true })
    expect(r.passed).toBe(false)
    expect(r.allVisible).toBe(false)
    expect(r.reason).toMatch(/not visible/)
    expect(ask.calls).toHaveLength(5)
  })
  it('fails a visible but different product with the model\'s reason', async () => {
    const ask = fakeAsk(() => ({ visible: true, same: false, why: 'plastic, not glass' }))
    const r = await checkProduct(ask, img('P'), [img('1')], { scale: 'close', mustBeVisible: true })
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/plastic, not glass/) })
  })
  it('passes a product that is not visible when visibility is not required', async () => {
    const ask = fakeAsk(() => ({ visible: false, same: true }))
    expect((await checkProduct(ask, img('P'), [img('1')], { scale: 'close', mustBeVisible: false })).passed).toBe(true)
  })
})

describe('glitches, extras, clone, lead face (C4–C6)', () => {
  it('fails any glitch item and names it', async () => {
    const ask = fakeAsk(() => ({ duplicate_object: true, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, what: 'two vending machines' }))
    const r = await checkGlitches(ask, [img('1')])
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/two vending machines/) })
  })
  it('extras: a single still with nobody behind fails; clips fail only when 2+ frames are empty', async () => {
    expect((await checkExtras(fakeAsk(() => ({ extras: false })), [img('1')])).passed).toBe(false)
    let i = 0
    expect((await checkExtras(fakeAsk(() => ({ extras: i++ !== 0 })), [img('1'), img('2'), img('3')])).passed).toBe(true)
    let j = 0
    expect((await checkExtras(fakeAsk(() => ({ extras: j++ === 0 })), [img('1'), img('2'), img('3')])).passed).toBe(false)
  })
  it('clone: one lookalike in any frame fails with LEAD_CLONED and where it is', async () => {
    let i = 0
    const ask = fakeAsk(() => ({ others: i++ === 1 ? [{ where: 'left, girl with notebook', looks_like_lead: true }] : [{ where: 'boy', looks_like_lead: false }] }))
    const r = await checkLeadClone(ask, img('L'), [img('1'), img('2'), img('3')])
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/LEAD_CLONED.*left, girl with notebook/) })
  })
  it('lead face: fails when the lead is missing or a different face', async () => {
    expect((await checkLeadFace(fakeAsk(() => ({ lead_present: true, same_face: false, why: 'rounder face' })), img('L'), img('S'))).passed).toBe(false)
    expect((await checkLeadFace(fakeAsk(() => ({ lead_present: true, same_face: true })), img('L'), img('S'))).passed).toBe(true)
  })
})

describe('action, end state, physics, motion reversal (C7) and trim window (C8)', () => {
  const frames = [0.3, 0.7, 1.0].map((t, i) => ({ t, img: img(String(i)) }))
  it('fails ACTION_NOT_COMPLETED when the cap is still on at the end (the 2026-10-05 opener)', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.34 } : q.includes('impossible') ? { impossible: true, what: 'cap flies but bottle stays capped' } : { holds: false, why: 'green cap still on' })
    const r = await checkAction(ask, frames, [img('a'), img('b'), img('c')], 'cap pops off on the opener', 'the bottle has no cap')
    expect(r.passed).toBe(false)
    expect(r.endStateTrue).toBe(false)
    expect(r.reason).toMatch(/ACTION_NOT_COMPLETED/)
    expect(r.reason).toMatch(/impossible/)
  })
  it('fails when the action never happens', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: null } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await checkAction(ask, frames, [], 'she spins all the way around once')
    expect(r).toMatchObject({ passed: false, actionTime: null })
  })
  it('fails a movement that reverses mid-way and names it (the v5 spin)', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.2 } : q.includes('impossible') ? { impossible: false }
      : q.includes('reverse') ? { reversal: true, what: 'the spin turns back the other way halfway' } : { holds: true })
    const r = await checkAction(ask, frames, [], 'she spins all the way around in one direction, 360°')
    expect(r.passed).toBe(false)
    expect(r.reversed).toBe(true)
    expect(r.reason).toMatch(/Movement reverses mid-way: the spin turns back the other way halfway/)
  })
  it('passes a real pop with the bottle open at the end', async () => {
    const ask = fakeAsk((q) => q.includes('at which') ? { action_time: 1.67 } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await checkAction(ask, frames, [img('a'), img('b'), img('c')], 'cap pops off', 'the bottle has no cap')
    expect(r).toMatchObject({ passed: true, actionTime: 1.67, endStateTrue: true, reversed: false })
  })
  it('centres the trim window on the action, clamped to the clip', () => {
    expect(trimStartFor(1.67, 0.88, 3)).toBe(1.32)
    expect(trimStartFor(0.1, 1, 3)).toBe(0)
    expect(trimStartFor(2.9, 1, 3)).toBe(2)
    expect(trimStartFor(null, 1, 3)).toBe(0.4)
  })
})

describe('runNarrowClipChecks / runStillChecks', () => {
  const sample = vi.fn(async (times: number[]) => times.map((t) => img(`f${t}`)))
  it('runs only the checks whose inputs are given, and reports a trim window', async () => {
    const ask = fakeAsk((q) => q.includes('duplicate_object') ? { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false }
      : q.includes('at which') ? { action_time: 1.5 } : q.includes('impossible') ? { impossible: false } : { holds: true })
    const r = await runNarrowClipChecks(ask, sample, { duration: 3, action: 'cap pops off', endState: 'no cap', shotDurationSeconds: 0.88 })
    expect(r.passed).toBe(true)
    expect(r.trimStartSeconds).toBe(1.15)
    expect(r.productVisible).toBeUndefined()
  })
  it('a still with a cloned lead fails', async () => {
    const ask = fakeAsk((q) => q.includes('duplicate_object') ? { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false }
      : q.includes('OTHER person') ? { others: [{ where: 'behind her', looks_like_lead: true }] } : { extras: true })
    const r = await runStillChecks(ask, img('S'), { lead: img('L'), expectExtras: true })
    expect(r.passed).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/LEAD_CLONED/)
  })
})

describe('face-aware placement (O1)', () => {
  it('moves text off a face and shrinks to top when every band has a face', () => {
    expect(chooseTextPosition([{ x0: 0.4, y0: 0.05, x1: 0.6, y1: 0.3 }], 'top').position).toBe('center')
    expect(chooseTextPosition([{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }], 'center').position).toBe('top')
    expect(chooseTextPosition([{ x0: 0, y0: 0, x1: 1, y1: 1 }], 'center')).toEqual({ position: 'top', shrink: true })
    expect(chooseTextPosition([], 'bottom')).toEqual({ position: 'bottom', shrink: false })
  })
  it('puts the end card in a third with no face', () => {
    expect(chooseCardColumn([])).toBe('center')
    expect(chooseCardColumn([{ x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.5 }])).toBe('right')
    expect(chooseCardColumn([{ x0: 0.4, y0: 0, x1: 1, y1: 1 }])).toBe('left')
  })
  it('faceBoxes drops malformed boxes', async () => {
    const ask = fakeAsk(() => ({ faces: [{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, { x0: 'a' }] }))
    expect(await faceBoxes(ask, img('F'))).toEqual([{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }])
  })
})
