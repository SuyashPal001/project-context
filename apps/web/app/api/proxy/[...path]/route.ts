import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { Agent, fetch as undiciFetch } from 'undici';
import { refreshSession } from '@/lib/auth';

const API_BASE = process.env.API_URL!;

// Refresh this far ahead of expiry. Covers the round trip to API Gateway plus
// clock skew between this VM and Cognito.
const EXPIRY_SKEW_MS = 60_000;

/** Reads `exp` (ms) out of a JWT without verifying it. Null if unparseable. */
function getExpiryMs(jwt: string): number | null {
    try {
        const parts = jwt.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
        );
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

interface RefreshedTokens {
    idToken: string;
    accessToken?: string;
}

/**
 * Swaps an expired/expiring ID token for a fresh one before the request is
 * forwarded.
 *
 * Without this, a tab that was asleep past the 1-hour token lifetime fires its
 * mount-time queries with a dead token. API Gateway's JWT authorizer rejects
 * them before the Lambda ever runs, so the browser logs a wall of 401s — the
 * client retries and recovers, but the console noise is already emitted and
 * cannot be suppressed from JS. Refreshing here means the browser only ever
 * sees the successful response.
 */
async function refreshIfExpiring(idToken: string | undefined): Promise<RefreshedTokens | null> {
    if (!idToken) return null;

    const expiry = getExpiryMs(idToken);
    if (expiry === null) return null;
    if (expiry - Date.now() > EXPIRY_SKEW_MS) return null;

    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('platform_refresh_token')?.value;
    if (!refreshToken) return null;

    try {
        const { idToken: fresh, accessToken } = await refreshSession(refreshToken);
        return { idToken: fresh, accessToken };
    } catch (err) {
        // Refresh token itself is dead — let the request go out with the old
        // token and 401 naturally, so the client's handler forces a re-login.
        console.warn(JSON.stringify({
            level: 'warn', service: 'web-proxy', msg: 'proactive_refresh_failed',
            error: err instanceof Error ? err.message : String(err),
        }));
        return null;
    }
}

/** Mirrors the cookie set written by /api/auth/refresh. */
function applyRefreshedCookies(res: NextResponse, tokens: RefreshedTokens): NextResponse {
    const secure = process.env.NODE_ENV === 'production';

    res.cookies.set({
        name: 'platform_token', value: tokens.idToken,
        httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 3600,
    });
    res.cookies.set({
        name: 'platform_id_token', value: tokens.idToken,
        httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge: 3600,
    });
    if (tokens.accessToken) {
        res.cookies.set({
            name: 'platform_access_token', value: tokens.accessToken,
            httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge: 3600,
        });
    }
    return res;
}

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    try {
        const { path: pathSegments } = await params;
        const path = pathSegments.join('/');
        const url = `${API_BASE}/${path}${req.nextUrl.search}`;

        const cookieStore = await cookies();
        const cookieToken = cookieStore.get('platform_token')?.value;
        const headerToken = req.headers.get('authorization');

        // Only manage tokens we own. An explicit Authorization header means the
        // caller is handling its own auth, so leave it alone.
        const refreshed = headerToken ? null : await refreshIfExpiring(cookieToken);
        const effectiveCookieToken = refreshed?.idToken ?? cookieToken;

        const token = headerToken || (effectiveCookieToken ? `Bearer ${effectiveCookieToken}` : null);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (token) headers['Authorization'] = token;

        const body = req.method !== 'GET' && req.method !== 'HEAD'
            ? await req.text()
            : undefined;

        const agent = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });

        try {
            console.log(JSON.stringify({ level: 'info', service: 'web-proxy', msg: 'upstream_request', method: req.method, url }));
            const res = await undiciFetch(url, {
                method: req.method,
                headers,
                body,
                dispatcher: agent,
                // @ts-ignore
                signal: AbortSignal.timeout(15000),
            });

            const data = await res.text();

            if (res.status === 204) {
                const empty = new NextResponse(null, { status: 204 });
                return refreshed ? applyRefreshedCookies(empty, refreshed) : empty;
            }

            if (!res.ok) {
                console.warn(JSON.stringify({ level: 'warn', service: 'web-proxy', msg: 'upstream_error', method: req.method, url, status: res.status, body: data.slice(0, 300) }));
            }

            const contentType = res.headers.get('content-type') ?? 'application/json';
            const responseHeaders: Record<string, string> = { 'Content-Type': contentType };
            const contentDisp = res.headers.get('content-disposition');
            if (contentDisp) responseHeaders['Content-Disposition'] = contentDisp;

            const out = new NextResponse(data, { status: res.status, headers: responseHeaders });
            return refreshed ? applyRefreshedCookies(out, refreshed) : out;
        } catch (err: unknown) {
            console.error(JSON.stringify({ level: 'error', service: 'web-proxy', msg: 'proxy_network_error', method: req.method, url, error: err instanceof Error ? err.message : String(err) }));
            const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
            return NextResponse.json(
                { error: isTimeout ? 'Upstream request timed out' : 'Proxy error' },
                { status: isTimeout ? 504 : 502 }
            );
        }
    } catch (err: unknown) {
        console.error(JSON.stringify({ level: 'error', service: 'web-proxy', msg: 'proxy_handler_error', error: err instanceof Error ? err.message : String(err) }));
        return NextResponse.json({ error: 'Proxy error' }, { status: 502 });
    }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
