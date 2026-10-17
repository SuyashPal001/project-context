// Hide a person's face in a frame before an image model sees it. The original's frames are pose references
// for remake photos, and the original actress's face leaked into ours (fan run real15). The head box comes
// from the pose reader (ai-service read_image "head", frame fractions).
const r = (x: number) => Math.round(x * 1000) / 1000

/** ffmpeg arguments: the frame with the head box blurred beyond recognition. */
export function hideFaceArgs(input: string, out: string, head: number[]): string[] {
  const [x0, y0, x1, y1] = head
  return ['-y', '-i', input, '-filter_complex',
    `[0]split[a][b];[b]crop=iw*${r(x1 - x0)}:ih*${r(y1 - y0)}:iw*${r(x0)}:ih*${r(y0)},boxblur=30:4[f];[a][f]overlay=main_w*${r(x0)}:main_h*${r(y0)}`,
    '-frames:v', '1', '-q:v', '2', out]
}
