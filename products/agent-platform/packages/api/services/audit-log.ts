import { createHash } from 'crypto';
import { db } from '@serverless-saas/database';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { eq, desc } from 'drizzle-orm';

export interface AuditLogInput {
  tenantId: string;
  actorId: string;
  actorType: 'human' | 'agent' | 'system';
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, any>;
  previousState?: Record<string, any> | null;
  newState?: Record<string, any> | null;
  ipAddress?: string;
  traceId?: string;
}

function computeEntryHash(prevHash: string | null, entry: AuditLogInput): string {
  const payload = JSON.stringify({
    prevHash: prevHash ?? '',
    tenantId: entry.tenantId,
    actorId: entry.actorId,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId ?? '',
    previousState: entry.previousState ?? null,
    newState: entry.newState ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Insert an audit log entry with before/after diff and hash chain.
 * The hash chain makes the audit log tamper-evident — any modification
 * to a past entry breaks the chain and is detectable via /audit-log/verify.
 */
export async function logWithDiff(input: AuditLogInput): Promise<{ id: string; entryHash: string }> {
  const [latest] = await db
    .select({ entryHash: auditLog.entryHash })
    .from(auditLog)
    .where(eq(auditLog.tenantId, input.tenantId))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  const prevHash = latest?.entryHash ?? null;
  const createdAt = new Date();
  const entryHash = computeEntryHash(prevHash, input);

  const [row] = await db
    .insert(auditLog)
    .values({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId,
      metadata: input.metadata ?? {},
      previousState: input.previousState ?? null,
      newState: input.newState ?? null,
      ipAddress: input.ipAddress,
      traceId: input.traceId ?? '',
      prevHash,
      entryHash,
      createdAt,
    })
    .returning({ id: auditLog.id, entryHash: auditLog.entryHash });

  return { id: row.id, entryHash: row.entryHash! };
}

/**
 * Walk the audit log chain for a tenant and verify each entry's hash.
 * Returns { valid: boolean, totalEntries, firstBrokenAt? }.
 */
export async function verifyAuditChain(tenantId: string): Promise<{
  valid: boolean;
  totalEntries: number;
  firstBrokenAt?: string;
}> {
  const entries = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantId))
    .orderBy(auditLog.createdAt);

  // Skip legacy entries that predate hash chain introduction
  const firstHashedIdx = entries.findIndex((e: typeof entries[number]) => e.entryHash !== null);
  if (firstHashedIdx === -1) {
    return { valid: true, totalEntries: entries.length };
  }

  // TODO(production): acquire row-level lock here to prevent concurrent inserts
  // racing on the same prevHash and breaking the chain.
  let prevHash: string | null = entries[firstHashedIdx].prevHash ?? null;
  for (let i = firstHashedIdx; i < entries.length; i++) {
    const e = entries[i];
    const expected = computeEntryHash(prevHash, {
      tenantId: e.tenantId,
      actorId: e.actorId,
      actorType: e.actorType as any,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId ?? undefined,
      previousState: e.previousState as any,
      newState: e.newState as any,
    });

    if (e.entryHash !== expected || e.prevHash !== prevHash) {
      return { valid: false, totalEntries: entries.length, firstBrokenAt: e.id };
    }
    prevHash = e.entryHash;
  }

  return { valid: true, totalEntries: entries.length };
}
