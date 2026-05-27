import { Hono } from 'hono';
import { db } from '@serverless-saas/database';
import { pensionCases, pensionFindings, pensionOfficerActions } from '@serverless-saas/database/schema/pension';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { eq, and } from 'drizzle-orm';
import type { AppEnv } from '../types';

const RELAY_URL = (process.env.RELAY_URL ?? 'http://localhost:3001').trim();
const INTERNAL_KEY = (process.env.INTERNAL_SERVICE_KEY ?? '').trim();

export const pensionRoutes = new Hono<AppEnv>();

// GET /pension/cases — officer queue for the tenant
pensionRoutes.get('/cases', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id as string;
  const status = c.req.query('status');
  const rows = await db.select().from(pensionCases)
    .where(status
      ? and(eq(pensionCases.tenantId, tenantId), eq(pensionCases.status, status as any))
      : eq(pensionCases.tenantId, tenantId));
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
// Writes audit log, updates case status, then calls relay /internal/pension/resume
// so the Mastra workflow run resumes at the officer-review suspension point.
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

  // Write to pension_officer_actions (local audit record)
  await db.insert(pensionOfficerActions).values({
    tenantId,
    caseId: id,
    findingId: body.findingId ?? null,
    action: body.action,
    rationale: body.rationale ?? null,
    actorId: userId ?? null,
    actorRole: body.actorRole,
  });

  const newStatus = body.action === 'accept' ? 'cleared' : body.action === 'escalate' ? 'escalated' : 'reviewed';
  await db.update(pensionCases)
    .set({ status: newStatus as any, updatedAt: new Date() })
    .where(and(eq(pensionCases.id, id), eq(pensionCases.tenantId, tenantId)));

  // Tamper-evident audit log
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

  // Resume the Mastra workflow run at the officer-review suspension point.
  // Best-effort — if the relay is unreachable the DB state is already correct.
  try {
    const res = await fetch(`${RELAY_URL}/internal/pension/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_KEY ? { 'x-internal-service-key': INTERNAL_KEY } : {}),
      },
      body: JSON.stringify({
        caseId: id,
        action: body.action,
        rationale: body.rationale,
        officerId: userId,
        actorRole: body.actorRole,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[pension/action] relay resume returned ${res.status} for caseId=${id}`);
    }
  } catch (err) {
    console.warn('[pension/action] relay resume call failed (best-effort):', (err as Error).message);
  }

  return c.json({ ok: true, status: newStatus });
});
