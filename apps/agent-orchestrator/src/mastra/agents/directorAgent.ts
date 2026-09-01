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
- If a generation is refused (returns refused: true), tell the user plainly what happened — do not retry automatically, do not describe the refusal as an error.
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
