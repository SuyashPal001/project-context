import { it, expect, vi } from 'vitest'
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
import { askChecked, gatewayAsk, CheckUnavailableError } from './tvcChecks.js'
it('accepts number and string keys', async () => {
  const ask = vi.fn(async () => ({ score: 9, feet: 'image-left' }))
  await expect(askChecked(ask, [{ text: 'q' }], [{ key: 'score', type: 'number' }, { key: 'feet', type: 'string' }])).resolves.toMatchObject({ score: 9 })
})
it('treats a wrong-typed number as missing (never a pass)', async () => {
  const ask = vi.fn(async () => ({ score: '9' }))
  await expect(askChecked(ask, [{ text: 'q' }], [{ key: 'score', type: 'number' }])).rejects.toBeInstanceOf(CheckUnavailableError)
})
it('gatewayAsk sends the model it is given', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })))
  await gatewayAsk('', fetchImpl, 'gemini-3.8-flash')([{ text: 'q' }])
  expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('gemini-3.8-flash')
})
