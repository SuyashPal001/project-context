import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison for the shared internal service key.
 *
 * The orchestrator previously compared with `===` at six call sites while the
 * API side used timingSafeEqual throughout. Beyond the timing question, the
 * `serviceKey !== INTERNAL_SERVICE_KEY` shape has a sharper edge: on a server
 * where the key is unset, an absent header compares undefined to undefined and
 * authenticates. This helper denies in that case, and denies on any comparison
 * failure including a length mismatch.
 */
export function isInternalServiceKey(provided: string | undefined | null): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY
  if (!expected) return false
  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false

  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
