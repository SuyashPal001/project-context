import { timingSafeEqual } from 'node:crypto';

/**
 * Inbound authentication for the MCP server.
 *
 * This service resolves a tenant's stored Google OAuth credentials and exposes
 * tools that can read, search, send and reply to that organisation's mail. The
 * tenant is named by a request header, so the header is only trustworthy if the
 * caller has already proven it is platform infrastructure.
 *
 * Matches the contract used by every other internal hop in the platform: a
 * shared `x-internal-service-key`, compared in constant time.
 */

/** Constant-time comparison that treats any failure — including length mismatch — as denial. */
export function isAuthorizedCaller(provided: string | undefined | null): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  // No configured key means the server cannot authenticate anyone. Deny, so a
  // misconfigured deployment is inert rather than wide open.
  if (!expected) return false;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on mismatch

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type TenantContext =
  | { ok: true; tenantId: string; agentId: string | undefined }
  | { ok: false; status: number; error: string };

type HeaderBag = Record<string, string | string[] | undefined>;

/** Express surfaces repeated headers as arrays; take the first, never the last. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Resolve the tenant/agent this request acts for.
 *
 * Callers must already be authenticated — this only shapes the context.
 */
export function resolveTenantContext(headers: HeaderBag): TenantContext {
  const tenantId = firstHeader(headers['x-tenant-id'])?.trim();
  if (!tenantId) {
    return { ok: false, status: 400, error: 'x-tenant-id header is required' };
  }

  const agentId = firstHeader(headers['x-agent-id'])?.trim() || undefined;
  return { ok: true, tenantId, agentId };
}
