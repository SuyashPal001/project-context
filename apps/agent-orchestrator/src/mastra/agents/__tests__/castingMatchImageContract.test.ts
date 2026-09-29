import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { platformAgent } from '../platformAgent.js'

// CASTING_MATCH_CONTRACT is composed inline inside platformAgent's instructions
// closure (not exported), so it's asserted against the fully-resolved prompt —
// same pattern as productConfirmationContract.test.ts.
async function instructions(): Promise<string> {
  const requestContext = new RequestContext()
  requestContext.set('agentSystemPrompt', 'Base override text.')
  const value = await platformAgent.getInstructions({ requestContext })
  return typeof value === 'string' ? value : JSON.stringify(value)
}

describe('casting match — image thumbnails on avatar matches', () => {
  it('tells Olmo to set imageFileId on avatar matches so faces show, not just names', async () => {
    const text = await instructions()
    expect(text).toContain('## Casting and voice matching — required behaviour')
    expect(text).toMatch(/set each option's imageFileId to that item's id/i)
    expect(text).toMatch(/voice matches have no image, so leave imageFileId unset/i)
  })
})
