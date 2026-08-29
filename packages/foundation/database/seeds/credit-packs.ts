import { eq } from 'drizzle-orm';
import { creditPacks } from '../schema/index';
import type { db as DB } from './index';

/**
 * Purchasable packs, priced at 2 US cents per credit.
 *
 * A credit costs 1 cent of inference (see credit-rates.ts, seeded at cost) and
 * sells for 2 — a 50% gross margin held in the sale price rather than in
 * credit_rates, so a credit stays an honest unit of consumption and plan
 * allowances keep their meaning. See the credit_packs table comment.
 *
 * These are DIFFERENT from plan allowances, deliberately. Plan credits are sold
 * at whatever the plan price implies; purchased credits are sold at exactly 2¢.
 * The two need not match and will not.
 */
const PACKS = [
  { key: 'starter',  name: 'Starter pack',  credits: 500,   priceCents: 1_000,  sortOrder: 1 },
  { key: 'standard', name: 'Standard pack', credits: 1_250, priceCents: 2_500,  sortOrder: 2 },
  { key: 'bulk',     name: 'Bulk pack',     credits: 5_000, priceCents: 10_000, sortOrder: 3 },
] as const;

/** Sale price per credit, in cents. The one number the margin lives in. */
export const CENTS_PER_CREDIT = 2;

export async function seedCreditPacks(db: typeof DB) {
  console.log('seeding credit packs');
  for (const p of PACKS) {
    const existing = await db.select().from(creditPacks).where(eq(creditPacks.key, p.key)).limit(1);
    // Never overwrite. A pack's price is what past sales were made at, and a
    // `payments` row has to stay reconcilable to it — repricing means
    // deactivating the old row and inserting a new key, the same discipline
    // credit_rates uses for versioned rate edits.
    if (existing.length > 0) continue;
    await db.insert(creditPacks).values({ ...p, currency: 'usd', isActive: true });
  }
}
