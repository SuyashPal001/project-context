import { describe, it, expect, vi } from 'vitest'
vi.mock('node:child_process', () => ({ execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }) }))
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), readFileSync: vi.fn(() => Buffer.from('jpg')) }))
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { checkShortShots } from './checkShortShots.js'

const shots = [{ n: 1, start_s: 0, end_s: 0.5, subject: 'eye', action: 'twitches' }, { n: 2, start_s: 0.5, end_s: 3, subject: 'room', action: 'wide' }]
it('returns unknown, never ok, when the checker fails', async () => {
  const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, shots, undefined, fetchImpl)
  expect(r.status).toBe('unknown')
  expect(r.fixes).toEqual([])
})
it('only checks shots under 1s and only corrects the subject', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"n":1,"ok":false,"subject":"woman with gum","action":"rests"}]' } }] })))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, shots, undefined, fetchImpl)
  expect(r.checked).toBe(1)
  expect(r.fixes).toEqual([{ n: 1, subject: 'woman with gum' }])
})

it('is not "ok" when the checker answers for only some short shots (review M4)', async () => {
  const two = [{ n: 1, start_s: 0, end_s: 0.5, subject: 'eye', action: 'a' }, { n: 2, start_s: 0.5, end_s: 0.9, subject: 'hand', action: 'b' }]
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"n":"1","ok":true}]' } }] })))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, two, undefined, fetchImpl)
  expect(r.status).toBe('unknown')
})
it('matches verdicts whose shot number comes back as a string (review M4)', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"n":"1","ok":false,"subject":"girl"}]' } }] })))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, shots, undefined, fetchImpl)
  expect(r).toMatchObject({ status: 'ok', fixes: [{ n: 1, subject: 'girl' }] })
})
