import { it, expect } from 'vitest'
import { goldenCutsScorer, goldenHiddenCutsScorer, goldenMomentsScorer, goldenLegsScorer, missingFixtures, itemsWithTruth } from './goldenScorers.js'
const out = { cuts: { cuts: Array.from({ length: 32 }, (_, i) => i) }, hidden_cuts: [{ at_s: 5.43 }, { at_s: 9.23 }, { at_s: 12.78 }],
  overview: { moments: [{ t_s: 1.3, what: 'points remote up', measured: true }, { t_s: 3.2, what: 'legs slide right', measured: false }], looks: [{ leg_side: 'image-right' }, { leg_side: 'image-left' }, { leg_side: 'center' }, { leg_side: 'image-left' }] } }
it('cuts within 15%', async () => { expect((await goldenCutsScorer.run({ input: {}, output: out, groundTruth: { cutCount: 30 } })).score).toBe(1) })
it('cuts outside 15% fail', async () => { expect((await goldenCutsScorer.run({ input: {}, output: out, groundTruth: { cutCount: 20 } })).score).toBe(0) })
it('hidden cuts within 0.4s', async () => { expect((await goldenHiddenCutsScorer.run({ input: {}, output: out, groundTruth: { hiddenCuts: [5.3, 9.1, 12.7] } })).score).toBe(1) })
it('a missed hidden cut fails', async () => { expect((await goldenHiddenCutsScorer.run({ input: {}, output: { ...out, hidden_cuts: [{ at_s: 5.43 }] }, groundTruth: { hiddenCuts: [5.3, 9.1] } })).score).toBe(0) })
it('moments count only when MEASURED and within 0.5s', async () => {
  expect((await goldenMomentsScorer.run({ input: {}, output: out, groundTruth: { moments: [{ t_s: 1.25 }, { t_s: 3.25 }] } })).score).toBe(0.5)
})
it('leg sides as a fraction', async () => {
  expect((await goldenLegsScorer.run({ input: {}, output: out, groundTruth: { legSides: ['image-right', 'image-left', 'image-right', 'image-left'] } })).score).toBe(0.75)
})
it('reports missing fixture videos instead of passing silently', () => {
  expect(missingFixtures([{ input: { filePath: '/definitely/missing.mp4' } }])).toEqual(['/definitely/missing.mp4'])
})
it('scores a scorer only on videos that have truth for it', () => {
  const data = [{ input: { filePath: 'a' }, groundTruth: { moments: [{ t_s: 1 }] } }, { input: { filePath: 'b' }, groundTruth: { moments: [] } }, { input: { filePath: 'c' } }]
  expect(itemsWithTruth(data, 'moments').map((d) => d.input.filePath)).toEqual(['a'])
})
it('unmeasured cuts never pass the cuts gate (review M1)', async () => {
  expect((await goldenCutsScorer.run({ input: {}, output: { ...out, cuts: null }, groundTruth: { cutCount: 0 } })).score).toBe(0)
})
it('a spurious cut on a 0-cut video fails', async () => {
  expect((await goldenCutsScorer.run({ input: {}, output: { ...out, cuts: { cuts: [3.1] } }, groundTruth: { cutCount: 0 } })).score).toBe(0)
})
