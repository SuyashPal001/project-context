import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * F-01 — the middleware must never treat an unverified JWT as identity.
 *
 * The bug: when JWKS verification failed (or no JWKS was configured), the
 * middleware base64-decoded the payload anyway and set it as `jwtPayload`.
 * Downstream `userUpsertMiddleware` trusts `sub`/`email` from that payload to
 * create or re-point user rows, so a forged token became a real identity on
 * every `requires_auth = false` gateway route.
 *
 * These tests assert the *effect* — whether jwtPayload is populated — rather
 * than which internal branch ran, so they keep holding if the control flow is
 * rewritten.
 */

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A structurally valid JWT with an unverifiable signature. */
function forgedToken(payload: Record<string, unknown>): string {
  const header = b64url({ alg: 'RS256', kid: 'attacker-supplied' });
  const body = b64url(payload);
  const sig = Buffer.from('this-is-not-a-real-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

const ATTACKER_CLAIMS = {
  sub: 'attacker-cognito-sub',
  email: 'victim@example.com',
  'custom:tenantId': 'victim-tenant-id',
  'custom:role': 'platform_admin',
};

/** Builds an app around the middleware with a probe that reports what it saw. */
async function harness() {
  const { authInjectionMiddleware } = await import('./authInjection');
  const app = new Hono<any>();
  app.use('*', authInjectionMiddleware);
  app.get('/api/v1/probe', (c) =>
    c.json({ payload: (c.get('jwtPayload') as unknown) ?? null }),
  );
  return app;
}

async function probe(app: Hono<any>, headers: Record<string, string> = {}, env?: unknown) {
  const res = await app.request('/api/v1/probe', { headers }, env);
  return (await res.json()) as { payload: Record<string, unknown> | null };
}

describe('authInjectionMiddleware', () => {
  const ORIGINAL_JWKS = process.env.COGNITO_JWKS_URI;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_JWKS === undefined) delete process.env.COGNITO_JWKS_URI;
    else process.env.COGNITO_JWKS_URI = ORIGINAL_JWKS;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not trust a forged token when no JWKS is configured', async () => {
    delete process.env.COGNITO_JWKS_URI;
    const app = await harness();

    const { payload } = await probe(app, {
      Authorization: `Bearer ${forgedToken(ATTACKER_CLAIMS)}`,
    });

    expect(payload).toBeNull();
  });

  it('does not trust a token whose signature fails verification', async () => {
    process.env.COGNITO_JWKS_URI = 'https://cognito-idp.test.amazonaws.com/pool/.well-known/jwks.json';

    // Simulate the verification outcome under test: a bad signature.
    vi.doMock('jose', async (importOriginal) => {
      const actual = await importOriginal<typeof import('jose')>();
      return {
        ...actual,
        createRemoteJWKSet: () => (() => {
          throw new Error('should not be reached');
        }) as never,
        jwtVerify: vi.fn().mockRejectedValue(
          Object.assign(new Error('signature verification failed'), {
            code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
          }),
        ),
      };
    });

    const app = await harness();

    const { payload } = await probe(app, {
      Authorization: `Bearer ${forgedToken(ATTACKER_CLAIMS)}`,
    });

    expect(payload).toBeNull();
  });

  it('never lets a forged token reach downstream as a platform_admin identity', async () => {
    delete process.env.COGNITO_JWKS_URI;
    const app = await harness();

    const { payload } = await probe(app, {
      Authorization: `Bearer ${forgedToken(ATTACKER_CLAIMS)}`,
    });

    // The specific escalation the bug enabled.
    expect(payload?.['custom:role']).toBeUndefined();
    expect(payload?.['custom:tenantId']).toBeUndefined();
    expect(payload?.sub).toBeUndefined();
  });

  it('still accepts claims the API Gateway authorizer already verified', async () => {
    delete process.env.COGNITO_JWKS_URI;
    const app = await harness();

    const gatewayEvent = {
      event: {
        requestContext: {
          authorizer: { jwt: { claims: { sub: 'real-user', 'custom:tenantId': 'real-tenant' } } },
        },
      },
    };

    const { payload } = await probe(app, {}, gatewayEvent);

    expect(payload).toEqual({ sub: 'real-user', 'custom:tenantId': 'real-tenant' });
  });

  it('passes through with no identity when there is no Authorization header', async () => {
    delete process.env.COGNITO_JWKS_URI;
    const app = await harness();

    const { payload } = await probe(app);

    expect(payload).toBeNull();
  });

  it('leaves API-key requests for the api-key middleware to handle', async () => {
    delete process.env.COGNITO_JWKS_URI;
    const app = await harness();

    const { payload } = await probe(app, { Authorization: 'Bearer ak_live_abc123' });

    expect(payload).toBeNull();
  });
});
