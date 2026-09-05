import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillVersions, skillInstalls } from '@serverless-saas/agent-schema/skills';
import { users } from '@serverless-saas/database/schema/auth';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

// Every :id path param is UUID-validated before it reaches the DB, so the
// fixtures have to be real UUIDs — a non-UUID id is now a 404 by design.
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_1 = 'tenant-1';
const OWN_KEY = `tenants/${TENANT_1}/skill-uploads/abc-pack.zip`;
const FOREIGN_KEY = 'tenants/tenant-2/skill-uploads/abc-pack.zip';

function appWithContext(permissionAction = 'create') {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT_1 }, permissions: [{ resource: 'skills', action: permissionAction }] });
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
          if (table === skills) return [{ id: SKILL_ID, ...data }];
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
      body: JSON.stringify({ name: 'PDF Tools', source: { type: 'zip', fileKey: OWN_KEY } }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.skill.name).toBe('PDF Tools');
    expect(body.data.version.version).toBe(1);
    expect(publishToQueueMock).toHaveBeenCalledWith('https://sqs.test/queue', expect.objectContaining({ type: 'skill.import', skillId: SKILL_ID, version: 1 }));
  });

  it("rejects a zip fileKey under another tenant's upload prefix", async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen', source: { type: 'zip', fileKey: FOREIGN_KEY } }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a zip fileKey outside the skill-uploads prefix entirely', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen', source: { type: 'zip', fileKey: 'skill-packages/other/1/SKILL.md' } }),
    });

    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a traversal attempt that starts with a legitimate prefix', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen', source: { type: 'zip', fileKey: `tenants/${TENANT_1}/skill-uploads/../../tenant-2/skill-uploads/x.zip` } }),
    });

    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects without skills:create permission', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PDF Tools', source: { type: 'zip', fileKey: OWN_KEY } }),
    });

    expect(res.status).toBe(403);
  });

  it('accepts an authored source and enqueues it with sourceType authored', async () => {
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          if (table === skills) return [{ id: SKILL_ID, ...data }];
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
      body: JSON.stringify({
        name: 'Bid Writer',
        source: { type: 'authored', body: '---\nname: bid-writer\ndescription: Writes bids\n---\n\nDo the thing.' },
      }),
    });

    expect(res.status).toBe(202);
    expect(publishToQueueMock).toHaveBeenCalledTimes(1);
    const [, message] = publishToQueueMock.mock.calls[0];
    expect(message.type).toBe('skill.import');
    expect(message.source).toEqual({
      type: 'authored',
      body: '---\nname: bid-writer\ndescription: Writes bids\n---\n\nDo the thing.',
    });
  });

  // An authored version has no external source to point back at — unlike a zip
  // (fileKey), a URL, or owner/repo@ref — so sourceRef stays null rather than
  // duplicating the body into a text column the UI never reads.
  it('stores a null sourceRef for an authored version', async () => {
    const inserted: Record<string, unknown>[] = [];
    dbMock.insert.mockImplementation((table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        if (table === skillVersions) inserted.push(data);
        return {
          returning: async () => {
            if (table === skills) return [{ id: SKILL_ID, ...data }];
            if (table === skillVersions) return [{ id: 'version-1', ...data }];
            return [{ id: 'audit-1' }];
          },
          catch: () => {},
        };
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bid Writer',
        source: { type: 'authored', body: '---\nname: bid-writer\ndescription: d\n---\n\nBody.' },
      }),
    });

    expect(inserted[0].sourceType).toBe('authored');
    expect(inserted[0].sourceRef).toBeNull();
  });

  it('rejects an authored body over 64KB', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Huge', source: { type: 'authored', body: 'x'.repeat(65_537) } }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects an empty authored body', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty', source: { type: 'authored', body: '' } }),
    });

    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });
});

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

