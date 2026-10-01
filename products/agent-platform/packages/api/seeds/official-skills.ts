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
 * the computed body, references or director markers differ from the latest
 * stored version's manifest.
 *
 * Official installs always run the latest version: when a new version is
 * written, every tenant's install of that skill moves to it in the same
 * transaction. Olmo and Director then read the same version, so the skill's
 * card text and its Director rules can never drift apart.
 *
 * A skill folder next to its .md (official-skills/<slug>/) holds Director's
 * half of the skill: director.md becomes the manifest's references, and
 * Director loads it as a native Mastra skill (usage.ts's
 * fetchOfficialDirectorSkills) only for a brief that carries one of its markers.
 *
 * Runs on the VM as a deploy step (deploy.sh), never from a laptop, so skill
 * text goes live together with the code that reads it.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:official-skills
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { skillInstalls, skills, skillVersions } from '@serverless-saas/agent-schema/skills';

export interface SkillShowcase {
  imageUrl: string;
  bestFor: string[];
  starterPrompt: string;
}

/** Director's half of a skill: the file it loads, and the lines in Olmo's
 *  brief that tell Director to load it (e.g. "style: tvc"). */
export interface DirectorReferenceSeed {
  file: string;
  markers: string[];
}

export interface OfficialSkillSeed {
  slug: string;
  name: string;
  description: string;
  file: string;
  showcase: SkillShowcase;
  director?: DirectorReferenceSeed;
}

const SEEDS_DIR = dirname(fileURLToPath(import.meta.url));
const officialSkillFile = (name: string) => join(SEEDS_DIR, 'official-skills', name);

export const OFFICIAL_SKILLS: OfficialSkillSeed[] = [
  {
    slug: 'avatar-creator',
    name: 'Avatar creator',
    description: 'Use when the user wants a new reusable AI presenter/avatar for their ads, from a description or from a reference photo.',
    file: officialSkillFile('avatar-creator.md'),
    director: { file: officialSkillFile('avatar-creator/director.md'), markers: ['style: realistic avatar'] },
    showcase: {
      imageUrl: '/creative/avatars/beginner-fitness-instructor.jpg',
      bestFor: ['UGC ads', 'Presenters', 'Brand faces'],
      starterPrompt: 'Create a new avatar for my ads',
    },
  },
  {
    slug: 'animated-character-creator',
    name: 'Animated character creator',
    description: 'Use when the user wants a new reusable animated character for their ads — a cozy 3D mascot, a console-game-style hero, a cinematic, fantasy or storybook anime character, or a 3D chibi family character, not a photoreal person.',
    file: officialSkillFile('animated-character-creator.md'),
    director: {
      file: officialSkillFile('animated-character-creator/director.md'),
      // Every style line Olmo's brief can carry. "style: 2d flat" is no longer
      // offered, but Director still has its rules, so a brief with it loads them.
      markers: [
      'style: animated character',
      'style: game hero',
      'style: cinematic anime',
      'style: fantasy anime',
      'style: 3d chibi',
      'style: storybook anime',
      'style: pixar 3d',
      'style: 2d flat',
      'style: claymation',
      'style: cute claymation',
      'style: 3d family film',
      'style: 3d movie drama',
    ],
    },
    showcase: {
      imageUrl: '/creative/avatars/animated-character.jpg',
      bestFor: ['Mascots', 'Game heroes', 'Anime'],
      starterPrompt: 'Create an animated character for my ads',
    },
  },
  {
    slug: 'tvc-character-creator',
    name: 'TVC character creator',
    description: 'Use when the user wants a new reusable polished lead actor for TV-commercial style ads, with a full character reference sheet — not a candid UGC creator or an animated character.',
    file: officialSkillFile('tvc-character-creator.md'),
    director: { file: officialSkillFile('tvc-character-creator/director.md'), markers: ['style: tvc'] },
    showcase: {
      imageUrl: '/creative/avatars/tvc-character.jpg',
      bestFor: ['TV commercials', 'Brand films', 'Premium ads'],
      starterPrompt: 'Create a TVC actor for my brand',
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

export interface OfficialSkillManifest {
  name: string;
  description: string;
  body: string;
  references?: Record<string, string>;
  directorMarkers?: string[];
}

/** Mirrors the shape the import worker writes to skill_versions.manifest — see
 *  worker-handlers/handlers/skillImport.ts's manifestWithBody — plus, for a
 *  skill with a Director half, its director.md and marker. */
export function buildSkillManifest(name: string, description: string, body: string, director?: { text: string; markers: string[] }): OfficialSkillManifest {
  if (!director) return { name, description, body };
  return { name, description, body, references: { 'director.md': director.text }, directorMarkers: director.markers };
}

/** True when the stored manifest already holds exactly this content. */
export function manifestUnchanged(stored: unknown, next: OfficialSkillManifest): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const s = stored as Record<string, unknown>;
  return s.body === next.body
    && JSON.stringify(s.references ?? null) === JSON.stringify(next.references ?? null)
    && JSON.stringify(s.directorMarkers ?? null) === JSON.stringify(next.directorMarkers ?? null);
}

async function run(): Promise<void> {
  for (const entry of OFFICIAL_SKILLS) {
    const body = readSkillBody(entry.file);
    const director = entry.director ? { text: readSkillBody(entry.director.file), markers: entry.director.markers } : undefined;
    const manifest = buildSkillManifest(entry.name, entry.description, body, director);

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

      if (!latest || !manifestUnchanged(latest.manifest, manifest)) {
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
        await tx.update(skillInstalls).set({ installedVersion: nextVersion }).where(eq(skillInstalls.skillId, skill.id));
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
