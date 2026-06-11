import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { refreshSession } from '@/lib/auth';

export async function POST(request: NextRequest) {
    try {
        const refreshToken = request.cookies.get('platform_refresh_token')?.value;

        if (!refreshToken) {
            return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
        }

        // Optional tenantId — when present, passes clientMetadata to Cognito so the
        // pre-token lambda stamps the requested workspace into the new JWT (workspace switching)
        const body = await request.json().catch(() => ({}));
        const tenantId: string | undefined = body.tenantId;

        // Write pendingTenantId to DB before Cognito refresh — Cognito drops
        // ClientMetadata on REFRESH_TOKEN_AUTH, so the Pre-Token Lambda reads
        // it from the DB instead.
        if (tenantId) {
            const currentToken = request.cookies.get('platform_token')?.value;
            if (currentToken) {
                await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/auth/set-pending-tenant`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`,
                    },
                    body: JSON.stringify({ tenantId }),
                }).catch((e) => console.error('set-pending-tenant failed:', e));
            }
        }

        const { idToken, accessToken } = await refreshSession(
            refreshToken,
            tenantId ? { tenantId } : undefined,
        );

        const response = NextResponse.json({ success: true });

        // ID Token - httpOnly (used by proxy route)
        response.cookies.set({
            name: 'platform_token',
            value: idToken,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 3600,
        });

        // ID Token - NOT httpOnly (so useChat can read it for X-Id-Token after refresh)
        response.cookies.set({
            name: 'platform_id_token',
            value: idToken,
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            path: '/',
            maxAge: 3600,
        });

        // Access Token - NOT httpOnly (for relay auth)
        if (accessToken) {
            response.cookies.set({
                name: 'platform_access_token',
                value: accessToken,
                httpOnly: false,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                path: '/',
                maxAge: 3600,
            });
        }

        return response;
    } catch (error) {
        console.error('Token refresh failed', error);
        return NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 });
    }
}