describe('GET /skills', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the install row id so the attach picker can send a real skill_installs.id', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', installId: 'install-1', installedVersion: 2, installStatus: 'active' }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=installed');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].installId).toBe('install-1');
    expect(body.data[0].installed).toBe(true);
    expect(body.data[0].latestVersionStatus).toBe('ready');
  });

  it('surfaces a failed import as latestVersionStatus + failureReason for the owning tenant', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'Broken', ownerTenantId: TENANT_1, installId: null, installedVersion: null, installStatus: null }],
      [{ skillId: SKILL_ID, status: 'failed', failureReason: 'SKILL.md not found at the archive root' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=mine');
    const body = await res.json();
    expect(body.data[0].latestVersionStatus).toBe('failed');
    expect(body.data[0].failureReason).toBe('SKILL.md not found at the archive root');
    expect(body.data[0].installed).toBe(false);
  });

  it("hides another tenant's failureReason on the public/official tabs while still surfacing latestVersionStatus", async () => {
    // A tenant browsing Public/Official can see skills owned by other
    // tenants. failureReason sometimes carries raw rejection detail (a
    // blocked hostname, manifest specifics) that must not leak cross-tenant,
    // even though the status itself (so the card can render "failed" instead
    // of a stuck spinner) is fine for anyone to see.
    mockList(
      [{ id: SKILL_ID, name: 'Broken', ownerTenantId: 'tenant-2', installId: null, installedVersion: null, installStatus: null }],
      [{ skillId: SKILL_ID, status: 'failed', failureReason: 'Could not resolve host: internal-host.example' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=public');
    const body = await res.json();
    expect(body.data[0].latestVersionStatus).toBe('failed');
    expect(body.data[0].failureReason).toBeNull();
  });

  it('falls back to null status when a skill has no version rows yet', async () => {
    mockList([{ id: SKILL_ID, name: 'Fresh', installStatus: null }], []);

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills');
    const body = await res.json();
    expect(body.data[0].latestVersionStatus).toBeNull();
    expect(body.data[0].failureReason).toBeNull();
  });

  it('skips the version lookup entirely when no skills matched', async () => {
    mockList([], []);

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
    expect(dbMock.selectDistinctOn).not.toHaveBeenCalled();
  });

  it('returns the creating user as ownerName, with ownerEmail for the owning tenant', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=mine');
    const body = await res.json();
    expect(body.data[0].ownerName).toBe('Ada Lovelace');
    expect(body.data[0].ownerEmail).toBe('ada@example.com');
    expect(body.data[0].createdBy).toBeUndefined();
  });

  it("hides another tenant's owner email on the public tab but still names the author", async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: 'tenant-2', createdBy: 'user-9', installStatus: null }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=public');
    const body = await res.json();
    expect(body.data[0].ownerName).toBe('Ada Lovelace');
    expect(body.data[0].ownerEmail).toBeNull();
  });
});

