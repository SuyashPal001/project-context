// FREE-AI Sutra 1 — internal fairness audit endpoint
// Receives automated fairness check results from the relay and persists them
// to audit_log so ops can query trends across tenants and agents.

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

const schema = z.object({
  tenantId:        z.string().uuid(),
  conversationId:  z.string().uuid(),
  messageId:       z.string().uuid(),
  agentId:         z.string().min(1),
  agentName:       z.string().optional(),
  overallStatus:   z.enum(['pass', 'warn', 'fail']),
  checkResults:    z.array(z.unknown()),
  responseLength:  z.number().int().nonnegative(),
  toolsUsed:       z.number().int().nonnegative(),
  responseSnippet: z.string().max(200).optional(),
})

const internalFairnessRoute = new Hono<AppEnv>()

internalFairnessRoute.post('/audit', async (c) => {
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
    actorId:    d.agentId,
    actorType:  'agent',
    action:     'response_fairness_audit',
    resource:   'conversation',
    resourceId: d.conversationId,
    metadata:   {
      sutra:           'FREE-AI-Sutra-1',
      messageId:       d.messageId,
      agentName:       d.agentName,
      overallStatus:   d.overallStatus,
      checkResults:    d.checkResults,
      responseLength:  d.responseLength,
      toolsUsed:       d.toolsUsed,
      responseSnippet: d.responseSnippet,
    },
    traceId: '',
  }).catch((err: unknown) => {
    console.error('[fairness/audit] insert failed:', err)
  })

  return c.json({ success: true }, 200)
})

export default internalFairnessRoute
