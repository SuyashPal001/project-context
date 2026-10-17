// An edit added what nobody asked for: a fan blade across the top of the fan reel's look 1 end photo, copied
// from the original frame (fan run real16, 2026-10-17); a dupatta over her face before that. The same-room
// check called it the same place, which it was. This compares the photo before and after the edit.
import { describe, it, expect, vi } from 'vitest'
import { addedByEdit, ADDED_BY_EDIT_QUESTION } from './editCheck.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })

describe('addedByEdit', () => {
  it('something new that the change does not explain fails, named', async () => {
    const ask = vi.fn().mockResolvedValue({ added: true, what: 'a dark wooden fan blade across the top' })
    expect(await addedByEdit(ask, img('a'), img('b'), 'the body pose')).toEqual({ status: 'fail', reason: 'not in the photo it was edited from: a dark wooden fan blade across the top' })
    expect(ask.mock.calls[0][0].at(-1).text).toMatch(/The edit was asked to change only: the body pose\./)
  })
  it('nothing new passes; no answer is unknown, never a pass', async () => {
    expect((await addedByEdit(vi.fn().mockResolvedValue({ added: false, what: '' }), img('a'), img('b'), 'x')).status).toBe('pass')
    expect((await addedByEdit(vi.fn().mockRejectedValue(new Error('x')), img('a'), img('b'), 'x')).status).toBe('unknown')
  })
  it('the question names what counts: objects, things in front of the camera, a covered face, text', () => {
    expect(ADDED_BY_EDIT_QUESTION('x')).toMatch(/in front of the camera/)
    expect(ADDED_BY_EDIT_QUESTION('x')).toMatch(/covering the face/)
  })  // fan run real19: look 4's edit was failed for "shoes and a small object in her hand": the shoes came with the
  // new outfit and the object was the remote the original has, so its fix removed the remote
  it('objects that belong in the shot and parts of a new outfit do not count', async () => {
    const ask = vi.fn().mockResolvedValue({ added: false, what: '' })
    await addedByEdit(ask, img('a'), img('b'), 'the outfit to a red brocade set', ['Remote control'])
    const q = ask.mock.calls[0][0].at(-1).text
    expect(q).toMatch(/These belong in the shot and do not count: Remote control\./)
    expect(q).toMatch(/Shoes, jewellery and anything worn with a new outfit are part of an outfit change/)
  })
})
