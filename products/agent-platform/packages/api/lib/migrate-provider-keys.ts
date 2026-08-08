import { encryptSecret, decryptSecret } from '@serverless-saas/ai/src/utils/encryption';

/**
 * Re-encrypt llm_providers.api_key_encrypted rows written before the AES-256-GCM fix.
 *
 * Those rows hold plain base64, which is reversible: anyone with a database
 * backup, a read replica, the hosted dashboard or a SQL-injection foothold
 * recovers the provider credential with a single `base64 -d`.
 *
 * Two properties make this safe to run against production:
 *
 *  - **Idempotent.** Re-running must not double-encrypt. An already-encrypted
 *    envelope is detected and left alone, so the job can be retried or run on a
 *    partially-migrated table.
 *  - **Non-destructive.** A value that cannot be classified is returned
 *    unchanged rather than overwritten. Losing a credential is worse than
 *    leaving one row for a human to look at.
 *
 * Re-encrypting does NOT undo the exposure — anything already in a backup stays
 * readable. These keys should also be rotated at the provider.
 */

export type StoredSecretKind = 'empty' | 'encrypted' | 'legacy-prefixed' | 'legacy-base64' | 'unknown';

/** Is this the AES-256-GCM envelope written by encryptSecret? */
function isEncryptedEnvelope(value: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return Boolean(parsed && parsed.iv && parsed.authTag && parsed.data);
  } catch {
    return false;
  }
}

function isBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  // Round-trip check: base64 of the decoded bytes must reproduce the input.
  try {
    return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch {
    return false;
  }
}

export function classifyStoredSecret(value: string | null | undefined): StoredSecretKind {
  if (!value) return 'empty';
  // Order matters: the encrypted envelope is itself valid base64, so it must be
  // ruled out before the legacy check or every migrated row looks unmigrated.
  if (isEncryptedEnvelope(value)) return 'encrypted';
  if (value.startsWith('enc:')) return 'legacy-prefixed';
  if (isBase64(value)) return 'legacy-base64';
  return 'unknown';
}

export interface MigrationResult {
  changed: boolean;
  value: string;
}

/** Return the value as it should be stored, and whether it needs writing back. */
export function migrateStoredSecret(value: string | null | undefined): MigrationResult {
  const kind = classifyStoredSecret(value);
  const current = value ?? '';

  switch (kind) {
    case 'empty':
    case 'encrypted':
      return { changed: false, value: current };

    case 'legacy-prefixed': {
      // decryptSecret strips the enc: prefix and base64-decodes this shape.
      return { changed: true, value: encryptSecret(decryptSecret(current)) };
    }

    case 'legacy-base64': {
      // Decoded here rather than via decryptSecret: bare base64 matches neither
      // the new envelope nor the enc: prefix, so decryptSecret's plaintext
      // fallback hands it straight back and the row would be re-encrypted
      // still-encoded — recoverable with one extra base64 -d.
      return {
        changed: true,
        value: encryptSecret(Buffer.from(current, 'base64').toString('utf8')),
      };
    }

    default:
      // Unrecognised — leave it for a human rather than risk destroying a key.
      return { changed: false, value: current };
  }
}
