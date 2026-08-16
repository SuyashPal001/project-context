export interface PersonaAnimationStates {
    idle: string;
    thinking: string;
    responding: string;
}

export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    animationStates: PersonaAnimationStates | null;
    skillTags: string[];
    isOfficial: boolean;
}

export interface PersonaDetail extends PersonaSummary {
    basePersonality: string;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    status: 'draft' | 'published';
}

export interface PersonasResponse {
    personas: PersonaDetail[];
}
