export interface CuratedVoice {
    name: string;
    tagline: string;
    previewAsset?: string;
}

// Specific public voices reviewed for the creative library. The name and
// tagline pair matters: the catalog contains distinct voices with the same
// name (including several Carson variants).
export const CURATED_VOICES: readonly CuratedVoice[] = [
    { name: 'Lauren', tagline: 'Lively Narrator', previewAsset: '/creative/voices/lauren-lively-narrator.wav' },
    { name: 'Cathy', tagline: 'Coworker' },
    { name: 'Nandi', tagline: 'Poised Concierge', previewAsset: '/creative/voices/nandi-poised-concierge.wav' },
    { name: 'Carson', tagline: 'Curious Conversationalist' },
    { name: 'Corey', tagline: 'Supportive Buddy' },
    { name: 'Connie', tagline: 'Candid Conversationalist' },
    { name: 'Theo', tagline: 'Modern Narrator' },
    { name: 'Asher', tagline: 'Podcaster' },
];

export function findCuratedVoice(voice: Pick<CuratedVoice, 'name' | 'tagline'>): CuratedVoice | undefined {
    return CURATED_VOICES.find(item =>
        item.name.toLowerCase() === voice.name.toLowerCase()
        && item.tagline.toLowerCase() === voice.tagline.toLowerCase()
    );
}
