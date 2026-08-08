import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuthorizedCaller, extractServiceKey } from './auth';

/**
 * F-04 — the inference gateway must authenticate its callers.
 *
 * The bug: the dispatcher routed purely on method and URL with no auth of any
 * kind, bound 0.0.0.0:4001, and minted a GCP access token per request from the
 * VM's own service account before forwarding to Vertex. Anyone able to reach the
 * port got unlimited billable Gemini/Vertex inference plus an open /metrics.
 *
 * Every other internal hop in the platform authenticates with a shared service
 * key compared in constant time. This brings the most cost-sensitive service in
 * line, and the key is accepted from either the dedicated header or a bearer
 * token so AI-SDK callers that only expose an apiKey can authenticate too.
 */

const SECRET = 'k'.repeat(40);

describe('isAuthorizedCaller', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = SECRET;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = ORIGINAL;
  });

  it('accepts the correct key', () => {
    expect(isAuthorizedCaller(SECRET)).toBe(true);
  });

  it('rejects a wrong key of equal length', () => {
    expect(isAuthorizedCaller('x'.repeat(40))).toBe(false);
  });

  it('rejects an absent key', () => {
    expect(isAuthorizedCaller(undefined)).toBe(false);
    expect(isAuthorizedCaller('')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(isAuthorizedCaller('short')).toBe(false);
  });

  it('denies everything when the gateway has no key configured', () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    expect(isAuthorizedCaller(SECRET)).toBe(false);
    expect(isAuthorizedCaller('')).toBe(false);
  });
});

describe('extractServiceKey', () => {
  it('reads the dedicated header', () => {
    expect(extractServiceKey({ 'x-internal-service-key': SECRET })).toBe(SECRET);
  });

  it('reads a bearer token, for AI-SDK callers that only expose an apiKey', () => {
    expect(extractServiceKey({ authorization: `Bearer ${SECRET}` })).toBe(SECRET);
  });

  it('reads the Google-style api key header', () => {
    expect(extractServiceKey({ 'x-goog-api-key': SECRET })).toBe(SECRET);
  });

  it('prefers the dedicated header over a bearer token', () => {
    expect(
      extractServiceKey({ 'x-internal-service-key': SECRET, authorization: 'Bearer other' }),
    ).toBe(SECRET);
  });

  it('returns undefined when nothing is supplied', () => {
    expect(extractServiceKey({})).toBeUndefined();
  });

  it('takes the first value when a header is repeated', () => {
    expect(extractServiceKey({ 'x-internal-service-key': [SECRET, 'evil'] })).toBe(SECRET);
  });

  it('ignores a non-bearer authorization scheme', () => {
    expect(extractServiceKey({ authorization: `Basic ${SECRET}` })).toBeUndefined();
  });
});
