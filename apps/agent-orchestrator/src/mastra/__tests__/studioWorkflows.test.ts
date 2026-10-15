import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Studio has no auth: a registered workflow taking a server file path would let anyone
// run a paid Gemini watch on any file (review I5). The golden set builds its own target.
it('does not register the local-file video breakdown workflow on the Mastra instance', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  expect(src).not.toMatch(/video-breakdown-local|videoBreakdownWorkflow/)
})

it('does not register the paid remake workflow on the Studio-mounted Mastra instance', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
  expect(src).not.toMatch(/video-remake|videoRemakeWorkflow|remake\/workflow/)
})
