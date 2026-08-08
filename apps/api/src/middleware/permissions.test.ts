import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { permissionSetKey } from '@serverless-saas/cache';

/**
 * F-06 — the permission cache must be readable and writable under the SAME key
 * the invalidation sites delete.
 *
 * The bug: the middleware hand-rolled `tenant:{t}:user:{u}:permissions` while
 * `cache/keys.ts` defines the convention as `...:perms`, which is what every
 * invalidator uses (workspaces.ts remove-member and delete-workspace,
 * auth.account.ts account deletion). Every del() therefore missed, the RBAC
 * cache was never invalidated, and a removed user kept their permissions for
 * the full 15-minute TTL.
 *
 * The test asserts the cache key the middleware actually touches, so it fails
 * for any divergence from the shared helper — including a future hand-rolled
 * string that happens to look right.
 */

const TENANT = 'tenant-abc';
const USER = 'user-xyz';

const cacheGet = vi.fn();
const cacheSet = vi.fn();

vi.mock('@serverless-saas/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@serverless-saas/cache')>();
  return {
    ...actual,
    getCacheClient: () => ({ get: cacheGet, set: cacheSet }),
  };
});

vi.mock('@serverless-saas/database', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ roleId: 'role-1' }]) }),
        innerJoin: () => ({
          where: () => Promise.resolve([{ resource: 'documents', action: 'read' }]),
        }),
      }),
    }),
  },
}));

vi.mock('@serverless-saas/database/schema/tenancy', () => ({ memberships: {} }));
vi.mock('@serverless-saas/database/schema/authorization', () => ({
  rolePermissions: {},
  permissions: {},
}));

async function runMiddleware() {
  const { permissionsMiddleware } = await import('./permissions');
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT } });
    c.set('userId', USER);
    await next();
  });
  app.use('*', permissionsMiddleware);
  app.get('/probe', (c) => c.json({ ok: true }));
  await app.request('/probe');
}

describe('permissionsMiddleware cache key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('reads using the shared permissionSetKey helper', async () => {
    cacheGet.mockResolvedValue(null);

    await runMiddleware();

    expect(cacheGet).toHaveBeenCalledWith(permissionSetKey(TENANT, USER));
  });

  it('writes using the shared permissionSetKey helper', async () => {
    cacheGet.mockResolvedValue(null);

    await runMiddleware();

    expect(cacheSet).toHaveBeenCalledWith(
      permissionSetKey(TENANT, USER),
      expect.any(String),
      expect.objectContaining({ ex: expect.any(Number) }),
    );
  });

  it('uses a key the invalidation sites can actually delete', async () => {
    cacheGet.mockResolvedValue(null);

    await runMiddleware();

    // The literal string workspaces.ts:200 / :282 and auth.account.ts:97 delete.
    const keyDeletedByInvalidators = `tenant:${TENANT}:user:${USER}:perms`;
    expect(cacheGet).toHaveBeenCalledWith(keyDeletedByInvalidators);
    expect(cacheSet).toHaveBeenCalledWith(
      keyDeletedByInvalidators,
      expect.any(String),
      expect.anything(),
    );
  });
});
