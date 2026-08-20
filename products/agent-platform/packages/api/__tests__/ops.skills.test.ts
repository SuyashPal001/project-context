import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const SKILL_ID = '22222222-2222-4222-8222-222222222222';

describe('PATCH /ops/skills/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  function appAs(role: string) {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('jwtPayload', { 'custom:role': role });
      c.set('userId', 'ops-user-1');
      c.set('traceId', 'trace-1');
      await next();
    });
    return app;
  }

  it('rejects a non-platform-admin caller', async () => {
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = appAs('member');
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request(`/ops/skills/${SKILL_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(403);
  });

  it('flips isOfficial for a platform admin', async () => {
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skills ? [{ id: SKILL_ID, ...data }] : []) }),
      }),
    }));

    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = appAs('platform_admin');
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request(`/ops/skills/${SKILL_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isOfficial).toBe(true);
  });

  it('returns 404 for a malformed skill id instead of a 500 from Postgres', async () => {
    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = appAs('platform_admin');
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request('/ops/skills/not-a-uuid', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(404);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when the update throws', async () => {
    dbMock.update.mockImplementation(() => ({
      set: () => ({ where: () => ({ returning: async () => { throw new Error('connection terminated'); } }) }),
    }));

    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = appAs('platform_admin');
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request(`/ops/skills/${SKILL_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('QUERY_ERROR');
  });
});
