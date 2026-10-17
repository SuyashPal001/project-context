// The next shot (user, 2026-10-16): within one place and camera, a shot is an EDIT of that place's first
// photo, so the face, hair, room and camera stay identical (the hand-made v12 and the edit-chain test held
// all four fan looks; fresh drawings drifted every look). A new place or camera starts a fresh photo.
import { describe, it, expect, vi } from 'vitest'
import { editShotPrompt, editShotGateLine, placeGroups } from './nextShot.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })

describe('editShotPrompt', () => {
  it('changes only what is named and keeps face, hair, room and camera', () => {
    const p = editShotPrompt({ outfit: 'a red saree', poseFromFrame: true })
    expect(p).toMatch(/^Edit the first image\. Change only:/)
    expect(p).toMatch(/the outfit to a red saree/)
    expect(p).toMatch(/the body pose: copy how the person's arms, hands, legs, head and body lie in the second image/)
    // a new outfit is never also told to stay as in the first image
    expect(p).not.toMatch(/stays worn and draped as in the first image/)
    expect(p).toMatch(/not that person, outfit, objects or any text/)
    expect(p).toMatch(/Keep everything else exactly as in the first image: the face, the hair, the room/)
    expect(p).toMatch(/the camera height and angle, the person's size and position in the frame/)
  })
  it('a styling change lets the hair change; a pose-only edit names only the pose', () => {
    expect(editShotPrompt({ styling: 'hair in a bun', poseFromFrame: false })).not.toMatch(/the face, the hair,/)
    const pose = editShotPrompt({ poseFromFrame: true })
    expect(pose).not.toMatch(/outfit to/)
    expect(pose).toMatch(/\(1\) the body pose/)
  })
  it('a pose from a frame copies nothing that covers the person there (a blade, a cloth)', () => {
    // fan run real9: the blade over her head in the original came out as a dupatta over her face
    expect(editShotPrompt({ poseFromFrame: true })).toMatch(/nothing that covers or hides the person there is copied: the face and hair stay uncovered/)
    // plain words for the pose and the drape (fan run real11: the end photos barely moved and the dupatta
    // vanished; a test edit worded this way got the pose and kept the dupatta)
    expect(editShotPrompt({ poseFromFrame: true })).toMatch(/copy how the person's arms, hands, legs, head and body lie in the second image/)
    expect(editShotPrompt({ poseFromFrame: true })).toMatch(/any dupatta or scarf, stays worn and draped as in the first image/)
  })
  it('the check line says it is an edit of an approved photo with the pose from a frame', () => {
    expect(editShotGateLine({ outfit: 'a red saree', poseFromFrame: true }, 'looks[1]')).toMatch(/edit of the previous approved photo \(the first image\).*only: looks\[1\] outfit to a red saree; the pose of the person in the second image.*everything else kept/)
  })
})

describe('placeGroups', () => {
  it('frames of one place share a group; a new place starts one; unknown starts one (fresh is safe)', async () => {
    const same = vi.fn(async (_a: unknown, x: { data: string }, y: { data: string }) => ({ same: x.data[0] === y.data[0] ? true : x.data === 'Z' ? null : false, differs: '' }))
    expect(await placeGroups({} as never, [img('A1'), img('A2'), img('B1'), img('A3'), img('Z')], same as never)).toEqual([0, 0, 1, 0, 2])
  })
})
