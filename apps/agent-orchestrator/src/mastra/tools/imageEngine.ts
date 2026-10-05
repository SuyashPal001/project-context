// Which engine makes an image. Gemini makes ad stills; GPT Image 2 makes the
// avatar and character creators' portraits and reference sheets, where it beat
// Gemini on the look (2026-10). The choice is made here in tool code, not by
// the model: a creator flow is known from its variety roll (every creator calls
// roll_*_variations first) or from a creator skill the user turned on, and it
// ends when the avatar is saved. Ad stills made later from that avatar go back
// to Gemini, so one ad's stills never mix engines.

export type ImageEngine = 'gemini' | 'gpt'

export const GEMINI_IMAGE_MODEL = 'gemini-3-pro-image-preview'
export const GPT_IMAGE_MODEL = 'gpt-image-2'

// Off until the gateway has an OpenAI key: with it off every image stays on Gemini.
export const gptImageEnabled = (): boolean => process.env.GPT_IMAGE_ENABLED === 'true'

export const CREATOR_SKILL_NAMES = /^((ugc )?avatar creator|animated character creator|tvc character creator)$/i

const CREATOR_FLOW_TTL_MS = 3 * 60 * 60 * 1000
const creatorFlows = new Map<string, number>()

export function markCreatorFlow(conversationId: string | undefined): void {
  if (!conversationId) return
  creatorFlows.set(conversationId, Date.now())
  if (creatorFlows.size > 5000) creatorFlows.delete(creatorFlows.keys().next().value as string)
}

export function endCreatorFlow(conversationId: string | undefined): void {
  if (conversationId) creatorFlows.delete(conversationId)
}

interface ContextLike { get: (key: never) => unknown }

export function imageEngineFor(requestContext: ContextLike | undefined, requested?: ImageEngine): ImageEngine {
  if (!gptImageEnabled()) return 'gemini'
  if (requested) return requested
  const conversationId = requestContext?.get('conversationId' as never) as string | undefined
  const since = conversationId ? creatorFlows.get(conversationId) : undefined
  if (since !== undefined && Date.now() - since < CREATOR_FLOW_TTL_MS) return 'gpt'
  const names = (requestContext?.get('invokedSkillNames' as never) as string[] | undefined) ?? []
  return names.some((n) => CREATOR_SKILL_NAMES.test(n.trim())) ? 'gpt' : 'gemini'
}

/** The model the gateway runs and the credit-rate subject it is billed under. */
export function imageModelFor(engine: ImageEngine, imageSize?: string): { model: string; rateSubject: string } {
  if (engine === 'gpt') return { model: GPT_IMAGE_MODEL, rateSubject: imageSize === '2K' ? `${GPT_IMAGE_MODEL}-2k` : GPT_IMAGE_MODEL }
  return { model: GEMINI_IMAGE_MODEL, rateSubject: GEMINI_IMAGE_MODEL }
}
