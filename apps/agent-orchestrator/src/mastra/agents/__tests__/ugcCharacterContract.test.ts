import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Moved word for word into the UGC character ad Official skill.
const UGC_CHARACTER_CONTRACT = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../products/agent-platform/packages/api/seeds/official-skills/ugc-character-ad.md',
), 'utf8')

describe('UGC_CHARACTER_CONTRACT', () => {
  it('tells Olmo to delegate whole stages in one delegation, not one beat at a time', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('ALL beats')
    expect(UGC_CHARACTER_CONTRACT).toContain('in ONE delegation')
  })

  it('no longer tells Olmo that every beat needs its own separate approval', () => {
    expect(UGC_CHARACTER_CONTRACT).not.toContain('there is no single approval that covers the whole board today')
  })

  it('still requires the cast sheet first and board approval before any video', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('generate or reuse the cast sheet')
    expect(UGC_CHARACTER_CONTRACT).toContain('approve the set as a whole')
  })
})
