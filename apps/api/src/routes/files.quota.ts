/**
 * Storage quota arithmetic, kept free of Hono and Drizzle so the decisions can
 * be tested without a database.
 *
 * Limits are an abuse ceiling, not a monetization lever: they are unadvertised
 * and set generously enough that ordinary use never reaches them. The numbers
 * only ever surface in a rejection payload.
 */

/** Binary gigabyte. Entitlements store GB; every byte comparison uses this. */
export const GB_BYTES = 1024 ** 3;

/**
 * How long a presigned upload URL stays valid, and therefore how old a still
 * `pending` row must be before its upload counts as abandoned. Lives here with
 * the other policy constants so the reclamation sweep and the signer cannot
 * drift apart — sweeping earlier than the expiry would kill an upload still
 * legitimately in flight.
 */
export const PRESIGN_EXPIRY_MS = 3600 * 1000;

export function abandonedBefore(now: Date): Date {
  return new Date(now.getTime() - PRESIGN_EXPIRY_MS);
}

/** Per-file ceiling. Fits phone video and long audio, so real users never hit it. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export interface StorageLimit {
  unlimited: boolean;
  /** Meaningless when `unlimited` — read the flag first. */
  limitBytes: number;
}

interface ResolvedEntitlement {
  valueLimit?: number | null;
  unlimited?: boolean | null;
}

/**
 * Entitlement maps from entitlementsMiddleware are keyed by featureId (UUID),
 * not by feature key, and carry only {enabled, valueLimit, unlimited}. Callers
 * must look the UUID up in `features` first.
 *
 * An absent map means the middleware did not run for this request — a wiring
 * error, not a free-tier user. The same reasoning is documented at length in
 * tenants.limit.ts, where defaulting instead of throwing hid a revenue bug.
 */
export function resolveStorageLimit(
  entitlements: Record<string, ResolvedEntitlement> | undefined,
  featureId: string,
): StorageLimit {
  if (!entitlements) {
    throw new Error(
      'entitlements missing from request context — the storage limit cannot be resolved. ' +
        'This route must be registered after entitlementsMiddleware in app.ts.',
    );
  }

  const entitlement = entitlements[featureId];
  if (entitlement?.unlimited) return { unlimited: true, limitBytes: 0 };

  return { unlimited: false, limitBytes: (entitlement?.valueLimit ?? 0) * GB_BYTES };
}

export type UploadDecision =
  | { allowed: true }
  | { allowed: false; code: 'file_too_large'; maxBytes: number; size: number }
  | { allowed: false; code: 'storage_quota_exceeded'; usedBytes: number; limitBytes: number; size: number };

export function decideUpload(args: {
  size: number;
  usedBytes: number;
  limit: StorageLimit;
}): UploadDecision {
  const { size, usedBytes, limit } = args;

  if (limit.unlimited) return { allowed: true };

  // Per-file first: an oversized file on a full tenant should be told the
  // actionable thing, which is that the file itself is too big.
  if (size > MAX_FILE_BYTES) {
    return { allowed: false, code: 'file_too_large', maxBytes: MAX_FILE_BYTES, size };
  }

  if (usedBytes + size > limit.limitBytes) {
    return { allowed: false, code: 'storage_quota_exceeded', usedBytes, limitBytes: limit.limitBytes, size };
  }

  return { allowed: true };
}

/**
 * Whole-percent usage for the meter. Returns 0 when there is no limit, because
 * the unlimited case carries a placeholder limitBytes of 0 and dividing by it
 * would pin the meter at Infinity for the one plan that should never show one.
 */
export function storagePercent(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0;
  return Math.min(100, Math.round((usedBytes / limitBytes) * 100));
}
