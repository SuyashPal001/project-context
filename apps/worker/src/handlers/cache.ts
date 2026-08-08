import { getRedis } from '../redis';

interface CachePayload {
  keys: string[];
}

/**
 * Generic cache-key invalidation job.
 *
 * Registered in the router but currently has no producer anywhere in the
 * codebase — the caches that need invalidating (tenant context, permissions,
 * entitlements) are cleared synchronously by the routes that mutate them, via
 * the shared key helpers in @serverless-saas/cache. Kept because it is a
 * working generic capability, but note that enqueuing it is not how cache
 * invalidation currently happens; a comment claiming otherwise once masked a
 * cache that was never being invalidated at all.
 */
export async function handleCacheInvalidate(body: Record<string, unknown>): Promise<void> {
  const payload = body.payload as CachePayload | undefined;
  const keys = payload?.keys;

  // A malformed message previously threw on `payload.keys`, failing the whole
  // SQS batch item for what is a no-op.
  if (!Array.isArray(keys) || keys.length === 0) {
    console.log('Cache invalidation job had no keys — nothing to do');
    return;
  }

  const redis = getRedis();
  for (const key of keys) {
    await redis.del(key);
  }

  console.log('Cache keys invalidated', { count: keys.length, keys });
}