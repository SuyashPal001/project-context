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
 *
 * Ordered `started_at desc nulls last, limit 1` to match
 * ./lifecycle.ts's planCreditAllowance(), which runs
 * the same join. A tenant should never carry two rows in ('active',
 * 'trialing') at once, but if one ever slips through, a bare `limit 1` here
 * and an ordered `limit 1` there could each pick a different row and
 * disagree on whether the tenant is unlimited - keep the ordering identical
 * rather than relying on that invariant never breaking.
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
     order by s.started_at desc nulls last
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

export interface UsageByType {
  text: bigint;
  image: bigint;
  video: bigint;
  audio: bigint;
}

/** credit_ledger.jobType values that bucket into "text" spend. Anything not
 * listed here and not one of the media job types below also falls into
 * text — a new/unrecognized jobType must never silently disappear from the
 * total. */
const IMAGE_JOB_TYPE = 'image_generation';
const VIDEO_JOB_TYPE = 'video_generation';
const AUDIO_JOB_TYPE = 'music_generation';

export async function getUsageByType(tenantId: string): Promise<UsageByType> {
  const rows = await db.execute(sql`
    select job_type, sum(-amount_micro) as spent
      from credit_ledger
     where tenant_id = ${tenantId} and kind = 'debit'
     group by job_type
  `) as unknown as { job_type: string | null; spent: string | null }[];

  const usage: UsageByType = { text: 0n, image: 0n, video: 0n, audio: 0n };
  for (const row of rows) {
    const spent = BigInt(row.spent ?? '0');
    if (row.job_type === IMAGE_JOB_TYPE) usage.image += spent;
    else if (row.job_type === VIDEO_JOB_TYPE) usage.video += spent;
    else if (row.job_type === AUDIO_JOB_TYPE) usage.audio += spent;
    else usage.text += spent;
  }
  return usage;
}

export interface LastGrantSummary {
  amountMicro: bigint;
  spentMicro: bigint;
  grantType: string;
}

/** The tenant's most recently created grant, regardless of expiry or
 * remaining balance — used only to compute a "percent since last top-up"
 * indicator, not for spend-eligibility (that's getBalance's job). */
export async function getLastGrant(tenantId: string): Promise<LastGrantSummary | null> {
  const [row] = await db.select().from(creditGrants)
    .where(eq(creditGrants.tenantId, tenantId))
    .orderBy(desc(creditGrants.createdAt)).limit(1);
  if (!row) return null;
  return { amountMicro: row.amountMicro, spentMicro: row.spentMicro, grantType: row.grantType };
}
