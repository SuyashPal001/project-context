import { describe, it, expect } from 'vitest';
import { isSessionValidationExempt, SESSION_EXEMPT_PATHS } from './sessionExempt';

/**
 * F-15 — the session-validation exemption list must actually match.
 *
 * The bug: `except(['/auth/me', '/auth/tenants'], sessionValidationMiddleware)`
 * never matched anything. Hono's `except` tests `c.req.path`, which is the FULL
 * request path — and the sub-app is mounted at /api/v1, so the real path is
 * `/api/v1/auth/me`. The bare paths never matched, so the exemption silently did
 * nothing and session validation ran everywhere.
 *
 * The danger was less the current behaviour than the appearance of one: the list
 * looked functional, so anything added to it later would be ignored too. This is
 * the same missing-prefix mistake already shipped once in commit 09f66d3.
 *
 * Matching is now an explicit, tested predicate rather than a library call whose
 * path semantics are easy to get wrong.
 */

describe('isSessionValidationExempt', () => {
  it('exempts /auth/me at its real mounted path', () => {
    expect(isSessionValidationExempt('/api/v1/auth/me')).toBe(true);
  });

  it('exempts /auth/tenants at its real mounted path', () => {
    expect(isSessionValidationExempt('/api/v1/auth/tenants')).toBe(true);
  });

  it('does not exempt other auth routes', () => {
    expect(isSessionValidationExempt('/api/v1/auth/logout')).toBe(false);
    expect(isSessionValidationExempt('/api/v1/auth/switch-tenant')).toBe(false);
  });

  it('does not exempt unrelated routes', () => {
    expect(isSessionValidationExempt('/api/v1/documents')).toBe(false);
    expect(isSessionValidationExempt('/api/v1/tenants')).toBe(false);
  });

  it('is not fooled by a path that merely contains an exempt path', () => {
    // A prefix match would wrongly exempt these.
    expect(isSessionValidationExempt('/api/v1/auth/me/evil')).toBe(false);
    expect(isSessionValidationExempt('/api/v1/auth/tenants/steal')).toBe(false);
  });

  it('ignores a trailing slash', () => {
    expect(isSessionValidationExempt('/api/v1/auth/me/')).toBe(true);
  });

  it('ignores a query string', () => {
    expect(isSessionValidationExempt('/api/v1/auth/tenants?all=1')).toBe(true);
  });

  it('declares its exempt paths with the mount prefix included', () => {
    // The root cause was paths written without /api/v1. Pin that.
    for (const p of SESSION_EXEMPT_PATHS) {
      expect(p.startsWith('/api/v1/')).toBe(true);
    }
  });
});
