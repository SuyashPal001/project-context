import { Hono } from 'hono';
import { db } from '@serverless-saas/database';
import { pensionCases, pensionFindings, pensionOfficerActions } from '@serverless-saas/database/schema/pension';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { eq, and } from 'drizzle-orm';
import type { AppEnv } from '../types';

export const pensionRoutes = new Hono<AppEnv>();

// GET /pension/cases — officer queue for the tenant
pensionRoutes.get('/cases', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id as string;
  const rows = await db.select().from(pensionCases).where(eq(pensionCases.tenantId, tenantId));
  return c.json(rows);
});

// GET /pension/cases/:id — case + findings
pensionRoutes.get('/cases/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id as string;
  const id = c.req.param('id');
  const [kase] = await db.select().from(pensionCases)
    .where(and(eq(pensionCases.id, id), eq(pensionCases.tenantId, tenantId)));
  if (!kase) return c.json({ error: 'not found' }, 404);
  const findings = await db.select().from(pensionFindings).where(eq(pensionFindings.caseId, id));
  return c.json({ ...kase, findings });
});

// POST /pension/cases/:id/action — accept | override | escalate
pensionRoutes.post('/cases/:id/action', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id as string;
  const userId = c.get('userId') as string;
  const id = c.req.param('id');

  const body = await c.req.json<{
    findingId?: string;
    action: 'accept' | 'override' | 'escalate';
    rationale?: string;
    actorRole: string;
  }>();

  if ((body.action === 'override' || body.action === 'escalate') && !body.rationale?.trim()) {
    return c.json({ error: 'rationale required for override/escalate' }, 400);
  }

  await db.insert(pensionOfficerActions).values({
    tenantId,
    caseId: id,
    findingId: body.findingId ?? null,
    action: body.action,
    rationale: body.rationale ?? null,
    actorId: userId ?? null,
    actorRole: body.actorRole,
  });

  const newStatus = body.action === 'escalate' ? 'escalated' : 'reviewed';
  await db.update(pensionCases)
    .set({ status: newStatus as any, updatedAt: new Date() })
    .where(and(eq(pensionCases.id, id), eq(pensionCases.tenantId, tenantId)));

  // Write to tamper-evident audit log (mirrors pattern in tasks.update.ts)
  db.insert(auditLog).values({
    tenantId,
    actorId: userId ?? 'system',
    actorType: 'human',
    action: `pension_${body.action}`,
    resource: 'pension_case',
    resourceId: id,
    metadata: { findingId: body.findingId, rationale: body.rationale, actorRole: body.actorRole },
    traceId: c.get('traceId') ?? '',
  }).catch((err: unknown) => console.error('Audit log write failed:', err));

  return c.json({ ok: true, status: newStatus });
});
