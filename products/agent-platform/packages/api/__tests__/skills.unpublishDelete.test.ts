import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';

const s3SendMock = vi.hoisted(() => vi.fn(async () => ({ Contents: [] })));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = s3SendMock; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(() => Promise.resolve()),
  transaction: vi.fn(),
}));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_1 = 'tenant-1';

function appWithContext(permissionAction = 'update') {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT_1 }, permissions: [{ resource: 'skills', action: permissionAction }] });
    c.set('userId', 'user-1');
    c.set('traceId', 'trace-1');
    await next();
  });
  return app;
}

function mockSkillLookup(skill: Record<string, unknown> | null) {
  dbMock.select.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === skills) return { where: () => ({ limit: async () => (skill ? [skill] : []) }) };
      throw new Error('unexpected select target: ' + String(table));
    },
  }));
}

describe('POST /skills/:id/unpublish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unpublishing a skill owned by a different tenant', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public' });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/unpublish`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('rejects unpublishing an Official skill (ownerTenantId null)', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: null, visibility: 'public', isOfficial: true });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/unpublish`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 409 ALREADY_PRIVATE when the skill is already private', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private' });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/unpublish`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_PRIVATE');
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('flips visibility to private for the owning tenant and writes an audit row', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'public' });
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skills ? [{ id: SKILL_ID, ownerTenantId: TENANT_1, ...data }] : []) }),
      }),
    }));
    const auditInsert = vi.fn(() => ({ catch: () => {} }));
    dbMock.insert.mockImplementation(() => ({ values: auditInsert }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/unpublish`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.visibility).toBe('private');
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill_unpublished' }));
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/unpublish', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('DELETE /skills/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects deleting a skill owned by a different tenant', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private' });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('rejects deleting an Official skill (ownerTenantId null)', async () => {
    mockSkillLookup({ id: SKILL_ID, ownerTenantId: null, visibility: 'public', isOfficial: true });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 409 IN_USE with a workspace count and deletes nothing when other tenants have active installs', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'public' }] }) };
        if (table === skillInstalls) return { where: async () => [{ count: 3 }] };
        throw new Error('unexpected select target: ' + String(table));
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('IN_USE');
    expect(body.workspaces).toBe(3);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('hard-deletes the skill, detaching agent_skills rows tied to its installs first', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'public' }] }) };
        if (table === skillInstalls) return { where: async () => [{ count: 0 }] };
        throw new Error('unexpected select target: ' + String(table));
      },
    }));

    const deletedTables: unknown[] = [];
    const tx = {
      select: (cols: unknown) => ({
        from: (table: unknown) => ({
          where: async () => (table === skillInstalls ? [{ id: 'install-own' }] : []),
        }),
      }),
      delete: (table: unknown) => {
        deletedTables.push(table);
        return { where: async () => {} };
      },
    };
    dbMock.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => cb(tx));

    const auditInsert = vi.fn(() => ({ catch: () => {} }));
    dbMock.insert.mockImplementation(() => ({ values: auditInsert }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deletedTables).toEqual([agentSkills, skills]);
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill_deleted' }));
  });

  it('does not fail the delete when S3 cleanup throws', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private' }] }) };
        if (table === skillInstalls) return { where: async () => [{ count: 0 }] };
        throw new Error('unexpected select target: ' + String(table));
      },
    }));
    const tx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: () => ({ where: async () => {} }),
    };
    dbMock.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => cb(tx));
    dbMock.insert.mockImplementation(() => ({ values: () => ({ catch: () => {} }) }));
    s3SendMock.mockRejectedValueOnce(new Error('S3 unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    consoleSpy.mockRestore();
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown skill', async () => {
    mockSkillLookup(null);

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
