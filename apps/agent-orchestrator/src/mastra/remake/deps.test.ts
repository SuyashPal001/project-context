import { describe, it, expect, afterEach } from 'vitest'
import { remakeDeps, setRemakeDeps } from './deps.js'

afterEach(() => setRemakeDeps(null))

it('overrides only the parts a test sets, and resets to the real ones', async () => {
  setRemakeDeps({ imageRateMicro: async () => 5n })
  expect(await remakeDeps().imageRateMicro()).toBe(5n)
  expect(typeof remakeDeps().generateStill).toBe('function')
  setRemakeDeps(null)
  expect(remakeDeps().imageRateMicro).not.toBe(undefined)
})

// The ai-service reads and writes only inside the media cache (paths.safe_media_path). Work folders in the OS temp
// folder passed locally (its media dir was /private) but every clip pose check would be refused on the server.
describe('work folders', () => {
  it('are inside the media cache the ai-service reads', async () => {
    const { remakeDeps, setRemakeDeps } = await import('./deps.js')
    const { MEDIA_DIR } = await import('../../types.js')
    setRemakeDeps(null)
    const dir = remakeDeps().tempDir('remake-test-')
    try { expect(dir.startsWith(MEDIA_DIR + '/')).toBe(true) } finally { remakeDeps().removeDir(dir) }
  })
})
