import { db } from '../client.js'
import { creditRates } from '../schema/index.js'
import { and, eq } from 'drizzle-orm'

async function main() {
  const existing = await db.query.creditRates.findFirst({
    where: and(eq(creditRates.resourceType, 'video_generation'), eq(creditRates.subject, 'google/gemini-omni-1.1-flash')),
  })
  if (existing) {
    console.log('already migrated, nothing to do')
    return
  }
  // There are two rows for the bare 'gemini-omni-1.1-flash' subject on the
  // real dev DB: a deactivated v1 (underpriced per migration
  // 0079_media_credit_rate_correction.sql) and the active v2. Without the
  // isActive filter, findFirst can nondeterministically return the
  // deactivated row and copy its wrong price into the new namespaced row.
  const old = await db.query.creditRates.findFirst({
    where: and(
      eq(creditRates.resourceType, 'video_generation'),
      eq(creditRates.subject, 'gemini-omni-1.1-flash'),
      eq(creditRates.isActive, true),
    ),
  })
  if (!old) {
    console.error('no existing gemini-omni-1.1-flash rate found — insert manually with the correct pricingSchema')
    process.exit(1)
  }
  await db.insert(creditRates).values({
    resourceType: 'video_generation',
    subject: 'google/gemini-omni-1.1-flash',
    pricingSchema: old.pricingSchema,
    version: 1,
    isActive: true,
  })
  console.log('inserted namespaced video_generation rate')
}

main()
  .then(() => {
    // main() uses @serverless-saas/database's shared drizzle client (a pooled
    // postgres.js connection opened at import time), which this script never
    // owns a handle to and so cannot .end(). It has no idle timeout, so
    // without an explicit exit here the process hangs after a successful run
    // instead of returning to the shell (see backfillCredits.ts for the same
    // pattern).
    process.exit(0)
  })
  .catch((err) => {
    console.error('migration failed', err)
    process.exit(1)
  })
