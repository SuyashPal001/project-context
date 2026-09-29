import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
const getDownloadUrl = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { getDownloadUrl: (...a: unknown[]) => getDownloadUrl(...a) } }));

import { avatarPlaceholderName, describeAvatarImage, isPresetCopy, getTenantAvatar, nameTenantAvatar, type TenantAvatarRecord } from '../lib/avatarRecords';
import { db } from '../db';

// Drizzle SQL objects are circular (every column points back at its table), so
// bound literal values are collected by walking queryChunks rather than by
// stringifying — same technique as internal.skills.test.ts's boundValues and
// conversations.folderScope.test.ts's renderSql.
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundValues(chunk, out);
  } else if ('value' in n) {
    out.push(n.value);
  }
  return out;
}
function renderSql(expr: unknown): string {
  const e = expr as { value?: unknown[]; queryChunks?: unknown[] };
  if (e && Array.isArray(e.value)) return e.value.join('');
  if (e && Array.isArray(e.queryChunks)) return e.queryChunks.map(renderSql).join('');
  if (typeof expr === 'string') return expr;
  return '';
}

/** Queues successive db.select(...) results, supporting both the
 * .from().innerJoin().where().limit() shape (getTenantAvatar) and the plain
 * .from().where().limit() shape (the incidental file-rename select). Also
 * captures the WHERE expression passed to innerJoin-shaped selects (idx 0),
 * for asserting on the built SQL. */
function mockSelectSequence(results: unknown[][]) {
  let i = 0;
  const whereSpies: ReturnType<typeof vi.fn>[] = [];
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = results[i++] ?? [];
    const whereSpy = vi.fn(() => ({ limit: async () => rows }));
    whereSpies.push(whereSpy);
    return { from: () => ({ where: whereSpy, innerJoin: () => ({ where: whereSpy }) }) };
  });
  return whereSpies;
}

function mockUpdateCapture(returningRows: unknown[]) {
  const setSpy = vi.fn().mockReturnValue({ where: () => ({ returning: async () => returningRows }) });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setSpy });
  return setSpy;
}

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

describe('getTenantAvatar', () => {
  it('scopes the lookup to kind=avatar (Finding #7 — a product-kind row must never resolve here)', async () => {
    const whereSpies = mockSelectSequence([[]]);
    await getTenantAvatar('t1', { id: 'a1' });
    const whereExpr = whereSpies[0].mock.calls[0][0];
    expect(boundValues(whereExpr)).toContain('avatar');
  });
});

describe('nameTenantAvatar', () => {
  const pendingWithReference = {
    id: 'a1', fileId: 'f1', name: 'IMG_4432', attributes: {
      namingStatus: 'pending', referenceSheetFileId: 'sheet-1', terseTag: 'Riya, wavy hair', styleLock: 'photoreal, 50mm',
    },
    createdAt: new Date('2026-09-29T00:00:00.000Z'), mimeType: 'image/jpeg', size: 1000,
  };

  // Finding #1: naming REPLACED `attributes`, silently wiping
  // referenceSheetFileId/terseTag/styleLock if setAvatarReference had already
  // pinned them before naming finished. Both branches (success and failure)
  // must merge via jsonb `||`, never a plain-object .set().
  it('merges naming results into attributes on success, keeping a reference sheet pinned before naming finished', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: 'Riya', role: 'Fitness creator', tone: 'Energetic' }) });
    const finalRow = {
      ...pendingWithReference, name: 'Riya',
      attributes: { ...pendingWithReference.attributes, namingStatus: 'done', role: 'Fitness creator', tone: 'Energetic' },
    };
    mockSelectSequence([[pendingWithReference], [], [finalRow]]);
    const setSpy = mockUpdateCapture([{ name: 'Riya', fileId: 'f1' }]);

    const result = await nameTenantAvatar('t1', 'a1');

    const patch = setSpy.mock.calls[0][0];
    expect(patch.name).toBe('Riya');
    // Not a plain object replace — a drizzle SQL fragment merging via `||`.
    expect(Array.isArray((patch.attributes as { queryChunks?: unknown[] }).queryChunks)).toBe(true);
    const rendered = renderSql(patch.attributes);
    expect(rendered).toContain('||');
    expect(rendered).toContain(JSON.stringify({ role: 'Fitness creator', tone: 'Energetic', namingStatus: 'done' }));
    expect(rendered).not.toContain('referenceSheetFileId'); // never re-stated — the merge preserves it, doesn't overwrite it
    expect(result?.referenceSheetFileId).toBe('sheet-1');
  });

  it('merges a failed-naming status into attributes too, keeping a reference sheet pinned before naming finished', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const finalRow = { ...pendingWithReference, attributes: { ...pendingWithReference.attributes, namingStatus: 'failed' } };
    mockSelectSequence([[pendingWithReference], [finalRow]]);
    const setSpy = mockUpdateCapture([{ name: 'IMG_4432', fileId: 'f1' }]);

    const result = await nameTenantAvatar('t1', 'a1');

    const patch = setSpy.mock.calls[0][0];
    expect(patch.name).toBeUndefined();
    expect(Array.isArray((patch.attributes as { queryChunks?: unknown[] }).queryChunks)).toBe(true);
    const rendered = renderSql(patch.attributes);
    expect(rendered).toContain('||');
    expect(rendered).toContain(JSON.stringify({ namingStatus: 'failed' }));
    // TenantAvatarRecord's toRecord() doesn't project terseTag/styleLock (a
    // separate, pre-existing gap outside this finding's scope) — asserting on
    // referenceSheetFileId is the projection that proves the merge preserved
    // the other pinned fields underneath.
    expect(result?.referenceSheetFileId).toBe('sheet-1');
  });
});
