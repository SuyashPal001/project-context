import { describe, it, expect, vi } from 'vitest'
import { planRefs, enforceRules, applyEdits, writePlan } from './plan.js'
import { remakeLooks } from './looks.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli lemon soda', audience: 'college students' }

describe('planRefs', () => {
  it('lists every breakdown element once, with cast only when someone is on screen', () => {
    const b = breakdown()
    const refs = planRefs(b, remakeLooks(b)).map((r) => r.ref)
    expect(refs).toEqual(['story', 'setting', 'cast', 'looks[0].outfit', 'looks[0].expression', 'looks[1].outfit', 'looks[1].expression', 'moments[0]', 'props[0]', 'onScreenText[0]', 'sound.music', 'trick'])
    const empty = breakdown(); empty.pose!.looks = empty.pose!.looks.map((l) => ({ ...l, people: 0, no_person: true }))
    expect(planRefs(empty, remakeLooks(empty)).map((r) => r.ref)).not.toContain('cast')
  })
})

describe('enforceRules', () => {
  const b = breakdown()
  const refs = planRefs(b, remakeLooks(b))
  const ctx = { brand, musicMood: 'upbeat, pop' }
  it('fills every missing ref with keep, marked auto', () => {
    const { lines } = enforceRules([], refs, ctx)
    expect(lines.map((l) => l.ref)).toEqual(refs.map((r) => r.ref))
    expect(lines.find((l) => l.ref === 'story')).toMatchObject({ action: 'keep', auto: true })
  })
  it('never keeps the music, the reference text, or the person', () => {
    const { lines, warnings } = enforceRules([
      { ref: 'sound.music', action: 'keep' }, { ref: 'onScreenText[0]', action: 'keep' }, { ref: 'cast', action: 'keep' },
    ], refs, ctx)
    expect(lines.find((l) => l.ref === 'sound.music')).toMatchObject({ action: 'swap', to: 'new music, same mood: upbeat, pop' })
    expect(lines.find((l) => l.ref === 'onScreenText[0]')).toMatchObject({ action: 'drop' })
    expect(lines.find((l) => l.ref === 'cast')).toMatchObject({ action: 'swap', to: 'a new person who fits college students' })
    expect(warnings).toHaveLength(3)
  })
  it('drops unknown refs and turns a swap with no replacement into keep, with warnings', () => {
    const { lines, warnings } = enforceRules([{ ref: 'looks[9].outfit', action: 'swap', to: 'x' }, { ref: 'props[0]', action: 'swap' }], refs, ctx)
    expect(lines.some((l) => l.ref === 'looks[9].outfit')).toBe(false)
    expect(lines.find((l) => l.ref === 'props[0]')).toMatchObject({ action: 'keep' })
    expect(warnings.join(' ')).toMatch(/looks\[9\]\.outfit/)
  })
  it('keeps the first line for a duplicated ref', () => {
    const { lines } = enforceRules([{ ref: 'story', action: 'drop', why: 'a' }, { ref: 'story', action: 'keep' }], refs, ctx)
    expect(lines.filter((l) => l.ref === 'story')).toEqual([{ ref: 'story', action: 'drop', why: 'a' }])
  })
})

describe('writePlan', () => {
  it('asks once with every ref and the brand, then enforces the rules', async () => {
    const ask = vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow Bubbli tee' }, { ref: 'sound.music', action: 'keep' }] })
    const plan = await writePlan(breakdown(), brand, ask)
    const sent = (ask.mock.calls[0][0] as Array<{ text: string }>)[0].text
    expect(sent).toContain('looks[1].expression')
    expect(sent).toContain('Bubbli lemon soda')
    expect(sent).toMatch(/never a real or famous person/i)
    expect(plan.lines.find((l) => l.ref === 'looks[0].outfit')).toMatchObject({ action: 'swap', to: 'yellow Bubbli tee' })
    expect(plan.lines.find((l) => l.ref === 'sound.music')?.action).toBe('swap')
    expect(plan.needsCasting).toBe(true)
    expect(plan.aspectRatio).toBe('9:16')
    expect(plan.reference.videoFileId).toBe('vid')
  })
})

describe('applyEdits', () => {
  it('replaces lines by ref and re-applies the rules (an edit cannot keep the music)', async () => {
    const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const next = applyEdits(plan, [{ ref: 'looks[1].outfit', action: 'swap', to: 'green kurta' }, { ref: 'sound.music', action: 'keep' }], brand)
    expect(next.lines.find((l) => l.ref === 'looks[1].outfit')?.to).toBe('green kurta')
    expect(next.lines.find((l) => l.ref === 'sound.music')?.action).toBe('swap')
    expect(next.warnings.join(' ')).toMatch(/music/)
  })
})
