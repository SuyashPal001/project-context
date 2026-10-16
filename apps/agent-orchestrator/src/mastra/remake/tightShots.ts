// A tighter original shot (a selfie, a close-up) is matched by cropping the kept still around the
// face with crop_image's own core, for free, never by paying for another image (2026-10-16).
import type { CropFraming } from '../tools/cropImage.js'

const ORDER = ['full_body', 'knees_up', 'waist_up', 'chest_up', 'face']

/** The crop that brings a still to the reference's framing, or null when none is needed: only for
 *  an original that is more than one step tighter, or waist-up and tighter (within one step the
 *  pose check already accepts it, and a wider original is never "fixed" by cropping). */
export function cropFramingFor(reference: string, still: string): CropFraming | null {
  const r = ORDER.indexOf(reference), s = ORDER.indexOf(still)
  if (r < 0 || s < 0 || r <= s) return null
  if (r < ORDER.indexOf('waist_up')) return null
  return r >= ORDER.indexOf('chest_up') ? 'close-up' : 'half-body'
}
