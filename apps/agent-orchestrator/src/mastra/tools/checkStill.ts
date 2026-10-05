import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchBase64 } from './checkClip.js'
import { CheckUnavailableError, gatewayAsk, runStillChecks, type ProductScale } from './tvcChecks.js'

// Checks a TVC still BEFORE it is animated (spec §3.3): the product, glitches,
// background people and the lead (same face; nobody else looks like her).
// Free to the user. Proven 2026-10-05: a squat bottle was fixed on retry, and
// a wide shot that failed twice was held back instead of animated.
const passedStills = new Map<string, true>()
export function markStillPassed(conversationId: string, stillFileId: string): void {
  if (passedStills.size > 2000) passedStills.delete(passedStills.keys().next().value as string)
  passedStills.set(`${conversationId}:${stillFileId}`, true)
}
export function stillPassedCheck(conversationId: string, stillFileId: string): boolean {
  return passedStills.has(`${conversationId}:${stillFileId}`)
}

export const checkStill = createTool({
  id: 'check-still',
  description: 'Free check of a TVC still before it is animated: the product matches the product photo, no glitches (duplicates, stray faces, invented text, CG effects, flat backgrounds), background people where the place needs them, and the lead is the same person with no lookalike behind her. On fail, generate the still once more with the reason added; on a second fail, return it to Olmo. plan_tvc only records stills that passed here (or that the user kept).',
  inputSchema: z.object({
    stillFileId: z.string().describe('The still to check'),
    productFileId: z.string().optional().describe('The product photo, when the product is in the shot'),
    productScale: z.enum(['close', 'medium', 'wide']).optional().describe('How big the product is in the shot; wide judges only colour and label'),
    productMustBeVisible: z.boolean().optional().describe('The plan says the product is visible in this shot'),
    expectExtras: z.boolean().optional().describe('This place needs background people'),
    actorFileId: z.string().optional().describe('The lead actor (avatar) image'),
    leadInShot: z.boolean().optional().describe('The lead is in this shot (checks it is the same face)'),
  }),
  outputSchema: z.object({
    passed: z.boolean().optional(),
    reason: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const i = inputData as { stillFileId: string; productFileId?: string; productScale?: ProductScale; productMustBeVisible?: boolean; expectExtras?: boolean; actorFileId?: string; leadInShot?: boolean }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? ''
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    const signal = AbortSignal.timeout(300_000)
    try {
      const [still, product, lead] = await Promise.all([
        fetchBase64(i.stillFileId, idToken, signal),
        i.productFileId ? fetchBase64(i.productFileId, idToken, signal) : Promise.resolve(undefined),
        i.actorFileId ? fetchBase64(i.actorFileId, idToken, signal) : Promise.resolve(undefined),
      ])
      const r = await runStillChecks(gatewayAsk(tenantId), still, {
        product, productScale: i.productScale, productMustBeVisible: i.productMustBeVisible,
        expectExtras: i.expectExtras, lead, leadInShot: i.leadInShot,
      })
      if (r.passed) markStillPassed(conversationId, i.stillFileId)
      return { passed: r.passed, reason: r.passed ? 'The still passed every check.' : r.reasons.join(' ') }
    } catch (err) {
      // Every throw here — CheckUnavailableError, a plain Error from fetchBase64
      // or runStillChecks, a failed image fetch — means the still was never
      // actually checked. It must come back as CHECK_UNAVAILABLE, never a pass
      // and never an uncaught crash (same rule as check_clip's narrow checks).
      const msg = err instanceof CheckUnavailableError ? err.message : `check unavailable: ${(err as Error)?.message ?? 'unknown'}`
      console.error('[checkStill] failed:', (err as Error)?.message)
      return { refused: true, refusalReason: `CHECK_UNAVAILABLE: ${msg} — this still is unchecked` }
    }
  },
})
