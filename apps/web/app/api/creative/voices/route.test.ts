import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { cookies } from 'next/headers';
import { CURATED_VOICES } from './curated';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

beforeEach(() => {
    process.env.CARTESIA_API_KEY = 'test-secret';
    process.env.API_URL = 'https://api.example.com';
    vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'session-token' }) } as never);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.CARTESIA_API_KEY;
    delete process.env.API_URL;
});

it('does not use the provider key when the session is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices'));
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/api/v1/agents');
});

it('returns only the curated voices with previews without exposing the API key', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
        if (input.toString() === 'https://api.example.com/api/v1/agents') return { ok: true };
        const name = new URL(input.toString()).searchParams.get('q');
        return { ok: true, json: async () => ({ data: [
            { id: `voice-${name}`, name, tagline: name === 'Lauren' ? 'Lively Narrator' : 'Wrong variant', language: 'en', accents: [{ locale: 'en-US' }], preview_file_url: null },
            { id: 'uncurated', name: 'Other Voice', language: 'en', preview_file_url: 'https://audio.example.com/other.wav' },
        ] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=en&q=Lauren'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ voices: [{ id: 'voice-Lauren', name: 'Lauren', tagline: 'Lively Narrator', language: 'en', supportedLocales: ['en-US'], hasPreview: true }] });
    expect(JSON.stringify(body)).not.toContain('test-secret');
    const providerRequest = fetchMock.mock.calls[1];
    expect(providerRequest[0].toString()).toContain('expand%5B%5D=preview_file_url');
    expect(providerRequest[1].headers.Authorization).toBe('Bearer test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(CURATED_VOICES.length + 1);
});

it('selects the requested tagline when the provider has multiple voices with one name', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
        if (input.toString() === 'https://api.example.com/api/v1/agents') return { ok: true };
        const name = new URL(input.toString()).searchParams.get('q');
        return { ok: true, json: async () => ({ data: name === 'Carson' ? [
            { id: 'wrong-carson', name: 'Carson', tagline: 'Friendly Support', language: 'en' },
            { id: 'right-carson', name: 'Carson', tagline: 'Curious Conversationalist', language: 'en', accents: [{ locale: 'en-US' }, { locale: 'hi-IN' }], preview_file_url: 'https://api.cartesia.ai/previews/carson.wav' },
        ] : [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=en&q=Carson'));
    expect((await response.json()).voices).toEqual([{ id: 'right-carson', name: 'Carson', tagline: 'Curious Conversationalist', language: 'en', supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }]);
});

it('enables preview via on-demand TTS when a curated voice has no static clip', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
        if (input.toString() === 'https://api.example.com/api/v1/agents') return { ok: true };
        const name = new URL(input.toString()).searchParams.get('q');
        return { ok: true, json: async () => ({ data: name === 'Cathy' ? [
            { id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', preview_file_url: null },
        ] : [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=en&q=Cathy'));
    expect((await response.json()).voices).toEqual([{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', supportedLocales: ['en'], hasPreview: true }]);
});

it('enables synthesis when the requested language is supported by the curated voice', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
        if (input.toString() === 'https://api.example.com/api/v1/agents') return { ok: true };
        const name = new URL(input.toString()).searchParams.get('q');
        return { ok: true, json: async () => ({ data: name === 'Cathy' ? [
            { id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', accents: [{ locale: 'en-US' }, { locale: 'hi-IN' }], preview_file_url: null },
        ] : [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('http://localhost/api/creative/voices?language=hi&q=Cathy'));
    expect((await response.json()).voices).toEqual([{ id: 'cathy-id', name: 'Cathy', tagline: 'Coworker', language: 'en', supportedLocales: ['en-US', 'hi-IN'], hasPreview: true }]);
});
