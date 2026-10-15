import { it, expect, vi } from 'vitest'
import { differenceNote } from './finalNote.js'
import { writePlan, applyEdits } from './plan.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const plan = async () => applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow tee' }], brand)

it('says what changed on purpose, what stayed a still, the fallback, failed checks, and the AI label', async () => {
  const note = differenceNote({
    plan: await plan(),
    stills: [],
    clips: [
      { look: 1, fileId: 'c1', localPath: '/x', engine: 'omni', fallback: true, status: 'passed', reasons: [] },
      { look: 2, fileId: null, localPath: null, engine: 'none', fallback: false, status: 'still', reasons: ['this part is too long to animate yet, so it stays a still'] },
    ],
    checks: [{ name: 'brightness-jumps', status: 'fail', reason: 'reference 0, remake 1', evidenceTimes: [] }, { name: 'same-person', status: 'unknown', reason: 'x', evidenceTimes: [] }],
  })
  expect(note).toMatch(/yellow tee/)
  expect(note).toMatch(/part 2.*too long/i)
  expect(note).toMatch(/part 1.*simpler way/i)
  expect(note).toMatch(/brightness/i)
  expect(note).toMatch(/couldn’t be checked/)
  expect(note.trim().split('\n').pop()).toMatch(/AI-generated/)
  expect(note).not.toMatch(/veo|omni|gemini|lyria|ai-service|gateway/i)
})

it('a comparison that could not run is said plainly, never as a match (Review Focus 5)', async () => {
  const note = differenceNote({ plan: await plan(), stills: [], clips: [], checks: null })
  expect(note).toMatch(/couldn’t be run this time/)
  expect(note).not.toMatch(/matches/)
})
