import { describe, it, expect, vi } from 'vitest'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

import { FACE_MODEL, FIND_FACES_QUESTION, FaceFinderError, findFaces, largestBox, parseBox2dList, parseFractionBox } from './findFaces.js'

const reply = (content: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch
const img = { data: 'QUJD', mime: 'image/jpeg' }

describe('parseBox2dList (K2)', () => {
  it('reads every valid box_2d, in order', () => {
    expect(parseBox2dList('```json\n[{"box_2d":[100,100,200,200],"label":"head"},{"box_2d":[0,500,500,750],"label":"head"}]\n```')).toEqual([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.5, y: 0, w: 0.25, h: 0.5 },
    ])
  })
  it('skips out-of-range or inverted boxes', () => {
    expect(parseBox2dList('[{"box_2d":[0,0,1200,10]},{"box_2d":[500,500,400,600]}]')).toEqual([])
  })
})

describe('largestBox (Review Focus 4)', () => {
  it('largestBox picks the biggest head, and null for none', () => {
    expect(largestBox([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.5, y: 0, w: 0.25, h: 0.5 }])).toEqual({ x: 0.5, y: 0, w: 0.25, h: 0.5 })
    expect(largestBox([])).toBeNull()
  })
})

describe('findFaces (K2)', () => {
  it('asks the shared box_2d question on gemini-3.6-flash and returns every head', async () => {
    const f = reply('[{"box_2d":[222,227,563,695],"label":"head"}]')
    const boxes = await findFaces(img, { tenantId: 't1', agentId: 'crop-image', fetchImpl: f })
    expect(boxes).toHaveLength(1)
    const body = JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe(FACE_MODEL)
    expect(body.messages[0].content[1].text).toBe(FIND_FACES_QUESTION)
  })
  it('an empty list is no faces; a fraction reply still works; garbage throws', async () => {
    expect(await findFaces(img, { agentId: 'x', fetchImpl: reply('[]') })).toEqual([])
    expect(await findFaces(img, { agentId: 'x', fetchImpl: reply('{"x":0.4,"y":0.08,"w":0.15,"h":0.11}') })).toEqual([{ x: 0.4, y: 0.08, w: 0.15, h: 0.11 }])
    await expect(findFaces(img, { agentId: 'x', fetchImpl: reply('no idea') })).rejects.toBeInstanceOf(FaceFinderError)
    await expect(findFaces(img, { agentId: 'x', fetchImpl: reply('', 500) })).rejects.toBeInstanceOf(FaceFinderError)
  })
  it('parseFractionBox keeps crop_image\'s old rules', () => {
    expect(parseFractionBox('{"x":400,"y":80,"w":150,"h":110}')).toBeNull()
    expect(parseFractionBox('{"x":0.9,"y":0.1,"w":0.3,"h":0.1}')).toBeNull()
  })
})
