import { interpolate } from 'remotion'

// 0.25s ease in/out at the edges of an element's own Sequence-relative frame
// range — shared by every element so a graphic never hard-cuts in or out.
const FADE_SECONDS = 0.25

export function fadeOpacity(frame: number, durationInFrames: number, fps: number): number {
  const fadeFrames = Math.round(FADE_SECONDS * fps)
  return interpolate(
    frame,
    [0, fadeFrames, Math.max(fadeFrames + 1, durationInFrames - fadeFrames), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )
}
