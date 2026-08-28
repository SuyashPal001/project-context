import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, creditAccounts, creditGrants, creditLedger, creditRates } from '@serverless-saas/database';
import type { PricingSchema } from './rate';

export interface GrantSummary {
  grantType: string;
  amountMicro: bigint;
  spentMicro: bigint;
  expiresAt: Date | null;
}

export type LedgerRow = typeof creditLedger.$inferSelect;

/**
 * Reads the `credits` entitlement for a tenant's active/trialing subscription.
 * A tenant feature override wins over the plan entitlement. Mirrors the
 * entitlement lookup in `checkMessageQuota`
 * (apps/agent-orchestrator/src/usage.ts). Returns false (not unlimited) for a
 * tenant with no active subscription row, rather than throwing.
 */
export async function isUnlimited(tenantId: string): Promise<boolean> {
  const [row] = await db.execute(sql`
    select coalesce(tfo.unlimited, pe.unlimited, false) as unlimited
      from subscriptions s
      join features f on f.key = 'credits'
      left join plan_entitlements pe on pe.plan = s.plan::text and pe.feature_id = f.id
      left join tenant_feature_overrides tfo
             on tfo.tenant_id = s.tenant_id and tfo.feature_id = f.id
            and tfo.revoked_at is null and tfo.deleted_at is null
            and (tfo.expires_at is null or tfo.expires_at > now())
     where s.tenant_id = ${tenantId} and s.status in ('active','trialing')
     limit 1
  `) as unknown as { unlimited: boolean }[];
  return row?.unlimited ?? false;
}

export async function getBalance(tenantId: string): Promise<{
  balanceMicro: bigint;
  unlimited: boolean;
  grants: GrantSummary[];
}> {
  const [account] = await db.select().from(creditAccounts)
    .where(eq(creditAccounts.tenantId, tenantId)).limit(1);
  const grants = await db.select().from(creditGrants).where(and(
    eq(creditGrants.tenantId, tenantId),
    or(isNull(creditGrants.expiresAt), gt(creditGrants.expiresAt, new Date())),
    sql`${creditGrants.spentMicro} < ${creditGrants.amountMicro}`,
  ));
  return {
    balanceMicro: account?.balanceMicro ?? 0n,
    unlimited: await isUnlimited(tenantId),
    grants: grants.map<GrantSummary>(g => ({
      grantType: g.grantType, amountMicro: g.amountMicro,
      spentMicro: g.spentMicro, expiresAt: g.expiresAt,
    })),
  };
}

export interface GetLedgerOpts {
  limit?: number;
  before?: Date;
  kind?: string;
}

export async function getLedger(tenantId: string, opts: GetLedgerOpts = {}): Promise<LedgerRow[]> {
  const conditions = [eq(creditLedger.tenantId, tenantId)];
  if (opts.before) conditions.push(sql`${creditLedger.createdAt} < ${opts.before}`);
  if (opts.kind) conditions.push(eq(creditLedger.kind, opts.kind as never));
  return db.select().from(creditLedger).where(and(...conditions))
    .orderBy(desc(creditLedger.createdAt)).limit(Math.min(opts.limit ?? 50, 200));
}

/** Active rate for (resourceType, subject), falling back to the '*' subject row. */
export async function resolveRate(
  resourceType: string,
  subject: string,
): Promise<{ id: string; version: number; schema: PricingSchema } | null> {
  const rows = await db.select().from(creditRates).where(and(
    eq(creditRates.resourceType, resourceType as never),
    eq(creditRates.isActive, true),
    sql`${creditRates.subject} in (${subject}, '*')`,
  ));
  // exact subject wins over the wildcard
  const row = rows.find(r => r.subject === subject) ?? rows.find(r => r.subject === '*');
  return row ? { id: row.id, version: row.version, schema: row.pricingSchema as PricingSchema } : null;
}
