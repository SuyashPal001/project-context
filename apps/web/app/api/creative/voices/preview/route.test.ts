import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyVoiceLibrarySession } from '../session';

const findFirstMock = vi.fn();
vi.mock('../session', () => ({ verifyVoiceLibrarySession: vi.fn() }));
vi.mock('@serverless-saas/database', () => ({
  db: { query: { voiceCatalogue: { findFirst: (...a: unknown[]) => findFirstMock(...a) } } },
  voiceCatalogue: { providerId: 'providerId' },
}));
// Real `eq` doesn't understand our fake column object, but the route only ever needs the
// looked-up id back out of `where` — capture it verbatim so tests can assert the lookup is
// actually id-scoped instead of the mock echoing back whatever it was told to return.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (_column: unknown, value: unknown) => ({ __mockWhere: true, value }) };
});

beforeEach(() => {
    process.env.CARTESIA_API_KEY = 'test-secret';
    vi.mocked(verifyVoiceLibrarySession).mockResolvedValue('ok');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.CARTESIA_API_KEY;
});

it('streams the CDN preview for a catalogue row with a provider URL', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-1', name: 'Cathy', tagline: 'Coworker', previewFileUrl: 'https://api.cartesia.ai/previews/sample.wav', localPreviewAsset: null, accents: null });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'audio/wav', 'content-length': '3' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-secret');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
});

it('does not send the provider key to an untrusted preview host', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-1', name: 'Cathy', tagline: 'Coworker', previewFileUrl: 'https://example.com/sample.wav', localPreviewAsset: null, accents: null });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    // The untrusted static clip is skipped (never fetched, so the key is never sent to it) and the
    // route falls through to on-demand TTS instead of failing the preview.
    expect(response.status).toBe(200);
    const calledUrls = fetchMock.mock.calls.map(call => call[0].toString());
    expect(calledUrls).not.toContain('https://example.com/sample.wav');
    expect(calledUrls.some(url => url.startsWith('https://example.com'))).toBe(false);
});

it('uses the fixed sample for a catalogue row without a provider preview', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-1', name: 'Lauren', tagline: 'Lively Narrator', previewFileUrl: null, localPreviewAsset: '/creative/voices/lauren-lively-narrator.wav', accents: null });
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/creative/voices/lauren-lively-narrator.wav');
});

it('synthesises English on demand when neither a provider preview nor a local sample exists', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-2', name: 'Cathy', tagline: 'Coworker', previewFileUrl: null, localPreviewAsset: null, accents: null });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-2'));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://api.cartesia.ai/tts/bytes');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ language: 'en', transcript: 'Hello! How are you doing today?' });
});

it('generates the sample in the requested supported language', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-1', name: 'Cathy', tagline: 'Coworker', previewFileUrl: null, localPreviewAsset: null, accents: [{ accent: 'american', locale: 'en-US', is_native: true }, { accent: 'indian', locale: 'hi-IN', is_native: false }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1&language=hi'));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cartesia.ai/tts/bytes');
    const request = fetchMock.mock.calls[0][1];
    expect(request.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(request.body)).toEqual(expect.objectContaining({ language: 'hi', transcript: expect.stringMatching(/[ऀ-ॿ]/), voice: { mode: 'id', id: 'voice-1' } }));
});

it('does not synthesize a language the catalogue row does not support', async () => {
    findFirstMock.mockResolvedValue({ providerId: 'voice-1', name: 'Cathy', tagline: 'Coworker', previewFileUrl: null, localPreviewAsset: null, accents: [{ accent: 'american', locale: 'en-US', is_native: true }] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1&language=hi'));
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
});

it('returns 404 for an id with no catalogue row', async () => {
    findFirstMock.mockResolvedValue(undefined);
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(404);
});

it('looks up the voice by the requested id', async () => {
    const rows = [
        { providerId: 'voice-1', name: 'Cathy', tagline: 'Coworker', previewFileUrl: null, localPreviewAsset: '/creative/voices/cathy-coworker.wav', accents: null },
        { providerId: 'voice-2', name: 'Lauren', tagline: 'Lively Narrator', previewFileUrl: null, localPreviewAsset: '/creative/voices/lauren-lively-narrator.wav', accents: null },
    ];
    findFirstMock.mockImplementation(({ where }: { where: { value: string } }) => rows.find(row => row.providerId === where.value));
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-2'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/creative/voices/lauren-lively-narrator.wav');
});

it('returns 502 when the catalogue query fails', async () => {
    findFirstMock.mockRejectedValue(new Error('boom'));
    const { GET } = await import('./route');
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Voice preview is unavailable.' });
});
