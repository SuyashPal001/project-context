export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    skillTags: string[];
    isOfficial: boolean;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    exampleAssetUrl2: string | null;
    exampleCaption2: string | null;
    defaultModel: string | null;
}

export interface PersonaDetail extends PersonaSummary {
    basePersonality: string;
    status: 'draft' | 'published';
}

export interface PersonasResponse {
    personas: PersonaDetail[];
}
