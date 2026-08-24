import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills, skillInstalls } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }));

const s3SendMock = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = s3SendMock },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://signed.test/put') }));

const SKILL_ID = '22222222-2222-4222-8222-222222222222';
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

function mockSkillAndInstall(skillRow: Record<string, unknown>, installRows: Record<string, unknown>[]) {
  dbMock.select.mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === skills) return { where: () => ({ limit: async () => [skillRow] }) };
      if (table === skillInstalls) return { where: () => ({ limit: async () => installRows }) };
      throw new Error('unexpected select target');
    },
  }));
}

describe('GET /skills/:id/files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
  });

  it("lists the package files for this tenant's pinned version", async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', isOfficial: false, latestVersion: 3 },
      [{ installedVersion: 2 }],
    );
    s3SendMock.mockResolvedValueOnce({
      Contents: [
        { Key: `skill-packages/${SKILL_ID}/2/scripts/run.py`, Size: 120 },
        { Key: `skill-packages/${SKILL_ID}/2/SKILL.md`, Size: 900 },
      ],
    });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { fileName: 'SKILL.md', size: 900 },
      { fileName: 'scripts/run.py', size: 120 },
    ]);
    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Prefix: `skill-packages/${SKILL_ID}/2/` }) }),
    );
  });

  it('falls back to latestVersion when this tenant has no install', async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'public', isOfficial: false, latestVersion: 5 },
      [],
    );
    s3SendMock.mockResolvedValueOnce({ Contents: [{ Key: `skill-packages/${SKILL_ID}/5/SKILL.md`, Size: 10 }] });

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect((await res.json()).data).toEqual([{ fileName: 'SKILL.md', size: 10 }]);
  });

  it("returns 403 for another tenant's private skill", async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: 'tenant-2', visibility: 'private', isOfficial: false, latestVersion: 1 },
      [],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect(res.status).toBe(403);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it('returns an empty list without touching S3 when no version is ready', async () => {
    mockSkillAndInstall(
      { id: SKILL_ID, ownerTenantId: TENANT_1, visibility: 'private', isOfficial: false, latestVersion: 0 },
      [],
    );

    const { skillsRoutes } = await import('../routes/skills');
    const app = appWithContext();
    app.route('/skills', skillsRoutes);

    const res = await app.request(`/skills/${SKILL_ID}/files`);
    expect((await res.json()).data).toEqual([]);
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});
