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
  it('the casting sheet and the reference sheet show plain styling and never lock the hair', () => {
    expect(castSheetPrompt('a woman')).toMatch(/plain everyday styling: simply worn hair, no jewellery, light natural makeup/)
    expect(REFERENCE_SHEET_PROMPT).not.toMatch(/Skin tone · Age · Hair/)
    expect(REFERENCE_SHEET_PROMPT).toMatch(/Hair, jewellery and makeup are styling/)
  })
  it('a still says its look\'s styling, kept or swapped', async () => {
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [{ ref: 'looks[1].styling', action: 'swap', to: 'hair in a braid, gold jhumkas' }] }))
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

describe('the workflow makes one styled picture per styling and gives it to that look\'s stills', () => {
  afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })
  it('styled pictures are edits of the pick; each look\'s stills get theirs; checks stay on the base', async () => {
    setRemakeStorageForTests(new InMemoryStore())
    const b = styled()
    let made = 0
    const generateStill = vi.fn(async (input: { title: string; referenceFileIds?: string[] }) => ({ fileId: /styled/i.test(input.title) ? `styled-${++made}` : `img-${++made}`, creditsUsedMicro: '100' }))
    const stillChecks = vi.fn().mockResolvedValue({ passed: true, reasons: [] })
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: generateStill as never, stillChecks,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
      upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      cutBoard: vi.fn().mockResolvedValue(null), sameSetting: vi.fn().mockResolvedValue({ same: true, differs: '' }),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
    const run = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
    await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand, castFileId: 'own' }, requestContext: rc() })
    await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: run.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
    const styledCalls = generateStill.mock.calls.filter((c) => /styled/i.test(c[0].title))
    expect(styledCalls).toHaveLength(2)
    expect(styledCalls.every((c) => (c[0].referenceFileIds ?? [])[0] === 'own')).toBe(true)
    const look1 = generateStill.mock.calls.filter((c) => /look 1 /.test(c[0].title)).map((c) => (c[0].referenceFileIds ?? [])[0])
    const look2 = generateStill.mock.calls.filter((c) => /look 2 /.test(c[0].title)).map((c) => (c[0].referenceFileIds ?? [])[0])
    expect(new Set(look1).size).toBe(1); expect(new Set(look2).size).toBe(1)
    expect(look1[0]).toMatch(/^styled-/); expect(look2[0]).toMatch(/^styled-/); expect(look1[0]).not.toBe(look2[0])
    // the face check compares against the base person (the reference sheet), never a styled picture
    expect(stillChecks.mock.calls.every((c) => !/^styled-/.test(c[2].lead?.data ?? ''))).toBe(true)
  }, 30_000)
})

describe('the quote counts one image per styling', () => {
  it('two stylings add two images', async () => {
    const { estimateCost } = await import('./cost.js')
    const p = await writePlan(styled(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const plain = { ...p, lines: p.lines.map((l) => (/\.styling$/.test(l.ref) ? { ...l, action: 'drop' as const } : l)) }
    expect(estimateCost(p, { castProvided: true, microEach: 1n }).images - estimateCost(plain, { castProvided: true, microEach: 1n }).images).toBe(2)
  })
})
