export type SkillVisibility = "private" | "public";

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
    installedVersion: number | null;
    installed: boolean;
}

export interface SkillsResponse {
    data: Skill[];
}

export type SkillTab = "mine" | "official" | "public";
