import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
import { claimsSummaryMarkdown, sdcDescription, summaryCounts } from './claimsSummary.js'
import { findClaims } from './claims.js'
import { tvcPlanSchema, countWords, type TvcPlan } from './tvcPlan.js'
import { runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'

const NOW = new Date('2026-10-11T10:00:00Z')
const shot = (n: number, type: string, extra: Record<string, unknown> = {}) => ({ n, type, size: n % 2 ? 'wide' : 'close_up', action: `shot ${n} action`, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', ...extra })
const plan6 = (o: { vo?: string[]; category?: string; market?: string; claims?: TvcPlan['claims']; legal?: TvcPlan['legal']; text?: string } = {}): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Fizz that wakes you up', category: o.category ?? 'beverage', tier: 'mass', objective: 'brand', market: o.market ?? 'india', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', brandName: 'Bubbli', productName: 'Bubbli Lemon Fizz' },
  look: 'bright', locations: ['kitchen'],
  shots: [shot(1, 'hook', o.text ? { text: o.text } : {}), shot(2, 'hero'), { ...shot(3, 'packshot'), audio: 'silent' }],
  voiceover: (o.vo ?? []).map((text, i) => ({ text, startSeconds: 0.2 + i * 1.6 })),
  packshot: { kind: 'product', tagline: 'Wake up to Bubbli' },
  legal: o.legal ?? [],
  ...(o.claims ? { claims: o.claims } : {}),
})
const md = (p: TvcPlan) => claimsSummaryMarkdown(p, findClaims(p), { now: NOW })
const headings = (s: string) => s.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3))

describe('claims summary markdown', () => {
  it('has every section in order for an India beverage ad', () => {
    const p = plan6({ vo: ['India’s No.1 fizz'], claims: [{ text: 'India’s No.1 fizz', status: 'no_proof' }] })
    expect(md(p).split('\n')[0]).toBe('# Claims summary — Bubbli Lemon Fizz')
    expect(headings(md(p))).toEqual(['Needs proof before airing', 'Claims', 'Also in the ad', 'Reviewed, not claims', 'SDC description', 'Full script', 'SDC checklist'])
    expect(md(p)).toContain('Made: 2026-10-11')
  })
  it('leaves out the SDC parts for a generic or non-food ad (D6)', () => {
    expect(headings(md(plan6({ market: 'generic' })))).not.toContain('SDC description')
    expect(headings(md(plan6({ category: 'fashion' })))).not.toContain('SDC checklist')
    expect(headings(md(plan6({ category: 'health' })))).toContain('SDC checklist')
  })
  it('lists no-proof, unreviewed and likely-banned claims under Needs proof, one row per phrase (F5)', () => {
    const p = plan6({ vo: ['India’s No.1 fizz', 'Controls diabetes'], claims: [{ text: 'India’s No.1 fizz', status: 'no_proof' }] })
    const section = md(p).split('## Needs proof before airing')[1].split('\n## ')[0]
    expect(section).toContain('India’s No.1 fizz — kept without proof')
    // F5: a claim that is both unreviewed AND likely-banned gets ONE row
    // with both reasons joined, not two separate rows for the same phrase.
    expect(section).toContain('Controls diabetes — not reviewed; may not be allowed (Drugs and Magic Remedies Act 1954); check with a lawyer')
    expect(section.match(/Controls diabetes/g)).toHaveLength(1)
    expect(summaryCounts(p, findClaims(p))).toEqual({ needsProof: 2, unreviewed: 1 })
  })
  it('says Nothing flagged and No claims found when there are none (E12)', () => {
    const s = md(plan6({ vo: ['Cold fizz, any time'] }))
    expect(s).toContain('Nothing flagged')
    expect(s).toContain('No claims found.')
  })
  it('links a voiceover claim to its disclaimer and escapes table cells (M4)', () => {
    const p = plan6({ vo: ['India’s No.1 fizz | for real'], legal: [{ text: 'Source: Nielsen 2026', forVoiceoverBlock: 1 }], claims: [{ text: 'India’s No.1 fizz | for real', status: 'proof', proof: 'Nielsen\nMAT 2026' }] })
    const row = md(p).split('\n').find((l) => l.startsWith('| India'))!
    expect(row).toContain('India’s No.1 fizz \\| for real')
    expect(row).toContain('Source: Nielsen 2026')
    expect(row).toContain('Nielsen MAT 2026')
  })
  it('flattens a newline in productName so it cannot inject a fake heading', () => {
    const p = tvcPlanSchema.parse({ ...plan6(), brief: { ...plan6().brief, productName: 'Bubbli\n## Fake' } })
    const s = md(p)
    expect(s.split('\n')[0]).toBe('# Claims summary — Bubbli ## Fake')
    expect(headings(s)).toEqual(['Needs proof before airing', 'Claims', 'Also in the ad', 'Reviewed, not claims', 'SDC description', 'Full script', 'SDC checklist'])
  })
  it('puts the script in time order', () => {
    const s = md(plan6({ vo: ['Cold fizz', 'Any time'], text: 'Wake up' }))
    const script = s.split('## Full script')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('- '))
    const times = script.map((l) => Number(/\[(\d+):(\d+\.\d)\]/.exec(l)!.slice(1).reduce((m, x, i) => (i === 0 ? Number(x) * 60 : m + Number(x)), 0)))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(script[0]).toContain('[0:00.0]')
  })
})

