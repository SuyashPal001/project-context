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

export function creativeVoiceArtwork(name: string): string | undefined {
    return CREATIVE_VOICE_ARTWORK[name];
}