describe('POST /skills/:id — new version', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes the next version as max(version)+1 for that skill', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1 }] }) };
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

    const res = await app.request(`/skills/${SKILL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'url', url: 'https://example.com/pack.zip' } }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.version.version).toBe(4);
  });

  it("rejects a new version sourced from another tenant's upload key", async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'zip', fileKey: FOREIGN_KEY } }),
    });

    expect(res.status).toBe(400);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed skill id instead of a 500 from Postgres', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'url', url: 'https://example.com/pack.zip' } }),
    });

    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('GET /skills/:id/versions', () => {
  beforeEach(() => vi.clearAllMocks());

  const fullVersionRow = {
    id: 'version-1',
    skillId: SKILL_ID,
    version: 1,
    manifest: { name: 'PDF Tools' },
    s3Prefix: `skill-packages/${SKILL_ID}/1`,
    sourceType: 'zip',
    sourceRef: 'tenants/tenant-2/skill-uploads/secret-pack.zip',
    status: 'ready',
    failureReason: 'internal detail',
  };

  function mockSkillAndVersions(skill: Record<string, unknown>) {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [skill] }) };
        if (table === skillVersions) return { where: () => ({ orderBy: async () => [fullVersionRow] }) };
        throw new Error('unexpected select target');
      },
    }));
  }

  it("returns 403 for another tenant's private skill", async () => {
    mockSkillAndVersions({ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/versions`);

    expect(res.status).toBe(403);
  });

  it('returns 200 for a public skill not owned by the caller', async () => {
    mockSkillAndVersions({ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/versions`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('version-1');
  });

  it("does not leak the owner's sourceRef/s3Prefix/failureReason to a non-owner", async () => {
    mockSkillAndVersions({ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/versions`);
    const body = await res.json();

    expect(body.data[0]).not.toHaveProperty('sourceRef');
    expect(body.data[0]).not.toHaveProperty('s3Prefix');
    expect(body.data[0]).not.toHaveProperty('failureReason');
    // The rest of the row is still there — this strips fields, not the row.
    expect(body.data[0].version).toBe(1);
    expect(body.data[0].status).toBe('ready');
    expect(JSON.stringify(body)).not.toContain('secret-pack.zip');
  });

  it('still returns the full row to the owning tenant', async () => {
    mockSkillAndVersions({ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', isOfficial: false });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/versions`);
    const body = await res.json();

    expect(body.data[0].sourceRef).toBe('tenants/tenant-2/skill-uploads/secret-pack.zip');
    expect(body.data[0].s3Prefix).toBe(`skill-packages/${SKILL_ID}/1`);
    expect(body.data[0].failureReason).toBe('internal detail');
  });

  it('returns 404 for a malformed skill id instead of a 500 from Postgres', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/versions');
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns a generic 500 rather than a raw DB error when the query throws', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => { throw new Error('connection terminated: password=hunter2'); } }) }),
    }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/versions`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR' });
    consoleSpy.mockRestore();
  });
});

describe('POST /skills/:id/publish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects publishing a skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', latestVersion: 1 }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/publish`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('refuses to publish a skill with no ready version', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', latestVersion: 0 }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/publish`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_READY');
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('flips visibility to public for the owning tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', latestVersion: 2 }] }) }),
    }));
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skills ? [{ id: SKILL_ID, ownerTenantId: TENANT_1, ...data }] : []) }),
      }),
    }));
    dbMock.insert.mockImplementation(() => ({ values: () => ({ catch: () => {} }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/publish`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.visibility).toBe('public');
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/publish', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('POST /skills/:id/install', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs a public skill from another tenant, pinned to latestVersion', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', latestVersion: 5 }] }) }),
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

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(5);
  });

  it('installs an official-but-private skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: true, latestVersion: 3 }] }) }),
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

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(3);
  });

  it('refuses to install a private, non-official skill owned by a different tenant', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false, latestVersion: 1 }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/install', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('POST /skills/:id/install/update', () => {
  beforeEach(() => vi.clearAllMocks());

  it("bumps the installed version to latestVersion for the caller's own active install row", async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', latestVersion: 7 }] }) }),
    }));
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skillInstalls ? [{ id: 'install-1', tenantId: TENANT_1, skillId: SKILL_ID, ...data }] : []) }),
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install/update`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.installedVersion).toBe(7);
  });

  it("returns 404 when the caller has no active install row for that skill (covers both 'never installed' and a different tenant's row)", async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', latestVersion: 7 }] }) }),
    }));
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install/update`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it("applies the same owner/public/official visibility rule as install", async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false, latestVersion: 7 }] }) }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install/update`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('update');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/install/update', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
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

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('returns 404 when nothing was installed', async () => {
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed skill id', async () => {
    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('delete');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills/not-a-uuid/install', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});

describe('GET /skills/:id — owner info', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves ownerName/ownerEmail from skills.createdBy', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: TENANT_1, createdBy: 'user-9', latestVersion: 1, visibility: 'private', isOfficial: false }] }) };
        if (table === users) return { where: async () => [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }] };
        if (table === skillInstalls) return { where: () => ({ limit: async () => [] }) };
        if (table === skillVersions) return { where: () => ({ orderBy: () => ({ limit: async () => [{ status: 'ready', failureReason: null, manifest: { body: '# Hi' } }] }) }) };
        throw new Error('unexpected select target');
      },
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ownerName).toBe('Ada Lovelace');
    expect(body.data.ownerEmail).toBe('ada@example.com');
  });
});

describe('download_count', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes downloadCount on the list response', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: null, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=mine');
    expect((await res.json()).data[0].downloadCount).toBe(42);
  });

  it('increments skills.download_count on every successful install, globally', async () => {
    dbMock.select.mockImplementation(() => ({
      from: (table: unknown) => {
        if (table === skills) return { where: () => ({ limit: async () => [{ id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false, latestVersion: 3 }] }) };
        throw new Error('unexpected select target');
      },
    }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: 'install-1', installedVersion: 3 }] }),
        returning: async () => [{ id: 'audit-1' }],
        catch: () => {},
      }),
    }));

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/install`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });
});

describe('run_count', () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes this tenant's runCount from its own install row", async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: TENANT_1, createdBy: 'user-9', installStatus: 'active', installId: 'install-1', runCount: 7, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=installed');
    expect((await res.json()).data[0].runCount).toBe(7);
  });

  it('reports runCount 0 when this tenant has no install row', async () => {
    mockList(
      [{ id: SKILL_ID, name: 'PDF Tools', ownerTenantId: 'tenant-2', createdBy: 'user-9', installStatus: null, installId: null, runCount: null, downloadCount: 42 }],
      [{ skillId: SKILL_ID, status: 'ready', failureReason: null }],
      [{ id: 'user-9', name: 'Ada Lovelace', email: 'ada@example.com' }],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext('read');
    app.route('/skills', skillsRoutes);

    const res = await app.request('/skills?tab=public');
    expect((await res.json()).data[0].runCount).toBe(0);
  });
});
