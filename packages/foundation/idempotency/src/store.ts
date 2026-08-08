import type { CacheClient } from '@serverless-saas/cache';
import { TTL } from '@serverless-saas/cache';

export interface IdempotencyRecord {
  status: 'processing' | 'completed';
  timestamp: string;
}

/**
 * How long an in-flight claim survives.
 *
 * This is the single most important number here. A claim must outlive the
 * longest legitimate run (the worker Lambda's 300s timeout) so two concurrent
 * consumers cannot both process a message — but it must expire soon enough that
 * a consumer killed WITHOUT a catchable error (timeout, OOM, runtime crash)
 * releases its claim before the message is retried for good.
 *
 * Holding an in-flight claim for the full completion window is what silently
 * destroyed jobs: the crashed consumer's lock outlived every redelivery, so each
 * retry was mistaken for a duplicate and dropped.
 */
export const PROCESSING_TTL_SECONDS = 900; // 15 min — > 300s Lambda timeout, << 48h

export class IdempotencyStore {
  constructor(private redis: CacheClient) {}

  /** True only when the key represents genuinely completed work. */
  async isProcessed(key: string): Promise<boolean> {
    const raw = await this.redis.get(`idempotency:${key}`);
    if (!raw) return false;
    return this.parse(raw)?.status === 'completed';
  }

  /**
   * Claim a message for processing. Returns false if another consumer holds a
   * live claim, or if this message already completed.
   */
  async acquire(key: string, ttl = PROCESSING_TTL_SECONDS): Promise<boolean> {
    const record: IdempotencyRecord = {
      status: 'processing',
      timestamp: new Date().toISOString(),
    };
    const result = await this.redis.set(`idempotency:${key}`, JSON.stringify(record), {
      nx: true,
      ex: ttl,
    });
    return result === 'OK';
  }

  /**
   * Mark work as durably done. Only here does the long dedupe window apply —
   * this is the record that must outlive every possible redelivery.
   */
  async complete(key: string, ttl = TTL.IDEMPOTENCY): Promise<void> {
    const record: IdempotencyRecord = {
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
    await this.redis.set(`idempotency:${key}`, JSON.stringify(record), { ex: ttl });
  }

  /** Drop the claim so the message can be retried immediately. */
  async release(key: string): Promise<void> {
    await this.redis.del(`idempotency:${key}`);
  }

  private parse(raw: unknown): IdempotencyRecord | null {
    try {
      // Upstash auto-deserializes JSON; ioredis returns strings.
      return typeof raw === 'string' ? (JSON.parse(raw) as IdempotencyRecord) : (raw as IdempotencyRecord);
    } catch {
      return null;
    }
  }
}
