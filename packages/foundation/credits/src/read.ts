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
 * Reads the `credits` entitlement. Stubbed for now - Task 5 wires this to the
 * real entitlement check. The wrapper tests in this task don't exercise it.
 */
export async function isUnlimited(_tenantId: string): Promise<boolean> {
  return false; // Task 5
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
