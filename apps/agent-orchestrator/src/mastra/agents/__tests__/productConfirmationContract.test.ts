import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { platformAgent } from '../platformAgent.js'

async function instructions(): Promise<string> {
  const requestContext = new RequestContext()
  requestContext.set('agentSystemPrompt', 'Base override text.')
  const value = await platformAgent.getInstructions({ requestContext })
  return typeof value === 'string' ? value : JSON.stringify(value)
}

describe('product confirmation contract', () => {
  it('asks for a one-line product check before the first paid generation', async () => {
    const text = await instructions()
    expect(text).toContain('## Product confirmation — required behaviour')
    expect(text).toContain('confirm it in ONE short line before the first paid generation')
    expect(text).toContain('name not known yet')
    expect(text).toContain('Never re-ask anything the brief already states.')
  })

  it('comes before the product-photo reuse contract and leaves it unchanged', async () => {
    const text = await instructions()
    const confirmation = text.indexOf('## Product confirmation — required behaviour')
    const reuse = text.indexOf('## Product-photo reuse — required behaviour')
    expect(confirmation).toBeGreaterThan(-1)
    expect(confirmation).toBeLessThan(reuse)
    expect(text).toContain('Before asking for a product photo in any contract below that needs one')
  })
})
