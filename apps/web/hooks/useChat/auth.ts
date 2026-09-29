export function getAuthTokens() {
    const cookies = document.cookie.split('; ');
    const find = (name: string) => cookies.find(r => r.startsWith(`${name}=`))?.split('=')[1];
    return {
        accessToken: find('platform_access_token'),
        idToken: find('platform_id_token'),
    };
}

export async function attemptRefresh(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        return res.ok;
    } catch {
        return false;
    }
}

// Seconds until a JWT expires, or null when it can't be read.
export function secondsUntilExpiry(jwt: string | undefined): number | null {
    if (!jwt) return null;
    try {
        const part = jwt.split('.')[1];
        const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        return typeof json.exp === 'number' ? json.exp - Math.floor(Date.now() / 1000) : null;
    } catch {
        return null;
    }
}

/**
 * Current tokens, refreshed first when the id token has under 10 minutes
 * left. The orchestrator uses the id token for every API call of a chat turn,
 * and a turn can run for minutes — starting one on an almost-expired token
 * made later calls fail with 401 partway through.
 */
export async function getFreshAuthTokens(minSeconds = 600) {
    const tokens = getAuthTokens();
    const left = secondsUntilExpiry(tokens.idToken);
    if (left !== null && left < minSeconds && await attemptRefresh()) return getAuthTokens();
    return tokens;
}
