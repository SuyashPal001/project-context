import { installOfficialSkill } from "./startOfficialSkill";
import type { Skill } from "./types";

/**
 * Shared "Create with AI" logic for the avatar picker's two CreativeEmptyState
 * sites (existing chat and the pre-conversation draft). Installs the Official
 * Avatar creator skill first, same as Start's contract — every call installs,
 * so it always moves the tenant's install to the latest version — then
 * returns the `skillsUsed` to attach to the seeded CREATE_AVATAR_PROMPT
 * message. Deliberately does not touch the prompt text itself: both sites
 * keep sending only CREATE_AVATAR_PROMPT, never a showcase starter prompt or
 * the creative brief.
 *
 * Returns:
 * - `undefined` when the Official skill isn't seeded — callers send/stage
 *   exactly like today, with no skillsUsed.
 * - `Array<{ id, name }>` on a successful install.
 * - `null` when install failed (already toasted) — callers must abort
 *   without sending, so the user isn't dropped into a chat that silently
 *   doesn't have the skill.
 */
export async function resolveCreateAvatarSkillsUsed(
    skill: Pick<Skill, "id" | "name"> | undefined,
): Promise<Array<{ id: string; name: string }> | undefined | null> {
    if (!skill) return undefined;

    const installed = await installOfficialSkill(skill);
    if (!installed) return null;

    return [{ id: skill.id, name: skill.name }];
}
