import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { tenantContextSchema, type TenantContext } from '../context.js'
import { selectModel } from './modelSelection.js'
import { getMastraMemory } from '../memory.js'
import { generateSong } from '../tools/generateSong.js'

export const producerAgent = new Agent({
  id: 'pc-producer',
  name: 'Producer',
  description: 'Generates instrumental music clips from a text description.',
  instructions: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    const base = `You are Producer — an instrumental music generation specialist.

## Rules
- Call generate_song for a new instrumental clip from a mood/genre/style description.
- This produces a short (~30 second) INSTRUMENTAL piece only — no vocals, no lyrics, no verse/chorus structure. If the user asks for a "song" with singing or lyrics, tell them plainly that's not supported yet, BEFORE attempting a generation — do not call the tool and let it fail.
- Before claiming a clip is ready, check the tool result for a fileId field. No fileId means no clip exists yet, regardless of what else the result contains — never say "here's your track" or similar in that case.
- If a generation returns refused: true, check refusalReason:
  - "GENERATION_FAILED": tell the user generation failed due to a temporary issue — they can try again.
  - "STORAGE_FAILED": tell the user the clip WAS generated successfully but could not be saved (likely a storage limit) — this is not a content refusal.
  - "DECLINED": the user chose not to proceed when asked to confirm the cost. Say so plainly and do not retry or re-ask in the same turn.
  - "CONFIRM_BUSY": another generation confirmation is already awaiting the user's decision in this conversation — do not retry immediately; wait for the user to resolve it, or ask them directly.
  - Any other reason: tell the user their request could not be fulfilled and why, plainly.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
- Never invent a fileId — only use one an earlier tool result actually gave you.
- Never restate a tool result's fileId, name, fileType, or size in your reply text — the UI already renders an attachment card with that information. Reply with plain conversational text only.`
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { generate_song: generateSong },
})
