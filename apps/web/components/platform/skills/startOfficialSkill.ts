import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Skill } from "./types";

/** Minimal shape of the router this needs — accepts both the App Router
 *  instance and a plain test double. */
interface RouterLike {
    push: (url: string) => void;
}

/** Minimal shape of a react-query QueryClient this needs — accepts both the
 *  real instance and a plain test double. */
interface QueryClientLike {
    invalidateQueries: (filters: { queryKey: unknown[] }) => unknown;
}

/**
 * Installs (or re-installs, moving the tenant's install to the latest
 * version — POST /skills/:id/install is idempotent) an Official skill.
 * Shows a toast and returns false on failure; callers must not proceed
 * (send/navigate) when this returns false, so the user isn't dropped into a
 * chat that silently doesn't have the skill.
 *
 * When `queryClient` is passed, a successful install invalidates
 * `['skills', 'installed']` (the "/" palette, the attach picker) and
 * `['skills']` (the Skills page lists), so a freshly-installed/updated
 * Official skill shows up immediately instead of waiting on the next
 * unrelated refetch. `queryClient` is optional — a caller with no
 * QueryClient in scope keeps working exactly as before.
 */
export async function installOfficialSkill(
    skill: Pick<Skill, "id" | "name">,
    queryClient?: QueryClientLike,
): Promise<boolean> {
    try {
        await api.post(`/api/v1/skills/${skill.id}/install`);
        queryClient?.invalidateQueries({ queryKey: ["skills", "installed"] });
        queryClient?.invalidateQueries({ queryKey: ["skills"] });
        return true;
    } catch {
        toast.error(`Failed to start "${skill.name}".`);
        return false;
    }
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
    queryClient?: QueryClientLike,
): Promise<void> {
    const installed = await installOfficialSkill(skill, queryClient);
    if (!installed) return;

    const prompt = skill.showcase?.starterPrompt ?? `Use the ${skill.name} skill`;
    router.push(
        `/${tenantSlug}/dashboard/chat?prompt=${encodeURIComponent(prompt)}&skill=${skill.id}&skillName=${encodeURIComponent(skill.name)}`,
    );
}
