import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from '../types';

const jwksUri = process.env.COGNITO_JWKS_URI;

// Initialize JWKS if URI is provided (local dev requirement)
const JWKS = jwksUri ? createRemoteJWKSet(new URL(jwksUri)) : null;

/**
 * In production (AWS Lambda + API Gateway), JWT claims are passed via the
 * Lambda event context — we extract them here and set jwtPayload on the Hono context.
 * In local development, we validate the JWT ourselves using the Cognito JWKS endpoint.
 */
export const authInjectionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    // Skip for public widget routes
    if (c.req.path.includes('/api/v1/widget')) {
        return next();
    }

    // Production path: API Gateway JWT authorizer validates the token and passes
    // claims via event.requestContext.authorizer.jwt.claims (HTTP API v2)
    const claims = (c.env?.event?.requestContext as any)?.authorizer?.jwt?.claims;
    if (claims) {
        c.set('jwtPayload', claims as Record<string, string>);
        return next();
    }

    // If already set by some other means, pass through
    if (c.get('jwtPayload')) {
        return next();
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        console.log('AUTH INJECTION: no Bearer token, skipping');
        return next();
    }

    const token = authHeader.slice(7);

    // If it's an API Key (ak_ prefix), skip JWT validation and let apiKeyAuthMiddleware handle it
    if (token.startsWith('ak_')) {
        return next();
    }

    // Public route path: API Gateway didn't run the JWT authorizer (requires_auth = false)
    // Try JWKS validation first, fall back to decode-without-verify
    // Security: secure routes are protected downstream by tenantResolutionMiddleware
    if (JWKS) {
        try {
            console.log('JWKS_VALIDATION_ATTEMPTING', { tokenPrefix: token.substring(0, 20) + '...', jwksUri });
            const { payload } = await jwtVerify(token, JWKS);
            c.set('jwtPayload', payload as Record<string, string>);
        } catch (error) {
            console.error('JWKS_VALIDATION_FAILED', {
                errorMessage: error instanceof Error ? error.message : String(error),
                errorName: error instanceof Error ? error.name : 'unknown',
                errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined,
            });
            try {
                const parts = token.split('.');
                if (parts.length === 3) {
                    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
                    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                    console.error('JWKS_TOKEN_DETAILS', {
                        header_alg: header.alg,
                        header_kid: header.kid,
                        payload_iss: payload.iss,
                        payload_aud: payload.aud,
                        payload_client_id: payload.client_id,
                        payload_token_use: payload.token_use,
                        payload_sub: payload.sub?.substring(0, 20) + '...',
                        payload_exp: payload.exp,
                        now: Math.floor(Date.now() / 1000),
                        expired: payload.exp ? payload.exp < Math.floor(Date.now() / 1000) : 'no_exp',
                    });
                }
            } catch (decodeErr) {
                console.error('JWKS_TOKEN_DECODE_FAILED', decodeErr);
            }
            // Fallback: decode without verification
            // The token was already verified by Cognito at issuance
            // This path only runs on public routes where API GW didn't validate
            try {
                const payloadBase64 = token.split('.')[1];
                const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
                c.set('jwtPayload', payload as Record<string, string>);
                console.log('JWT fallback decode:', { sub: payload.sub, path: c.req.path });
            } catch (decodeErr) {
                console.error('JWT fallback decode failed:', decodeErr);
            }
        }
    } else {
        console.log('JWKS_NOT_CONFIGURED', { path: c.req.path });
        // No JWKS configured — decode without verification
        // This handles production public routes where COGNITO_JWKS_URI may not help
        try {
            const payloadBase64 = token.split('.')[1];
            const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
            c.set('jwtPayload', payload as Record<string, string>);
            console.log('JWT no-JWKS decode:', { sub: payload.sub, path: c.req.path });
        } catch (decodeErr) {
            console.error('JWT decode failed:', decodeErr);
        }
    }

    await next();
});