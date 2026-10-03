export const CREATIVE_VOICE_ARTWORK: Readonly<Record<string, string>> = {
    Lauren: '/creative/voices/lauren-cover.jpg',
    Cathy: '/creative/voices/cathy-cover.jpg',
    Nandi: '/creative/voices/nandi-cover.jpg',
    Carson: '/creative/voices/carson-cover.jpg',
    Corey: '/creative/voices/corey-cover.jpg',
    Connie: '/creative/voices/connie-cover.jpg',
    Theo: '/creative/voices/theo-cover.jpg',
    Asher: '/creative/voices/asher-cover.jpg',
};

const CARTESIA_VOICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cartesia voices have photo covers by name; Gemini voices have generated
// abstract covers bundled next to their preview clips.
export function creativeVoiceArtwork(name: string, id?: string): string | undefined {
    if (id && !CARTESIA_VOICE_ID.test(id) && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return `/creative/voices/gemini/${id}/cover.jpg`;
    return CREATIVE_VOICE_ARTWORK[name];
}
