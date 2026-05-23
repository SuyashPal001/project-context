import { timingSafeEqual } from 'crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@serverless-saas/database'
import { auditLog } from '@serverless-saas/database/schema/audit'
import type { AppEnv } from '@serverless-saas/types'

function isAuthorized(provided: string): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY
  if (!expected) return false
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

const internalGuardrailsRoute = new Hono<AppEnv>()

const schema = z.object({
  tenantId:       z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  processorId:    z.string().min(1),
  message:        z.string().min(1),
  detail:         z.unknown().optional(),
})

internalGuardrailsRoute.post('/log', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const result = schema.safeParse(await c.req.json())
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400)
  }

  const d = result.data
  db.insert(auditLog).values({
    tenantId:   d.tenantId,
    actorId:    d.processorId,
    actorType:  'system',
    action:     'guardrail_violation',
    resource:   'conversation',
    resourceId: d.conversationId ?? null,
    metadata:   { processorId: d.processorId, message: d.message, detail: d.detail ?? null },
    traceId:    '',
  }).catch((err: unknown) => {
    console.error('[guardrails/log] insert failed:', err)
  })

  return c.json({ success: true }, 200)
})

export default internalGuardrailsRoute
