import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: {} }));
vi.mock('@serverless-saas/permissions', () => ({
  hasPermission: vi.fn((perms: string[], resource: string, action: string) => {
    return perms.includes(`${resource}:${action}`);
  }),
}));

const records = vi.hoisted(() => ({
  listTenantAvatars: vi.fn(),
  syncTenantAvatars: vi.fn(),
  getTenantAvatar: vi.fn(),
  nameTenantAvatarWithin: vi.fn(),
  setAvatarReference: vi.fn(),
  setAvatarSource: vi.fn(),
  findTenantAvatarBySource: vi.fn(),
}));
vi.mock('../lib/avatarRecords', () => ({ AVATAR_PREFIX: 'creative-avatars/', AVATAR_REFS_PREFIX: 'avatar-refs/', ...records }));

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const AVATAR_ID = '22222222-2222-4222-8222-222222222222';
const avatar = {
  id: AVATAR_ID, fileId: FILE_ID, name: 'IMG_4432', role: null, tone: null,
  namingStatus: 'pending', referenceSheetFileId: null, type: 'image/jpeg', size: 100, createdAt: '2026-09-29T00:00:00.000Z',
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

  const SOURCE_FILE_ID = '44444444-4444-4444-8444-444444444444';

  it('registers a source-file link and merges it into attributes before naming', async () => {
    records.getTenantAvatar.mockResolvedValue(avatar);
    records.nameTenantAvatarWithin.mockResolvedValue(avatar);
    const res = await (await appWith()).request('/creative-library-assets/avatars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: FILE_ID, sourceFileId: SOURCE_FILE_ID }),
    });
    expect(res.status).toBe(201);
    expect(records.setAvatarSource).toHaveBeenCalledWith('t1', avatar.id, SOURCE_FILE_ID, undefined);
  });

  it('pins the category at registration so naming picks a fitting role', async () => {
    records.getTenantAvatar.mockResolvedValue(avatar);
    records.nameTenantAvatarWithin.mockResolvedValue(avatar);
    const res = await (await appWith()).request('/creative-library-assets/avatars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: FILE_ID, sourceFileId: SOURCE_FILE_ID, category: 'TVC' }),
    });
    expect(res.status).toBe(201);
    expect(records.setAvatarSource).toHaveBeenCalledWith('t1', avatar.id, SOURCE_FILE_ID, 'TVC');
  });

  it('does not touch source attribution when sourceFileId is omitted', async () => {
    records.getTenantAvatar.mockResolvedValue(avatar);
    records.nameTenantAvatarWithin.mockResolvedValue(avatar);
    const res = await (await appWith()).request('/creative-library-assets/avatars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: FILE_ID }),
    });
    expect(res.status).toBe(201);
    expect(records.setAvatarSource).not.toHaveBeenCalled();
  });

  describe('GET /avatars/by-source/:fileId', () => {
    it('returns the tenant\'s active avatar registered for that source file', async () => {
      records.findTenantAvatarBySource.mockResolvedValue(avatar);
      const res = await (await appWith()).request(`/creative-library-assets/avatars/by-source/${SOURCE_FILE_ID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: avatar });
      expect(records.findTenantAvatarBySource).toHaveBeenCalledWith('t1', SOURCE_FILE_ID);
    });

    it('404s when no avatar is registered for that source file', async () => {
      records.findTenantAvatarBySource.mockResolvedValue(null);
      const res = await (await appWith()).request(`/creative-library-assets/avatars/by-source/${SOURCE_FILE_ID}`);
      expect(res.status).toBe(404);
    });

    it('404s a malformed id without calling the lib', async () => {
      const res = await (await appWith()).request('/creative-library-assets/avatars/by-source/not-a-uuid');
      expect(res.status).toBe(404);
      expect(records.findTenantAvatarBySource).not.toHaveBeenCalled();
    });
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

  describe('PUT /avatars/:id/reference', () => {
    const SHEET_ID = '33333333-3333-4333-8333-333333333333';
    const put = async (body: unknown, id = AVATAR_ID) => (await appWith()).request(`/creative-library-assets/avatars/${id}/reference`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const valid = { referenceSheetFileId: SHEET_ID, terseTag: 'Riya, long wavy black hair', styleLock: 'photoreal, soft daylight' };

    it('attaches the sheet and anchor', async () => {
      records.setAvatarReference.mockResolvedValue({ ...avatar, referenceSheetFileId: SHEET_ID });
      const res = await put(valid);
      expect(res.status).toBe(200);
      expect(records.setAvatarReference).toHaveBeenCalledWith('t1', AVATAR_ID, valid);
    });

    it('400s when the sheet is not the tenant\'s own avatar-refs image', async () => {
      records.setAvatarReference.mockResolvedValue('invalid_sheet');
      expect((await put(valid)).status).toBe(400);
    });

    it('404s an unknown avatar', async () => {
      records.setAvatarReference.mockResolvedValue(null);
      expect((await put(valid)).status).toBe(404);
    });

    it('rejects an empty anchor without touching the db', async () => {
      expect((await put({ ...valid, terseTag: '' })).status).toBe(400);
      expect(records.setAvatarReference).not.toHaveBeenCalled();
    });
  });
});
