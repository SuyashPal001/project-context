import { useQuery } from "@tanstack/react-query";
import { listSkills } from "./actions";
import type { Skill } from "./types";

/**
 * Looks up one Official skill by slug from the same ['skills','official']
 * query the Skills page's Explore tab uses — react-query dedupes/shares the
 * cache entry, so this doesn't issue an extra request when that page is also
 * mounted. Returns undefined while loading, on error, and when no Official
 * skill with this slug is seeded; callers fall back to today's behaviour in
 * that case.
 */
export function useOfficialSkill(slug: string): Skill | undefined {
    const { data } = useQuery<Skill[]>({
        queryKey: ["skills", "official"],
        queryFn: () => listSkills("official"),
    });
    return data?.find((skill) => skill.slug === slug);
}
