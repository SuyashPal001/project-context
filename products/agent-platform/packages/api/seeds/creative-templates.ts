/**
 * Seeds the six creative-library template recreation contracts.
 *
 * Consumed by the retrieve_template Mastra tool
 * (apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.ts) on Director.
 * Every row here is platform-owned (tenant_id = NULL) — tenant-authored
 * templates are not built yet.
 *
 * Idempotent: safe to re-run after hand-editing a contract below.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:creative-templates
 */

import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export interface TemplateSeed {
  slug: string;
  title: string;
  category: string;
  description: string;
  imageUrl: string;
  clonePrompt: string;
  negativePrompt: string;
  cloneNotes: string;
  excludeInClone: string;
  technical: { aspectRatio: string; durationSeconds: number; resolution: string; fps: number };
  scenes: Array<{ order: number; shotType: string; action: string; onScreenText?: string; audio?: string }>;
}

export const TEMPLATES: TemplateSeed[] = [
  {
    slug: 'problem-solution',
    title: 'Problem → Solution',
    category: 'Explainer',
    description: 'Open with a familiar frustration, then show the product fixing it.',
    imageUrl: '/creative/templates/problem-solution.png',
    clonePrompt: 'Open on the audience\'s problem in a relatable everyday moment. Introduce the product as the fix. Demonstrate the specific benefit that solves the problem shown. Close on a clear call to action.',
    negativePrompt: 'No competitor branding, no invented statistics, no unsupported medical or performance claims.',
    cloneNotes: 'Keep the pacing brisk — the frustration beat should read in 2-3 seconds, not linger. The tone shift from "problem" to "relief" is the emotional core; preserve that contrast.',
    excludeInClone: 'Any reference to a specific competitor product or brand. Do not carry over source-clip watermarks, UI chrome, or identifiable people from a reference.',
    technical: { aspectRatio: '9:16', durationSeconds: 20, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'medium close-up', action: 'Subject visibly frustrated by the problem in a natural setting.', onScreenText: undefined, audio: 'Relatable, slightly exasperated tone.' },
      { order: 2, shotType: 'product insert', action: 'Product is introduced — clean reveal, no fanfare.', onScreenText: 'The fix.', audio: 'Tone shifts to relief/curiosity.' },
      { order: 3, shotType: 'demonstration', action: 'Product used to directly resolve the problem shown in scene 1.', onScreenText: undefined, audio: 'Confident, upbeat.' },
      { order: 4, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Try it today.', audio: 'Warm, direct.' },
    ],
  },
  {
    slug: 'product-demo',
    title: 'Product Demo',
    category: 'Demonstration',
    description: 'Show the product in use and make its main benefit obvious.',
    imageUrl: '/creative/templates/product-demo.png',
    clonePrompt: 'Show the product in active use. Focus the entire piece on one clear, single benefit — do not try to cover multiple features. Close with a call to action.',
    negativePrompt: 'No competitor branding, no multi-feature laundry list, no invented pricing or claims.',
    cloneNotes: 'One benefit only. The demonstration shot should be the longest scene — this is a show-don\'t-tell structure, minimize narration over the demo itself.',
    excludeInClone: 'Any competitor product visible in-frame. Do not carry over a reference clip\'s original branding or identifiable presenter.',
    technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'establishing', action: 'Product introduced in its natural use context.', onScreenText: undefined, audio: 'Neutral, inviting.' },
      { order: 2, shotType: 'demonstration', action: 'Product used, single benefit made visually obvious.', onScreenText: undefined, audio: 'Confident narration on the one benefit only.' },
      { order: 3, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Get yours.', audio: 'Direct, brief.' },
    ],
  },
  {
    slug: 'testimonial',
    title: 'Testimonial',
    category: 'Social proof',
    description: 'Tell a customer story with a specific before and after.',
    imageUrl: '/creative/templates/testimonial.png',
    clonePrompt: 'Tell a believable customer story with a specific before-and-after. Do not invent customer quotes or results — ask for real ones before generating narration that states a result.',
    negativePrompt: 'No invented customer names, quotes, or numeric results. No claim of a "real" testimonial unless the user has actually supplied one.',
    cloneNotes: 'Authenticity over polish — slightly imperfect, conversational delivery reads as more credible than a scripted-sounding read.',
    excludeInClone: 'A reference clip\'s actual customer identity or quote — these must be replaced with the client\'s own, or left as clearly-marked placeholders pending real input.',
    technical: { aspectRatio: '9:16', durationSeconds: 25, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'talking head', action: 'Presenter describes life before the product, specific and personal.', onScreenText: undefined, audio: 'Conversational, unpolished.' },
      { order: 2, shotType: 'product insert', action: 'Product shown as the turning point.', onScreenText: undefined, audio: 'Tone lifts.' },
      { order: 3, shotType: 'talking head', action: 'Presenter describes the specific after-state.', onScreenText: undefined, audio: 'Warmer, more confident.' },
      { order: 4, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'See for yourself.', audio: 'Direct.' },
    ],
  },
  {
    slug: 'before-after',
    title: 'Before → After',
    category: 'Transformation',
    description: 'Contrast the old experience with the improved one.',
    imageUrl: '/creative/templates/before-after.png',
    clonePrompt: 'Contrast the experience before using the product against the experience after. Avoid unsupported performance claims — show the contrast visually rather than asserting numbers.',
    negativePrompt: 'No invented percentages, timeframes, or measurable claims not supplied by the user.',
    cloneNotes: 'The cut between "before" and "after" is the entire structure — keep it a hard, clean cut, not a slow transition, so the contrast reads instantly.',
    excludeInClone: 'Any competitor product shown as the "before" state. Do not carry over identifiable people from a reference clip.',
    technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'wide', action: 'The "before" state — visually establishes the problem/limitation.', onScreenText: 'Before', audio: 'Flat, unremarkable tone.' },
      { order: 2, shotType: 'hard cut, matching wide', action: 'The "after" state — same framing, product now in use.', onScreenText: 'After', audio: 'Sharp tonal lift on the cut.' },
      { order: 3, shotType: 'closing card', action: 'Product with call-to-action text.', onScreenText: 'Make the switch.', audio: 'Confident.' },
    ],
  },
  {
    slug: 'offer',
    title: 'Offer / Sale',
    category: 'Promotion',
    description: 'Lead with an offer and explain why it is worth acting on.',
    imageUrl: '/creative/templates/offer.png',
    clonePrompt: 'Lead with the offer itself. Explain the value in one beat. Close with a call to action and a deadline. Ask for the actual price, discount, and deadline instead of inventing them.',
    negativePrompt: 'No invented price, discount percentage, or deadline. No false urgency not supplied by the user.',
    cloneNotes: 'Offer comes first, not last — this inverts the usual "build up to the ask" structure deliberately.',
    excludeInClone: 'Any pricing or deadline copied from a reference clip — these are always client-specific and must never be reused.',
    technical: { aspectRatio: '9:16', durationSeconds: 12, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'product hero', action: 'Product shown immediately with the offer stated on-screen.', onScreenText: '[OFFER PLACEHOLDER]', audio: 'High-energy open.' },
      { order: 2, shotType: 'product insert', action: 'Brief value explanation — why the offer matters.', onScreenText: undefined, audio: 'Direct, persuasive.' },
      { order: 3, shotType: 'closing card', action: 'Offer restated with deadline and call to action.', onScreenText: '[DEADLINE PLACEHOLDER] — Shop now.', audio: 'Urgent but not invented.' },
    ],
  },
  {
    slug: 'ugc-review',
    title: 'UGC Review',
    category: 'Social video',
    description: 'A casual first-person walkthrough suited to short social clips.',
    imageUrl: '/creative/templates/ugc-review.png',
    clonePrompt: 'Use a casual, first-person hook, then walk through the product experience, land on one specific benefit, and close with a natural (not scripted-sounding) call to action. Do not claim this is a real customer review unless the user has provided one.',
    negativePrompt: 'No claim of being a "real" review without user-supplied source material. No invented reviewer identity.',
    cloneNotes: 'The hook must land in the first second — this is a scroll-stopping format, not a slow build. Handheld, imperfect camera energy is intentional, not a flaw to fix.',
    excludeInClone: 'A reference clip\'s actual creator identity, platform watermark, or username overlay.',
    technical: { aspectRatio: '9:16', durationSeconds: 20, resolution: '1080x1920', fps: 30 },
    scenes: [
      { order: 1, shotType: 'selfie-style hook', action: 'Casual, attention-grabbing opening line direct to camera.', onScreenText: undefined, audio: 'Energetic, informal.' },
      { order: 2, shotType: 'handheld demonstration', action: 'Product used in a natural, unstaged-feeling way.', onScreenText: undefined, audio: 'Conversational narration.' },
      { order: 3, shotType: 'selfie-style close', action: 'Direct-to-camera close with the one specific benefit and a natural call to action.', onScreenText: undefined, audio: 'Casual, sincere.' },
    ],
  },
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    for (const t of TEMPLATES) {
      await sql`
        INSERT INTO creative_templates (
          tenant_id, slug, title, category, description, image_url,
          clone_prompt, negative_prompt, clone_notes, exclude_in_clone,
          technical, scenes, status
        ) VALUES (
          NULL, ${t.slug}, ${t.title}, ${t.category}, ${t.description}, ${t.imageUrl},
          ${t.clonePrompt}, ${t.negativePrompt}, ${t.cloneNotes}, ${t.excludeInClone},
          ${sql.json(t.technical)}, ${sql.json(t.scenes)}, 'active'
        )
        ON CONFLICT (tenant_id, slug) DO UPDATE SET
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          description = EXCLUDED.description,
          image_url = EXCLUDED.image_url,
          clone_prompt = EXCLUDED.clone_prompt,
          negative_prompt = EXCLUDED.negative_prompt,
          clone_notes = EXCLUDED.clone_notes,
          exclude_in_clone = EXCLUDED.exclude_in_clone,
          technical = EXCLUDED.technical,
          scenes = EXCLUDED.scenes,
          updated_at = now()
      `;
      console.log(`[seed:creative-templates] upserted ${t.slug}`);
    }
  } finally {
    await sql.end();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  run().catch((err) => {
    console.error('[seed:creative-templates] failed', err);
    process.exit(1);
  });
}
