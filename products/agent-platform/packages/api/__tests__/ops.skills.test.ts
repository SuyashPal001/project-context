import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { skills } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

describe('PATCH /ops/skills/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a non-platform-admin caller', async () => {
    dbMock.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));

    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = new Hono<any>();
    app.use('*', async (c, next) => { c.set('jwtPayload', { 'custom:role': 'member' }); await next(); });
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request('/ops/skills/skill-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(403);
  });

  it('flips isOfficial for a platform admin', async () => {
    dbMock.update.mockImplementation((table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({ returning: async () => (table === skills ? [{ id: 'skill-1', ...data }] : []) }),
      }),
    }));

    const { handlePatchSkillOfficial } = await import('../routes/ops.skills');
    const app = new Hono<any>();
    app.use('*', async (c, next) => { c.set('jwtPayload', { 'custom:role': 'platform_admin' }); await next(); });
    app.patch('/ops/skills/:id', handlePatchSkillOfficial);

    const res = await app.request('/ops/skills/skill-1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isOfficial: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.isOfficial).toBe(true);
  });
});
