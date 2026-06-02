import { Redis as UpstashRedis } from '@upstash/redis';
import Redis from 'ioredis';

// Unified interface — both clients expose ping, get, set, del
export type CacheClient = {
  ping: () => Promise<string>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ex?: number; nx?: boolean }) => Promise<string | null>;
  del: (...keys: string[]) => Promise<number>;
  exists: (...keys: string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  incr: (key: string) => Promise<number>;
  sadd: (key: string, ...members: (string | number)[]) => Promise<number>;
  srem: (key: string, ...members: (string | number)[]) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
  sismember: (key: string, member: string) => Promise<number>;
  scan: (cursor: any, ...args: any[]) => Promise<[any, any[]]>;
};

let instance: CacheClient | null = null;

const isLocalRedis = (url: string): boolean =>
  url.startsWith('redis://') || url.startsWith('rediss://');

const createUpstashClient = (url: string, token: string): CacheClient => {
  const client = new UpstashRedis({ url, token });
  return {
    ping: () => client.ping(),
    get: (key) => client.get(key),
    set: (key, value, opts) => {
      if (opts?.ex !== undefined && opts?.nx) return client.set(key, value, { ex: opts.ex, nx: true }) as Promise<string | null>;
      if (opts?.ex !== undefined) return client.set(key, value, { ex: opts.ex }) as Promise<string | null>;
      if (opts?.nx) return client.set(key, value, { nx: true }) as Promise<string | null>;
      return client.set(key, value) as Promise<string | null>;
    },
    del: (...keys) => client.del(...keys),
    exists: (...keys) => client.exists(...keys),
    expire: (key, seconds) => client.expire(key, seconds),
    incr: (key) => client.incr(key),
    sadd: (key, ...members) => client.sadd(key, ...(members as [string, ...string[]])),
    srem: (key, ...members) => client.srem(key, ...members),
    smembers: (key) => client.smembers(key),
    sismember: (key, member) => client.sismember(key, member),
    scan: (cursor, ...args) => client.scan(cursor, ...(args as [])),
  };
};

const createIoRedisClient = (url: string): CacheClient => {
  const client = new Redis(url);
  return {
    ping: () => client.ping(),
    get: (key) => client.get(key),
    set: (key, value, opts) => {
      if (opts?.ex && opts?.nx) return client.set(key, value, 'EX', opts.ex, 'NX');
      if (opts?.ex) return client.set(key, value, 'EX', opts.ex);
      if (opts?.nx) return client.set(key, value, 'NX');
      return client.set(key, value);
    },
    del: (...keys) => client.del(...keys),
    exists: (...keys) => client.exists(...keys),
    expire: (key, seconds) => client.expire(key, seconds),
    incr: (key) => client.incr(key),
    sadd: (key, ...members) => client.sadd(key, ...members),
    srem: (key, ...members) => client.srem(key, ...members),
    smembers: (key) => client.smembers(key),
    sismember: (key, member) => client.sismember(key, member),
    scan: (cursor, ...args) => client.scan(cursor, ...args) as any,
  };
};

export const getCacheClient = (): CacheClient => {
  if (!instance) {
    const url = process.env.UPSTASH_REDIS_URL;
    const token = process.env.UPSTASH_REDIS_TOKEN;

    if (!url) {
      throw new Error('UPSTASH_REDIS_URL must be set');
    }

    if (isLocalRedis(url)) {
      // Local dev — use ioredis with standard Redis protocol
      instance = createIoRedisClient(url);
    } else {
      // Production — use Upstash REST client
      if (!token) {
        throw new Error('UPSTASH_REDIS_TOKEN must be set for Upstash');
      }
      instance = createUpstashClient(url, token);
    }
  }
  return instance;
};

export const resetCacheClient = (): void => {
  instance = null;
};

let healthChecked = false;

/**
 * Verify Redis connectivity on first use.
 * Resets the cached instance if the ping fails so the next call retries.
 * Call from initRuntimeSecrets() after setting UPSTASH credentials.
 */
export async function ensureCacheHealthy(): Promise<void> {
  if (healthChecked) return;
  const client = getCacheClient();
  try {
    await client.ping();
    healthChecked = true;
  } catch (err) {
    resetCacheClient();
    healthChecked = false;
    throw new Error(`Redis health check failed: ${(err as Error).message}`);
  }
}
