// Same camera as the original: where the main person sits in the frame (their box from the pose reader,
// fractions x0,y0,x1,y1) compared with the original frame's. Any model's photo or clip frame can drift
// closer, further or sideways (2026-10-16/17 fan runs: board crops and Omni re-framed the shot), and only a
// measured check catches it before the user does. A missing box is unknown, never a pass.

/** How far the person's height in the frame may differ, as a share of the original's. */
export const SIZE_TOLERANCE = 0.15
/** How far the person's centre may move, in frame fractions. */
export const SHIFT_TOLERANCE = 0.1

/** refHead/gotHead: whether each picture shows the person's head. Something in front of the head (a fan
 *  blade, an arm) cuts the box short at the top, so the size and the up-down place are then unknown; a
 *  sideways move is still caught. */
/** refLen/gotLen: shoulders to ankles in frame heights (the pose reader's body_len). When both are known they
 *  decide the size, and the up-down place is read at the feet: a blade over the head cut the box top while
 *  the head still read as seen (fan run real17). */
export function compareFraming(ref: number[] | undefined | null, got: number[] | undefined | null, heads: { refHead?: boolean; gotHead?: boolean; refLen?: number | null; gotLen?: number | null } = {}): { ok: boolean | null; why: string } {
  if (!ref || !got || ref.length !== 4 || got.length !== 4) return { ok: null, why: 'the person could not be placed in the frame' }
  const h = (b: number[]) => b[3] - b[1]
  const cx = (b: number[]) => (b[0] + b[2]) / 2
  const cy = (b: number[]) => (b[1] + b[3]) / 2
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const why: string[] = []
  const lens = heads.refLen && heads.gotLen ? { ref: heads.refLen, got: heads.gotLen } : null
  const hidden = !lens && (heads.refHead === false || heads.gotHead === false)
  if (lens) {
    const size = lens.got / lens.ref
    if (Math.abs(size - 1) > SIZE_TOLERANCE) why.push(`the person's body spans ${pct(lens.got)} of the frame height, the original ${pct(lens.ref)}: the camera is ${size > 1 ? 'closer' : 'further away'}`)
  } else {
    const size = h(got) / Math.max(h(ref), 1e-6)
    if (!hidden && Math.abs(size - 1) > SIZE_TOLERANCE) why.push(`the person fills ${pct(h(got))} of the frame height, the original ${pct(h(ref))}: the camera is ${size > 1 ? 'closer' : 'further away'}`)
  }
  const dx = cx(got) - cx(ref)
  const dy = lens ? got[3] - ref[3] : cy(got) - cy(ref)
  if (Math.abs(dx) > SHIFT_TOLERANCE) why.push(`the person sits further ${dx < 0 ? 'left' : 'right'} in the frame than in the original`)
  if (!hidden && Math.abs(dy) > SHIFT_TOLERANCE) why.push(`the person sits ${dy > 0 ? 'lower' : 'higher'} in the frame than in the original`)
  if (hidden && !why.length) return { ok: null, why: 'the person is partly hidden, so only the sideways place could be compared' }
  return { ok: why.length === 0, why: why.join('; ') }
}
