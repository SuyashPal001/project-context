import { describe, it, expect } from 'vitest'
import { SHOW_FILES_CONTRACT } from '../platformAgent.js'

describe('show_files contract', () => {
  it('tells Olmo to call show_files for files already generated/attached in this conversation', () => {
    expect(SHOW_FILES_CONTRACT).toMatch(/call show_files/i)
    expect(SHOW_FILES_CONTRACT).toMatch(/fileIds from earlier tool results/i)
  })

  it('forbids find_past_tasks / re-generating as a substitute', () => {
    expect(SHOW_FILES_CONTRACT).toMatch(/never call find_past_tasks/i)
    expect(SHOW_FILES_CONTRACT).toMatch(/never re-generate/i)
  })

  it('clarifies "already generated" means this conversation\'s own files, not a switch to casting/library presets', () => {
    expect(SHOW_FILES_CONTRACT).toMatch(/already generated.*the ones you made/i)
    expect(SHOW_FILES_CONTRACT).toMatch(/do not switch to casting\/library presets/i)
  })
})
