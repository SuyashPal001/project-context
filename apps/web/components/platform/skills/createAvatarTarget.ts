import type { Skill } from "./types";
import { installOfficialSkill } from "./startOfficialSkill";

export type AvatarKind = "UGC" | "Animation" | "TVC";

export const AVATAR_SKILL_SLUGS: Record<AvatarKind, string> = {
    UGC: "ugc-avatar-creator",
    Animation: "animated-character-creator",
    TVC: "tvc-character-creator",
};

const PROMPTS: Record<AvatarKind, string> = {
    UGC: "Create a new avatar for my ads",
    Animation: "Create an animated character for my ads",
    TVC: "Create a TVC actor for my brand",
};

/**
 * What "Create with AI" in the avatar picker starts, from the filter chip the
 * user is on. A chip picks its own skill and opening prompt. "All" (null)
 * says nothing about the kind, so all three avatar skills are turned on and
 * Olmo asks which kind first (platformAgent's OFFICIAL_SKILL_POINTERS).
 */
export function createAvatarTarget(kind: AvatarKind | null): { slugs: string[]; prompt: string } {
    if (kind === null) return { slugs: Object.values(AVATAR_SKILL_SLUGS), prompt: PROMPTS.UGC };
    return { slugs: [AVATAR_SKILL_SLUGS[kind]], prompt: PROMPTS[kind] };
}

/**
 * Installs each seeded skill (same contract as resolveCreateAvatarSkillsUsed)
 * and returns the skillsUsed to attach. `undefined` when none is seeded,
 * `null` when an install failed (already toasted) — callers abort then.
 */
export async function resolveSkillsUsed(
    skills: Array<Pick<Skill, "id" | "name"> | undefined>,
): Promise<Array<{ id: string; name: string }> | undefined | null> {
    const seeded = skills.filter((s): s is Pick<Skill, "id" | "name"> => Boolean(s));
    if (seeded.length === 0) return undefined;
    for (const skill of seeded) {
        if (!(await installOfficialSkill(skill))) return null;
    }
    return seeded.map((s) => ({ id: s.id, name: s.name }));
}
