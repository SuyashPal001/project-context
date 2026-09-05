import { Hono } from 'hono'
import { streamText } from 'ai'
import type { AuthPayload } from '../auth.js'
import { validateToken } from '../auth.js'
import { checkCreditBalance, debitChatTurn } from '../credits.js'
import { persistCost } from '../mastra/cost.js'
import { recordUsage } from '../usage.js'
import { platformModel } from '../mastra/model.js'
import { getAllowedOrigin } from '../types.js'
import { SKILL_SYSTEM_PROMPT, buildSkillPrompt } from '../skills/generationPrompt.js'

export const skillsRouter = new Hono()

const MAX_BRIEF = 4_000
const MAX_DRAFT = 65_536
const GENERATOR_AGENT_ID = 'skill-generator'

skillsRouter.options('/api/skills/generate', (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})

skillsRouter.post('/api/skills/generate', async (c) => {
  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: AuthPayload
  try {
    payload = await validateToken(token)
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Never from the body: the body is caller-controlled and this value decides
  // whose credits get spent.
  const tenantId = payload['custom:tenantId'] ?? ''
  if (!tenantId) return c.json({ error: 'Unauthorized' }, 401)

  const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  const brief = typeof raw?.brief === 'string' ? raw.brief.trim() : ''
  const description = typeof raw?.description === 'string' ? raw.description.trim() : undefined
  const previousDraft = typeof raw?.previousDraft === 'string' ? raw.previousDraft.slice(0, MAX_DRAFT) : undefined
  const feedback = typeof raw?.feedback === 'string' ? raw.feedback.trim() : undefined
  if (!name || !brief || brief.length > MAX_BRIEF) {
    return c.json({ error: 'name and brief are required', code: 'VALIDATION_ERROR' }, 400)
  }

  // Checked before the stream opens so an out-of-credit tenant gets a plain
  // 402 the dialog can render, not an error buried inside an SSE body.
  const credit = await checkCreditBalance(tenantId)
  if (!credit.allowed) {
    return c.json({ error: 'Insufficient credits', balanceMicro: String(credit.balanceMicro) }, 402)
  }

  const modelName = (platformModel as { modelId?: string }).modelId ?? 'gemini-2.5-flash'
  const generationId = crypto.randomUUID()
  const encoder = new TextEncoder()

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: object): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // enqueue after close — client went away
        }
      }

      try {
        const result = streamText({
          model: platformModel,
          system: SKILL_SYSTEM_PROMPT,
          prompt: buildSkillPrompt({ name, description, brief, previousDraft, feedback }),
        })

        for await (const chunk of result.textStream) {
          send('delta', { text: chunk })
        }

        const usage = await result.usage
        const inputTokens = usage?.inputTokens ?? 0
        const outputTokens = usage?.outputTokens ?? 0

        // Same post-turn trio as chatStream.ts: the cost row, the usage row,
        // and the debit. All three are fire-and-forget by contract — a metering
        // failure must never take down a draft the user already has.
        persistCost({ tenantId, agentId: GENERATOR_AGENT_ID, model: modelName, inputTokens, outputTokens })
        recordUsage({ tenantId, actorId: GENERATOR_AGENT_ID, inputTokens, outputTokens })
        Promise.resolve(debitChatTurn({
          tenantId,
          agentId: GENERATOR_AGENT_ID,
          messageId: `skillgen:${generationId}`,
          model: modelName,
          inputTokens,
          outputTokens,
        })).catch(err => console.error(`[skillgen:${generationId}] debit failed:`, (err as Error).message))

        send('done', { model: modelName })
      } catch (err) {
        // The gateway's own message can name internal hosts and model routing,
        // so it stays in the server log; the client gets something it can act on.
        console.error(`[skillgen:${generationId}] generation failed tenantId=${tenantId}:`, (err as Error).message)
        send('error', { message: 'Generation failed. Try again.' })
      } finally {
        try { controller.close() } catch {}
      }
    },
  })

  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})
