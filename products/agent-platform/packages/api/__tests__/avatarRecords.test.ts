import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
const getDownloadUrl = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { getDownloadUrl: (...a: unknown[]) => getDownloadUrl(...a) } }));

import { avatarPlaceholderName, describeAvatarImage, isPresetCopy, type TenantAvatarRecord } from '../lib/avatarRecords';

const avatar: TenantAvatarRecord = {
  id: 'a1', fileId: 'f1', name: 'IMG_4432', role: null, tone: null,
  namingStatus: 'pending', type: 'image/jpeg', size: 1000, createdAt: '2026-09-29T00:00:00.000Z',
};
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  process.env.AGENT_ORCHESTRATOR_URL = 'http://orchestrator';
  process.env.INTERNAL_SERVICE_KEY = 'key-1';
  getDownloadUrl.mockResolvedValue('https://signed.example/f1.jpg');
});

describe('avatarPlaceholderName', () => {
  it('drops the extension, falling back when nothing is left', () => {
    expect(avatarPlaceholderName('IMG_4432.jpg')).toBe('IMG_4432');
    expect(avatarPlaceholderName('.png')).toBe('My avatar');
  });
});

describe('isPresetCopy', () => {
  it('matches only the old picker\'s preset re-uploads', () => {
    const key = 'creative-avatars/3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c-everyday-creator.jpg';
    expect(isPresetCopy({ key, name: 'everyday-creator.jpg' })).toBe(true);
    expect(isPresetCopy({ key, name: 'Riya.jpg' })).toBe(false);
    expect(isPresetCopy({ key: 'creative-avatars/3f2b1c9e-8a7d-4e6f-9b0c-1d2e3f4a5b6c-me.jpg', name: 'me.jpg' })).toBe(false);
    expect(isPresetCopy({ key: 'creative-avatars/everyday-creator.jpg', name: 'everyday-creator.jpg' })).toBe(false);
  });
});

describe('describeAvatarImage', () => {
  it('sends a presigned link to the orchestrator and returns name, role and tone', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: ' Riya ', role: 'Fitness creator', tone: '' }) });
    expect(await describeAvatarImage('t1', avatar)).toEqual({ name: 'Riya', role: 'Fitness creator', tone: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://orchestrator/internal/avatars/describe');
    expect(JSON.parse(init.body)).toEqual({ tenantId: 't1', imageUrl: 'https://signed.example/f1.jpg', mimeType: 'image/jpeg' });
    expect(init.headers['X-Service-Key']).toBe('key-1');
  });

  it('returns null on an orchestrator error, a missing name, or an image over the cap', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    expect(await describeAvatarImage('t1', avatar)).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ role: 'Chef' }) });
    expect(await describeAvatarImage('t1', avatar)).toBeNull();
    expect(await describeAvatarImage('t1', { ...avatar, size: 50 * 1024 * 1024 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws when the download link cannot be made', async () => {
    getDownloadUrl.mockRejectedValue(new Error('File not found'));
    expect(await describeAvatarImage('t1', avatar)).toBeNull();
  });
});
