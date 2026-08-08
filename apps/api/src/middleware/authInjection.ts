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

    // Public route path: API Gateway didn't run the JWT authorizer (requires_auth = false),
    // so the signature has not been checked yet and we must check it ourselves.
    //
    // There is deliberately no decode-without-verify fallback here. An unverified
    // payload is attacker-controlled: userUpsertMiddleware trusts `sub`/`email` to
    // create and re-point user rows, so accepting one turns a forged token into a
    // real identity (including custom:role and custom:tenantId) on every
    // requires_auth = false route. A token we cannot verify is treated exactly like
    // no token at all — jwtPayload stays unset and the route decides what to do.
    if (!JWKS) {
        // Misconfiguration, not a supported mode. Loud, and still fail-closed.
        console.error('JWKS_NOT_CONFIGURED — refusing to trust bearer token', { path: c.req.path });
        return next();
    }

    try {
        const { payload } = await jwtVerify(token, JWKS);
        c.set('jwtPayload', payload as Record<string, string>);
    } catch (error) {
        console.error('JWT_VERIFICATION_FAILED — request continues unauthenticated', {
            path: c.req.path,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : 'unknown',
        });
    }

    await next();
});