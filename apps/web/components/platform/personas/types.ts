export interface PersonaSummary {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    category: 'engineering' | 'product' | 'research' | 'creative';
    skillTags: string[];
    isOfficial: boolean;
    exampleAssetUrl: string | null;
    exampleCaption: string | null;
    exampleAssetUrl2: string | null;
    exampleCaption2: string | null;
    defaultModel: string | null;
    /** Hand-authored per persona (see personas.suggested_prompts). null when
     *  not yet authored for this persona — callers fall through to a
     *  per-agent-type or generic fallback in that case. */
    suggestedPrompts: Array<{ icon: string; label: string; promptText: string }> | null;
}

export interface PersonaDetail extends PersonaSummary {
    basePersonality: string;
    status: 'draft' | 'published';
}

export interface PersonasResponse {
    personas: PersonaDetail[];
}
