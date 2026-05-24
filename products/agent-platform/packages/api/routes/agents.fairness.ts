import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { agentFairnessReviews } from '@serverless-saas/agent-schema/fairness';
import type { FairnessCheckResult } from '@serverless-saas/agent-schema/fairness';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const agentFairnessRoutes = new Hono<AppEnv>();

// ── Check engine (exported for ops reuse) ────────────────────────────────────

export const DEMOGRAPHIC_BIAS_PATTERNS = [
  /\b(only for|exclusively for|restricted to|limited to)\s+(male|female|men|women|hindu|muslim|christian|sikh|premium|vip|corporate|english.speaking)\b/i,
  /\b(ignore|refuse|reject)\s+(requests?|queries|messages?)\s+(in hindi|in regional|from rural|from small town)\b/i,
];

export const LANGUAGE_RESTRICTION_PATTERNS = [
  /respond\s+only\s+in\s+(english|hindi|marathi|tamil|bengali)\b/i,
  /answer\s+(only|exclusively)\s+in\s+english\b/i,
  /do\s+not\s+(respond|answer)\s+in\s+(hindi|regional|vernacular)\b/i,
];

export function checkDemographicLanguage(texts: string[]): FairnessCheckResult {
  const combined = texts.join(' ');
  for (const pattern of DEMOGRAPHIC_BIAS_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return { checkId: 'demographic_language', name: 'Demographic Language Scan', status: 'fail', detail: `Detected potentially biasing language: "${match[0]}"` };
    }
  }
  return { checkId: 'demographic_language', name: 'Demographic Language Scan', status: 'pass', detail: 'No demographic conditioning language detected in agent configuration.' };
}

export function checkLanguageRestriction(texts: string[]): FairnessCheckResult {
  const combined = texts.join(' ');
  for (const pattern of LANGUAGE_RESTRICTION_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return { checkId: 'language_restriction', name: 'Language Restriction Check', status: 'warn', detail: `Agent may restrict responses to a single language: "${match[0]}". Ensure multilingual customers are served equally.` };
    }
  }
  return { checkId: 'language_restriction', name: 'Language Restriction Check', status: 'pass', detail: 'No language-based exclusion detected.' };
}

export function checkInclusiveScope(texts: string[]): FairnessCheckResult {
  const combined = texts.join(' ');
  const hasExclusionary = /\b(only|exclusively)\s+(premium|vip|corporate|select)\s+(clients?|customers?|users?)\b/i.test(combined);
  if (hasExclusionary) {
    return { checkId: 'inclusive_scope', name: 'Inclusive Scope Check', status: 'warn', detail: 'Agent appears scoped to a specific customer segment. Verify this is intentional and documented.' };
  }
  const hasInclusive = /\b(all customers?|all users?|regardless of|any language|multilingual)\b/i.test(combined);
  return { checkId: 'inclusive_scope', name: 'Inclusive Scope Check', status: 'pass', detail: hasInclusive ? 'Agent explicitly serves all customer segments.' : 'No exclusionary scope detected.' };
}

export function deriveOverallStatus(results: FairnessCheckResult[]): 'pass' | 'warn' | 'fail' {
  if (results.some(r => r.status === 'fail')) return 'fail';
  if (results.some(r => r.status === 'warn')) return 'warn';
  return 'pass';
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /agents/:agentId/fairness/run
agentFairnessRoutes.post('/:agentId/fairness/run', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = requestContext?.userId;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'agents', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const agentId = c.req.param('agentId');
  const [agent] = await db.select({ id: agents.id, description: agents.description })
    .from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const skills = await db.select({ systemPrompt: agentSkills.systemPrompt, tools: agentSkills.tools })
    .from(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.tenantId, tenantId)));

  const texts = [agent.description ?? '', ...skills.map((s: { systemPrompt: string; tools: string[] }) => s.systemPrompt), ...skills.flatMap((s: { systemPrompt: string; tools: string[] }) => s.tools)];

  const checkResults: FairnessCheckResult[] = [
    checkDemographicLanguage(texts),
    checkLanguageRestriction(texts),
    checkInclusiveScope(texts),
  ];
  const overallStatus = deriveOverallStatus(checkResults);

  const [review] = await db.insert(agentFairnessReviews).values({
    agentId,
    tenantId,
    runBy: userId,
    overallStatus,
    checkResults,
  }).returning();

  return c.json({ review });
});

// GET /agents/:agentId/fairness
agentFairnessRoutes.get('/:agentId/fairness', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

  const agentId = c.req.param('agentId');
  const [review] = await db.select().from(agentFairnessReviews)
    .where(and(eq(agentFairnessReviews.agentId, agentId), eq(agentFairnessReviews.tenantId, tenantId)))
    .orderBy(desc(agentFairnessReviews.runAt)).limit(1);

  return c.json({ review: review ?? null });
});
