import { cookies } from 'next/headers';

export async function verifyVoiceLibrarySession(): Promise<'ok' | 'unauthorized' | 'unavailable'> {
    const token = (await cookies()).get('platform_token')?.value;
    if (!token) return 'unauthorized';
    try {
        const auth = await fetch(`${process.env.API_URL}/api/v1/agents`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5_000),
            cache: 'no-store',
        });
        if (auth.status === 401 || auth.status === 403) return 'unauthorized';
        return auth.ok ? 'ok' : 'unavailable';
    } catch {
        return 'unavailable';
    }
}
