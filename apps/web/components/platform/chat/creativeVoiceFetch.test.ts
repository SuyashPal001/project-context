import { afterEach, expect, it, vi } from 'vitest';
import { fetchCreativeVoice } from './creativeVoiceFetch';

afterEach(() => vi.unstubAllGlobals());

it('refreshes an expired session once and retries a voice request', async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce({ status: 401 })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchCreativeVoice('/api/creative/voices');
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/creative/voices', '/api/auth/refresh', '/api/creative/voices']);
});

it('does not loop when refresh fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchCreativeVoice('/api/creative/voices');
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});
