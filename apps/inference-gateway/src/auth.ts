import { timingSafeEqual } from 'node:crypto';

/**
 * Inbound authentication for the inference gateway.
 *
 * This process holds GCP credentials and spends real money on every request, so
 * it must not accept anonymous callers. It authenticates the same way every
 * other internal hop in the platform does: a shared service key compared in
 * constant time.
 *
 * The key is accepted from three places because callers reach this service in
 * three shapes: raw fetch (dedicated header), AI-SDK providers that only expose
 * an `apiKey` (bearer token), and Google-style clients (`x-goog-api-key`).
 */

type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Pull the presented credential out of whichever header carries it. */
export function extractServiceKey(headers: HeaderBag): string | undefined {
  const dedicated = firstHeader(headers['x-internal-service-key']);
  if (dedicated) return dedicated;

  const googleStyle = firstHeader(headers['x-goog-api-key']);
  if (googleStyle) return googleStyle;

  const auth = firstHeader(headers['authorization']);
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);

  return undefined;
}

/** Constant-time comparison; any failure — including length mismatch — is denial. */
export function isAuthorizedCaller(provided: string | undefined | null): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  // Unconfigured means unable to authenticate. Deny, so a misconfigured
  // deployment is inert rather than an open proxy to billable inference.
  if (!expected) return false;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
