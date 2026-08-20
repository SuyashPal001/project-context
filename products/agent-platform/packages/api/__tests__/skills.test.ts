import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

function appWithContext(permissionAction = 'create') {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [{ resource: 'skills', action: permissionAction }] });
    c.set('userId', 'user-1');
    c.set('traceId', 'trace-1');
    await next();
  });
  return app;
}

describe('POST /skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/queue';
  });

  it('creates a skill row, a version-1 row, and enqueues skill.import', async () => {
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          if (table === skills) return [{ id: 'skill-1', ...data }];
          if (table === skillVersions) return [{ id: 'version-1', ...data }];
          return [{ id: 'audit-1' }];
        },
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PDF Tools', source: { type: 'zip', fileKey: 'tenants/tenant-1/skill-uploads/x.zip' } }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.skill.name).toBe('PDF Tools');
    expect(body.data.version.version).toBe(1);
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/queue', expect.objectContaining({ type: 'skill.import', skillId: 'skill-1', version: 1 }));
  });

  it('rejects without skills:create permission', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PDF Tools', source: { type: 'zip', fileKey: 'x' } }),
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /skills/:id — new version', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes the next version as max(version)+1 for that skill', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-1' }] }) };
        if (table === skillVersions) return { where: () => ({ orderBy: () => ({ limit: async () => [{ v: 3 }] }) }) };
        throw new Error('unexpected select target');
      },
    }));
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({ returning: async () => [{ id: 'version-4', ...data }] }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'url', url: 'https://example.com/pack.zip' } }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.version.version).toBe(4);
  });
});

describe('GET /skills/:id/versions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 for another tenant\'s private skill', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) {
          return {
            where: () => ({
              limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false }],
            }),
          };
        }
        throw new Error('unexpected select target');
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/versions');

    expect(res.status).toBe(403);
  });

  it('returns 200 for a public skill not owned by the caller', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) {
          return {
            where: () => ({
              limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false }],
            }),
          };
        }
        if (table === skillVersions) {
          return { where: () => ({ orderBy: async () => [{ id: 'version-1', skillId: 'skill-1', version: 1 }] }) };
        }
        throw new Error('unexpected select target');
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/versions');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('version-1');
  });
});

describe('POST /skills/:id/publish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects publishing a skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'private' }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/publish', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('flips visibility to public for the owning tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-1', visibility: 'private' }] }) }),
    }));
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skills ? [{ id: 'skill-1', ownerTenantId: 'tenant-1', ...data }] : []) }),
      }),
    }));
    dbMock.insert.mockImplementation(() => ({ values: () => ({ catch: () => {} }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/publish', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.visibility).toBe('public');
  });
});

describe('POST /skills/:id/install', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs a public skill from another tenant, pinned to latestVersion', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'public', latestVersion: 5 }] }) }),
    }));
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: 'install-1', ...data }] }),
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install', { method: 'POST' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(5);
  });

  it('installs an official-but-private skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: true, latestVersion: 3 }] }) }),
    }));
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: 'install-1', ...data }] }),
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install', { method: 'POST' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(3);
  });

  it('refuses to install a private, non-official skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false, latestVersion: 1 }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('POST /skills/:id/install/update', () => {
  beforeEach(() => vi.clearAllMocks());

  it("bumps the installed version to latestVersion for the caller's own active install row", async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', latestVersion: 7 }] }) }),
    }));
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skillInstalls ? [{ id: 'install-1', tenantId: 'tenant-1', skillId: 'skill-1', ...data }] : []) }),
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install/update', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(7);
  });

  it("returns 404 when the caller has no active install row for that skill (covers both 'never installed' and a different tenant's row)", async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'skill-1', latestVersion: 7 }] }) }),
    }));
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install/update', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /skills/:id/install', () => {
  beforeEach(() => vi.clearAllMocks());

  it('soft-uninstalls by flipping status, not deleting the row', async () => {
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skillInstalls ? [{ id: 'install-1', ...data }] : []) }),
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install', { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('returns 404 when nothing was installed', async () => {
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/skill-1/install', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
