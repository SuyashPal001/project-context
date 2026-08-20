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
    ownerTenantId: string;
    createdAt: string;
    /** skill_installs.id — the FK agentSkills.installId points at. Null when this tenant has never installed the skill. */
    installId: string | null;
    installedVersion: number | null;
    installed: boolean;
    /** Status of the newest skill_versions row, so a failed import is distinguishable from one still running. */
    latestVersionStatus: SkillVersionStatus | null;
    failureReason: string | null;
}

export interface SkillsResponse {
    data: Skill[];
}

/** "installed" is not a visible dashboard tab — it's the attach picker's view of the tenant's install library, which spans skills owned by other tenants. */
export type SkillTab = "mine" | "official" | "public" | "installed";
