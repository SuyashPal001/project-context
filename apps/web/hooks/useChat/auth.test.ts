/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { secondsUntilExpiry, getFreshAuthTokens } from './auth';

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.s`;
const now = () => Math.floor(Date.now() / 1000);

afterEach(() => {
    document.cookie.split('; ').forEach(c => { document.cookie = `${c.split('=')[0]}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`; });
    vi.restoreAllMocks();
});

describe('fresh auth tokens', () => {
    it('reads seconds left from a JWT, null when unreadable', () => {
        expect(secondsUntilExpiry(jwt(now() + 120))).toBeGreaterThan(100);
        expect(secondsUntilExpiry('garbage')).toBeNull();
        expect(secondsUntilExpiry(undefined)).toBeNull();
    });

    it('refreshes before use when the id token has under 10 minutes left', async () => {
        document.cookie = `platform_access_token=a`;
        document.cookie = `platform_id_token=${jwt(now() + 60)}`;
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            document.cookie = `platform_id_token=${jwt(now() + 3600)}`;
            return new Response(null, { status: 200 });
        });
        const tokens = await getFreshAuthTokens();
        expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', { method: 'POST' });
        expect(secondsUntilExpiry(tokens.idToken)!).toBeGreaterThan(3000);
    });

    it('does not refresh a token with plenty of time left', async () => {
        document.cookie = `platform_access_token=a`;
        document.cookie = `platform_id_token=${jwt(now() + 3000)}`;
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        await getFreshAuthTokens();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
