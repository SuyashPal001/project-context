import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: {} }));

const records = vi.hoisted(() => ({
  listTenantAvatars: vi.fn(),
  syncTenantAvatars: vi.fn(),
  getTenantAvatar: vi.fn(),
  nameTenantAvatarWithin: vi.fn(),
}));
vi.mock('../lib/avatarRecords', () => ({ AVATAR_PREFIX: 'creative-avatars/', ...records }));

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const AVATAR_ID = '22222222-2222-4222-8222-222222222222';
const avatar = {
  id: AVATAR_ID, fileId: FILE_ID, name: 'IMG_4432', role: null, tone: null,
  namingStatus: 'pending', type: 'image/jpeg', size: 100, createdAt: '2026-09-29T00:00:00.000Z',
};

async function appWith(permissions: string[] = ['files:read', 'files:create']) {
  const { creativeLibraryAssetsRoutes } = await import('../routes/creativeLibraryAssets');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestContext' as never, { tenant: { id: 't1' }, permissions } as never);
    await next();
  });
  return app.route('/creative-library-assets', creativeLibraryAssetsRoutes);
}

beforeEach(() => vi.clearAllMocks());

describe('tenant avatar routes', () => {
  it('lists only the calling tenant\'s avatars', async () => {
    records.listTenantAvatars.mockResolvedValue([avatar]);
    const res = await (await appWith()).request('/creative-library-assets/avatars');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [avatar] });
    expect(records.listTenantAvatars).toHaveBeenCalledWith('t1');
  });

  it('refuses without files:read', async () => {
    const res = await (await appWith([])).request('/creative-library-assets/avatars');
    expect(res.status).toBe(403);
    expect(records.listTenantAvatars).not.toHaveBeenCalled();
  });

  it('registers and names a just-uploaded avatar', async () => {
    const named = { ...avatar, name: 'Riya', role: 'Fitness creator', tone: 'Energetic', namingStatus: 'done' };
    records.getTenantAvatar.mockResolvedValue(avatar);
    records.nameTenantAvatarWithin.mockResolvedValue(named);
    const res = await (await appWith()).request('/creative-library-assets/avatars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: FILE_ID }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: named });
    expect(records.syncTenantAvatars).toHaveBeenCalledWith('t1');
    expect(records.getTenantAvatar).toHaveBeenCalledWith('t1', { fileId: FILE_ID });
  });

  it('rejects a file that is not one of the tenant\'s avatar images', async () => {
    records.getTenantAvatar.mockResolvedValue(null);
    const res = await (await appWith()).request('/creative-library-assets/avatars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: FILE_ID }),
    });
    expect(res.status).toBe(400);
    expect(records.nameTenantAvatarWithin).not.toHaveBeenCalled();
  });

  it('describe 404s an unknown or malformed id', async () => {
    records.getTenantAvatar.mockResolvedValue(null);
    const app = await appWith();
    expect((await app.request(`/creative-library-assets/avatars/${AVATAR_ID}/describe`, { method: 'POST' })).status).toBe(404);
    expect((await app.request('/creative-library-assets/avatars/nope/describe', { method: 'POST' })).status).toBe(404);
  });

  it('describe names a pending avatar', async () => {
    records.getTenantAvatar.mockResolvedValue(avatar);
    records.nameTenantAvatarWithin.mockResolvedValue({ ...avatar, name: 'Riya', namingStatus: 'done' });
    const res = await (await appWith()).request(`/creative-library-assets/avatars/${AVATAR_ID}/describe`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Riya');
  });
});
