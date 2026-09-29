import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Skill } from "./types";

/** Minimal shape of the router this needs — accepts both the App Router
 *  instance and a plain test double. */
interface RouterLike {
    push: (url: string) => void;
}

/**
 * Runs an Official skill's "Start" action: installs (or re-installs, moving the
 * tenant's install to the latest version — POST /skills/:id/install is
 * idempotent) and then opens a fresh chat seeded with the showcase's starter
 * prompt, carrying `?skill=`/`?skillName=` so the seeded first message threads
 * `skillsUsed: [{ id, name }]` through chat/page.tsx's existing seeded-prompt
 * effect. Always installs first, even for a tenant that already has this
 * skill — that's what moves an outdated install to v2+ on Start. A failed
 * install shows a toast and never navigates, so the user isn't dropped into a
 * chat that silently doesn't have the skill.
 */
export async function startOfficialSkill(
    skill: Pick<Skill, "id" | "name" | "showcase">,
    tenantSlug: string,
    router: RouterLike,
): Promise<void> {
    try {
        await api.post(`/api/v1/skills/${skill.id}/install`);
    } catch {
        toast.error(`Failed to start "${skill.name}".`);
        return;
    }

    const prompt = skill.showcase?.starterPrompt ?? `Use the ${skill.name} skill`;
    router.push(
        `/${tenantSlug}/dashboard/chat?prompt=${encodeURIComponent(prompt)}&skill=${skill.id}&skillName=${encodeURIComponent(skill.name)}`,
    );
}
