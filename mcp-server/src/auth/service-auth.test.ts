import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuthorizedCaller, resolveTenantContext } from './service-auth';

/**
 * F-02 — the MCP server must authenticate its callers.
 *
 * The bug: POST /mcp had no auth middleware of any kind, and tenant identity
 * came from an `x-tenant-id` header validated only for non-emptiness. That
 * header is the sole key used to fetch and DECRYPT a tenant's Google OAuth
 * credentials, and the registered tools are GMAIL_SEND_EMAIL, GMAIL_READ_EMAIL,
 * GMAIL_SEARCH_EMAILS and GMAIL_REPLY_EMAIL. Anyone who could reach port 3002
 * could name any tenant and get full mailbox access to that organisation.
 *
 * Every other internal hop in the platform authenticates with a shared service
 * key compared in constant time; this brings the MCP server in line.
 */

const SECRET = 'a'.repeat(48);

describe('isAuthorizedCaller', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = SECRET;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = ORIGINAL;
  });

  it('accepts the correct service key', () => {
    expect(isAuthorizedCaller(SECRET)).toBe(true);
  });

  it('rejects a wrong key of the same length', () => {
    expect(isAuthorizedCaller('b'.repeat(48))).toBe(false);
  });

  it('rejects a missing key', () => {
    expect(isAuthorizedCaller(undefined)).toBe(false);
    expect(isAuthorizedCaller('')).toBe(false);
  });

  it('rejects a key of a different length without throwing', () => {
    // timingSafeEqual throws on length mismatch; that must read as "denied".
    expect(isAuthorizedCaller('short')).toBe(false);
    expect(isAuthorizedCaller('c'.repeat(200))).toBe(false);
  });

  it('denies everything when the server has no key configured', () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    // Fail closed: an unconfigured server must not accept the empty string.
    expect(isAuthorizedCaller('')).toBe(false);
    expect(isAuthorizedCaller(SECRET)).toBe(false);
  });
});

describe('resolveTenantContext', () => {
  it('refuses a request with no tenant', () => {
    expect(resolveTenantContext({})).toEqual({
      ok: false,
      status: 400,
      error: 'x-tenant-id header is required',
    });
  });

  it('accepts a tenant and carries the agent through when supplied', () => {
    expect(
      resolveTenantContext({ 'x-tenant-id': 'tenant-1', 'x-agent-id': 'agent-9' }),
    ).toEqual({ ok: true, tenantId: 'tenant-1', agentId: 'agent-9' });
  });

  it('reports a missing agent as absent rather than inventing one', () => {
    const result = resolveTenantContext({ 'x-tenant-id': 'tenant-1' });
    expect(result).toEqual({ ok: true, tenantId: 'tenant-1', agentId: undefined });
  });

  it('ignores a blank tenant header', () => {
    expect(resolveTenantContext({ 'x-tenant-id': '   ' }).ok).toBe(false);
  });

  it('takes the first value when a header is repeated', () => {
    // Express surfaces duplicated headers as arrays; picking the last would let
    // an attacker append their own value to a legitimate proxied request.
    const result = resolveTenantContext({ 'x-tenant-id': ['tenant-1', 'tenant-evil'] });
    expect(result).toEqual({ ok: true, tenantId: 'tenant-1', agentId: undefined });
  });
});