describe('F5: summary polish', () => {
  it('sdcDescription never says a claim "has not been reviewed yet" or lacks "substantiation"; it says what to do', () => {
    const p = plan6({ vo: ['India’s No.1 fizz'] })
    const d = sdcDescription(p, findClaims(p))
    expect(d).not.toContain('has not been reviewed yet')
    expect(d).not.toContain('no substantiation has been provided yet')
    expect(d).toContain('[add the proof before filing]')
  })
  it('the Claims table and the Full script agree on the jingle\'s timecode', () => {
    const p = tvcPlanSchema.parse({ ...plan6({ vo: ['Cold fizz'] }), brief: { ...plan6().brief, jingle: { line: 'Bubbli, sabse best', style: 'pop' } } })
    const s = md(p)
    const tableRow = s.split('\n').find((l) => l.includes('jingle'))!
    const scriptRow = s.split('## Full script')[1].split('\n').find((l) => l.includes('Sung:'))!
    const tc = (l: string) => /\[(\d+):(\d+\.\d)\]/.exec(l)![0]
    expect(tc(tableRow)).toBe(tc(scriptRow))
  })
})

describe('SDC description (I9)', () => {
  it('is 100–200 words for a 6s ad with no claims', () => {
    const n = countWords(sdcDescription(plan6({ vo: ['Cold fizz'] }), []))
    expect(n).toBeGreaterThanOrEqual(100)
    expect(n).toBeLessThanOrEqual(200)
  })
  it('is at most 200 words for a 30s ad with many claims, and keeps the first claim', () => {
    const claimsVo = ['India’s No.1 fizz', 'Zero sugar', '100% natural lemon', 'Doctor recommended for kids', 'Clinically proven freshness']
    const p = tvcPlanSchema.parse({ ...plan6(), brief: { ...plan6().brief, lengthSeconds: 30 }, shots: Array.from({ length: 15 }, (_, i) => (i === 14 ? { ...shot(15, 'packshot'), audio: 'silent' } : shot(i + 1, ['hook', 'hero', 'lifestyle', 'reach', 'product_macro'][i % 5]))), voiceover: claimsVo.map((text, i) => ({ text: `${text}, every single day for the whole family at home`, startSeconds: i * 5 })) })
    const d = sdcDescription(p, findClaims(p))
    expect(countWords(d)).toBeLessThanOrEqual(200)
    expect(countWords(d)).toBeGreaterThanOrEqual(100)
    expect(d).toContain('India’s No.1 fizz')
  })
})

describe('plan_tvc summary', () => {
  it('uploads the markdown and returns the counts (free)', async () => {
    const store = new Map<string, SavedPlan>([['p1', { version: 1, storageKey: 'k1', plan: plan6({ vo: ['India’s No.1 fizz'] }) }]])
    const uploads: Array<{ title: string; content: string }> = []
    const deps = {
      load: async (id: string) => structuredClone(store.get(id)!), save: async () => 'x', price: async () => ({ fullCostCredits: 0, shortfallCredits: 0 }), newKey: () => 'k',
      stillChecked: () => true, detectCutTimes: async () => ({ cutTimes: [], durationSeconds: 1 }), productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/x.jpg' }),
      upload: async (title: string, content: string) => { uploads.push({ title, content }); return 'md-1' }, now: () => NOW,
    } satisfies PlanTvcDeps
    const out = await runPlanTvc({ action: 'summary', planFileId: 'p1' }, deps)
    expect(out).toEqual({ planFileId: 'p1', fileId: 'md-1', needsProof: 1, unreviewed: 1 })
    expect(uploads[0].title).toBe('Claims summary — Bubbli Lemon Fizz')
    expect(uploads[0].content.startsWith('# Claims summary — Bubbli Lemon Fizz')).toBe(true)
  })
  it('refuses STORAGE_FAILED when the upload gives nothing', async () => {
    const store = new Map<string, SavedPlan>([['p1', { version: 1, storageKey: 'k1', plan: plan6() }]])
    const deps = {
      load: async (id: string) => structuredClone(store.get(id)!), save: async () => 'x', price: async () => ({ fullCostCredits: 0, shortfallCredits: 0 }), newKey: () => 'k',
      stillChecked: () => true, detectCutTimes: async () => ({ cutTimes: [], durationSeconds: 1 }), productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/x.jpg' }),
      upload: async () => null, now: () => NOW,
    } satisfies PlanTvcDeps
    expect((await runPlanTvc({ action: 'summary', planFileId: 'p1' }, deps)).refusalReason).toBe('STORAGE_FAILED')
  })
})
