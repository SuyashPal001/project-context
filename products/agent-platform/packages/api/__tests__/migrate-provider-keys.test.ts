import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret } from '@serverless-saas/ai/src/utils/encryption';
import { classifyStoredSecret, migrateStoredSecret } from '../lib/migrate-provider-keys';

/**
 * Migration for llm_providers.api_key_encrypted.
 *
 * Rows written before the AES-256-GCM fix hold plain base64, which is
 * reversible — anyone with a backup, read replica or SQLi foothold recovers the
 * provider credential with one `base64 -d`. This re-encrypts them in place.
 *
 * The two properties that make a data migration safe to run against production:
 * it must be idempotent (re-running cannot double-encrypt), and it must never
 * destroy a value it does not understand.
 */

const PLAINTEXT = 'sk-proj-REALPROVIDERKEY-123456';

describe('classifyStoredSecret', () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY ??= 'test-master-key-for-unit-tests-only';
  });

  it('recognises an already-encrypted value', () => {
    expect(classifyStoredSecret(encryptSecret(PLAINTEXT))).toBe('encrypted');
  });

  it('recognises a legacy base64 value', () => {
    expect(classifyStoredSecret(Buffer.from(PLAINTEXT).toString('base64'))).toBe('legacy-base64');
  });

  it('recognises the enc: prefixed legacy envelope', () => {
    const legacy = 'enc:' + Buffer.from(PLAINTEXT).toString('base64');
    expect(classifyStoredSecret(legacy)).toBe('legacy-prefixed');
  });

  it('treats an empty value as nothing to do', () => {
    expect(classifyStoredSecret('')).toBe('empty');
    expect(classifyStoredSecret(null as never)).toBe('empty');
  });

  it('does not mistake an encrypted value for legacy base64', () => {
    // The encrypted envelope IS itself base64, so ordering matters here.
    const encrypted = encryptSecret(PLAINTEXT);
    expect(classifyStoredSecret(encrypted)).not.toBe('legacy-base64');
  });
});

describe('migrateStoredSecret', () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY ??= 'test-master-key-for-unit-tests-only';
  });

  it('encrypts a legacy base64 value so the plaintext is no longer recoverable', () => {
    const legacy = Buffer.from(PLAINTEXT).toString('base64');

    const result = migrateStoredSecret(legacy);

    expect(result.changed).toBe(true);
    expect(Buffer.from(result.value, 'base64').toString('utf8')).not.toContain(PLAINTEXT);
    expect(decryptSecret(result.value)).toBe(PLAINTEXT);
  });

  it('migrates the enc: prefixed envelope too', () => {
    const legacy = 'enc:' + Buffer.from(PLAINTEXT).toString('base64');

    const result = migrateStoredSecret(legacy);

    expect(result.changed).toBe(true);
    expect(decryptSecret(result.value)).toBe(PLAINTEXT);
  });

  it('is idempotent — re-running does not double-encrypt', () => {
    const once = migrateStoredSecret(Buffer.from(PLAINTEXT).toString('base64'));
    const twice = migrateStoredSecret(once.value);

    expect(twice.changed).toBe(false);
    expect(twice.value).toBe(once.value);
    // Still exactly one layer of encryption.
    expect(decryptSecret(twice.value)).toBe(PLAINTEXT);
  });

  it('leaves an empty value untouched', () => {
    expect(migrateStoredSecret('')).toEqual({ changed: false, value: '' });
  });

  it('round-trips a key containing characters that survive base64 poorly', () => {
    const gnarly = 'key-with/slashes+plus=equals\nand-newline';
    const legacy = Buffer.from(gnarly).toString('base64');

    const result = migrateStoredSecret(legacy);

    expect(decryptSecret(result.value)).toBe(gnarly);
  });
});
