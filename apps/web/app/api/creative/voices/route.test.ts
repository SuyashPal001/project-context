import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';

const findManyMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@serverless-saas/database', () => ({
  db: { query: { voiceCatalogue: { findMany: (...a: unknown[]) => findManyMock(...a) } } },
}));

beforeEach(() => {
  process.env.API_URL = 'https://api.example.com';
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'session-token' }) } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.API_URL;
});

it('does not query the catalogue when the session is rejected', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices'));
  expect(response.status).toBe(401);
  expect(findManyMock).not.toHaveBeenCalled();
});

it('returns curated voices from the catalogue, matching by search query', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockResolvedValue([
    { providerId: 'voice-lauren', name: 'Lauren', tagline: 'Lively Narrator', description: undefined, language: 'en', gender: undefined, country: undefined, accents: [{ accent: 'american', locale: 'en-US', is_native: true }], previewFileUrl: null, localPreviewAsset: '/creative/voices/lauren-lively-narrator.wav' },
  ]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=en&q=Lauren'));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toEqual({ voices: [{ id: 'voice-lauren', name: 'Lauren', tagline: 'Lively Narrator', description: undefined, language: 'en', gender: undefined, country: undefined, supportedLocales: ['en-US'], hasPreview: true }] });
});

it('disables preview when a catalogue row has neither a provider clip nor a fixed sample', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockResolvedValue([
    { providerId: 'cathy-id', name: 'Cathy', tagline: 'Coworker', description: undefined, language: 'en', gender: undefined, country: undefined, accents: null, previewFileUrl: null, localPreviewAsset: null },
  ]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=en&q=Cathy'));
  expect((await response.json()).voices).toEqual([{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', description: undefined, language: 'en', gender: undefined, country: undefined, supportedLocales: ['en'], hasPreview: false }]);
});

it('enables synthesis when the requested language is supported by the catalogue row', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockResolvedValue([
    { providerId: 'cathy-id', name: 'Cathy', tagline: 'Coworker', description: undefined, language: 'en', gender: undefined, country: undefined, accents: [{ accent: 'american', locale: 'en-US', is_native: true }, { accent: 'indian', locale: 'hi-IN', is_native: false }], previewFileUrl: null, localPreviewAsset: null },
  ]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=hi&q=Cathy'));
  expect((await response.json()).voices).toEqual([{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', description: undefined, language: 'en', gender: undefined, country: undefined, supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }]);
});

it('returns all catalogue rows regardless of requested language, disabling preview for unsupported ones', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockResolvedValue([
    { providerId: 'english-only', name: 'Lauren', tagline: 'Lively Narrator', description: undefined, language: 'en', gender: undefined, country: undefined, accents: [{ accent: 'american', locale: 'en-US', is_native: true }], previewFileUrl: null, localPreviewAsset: null },
    { providerId: 'hindi-capable', name: 'Cathy', tagline: 'Coworker', description: undefined, language: 'en', gender: undefined, country: undefined, accents: [{ accent: 'american', locale: 'en-US', is_native: true }, { accent: 'indian', locale: 'hi-IN', is_native: false }], previewFileUrl: null, localPreviewAsset: null },
  ]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=hi'));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.voices).toHaveLength(2);
  expect(body.voices.find((v: { id: string }) => v.id === 'english-only')).toEqual(expect.objectContaining({ hasPreview: false }));
  expect(body.voices.find((v: { id: string }) => v.id === 'hindi-capable')).toEqual(expect.objectContaining({ hasPreview: true }));
});

it('returns 503 when the catalogue table is empty', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockResolvedValue([]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Voice library is not configured yet.' });
});

it('returns 502 when the catalogue query fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  findManyMock.mockRejectedValue(new Error('boom'));
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/creative/voices'));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Could not load voices right now.' });
});
