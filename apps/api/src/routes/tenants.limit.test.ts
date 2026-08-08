import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceLimit } from './tenants.limit';

/**
 * F-08 — workspace creation must honour the plan's entitlement.
 *
 * The bug had two halves and both are covered here.
 *
 * 1. `/tenants` was registered in app.ts BEFORE entitlementsMiddleware, so
 *    `requestContext.entitlements` was always undefined. The route read
 *    `?? {}` and silently fell back to a hardcoded limit of 1, capping every
 *    paid plan (starter 3 / pro 10 / enterprise unlimited) at one workspace and
 *    telling paying customers to upgrade.
 *
 * 2. The failure was *silent*. A missing entitlement map is a wiring error, not
 *    a free-tier user, so resolveWorkspaceLimit now refuses to guess.
 *
 * The source-order test guards the wiring itself, which is what actually broke.
 */

describe('resolveWorkspaceLimit', () => {
  const FEATURE = 'feat-workspaces';

  it('refuses to guess when the entitlement map is missing entirely', () => {
    // This is the exact state the bug produced. Silently returning {limit: 1}
    // here is what made a revenue bug invisible for as long as it existed.
    expect(() => resolveWorkspaceLimit(undefined, FEATURE)).toThrow(/entitlements/i);
  });

  it('grants the plan limit when the feature is entitled', () => {
    const result = resolveWorkspaceLimit({ [FEATURE]: { valueLimit: 10 } }, FEATURE);
    expect(result).toEqual({ unlimited: false, limit: 10 });
  });

  it('grants unlimited workspaces on an unlimited plan', () => {
    const result = resolveWorkspaceLimit({ [FEATURE]: { unlimited: true } }, FEATURE);
    expect(result.unlimited).toBe(true);
  });

  it('falls back to a single workspace only when the plan genuinely omits the feature', () => {
    const result = resolveWorkspaceLimit({ 'other-feature': { valueLimit: 5 } }, FEATURE);
    expect(result).toEqual({ unlimited: false, limit: 1 });
  });

  it('does not treat a disabled entitlement as unlimited', () => {
    const result = resolveWorkspaceLimit({ [FEATURE]: { valueLimit: 3, unlimited: false } }, FEATURE);
    expect(result).toEqual({ unlimited: false, limit: 3 });
  });
});

describe('app.ts middleware wiring', () => {
  const source = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
  const indexOfLine = (needle: string) => {
    const i = source.indexOf(needle);
    expect(i, `expected to find ${needle} in app.ts`).toBeGreaterThan(-1);
    return i;
  };

  it('registers /tenants after the entitlements middleware that it depends on', () => {
    // In Hono the chain runs in registration order and a handler that returns a
    // Response ends it, so a route registered above its middleware never sees it.
    expect(indexOfLine("api.route('/tenants'")).toBeGreaterThan(
      indexOfLine('entitlementsMiddleware)'),
    );
  });

  it('registers /tenants after tenant resolution so requestContext exists', () => {
    expect(indexOfLine("api.route('/tenants'")).toBeGreaterThan(
      indexOfLine('tenantResolutionMiddleware)'),
    );
  });

  it('keeps /onboarding and /invitations before tenant resolution deliberately', () => {
    // These two genuinely must run without a tenant (ADR-026); the guard exists
    // so a future reorder does not silently break onboarding.
    const tenantRes = indexOfLine('tenantResolutionMiddleware)');
    expect(indexOfLine("api.route('/onboarding'")).toBeLessThan(tenantRes);
    expect(indexOfLine("api.route('/invitations'")).toBeLessThan(tenantRes);
  });
});
