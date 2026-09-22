import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { verifyVoiceLibrarySession } from '../session';

vi.mock('../session', () => ({ verifyVoiceLibrarySession: vi.fn() }));

beforeEach(() => {
    process.env.CARTESIA_API_KEY = 'test-secret';
    vi.mocked(verifyVoiceLibrarySession).mockResolvedValue('ok');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.CARTESIA_API_KEY;
});

it('fetches an authenticated Cartesia preview through the server', async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'Cathy', tagline: 'Coworker', preview_file_url: 'https://api.cartesia.ai/previews/sample.wav' }) })
        .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'audio/wav', 'content-length': '3' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer test-secret');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
});

it('does not send the provider key to an untrusted preview host', async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'Cathy', tagline: 'Coworker', preview_file_url: 'https://example.com/sample.wav' }) })
        .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(200);
    const calledUrls = fetchMock.mock.calls.map(call => call[0].toString());
    expect(calledUrls).not.toContain('https://example.com/sample.wav');
    expect(calledUrls.some(url => url.startsWith('https://example.com'))).toBe(false);
});

it('uses the fixed sample for a curated voice without a provider preview', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'Lauren', tagline: 'Lively Narrator', preview_file_url: null }) });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/creative/voices/lauren-lively-narrator.wav');
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('generates the sample in the requested supported language', async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'Cathy', tagline: 'Coworker', accents: [{ locale: 'en-US' }, { locale: 'hi-IN' }] }) })
        .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1&language=hi'));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.cartesia.ai/tts/bytes');
    const request = fetchMock.mock.calls[1][1];
    expect(request.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(request.body)).toEqual(expect.objectContaining({ language: 'hi', transcript: expect.stringMatching(/[\u0900-\u097f]/), voice: { mode: 'id', id: 'voice-1' } }));
});

it('does not synthesize a language the voice does not support', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'Cathy', tagline: 'Coworker', accents: [{ locale: 'en-US' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1&language=hi'));
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not generate audio for a different voice with the same name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'Carson', tagline: 'Friendly Support', preview_file_url: null }) });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices/preview?id=voice-1'));
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
