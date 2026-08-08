import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyStore, PROCESSING_TTL_SECONDS } from './store';
import { TTL } from '@serverless-saas/cache';

/**
 * F-11 — a crashed consumer must not permanently discard its message.
 *
 * The bug: acquire() wrote a `processing` record with the 48-hour completion
 * TTL, and release() was called only from the worker's catch block. When the
 * Lambda died without a catchable error — the 300s timeout, an OOM kill, a
 * runtime crash — the lock survived for two days. SQS redelivered, acquire()
 * returned false, the worker logged `idempotency_skip` and hit `continue`
 * WITHOUT appending to batchItemFailures, so SQS deleted the message. The job
 * was lost with no retry and no dead-letter.
 *
 * The distinction the store already modelled but never used: `processing` is an
 * in-flight claim that must expire soon after the queue's visibility timeout;
 * `completed` is a durable dedupe record. Only the second deserves 48 hours.
 */

/** Redis-accurate fake: NX honours existing keys; expiry is explicit. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();
  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= now()) {
      store.delete(k);
      return undefined;
    }
    return e;
  };
  return {
    store,
    async set(key: string, value: string, opts?: { nx?: boolean; ex?: number }) {
      if (opts?.nx && live(key)) return null;
      store.set(key, { value, expiresAt: now() + (opts?.ex ?? 60) * 1000 });
      return 'OK';
    },
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async exists(key: string) {
      return live(key) ? 1 : 0;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    /** Simulate wall-clock passing so a TTL lapses. */
    advance(seconds: number) {
      for (const [k, e] of store) {
        e.expiresAt -= seconds * 1000;
        if (e.expiresAt <= now()) store.delete(k);
      }
    },
  };
}

describe('IdempotencyStore', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let store: IdempotencyStore;
  const KEY = 'sqs-message-id-1';

  beforeEach(() => {
    redis = fakeRedis();
    store = new IdempotencyStore(redis as never);
  });

  it('lets the first caller claim a message', async () => {
    expect(await store.acquire(KEY)).toBe(true);
  });

  it('blocks a second concurrent caller while the first is still working', async () => {
    await store.acquire(KEY);
    expect(await store.acquire(KEY)).toBe(false);
  });

  it('holds the in-flight claim for far less than the completion window', async () => {
    // The crux: a processing claim must not outlive the queue's redelivery.
    expect(PROCESSING_TTL_SECONDS).toBeLessThan(TTL.IDEMPOTENCY);
  });

  it('lets a redelivered message be retried after the consumer died mid-flight', async () => {
    await store.acquire(KEY); // consumer claims it…
    // …then is killed by the Lambda timeout, so neither complete() nor release()
    // ever runs. The in-flight claim lapses.
    redis.advance(PROCESSING_TTL_SECONDS + 1);

    // SQS redelivers the same messageId. This MUST be reclaimable, or the job
    // is silently dropped.
    expect(await store.acquire(KEY)).toBe(true);
  });

  it('never reprocesses a message that genuinely completed', async () => {
    await store.acquire(KEY);
    await store.complete(KEY);

    expect(await store.acquire(KEY)).toBe(false);
  });

  it('keeps the completed record well beyond the in-flight window', async () => {
    await store.acquire(KEY);
    await store.complete(KEY);

    redis.advance(PROCESSING_TTL_SECONDS + 1);
    // Still deduped long after an in-flight claim would have lapsed.
    expect(await store.acquire(KEY)).toBe(false);
  });

  it('allows immediate retry after an explicit release', async () => {
    await store.acquire(KEY);
    await store.release(KEY);

    expect(await store.acquire(KEY)).toBe(true);
  });

  it('reports whether a key completed', async () => {
    expect(await store.isProcessed(KEY)).toBe(false);
    await store.acquire(KEY);
    await store.complete(KEY);
    expect(await store.isProcessed(KEY)).toBe(true);
  });
});
