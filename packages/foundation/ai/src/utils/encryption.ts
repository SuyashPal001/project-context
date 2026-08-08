/**
 * Encryption utilities for secrets
 *
 * Handles encryption/decryption of API keys stored in llm_providers.api_key_encrypted.
 * Uses AES-256-GCM with a per-salt key derived from TOKEN_ENCRYPTION_KEY via scrypt.
 * Aligns with the encryptCredentials() pattern used for OAuth credentials.
 *
 * salt defaults to 'platform' for LLM keys (platform rows have no tenantId).
 * Pass tenantId as salt for tenant-scoped keys.
 *
 * Backward compat:
 *   - Old 'enc:' base64 rows still decrypt correctly
 *   - Plaintext fallback retained for pre-migration rows
 */

import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'crypto';

/**
 * Encrypt a secret for storage using AES-256-GCM.
 */
export function encryptSecret(plain: string, salt: string = 'platform'): string {
  const masterKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!masterKey) throw new Error('TOKEN_ENCRYPTION_KEY not set');
  const key = scryptSync(masterKey, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
    })
  ).toString('base64');
}

/**
 * Decrypt a secret value from the database.
 *
 * Supports three formats (in detection order):
 *   1. AES-256-GCM (new format) — base64-encoded JSON with iv/authTag/data
 *   2. enc: prefix — old base64 envelope (backward compat)
 *   3. Plaintext fallback — pre-migration rows
 */
export function decryptSecret(encrypted: string, salt: string = 'platform'): string {
  if (!encrypted) return encrypted;

  // Detect the new AES-256-GCM format WITHOUT swallowing decryption failures.
  //
  // Only "this is not the new format" may fall through to the compat paths. A
  // value that IS the new format but fails to decrypt means the wrong key/salt
  // or a tampered ciphertext, and GCM's authentication tag exists precisely to
  // surface that — catching it and returning the input as "plaintext" would hand
  // the caller ciphertext dressed up as a secret and discard the integrity
  // guarantee the algorithm was chosen for.
  let parsed: { iv?: string; authTag?: string; data?: string } | null = null;
  try {
    parsed = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8'));
  } catch {
    parsed = null; // genuinely not the new envelope
  }

  if (parsed && parsed.iv && parsed.authTag && parsed.data) {
    const masterKey = process.env.TOKEN_ENCRYPTION_KEY;
    if (!masterKey) throw new Error('TOKEN_ENCRYPTION_KEY not set');
    const key = scryptSync(masterKey, salt, 32);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
    // Throws on auth-tag mismatch — intentionally propagated.
    return decipher.update(Buffer.from(parsed.data, 'base64')) + decipher.final('utf8');
  }

  // Backward compat: old enc: prefix (base64)
  if (encrypted.startsWith('enc:')) {
    return Buffer.from(encrypted.slice(4), 'base64').toString('utf8');
  }

  // Plaintext fallback (dev mode or pre-encryption rows)
  return encrypted;
}
