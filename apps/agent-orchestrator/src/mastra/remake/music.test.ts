import { it, expect, vi } from 'vitest'
import { musicPrompt } from './music.js'
import { writePlan, applyEdits } from './plan.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }

it('an instrumental in the reference mood and genre, never the song itself', async () => {
  const b = breakdown(); b.overview.music = { mood: 'upbeat', genre: 'pop', instruments: 'synth, claps', has_vocals: true, song_name: 'Famous Song' }
  const p = musicPrompt(await writePlan(b, brand, vi.fn().mockResolvedValue({ lines: [] })))
  expect(p).toMatch(/instrumental/i)
  expect(p).toMatch(/upbeat/)
  expect(p).toMatch(/synth, claps/)
  expect(p).not.toMatch(/Famous Song/)
  expect(p).toMatch(/no vocals/i)
})

it("uses the user's music swap when they edited it", async () => {
  const plan = applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'sound.music', action: 'swap', to: 'calm lo-fi piano' }], brand)
  expect(musicPrompt(plan)).toMatch(/calm lo-fi piano/)
})
