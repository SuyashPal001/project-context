import { randomBytes, createHash } from 'node:crypto';

/**
 * Mint a client-portal token. 32 random bytes rendered base64url is 43
 * characters with no padding — enough entropy that the URL itself is the
 * credential and cannot be enumerated.
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage. Only the digest is ever persisted, so a database
 * read does not hand over every live client portal. Lookup is by digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
