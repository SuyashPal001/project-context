import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { users } from '@serverless-saas/database/schema/auth';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

const SKILL_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_1 = 'tenant-1';

function appWithContext(permissionAction = 'read') {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT_1 }, permissions: [{ resource: 'skills', action: permissionAction }] });
    c.set('userId', 'user-1');
    c.set('traceId', 'trace-1');
    await next();
  });
  return app;
}

const SHOWCASE = { imageUrl: '/creative/avatars/beginner-fitness-instructor.jpg', bestFor: ['UGC ads'], starterPrompt: 'Create a new avatar for my ads' };

function mockList(
  rows: Record<string, unknown>[],
  versionRows: Record<string, unknown>[],
  ownerRows: Record<string, unknown>[] = [],
) {
  dbMock.select.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === users) return { where: async () => ownerRows };
      return { leftJoin: () => ({ where: () => ({ orderBy: async () => rows }) }) };
    },
  }));
  dbMock.selectDistinctOn.mockImplementation(() => ({
    from: () => ({ where: () => ({ orderBy: async () => versionRows }) }),
  }));
}

describe('GET /skills — showcase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns showcase from the row', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'Avatar creator', ownerTenantId: null, createdBy: null, isOfficial: true, showcase: SHOWCASE, installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=official');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].showcase).toEqual(SHOWCASE);
  });

  it('resolves owner: null and never throws for a NULL-owner Official skill', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'Avatar creator', ownerTenantId: null, createdBy: null, isOfficial: true, showcase: SHOWCASE, installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=official');
    const body = await res.json();
    expect(body.data[0].ownerName).toBeNull();
    expect(body.data[0].ownerEmail).toBeNull();
  });
});

describe('GET /skills/:id — showcase + NULL owner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns showcase and resolves owner fields without throwing when createdBy is NULL', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: null, createdBy: null, latestVersion: 1, visibility: 'public', isOfficial: true, showcase: SHOWCASE }] }) };
        if (table === users) return { where: async () => [] };
        if (table === skillInstalls) return { where: () => ({ limit: async () => [] }) };
        if (table === skillVersions) return { where: () => ({ orderBy: () => ({ limit: async () => [{ status: 'ready', failureReason: null, manifest: { body: '# Hi' } }] }) }) };
        throw new Error('unexpected select target');
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.showcase).toEqual(SHOWCASE);
    expect(body.data.ownerName).toBeNull();
    expect(body.data.ownerEmail).toBeNull();
  });
});

describe('POST /skills/:id/install — NULL-owner Official skill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('succeeds for any tenant when the skill has no owner (platform-owned Official)', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: null, visibility: 'public', isOfficial: true, latestVersion: 1 }] }) }),
    }));
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: 'install-1', ...data }] }),
        returning: async () => [{ id: 'audit-1' }],
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('create');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });
    expect(res.status).toBe(201);
  });
});
