/**
 * Seeds the platform-owned Official skills: the character creators, Talking
 * head, and the ad flows (UGC character, template video, first frame,
 * animated story, short-drama stitch).
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
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { skillInstalls, skills, skillVersions } from '@serverless-saas/agent-schema/skills';

export interface SkillShowcase {
  imageUrl: string;
  /** Optional example video; the detail modal plays it with imageUrl as poster. */
  videoUrl?: string;
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
  /** Slugs this skill was seeded under before. The seed renames that row in
   *  place, so tenant installs and version history carry over instead of a
   *  second copy of the skill appearing. */
  previousSlugs?: string[];
}

const SEEDS_DIR = dirname(fileURLToPath(import.meta.url));
const officialSkillFile = (name: string) => join(SEEDS_DIR, 'official-skills', name);

export const OFFICIAL_SKILLS: OfficialSkillSeed[] = [
  {
    slug: 'ugc-avatar-creator',
    name: 'UGC avatar creator',
    previousSlugs: ['avatar-creator'],
    description: 'Use when the user wants a new reusable AI presenter/avatar for their ads, from a description or from a reference photo.',
    file: officialSkillFile('ugc-avatar-creator.md'),
    director: { file: officialSkillFile('ugc-avatar-creator/director.md'), markers: ['style: realistic avatar'] },
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
    director: { file: officialSkillFile('talking-head/director.md'), markers: ['flow: talking head'] },
    showcase: {
      // A real talking-head made by this skill (Minjun, natural speech, clips
      // chained from the last frame) — the old glamour still wasn't one.
      imageUrl: '/creative/skills/talking-head-example.jpg',
      videoUrl: '/creative/skills/talking-head-example.mp4',
      bestFor: ['Product explainers', 'Testimonials', 'Announcements'],
      starterPrompt: 'Make a talking-head ad for my product',
    },
  },
  {
    slug: 'ugc-character-ad',
    name: 'UGC character ad',
    description: 'Use when the user wants a photoreal UGC-style ad built from scratch, with several distinct beats or shots in a storyboard — not one presenter reading one script, not an animated look, not a template clone.',
    file: officialSkillFile('ugc-character-ad.md'),
    showcase: {
      imageUrl: '/creative/skills/ugc-character-ad.jpg',
      bestFor: ['UGC ads', 'Storyboards', 'Product reviews'],
      starterPrompt: 'Make a UGC ad for my product',
    },
  },
  {
    slug: 'template-video',
    name: 'Template video',
    description: 'Use when the user wants to clone or recreate a reference ad\'s structure onto their own product — "clone this ad", "make a video like this template".',
    file: officialSkillFile('template-video.md'),
    showcase: {
      imageUrl: '/creative/skills/template-video.jpg',
      bestFor: ['Proven ad formats', 'Fast variations', 'Product demos'],
      starterPrompt: 'Make a video like this template for my product',
    },
  },
  {
    slug: 'ugc-first-frame',
    name: 'UGC first frame',
    description: 'Use when the user already has a finished still image — their own photo, a brand asset or an approved still — and wants that one frame animated into a short clip, with no storyboard, narration or lip-sync.',
    file: officialSkillFile('ugc-first-frame.md'),
    director: { file: officialSkillFile('ugc-first-frame/director.md'), markers: ['flow: first frame'] },
    showcase: {
      imageUrl: '/creative/skills/ugc-first-frame.jpg',
      bestFor: ['Photo to video', 'Quick clips', 'Brand assets'],
      starterPrompt: 'Animate this photo into a short ad',
    },
  },
  {
    slug: 'animation-character-ad',
    name: 'Animated story ad',
    description: 'Use when the user wants a stylized, animated or cartoon-look story ad built from scratch, with a short story arc — not a photoreal UGC ad and not a template clone.',
    file: officialSkillFile('animation-character-ad.md'),
    director: { file: officialSkillFile('animation-character-ad/director.md'), markers: ['flow: animation character ad'] },
    showcase: {
      imageUrl: '/creative/skills/animation-character-ad.jpg',
      bestFor: ['Animated ads', 'Mascot stories', 'Kids & family'],
      starterPrompt: 'Make an animated story ad for my brand',
    },
  },
  {
    slug: 'short-drama-stitch',
    name: 'Short-drama stitch',
    description: 'Use when the user already has video footage — episode clips, several takes, raw b-roll — and wants it cut down into an ad, never generating new video.',
    file: officialSkillFile('short-drama-stitch.md'),
    director: { file: officialSkillFile('short-drama-stitch/director.md'), markers: ['flow: short drama stitch'] },
    showcase: {
      imageUrl: '/creative/skills/short-drama-stitch.jpg',
      bestFor: ['Existing footage', 'Short dramas', 'Recuts'],
      starterPrompt: 'Cut my footage into a short ad',
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
      if (entry.previousSlugs?.length) {
        const [current] = await tx
          .select({ id: skills.id })
          .from(skills)
          .where(and(isNull(skills.ownerTenantId), eq(skills.slug, entry.slug)))
          .limit(1);
        if (!current) {
          const renamed = await tx
            .update(skills)
            .set({ slug: entry.slug, updatedAt: new Date() })
            .where(and(isNull(skills.ownerTenantId), inArray(skills.slug, entry.previousSlugs)))
            .returning({ id: skills.id });
          if (renamed.length) console.log(`[seed:official-skills] renamed ${entry.previousSlugs.join(', ')} to ${entry.slug}`);
        }
      }

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
