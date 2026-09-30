/**
 * Seeds the platform-owned Official skills: Avatar creator and Talking head.
 *
 * These rows have no owner — ownerTenantId and createdBy are both NULL, the
 * same "platform-owned" convention creative_library_assets.tenant_id uses.
 * The upsert targets (ownerTenantId, slug) via the NULLS NOT DISTINCT unique
 * constraint added in migration 0100, so re-running this seed against the
 * same NULL-owner row updates it instead of duplicating it.
 *
 * Idempotent: safe to re-run. A new skill_versions row is only inserted when
 * the computed body differs from the latest stored version's manifest->>'body'.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:official-skills
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { skills, skillVersions } from '@serverless-saas/agent-schema/skills';

export interface SkillShowcase {
  imageUrl: string;
  bestFor: string[];
  starterPrompt: string;
}

export interface OfficialSkillSeed {
  slug: string;
  name: string;
  description: string;
  file: string;
  showcase: SkillShowcase;
}

const SEEDS_DIR = dirname(fileURLToPath(import.meta.url));
const officialSkillFile = (name: string) => join(SEEDS_DIR, 'official-skills', name);

export const OFFICIAL_SKILLS: OfficialSkillSeed[] = [
  {
    slug: 'avatar-creator',
    name: 'Avatar creator',
    description: 'Use when the user wants a new reusable AI presenter/avatar for their ads, from a description or from a reference photo.',
    file: officialSkillFile('avatar-creator.md'),
    showcase: {
      imageUrl: '/creative/avatars/beginner-fitness-instructor.jpg',
      bestFor: ['UGC ads', 'Presenters', 'Brand faces'],
      starterPrompt: 'Create a new avatar for my ads',
    },
  },
  {
    slug: 'animated-character-creator',
    name: 'Animated character creator',
    description: 'Use when the user wants a new reusable animated character for their ads — a cozy 3D mascot, a console-game-style hero, or a cinematic or fantasy anime character, not a photoreal person.',
    file: officialSkillFile('animated-character-creator.md'),
    showcase: {
      imageUrl: '/creative/avatars/animated-character.jpg',
      bestFor: ['Mascots', 'Game heroes', 'Anime'],
      starterPrompt: 'Create an animated character for my ads',
    },
  },
  {
    slug: 'talking-head',
    name: 'Talking head',
    description: 'Use when the user wants a single presenter speaking one continuous script to camera — a talking-head ad.',
    file: officialSkillFile('talking-head.md'),
    showcase: {
      imageUrl: '/creative/avatars/beauty-skincare-presenter.jpg',
      bestFor: ['Product explainers', 'Testimonials', 'Announcements'],
      starterPrompt: 'Make a talking-head ad for my product',
    },
  },
];

/** Reads a skill body file, trimmed. Throws if the file is empty (or whitespace-only). */
export function readSkillBody(file: string): string {
  const contents = readFileSync(file, 'utf8').trim();
  if (contents.length === 0) {
    throw new Error(`Skill body file is empty: ${file}`);
  }
  return contents;
}

/** Mirrors the shape the import worker writes to skill_versions.manifest — see
 *  worker-handlers/handlers/skillImport.ts's manifestWithBody. */
export function buildSkillManifest(name: string, description: string, body: string): { name: string; description: string; body: string } {
  return { name, description, body };
}

async function run(): Promise<void> {
  for (const entry of OFFICIAL_SKILLS) {
    const body = readSkillBody(entry.file);
    const manifest = buildSkillManifest(entry.name, entry.description, body);

    await db.transaction(async (tx) => {
      const [skill] = await tx
        .insert(skills)
        .values({
          ownerTenantId: null,
          createdBy: null,
          name: entry.name,
          slug: entry.slug,
          description: entry.description,
          visibility: 'public',
          isOfficial: true,
          showcase: entry.showcase,
        })
        .onConflictDoUpdate({
          target: [skills.ownerTenantId, skills.slug],
          set: {
            name: entry.name,
            description: entry.description,
            visibility: 'public',
            isOfficial: true,
            showcase: entry.showcase,
            updatedAt: new Date(),
          },
        })
        .returning();

      const [latest] = await tx
        .select({ version: skillVersions.version, manifest: skillVersions.manifest })
        .from(skillVersions)
        .where(eq(skillVersions.skillId, skill.id))
        .orderBy(desc(skillVersions.version))
        .limit(1);

      const latestBody = latest?.manifest && typeof latest.manifest === 'object'
        ? (latest.manifest as Record<string, unknown>).body
        : undefined;

      if (!latest || latestBody !== body) {
        const nextVersion = (latest?.version ?? 0) + 1;
        await tx.insert(skillVersions).values({
          skillId: skill.id,
          version: nextVersion,
          manifest,
          s3Prefix: `official/${entry.slug}/v${nextVersion}`,
          sourceType: 'authored',
          sourceRef: null,
          status: 'ready',
        });
        await tx.update(skills).set({ latestVersion: nextVersion }).where(eq(skills.id, skill.id));
        console.log(`[seed:official-skills] ${latest ? 'updated' : 'created'} ${entry.slug} to v${nextVersion}`);
      } else {
        console.log(`[seed:official-skills] ${entry.slug} unchanged`);
      }
    });
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed:official-skills] failed', err);
      process.exit(1);
    });
}
