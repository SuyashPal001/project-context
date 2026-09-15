/**
 * End-to-end creative-brief harness.
 *
 * Reuses the production-shaped Director harness to prove that a brief emitted by
 * the four-part creative library reaches Olmo, delegates to Director, and causes
 * a real generation tool call. This fixture intentionally requests one keyframe;
 * final video assembly is a separate pipeline.
 *
 * Usage:
 *   NODE_EXTRA_CA_CERTS=$(pwd)/supabase-ca.crt npx tsx scripts/testCreativeBrief.ts
 */
import { runDirectorHarness } from './testDirector.js'

const CREATIVE_BRIEF_FIXTURE = `User direction:
Create the opening product-ad keyframe for a 20-second Instagram ad aimed at busy professionals. Generate the image now.
Creative brief:
- Template: Product Demo (Demonstration)
  Show the product in use, focus on one clear benefit, and close with a call to action.
- Avatar: Arjun · Tech presenter · Clear
  Use a friendly Indian male presenter in a natural social-video setting.
- Product: serum.png
  Show a premium unbranded skincare serum bottle as the product reference.
- Voice: Nandi · Poised narrator
  Narration language: Hindi (hi)
Create the first visual from this brief. Do not invent product claims, prices, customer quotes, or results.`

runDirectorHarness(CREATIVE_BRIEF_FIXTURE).catch(error => {
  console.error('\n[testCreativeBrief] fatal:', error)
  process.exit(1)
})
