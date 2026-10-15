import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = readFileSync(join(import.meta.dirname, '../../../../../products/agent-platform/packages/api/seeds/official-skills/template-video.md'), 'utf8')

it('step 8 sends a brand remake through remake_video and keeps the earlier steps intact', () => {
  expect(skill).toMatch(/^8\. /m)
  expect(skill).toContain('remake_video')
  expect(skill).toMatch(/^7\. When the user shares a video link/m) // append-only: step 7 unchanged
})

it('step 8 names no internals', () => {
  const step8 = skill.split(/^8\. /m)[1] ?? ''
  expect(step8).not.toMatch(/download|server|gemini|ai-service|gateway|yt-dlp/i)
})
