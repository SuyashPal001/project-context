/** Voice routes live in Next.js rather than the API proxy, so they need the
 * same one-time session refresh the shared API client performs on 401. */
export async function fetchCreativeVoice(path: string): Promise<Response> {
    let response = await fetch(path, { cache: 'no-store' });
    if (response.status !== 401) return response;
    const refreshed = await fetch('/api/auth/refresh', { method: 'POST' }).then(result => result.ok).catch(() => false);
    if (refreshed) response = await fetch(path, { cache: 'no-store' });
    return response;
}
