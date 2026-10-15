import { it, expect, vi } from 'vitest'
import { previewSegments, previewSize } from './preview.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'

it('keeps the reference shape at 1080 on the short side', () => {
  expect(previewSize(1080, 1920)).toEqual({ width: 1080, height: 1920 })
  expect(previewSize(720, 1280)).toEqual({ width: 1080, height: 1920 })
  expect(previewSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  expect(previewSize(1001, 1001)).toEqual({ width: 1080, height: 1080 })
})

it('one segment per look, timed from the measured spans; missing stills become grey cards', async () => {
  const plan = await writePlan(breakdown(), { name: 'B', product: 'p' }, vi.fn().mockResolvedValue({ lines: [] }))
  const segs = previewSegments(plan, [
    { look: 1, kind: 'start', fileId: 'a1', status: 'passed', reasons: [] },
    { look: 2, kind: 'start', fileId: null, status: 'blocked', reasons: ['x'] },
    { look: 2, kind: 'end', fileId: 'b2', status: 'failed', reasons: ['y'] },
  ], new Map([['a1', '/m/a1.jpg'], ['b2', '/m/b2.jpg']]))
  expect(segs).toEqual([
    { seconds: 4.1, start: '/m/a1.jpg', end: null },
    { seconds: 5.9, start: null, end: '/m/b2.jpg' },
  ])
})
