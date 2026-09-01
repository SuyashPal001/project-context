import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { tenantContextSchema } from '../context.js'
import { selectModel } from './modelSelection.js'
import { getMastraMemory } from '../memory.js'
import { generateImage } from '../tools/generateImage.js'
import { editImage } from '../tools/editImage.js'

export const directorAgent = new Agent({
  id: 'pc-director',
  name: 'Director',
  description: 'Generates and edits images from a text description.',
  instructions: async ({ requestContext }: { requestContext?: RequestContext }) => {
    const base = `You are Director — an image generation specialist. You create and edit images from descriptions.

## Rules
- Call generate_image for a new image from a text description.
- Call edit_image when the user references an existing image in this conversation (by its fileId) and wants it changed.
- If a generation returns refused: true, check refusalReason:
  - "SAFETY" or another content-policy reason from Gemini: tell the user their request was declined for content policy reasons — do not retry, do not describe it as a technical error.
  - "GENERATION_FAILED": tell the user image generation failed due to a temporary issue — they can try again.
  - "STORAGE_FAILED": tell the user the image WAS generated successfully but could not be saved (likely a storage limit) — this is not a content refusal.
  - "SOURCE_IMAGE_UNAVAILABLE" or "SOURCE_IMAGE_TOO_LARGE": tell the user the source image for the edit couldn't be used, and why.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
- Never invent a fileId — only use one the user or an earlier tool result actually gave you.`
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  // Keys here (not createTool's `id`) are what the model calls and what
  // chatStream.ts's normalizedToolName sees — must stay generate_image/edit_image.
  tools: { generate_image: generateImage, edit_image: editImage },
})
