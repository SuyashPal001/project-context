export type SkillVisibility = "private" | "public";

export type SkillVersionStatus = "pending" | "ready" | "failed";

export interface Skill {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    visibility: SkillVisibility;
    isOfficial: boolean;
    latestVersion: number;
    /** Null for an Official skill — those are platform-owned, not tenant-owned. */
    ownerTenantId: string | null;
    /** Display name of the user who created the skill. Null if the creator row is gone, or for an Official skill. */
    ownerName: string | null;
    /** Creator's email — only populated for the owning tenant; null cross-tenant, and for an Official skill. */
    ownerEmail: string | null;
    createdAt: string;
    updatedAt: string;
    /** skill_installs.id — the FK agentSkills.installId points at. Null when this tenant has never installed the skill. */
    installId: string | null;
    installedVersion: number | null;
    installed: boolean;
    /** Status of the newest skill_versions row, so a failed import is distinguishable from one still running. */
    latestVersionStatus: SkillVersionStatus | null;
    failureReason: string | null;
    /** Full SKILL.md body (frontmatter stripped), stored at import time. Only returned by GET /skills/:id, and only once the latest version is 'ready' — absent (not just null) on list responses. */
    body?: string | null;
    /** Times a chat message ran with this skill attached, for THIS tenant only (skill_installs.run_count). 0 when never installed. */
    runCount: number;
    /** Times this skill has been installed, counted globally across all tenants (skills.download_count). */
    downloadCount: number;
    /** Curated showcase content for an Official skill's card/detail view. Null/absent for a
     *  community or private skill, or an Official skill that hasn't been curated yet — the
     *  caller falls back to the plain community-style card in that case. */
    showcase?: {
        imageUrl: string;
        bestFor: string[];
        starterPrompt: string;
        /** Optional showcase video — when present, the detail modal plays this (muted,
         *  looping) instead of the static image, using imageUrl as the <video> poster. */
        videoUrl?: string;
    } | null;
}

export interface SkillsResponse {
    data: Skill[];
}

/** One file inside a skill package, from GET /skills/:id/files. Read-only listing. */
export interface SkillFile {
    fileName: string;
    size: number;
}

/** "installed" is not a visible dashboard tab — it's the attach picker's view of the tenant's install library, which spans skills owned by other tenants. */
export type SkillTab = "mine" | "official" | "public" | "installed";
