// Person vs styling (user, 2026-10-16): the same person needs hair open in one look and a bun with a
// maang tikka in another. The person (face, body) is cast once in plain styling; each look's styling
// (hair, jewellery, makeup) is a plan line, and each distinct styling gets one picture made by EDITING
// the chosen person, which that look's stills use as the person. The face check judges the face only.
// Styling test: two styled edits of one plain base kept her face, and their fan photos followed the styling.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { writePlan, planRefs } from './plan.js'
import { remakeLooks } from './looks.js'
import { castSheetPrompt, REFERENCE_SHEET_PROMPT, stillPrompt, stylingOf, styledPersonPrompt } from './prompts.js'
import { remakeStillChecks } from './stillChecks.js'
import { LEAD_FACE_ONLY_QUESTION } from '../tools/tvcChecks.js'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'Noor', product: 'festive wear' }
const styled = () => {
  const b = breakdown()
  b.overview.looks[0] = { ...b.overview.looks[0], styling: 'hair open in soft waves, gold jhumkas' }
  b.overview.looks[1] = { ...b.overview.looks[1], styling: 'hair in a low bun, maang tikka' }
  return b
}

describe('styling is per look, not part of the person', () => {
  it('each look with a person has a styling plan line', () => {
    const b = styled()
    expect(planRefs(b, remakeLooks(b)).filter((r) => /\.styling$/.test(r.ref))).toEqual([
      { ref: 'looks[0].styling', what: 'hair open in soft waves, gold jhumkas' },
      { ref: 'looks[1].styling', what: 'hair in a low bun, maang tikka' },
    ])
  })
  it('the person line never carries styling: makeup, jewellery and hair words are taken out', async () => {
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [{ ref: 'cast', action: 'swap', to: 'An elegant South Asian woman in her mid-20s with glowing skin, soft festive glam makeup, and graceful styling suited to festive ethnic occasions' }] }))
    const to = p.lines.find((l) => l.ref === 'cast')!.to!
    expect(to).toMatch(/elegant South Asian woman in her mid-20s/)
    expect(to).not.toMatch(/makeup|styling|jewell?ery|hair/i)
  })
  it('the casting sheet and the reference sheet keep styling open and never lock the hair', () => {
    expect(castSheetPrompt('a woman')).toMatch(/groomed hair worn simply, light polished makeup, no jewellery/) // ad casting, 2026-10-17
    expect(REFERENCE_SHEET_PROMPT).not.toMatch(/Skin tone · Age · Hair/)
    expect(REFERENCE_SHEET_PROMPT).toMatch(/Hair, jewellery and makeup are styling/)
  })
  it('a still says its look\'s styling, kept or swapped', async () => {
    const { applyEdits } = await import('./plan.js')
    const p = applyEdits(await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'looks[1].styling', action: 'swap', to: 'hair in a braid, gold jhumkas' }], brand)
    expect(stylingOf(p, p.looks[0])).toBe('hair open in soft waves, gold jhumkas')
    expect(stillPrompt(p, p.looks[1], 'start', brand, false)).toMatch(/Styling: hair in a braid, gold jhumkas\./)
  })
  it('a styled picture is an edit that changes only the styling', () => {
    const s = styledPersonPrompt('hair in a low bun, maang tikka')
    expect(s).toMatch(/^Edit this photo/)
    expect(s).toMatch(/Change only the styling to: hair in a low bun, maang tikka/)
    expect(s).toMatch(/same face/)
  })
})

describe('the face check judges the face, never the styling', () => {
  it('the shared question can ignore hair and jewellery, and the remake uses it', async () => {
    expect(LEAD_FACE_ONLY_QUESTION).toMatch(/hairstyle, jewellery, makeup/)
    const ask = vi.fn(async (parts: Array<{ text?: string }>) => {
      const q = parts.map((x) => x.text ?? '').join(' ')
      if (/duplicate_object/.test(q)) return { duplicate_object: false, stray_face: false, invented_text: false, cg_effect: false, flat_background: false, drawn: false, what: '' }
      if (/same_face/.test(q)) return { lead_present: true, same_face: true, why: '' }
      return { others: [] }
    })
    const img = { data: 'AA', mime: 'image/jpeg' }
    await remakeStillChecks(ask as never, img, { lead: img, leadInShot: true })
    expect(ask.mock.calls.some((c) => (c[0] as Array<{ text?: string }>).some((x) => x.text === LEAD_FACE_ONLY_QUESTION))).toBe(true)
  })
})

// Styled pictures were dropped the same day: each one drifted the face. The person sheet carries the reel's
// styling and the edit chain changes it per look (editChain.test.ts), at no extra image.
describe('the quote adds nothing for styling', () => {
  it('two stylings add no images', async () => {
    const { estimateCost } = await import('./cost.js')
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const plain = { ...p, lines: p.lines.map((l) => (/\.styling$/.test(l.ref) ? { ...l, action: 'drop' as const } : l)) }
    expect(estimateCost(p, { castProvided: true, microEach: 1n }).images - estimateCost(plain, { castProvided: true, microEach: 1n }).images).toBe(0)
  })
})

// Fan run 2026-10-16: the plan writer gave every look a different hairstyle ("sleek centre-parted",
// "soft curls", "voluminous waves") though the reel keeps open hair throughout. Styling is kept from the
// reference by default; only the user's own edit changes it.
describe('styling is kept from the reference unless the user changes it', () => {
  it('a styling swap from the plan writer is kept as the reference', async () => {
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[0].styling', action: 'swap', to: 'center-parted sleek hair' }] }))
    expect(p.lines.find((l) => l.ref === 'looks[0].styling')).toMatchObject({ action: 'keep' })
    expect(stylingOf(p, p.looks[0])).toBe('hair open in soft waves, gold jhumkas')
  })
  it('the user\'s edit still changes it', async () => {
    const { applyEdits } = await import('./plan.js')
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const e = applyEdits(p, [{ ref: 'looks[0].styling', action: 'swap', to: 'hair in a bun' }], brand)
    expect(stylingOf(e, e.looks[0])).toBe('hair in a bun')
  })
})

// Fan run 2026-10-17: plain casting (no makeup, everyday clothes) gave three ordinary-looking women; the
// user: "none of it is attractive". Casting is a fashion-ad casting: attractive and camera-ready, groomed,
// light polished makeup, no jewellery, plain clothes; styling stays open for each look.
describe('casting looks like an ad casting', () => {
  it('attractive, camera-ready models with polished but open styling', () => {
    const p = castSheetPrompt('a woman')
    expect(p).toMatch(/attractive, camera-ready models, as cast for a fashion ad/)
    expect(p).toMatch(/groomed hair worn simply, light polished makeup, no jewellery, plain neutral clothes/)
    expect(p).not.toMatch(/light natural makeup, plain clothes/)
  })
  it('a note from the user steers a new casting', () => {
    expect(castSheetPrompt('a woman', 'more glamorous, fuller face')).toMatch(/The user asked for: more glamorous, fuller face\./)
  })
})
