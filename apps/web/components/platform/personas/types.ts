export interface PersonaAnimationStates {
    idle: string;
    waving: string;
    running: string;
    thinking: string;
    responding: string;
    waiting: string;
    review: string;
    done: string;
    failed: string;
}

export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    animationStates: PersonaAnimationStates | null;
    skillTags: string[];
    isOfficial: boolean;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
}

export interface PersonaDetail extends PersonaSummary {
    basePersonality: string;
    status: 'draft' | 'published';
}

export interface PersonasResponse {
    personas: PersonaDetail[];
}
