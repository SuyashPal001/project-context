import type { CacheClient } from '@serverless-saas/cache';
import { TTL } from '@serverless-saas/cache';

export interface IdempotencyRecord {
  status: 'processing' | 'completed';
  timestamp: string;
}

export class IdempotencyStore {
  constructor(private redis: CacheClient) {}

  async isProcessed(key: string): Promise<boolean> {
    const exists = await this.redis.exists(`idempotency:${key}`);
    return exists === 1;
  }

  async acquire(key: string, ttl = TTL.IDEMPOTENCY): Promise<boolean> {
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

  async complete(key: string, ttl = TTL.IDEMPOTENCY): Promise<void> {
    const record: IdempotencyRecord = {
      status: 'completed',
      timestamp: new Date().toISOString(),
    };
    await this.redis.set(`idempotency:${key}`, JSON.stringify(record), {
      ex: ttl,
    });
  }

  async release(key: string): Promise<void> {
    await this.redis.del(`idempotency:${key}`);
  }
}
