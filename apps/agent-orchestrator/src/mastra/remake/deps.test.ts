import { it, expect, afterEach } from 'vitest'
import { remakeDeps, setRemakeDeps } from './deps.js'

afterEach(() => setRemakeDeps(null))

it('overrides only the parts a test sets, and resets to the real ones', async () => {
  setRemakeDeps({ imageRateMicro: async () => 5n })
  expect(await remakeDeps().imageRateMicro()).toBe(5n)
  expect(typeof remakeDeps().generateStill).toBe('function')
  setRemakeDeps(null)
  expect(remakeDeps().imageRateMicro).not.toBe(undefined)
})
