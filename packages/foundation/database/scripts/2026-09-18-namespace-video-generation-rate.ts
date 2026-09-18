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
  const old = await db.query.creditRates.findFirst({
    where: and(eq(creditRates.resourceType, 'video_generation'), eq(creditRates.subject, 'gemini-omni-1.1-flash')),
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
