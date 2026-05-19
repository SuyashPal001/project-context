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
