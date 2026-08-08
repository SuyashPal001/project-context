/**
 * One-off migration: re-encrypt legacy llm_providers.api_key_encrypted rows.
 *
 * Rows written before the AES-256-GCM fix hold plain base64 — reversible with a
 * single `base64 -d` by anyone holding a backup, a read replica, the hosted
 * database dashboard, or a SQL-injection foothold.
 *
 * Safe to re-run: already-encrypted rows are detected and skipped, and any value
 * that cannot be classified is left untouched for a human rather than
 * overwritten.
 *
 * Usage:
 *   TOKEN_ENCRYPTION_KEY=... DATABASE_URL=... pnpm tsx scripts/migrate-provider-keys.ts [--apply]
 *
 * Runs as a dry run unless --apply is passed, so the row counts can be checked
 * before anything is written.
 *
 * NOTE: this closes the ongoing exposure but does not undo it. Any key already
 * captured in a backup remains readable, so these credentials should also be
 * rotated at the provider.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import { classifyStoredSecret, migrateStoredSecret } from '../lib/migrate-provider-keys';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.error('TOKEN_ENCRYPTION_KEY is required — refusing to run.');
    process.exit(1);
  }

  const rows = await db
    .select({ id: llmProviders.id, provider: llmProviders.provider, secret: llmProviders.apiKeyEncrypted })
    .from(llmProviders);

  const tally: Record<string, number> = {};
  let migrated = 0;

  for (const row of rows) {
    const kind = classifyStoredSecret(row.secret);
    tally[kind] = (tally[kind] ?? 0) + 1;

    if (kind === 'unknown') {
      console.warn(`[migrate] provider ${row.id} (${row.provider}): unrecognised value, left untouched`);
      continue;
    }

    const result = migrateStoredSecret(row.secret);
    if (!result.changed) continue;

    if (apply) {
      await db
        .update(llmProviders)
        .set({ apiKeyEncrypted: result.value })
        .where(eq(llmProviders.id, row.id));
    }
    migrated++;
    console.log(`[migrate] provider ${row.id} (${row.provider}): ${kind} -> encrypted${apply ? '' : ' (dry run)'}`);
  }

  console.log('\nSummary');
  console.log('  rows scanned :', rows.length);
  for (const [kind, count] of Object.entries(tally)) console.log(`  ${kind.padEnd(15)}:`, count);
  console.log('  re-encrypted :', migrated, apply ? '' : '(dry run — re-run with --apply to write)');

  if (apply && migrated > 0) {
    console.log('\nThese credentials were previously stored reversibly. Rotate them at the provider.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
