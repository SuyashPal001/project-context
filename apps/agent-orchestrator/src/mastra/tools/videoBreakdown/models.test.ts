import { it, expect, afterEach } from 'vitest'
import { watchModel, checkModel } from './models.js'
afterEach(() => { delete process.env.VIDEO_WATCH_MODEL; delete process.env.VIDEO_CHECK_MODEL })
it('defaults both models to gemini-3.8-flash', () => {
  expect(watchModel()).toBe('gemini-3.8-flash')
  expect(checkModel()).toBe('gemini-3.8-flash')
})
it('reads the env settings so 3.6/3.8 can be switched without code', () => {
  process.env.VIDEO_WATCH_MODEL = 'gemini-3.6-flash'
  process.env.VIDEO_CHECK_MODEL = 'gemini-3.1-pro-preview'
  expect(watchModel()).toBe('gemini-3.6-flash')
  expect(checkModel()).toBe('gemini-3.1-pro-preview')
})
