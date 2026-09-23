export interface CreativeAvatar {
    id: string;
    name: string;
    role: string;
    tone: string;
    image: string;
    // The real uuid of this preset's creative_library_assets row (Task 3's
    // seed) — passed directly as attachment.fileId, no upload round-trip.
    // Fixed values, must match products/agent-platform/packages/api/seeds/creative-library-assets.ts's AVATAR_ASSETS exactly.
    assetId: string;
}

// Original synthetic portrait presets. These are still images, not generated videos.
export const CREATIVE_AVATARS: readonly CreativeAvatar[] = [
    { id: 'everyday-creator', name: 'Mira', role: 'Everyday creator', tone: 'Casual', image: '/creative/avatars/everyday-creator.jpg', assetId: '557e5751-adbb-4b4e-8b08-8e426e0ffcf5' },
    { id: 'tech-presenter', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', image: '/creative/avatars/tech-presenter.jpg', assetId: '8b6e9254-cc47-492c-bdc7-557ac6302e01' },
    { id: 'beauty-creator', name: 'Hana', role: 'Beauty creator', tone: 'Natural', image: '/creative/avatars/beauty-creator.jpg', assetId: '7df4d729-3611-4b15-8c49-ca691f2001b5' },
    { id: 'fitness-host', name: 'Samir', role: 'Fitness host', tone: 'Upbeat', image: '/creative/avatars/fitness-host-gym.jpg', assetId: '5f328586-1b58-4bf6-af32-de4d4b3dc14d' },
    { id: 'lifestyle-creator', name: 'Priya', role: 'Lifestyle creator', tone: 'Friendly', image: '/creative/avatars/lifestyle-creator-home.jpg', assetId: '90e08f84-458e-472f-8c04-8da7860d2afe' },
    { id: 'friendly-storyteller', name: 'Mateo', role: 'Friendly storyteller', tone: 'Conversational', image: '/creative/avatars/friendly-storyteller.jpg', assetId: '78d215f5-5a6d-43f2-acac-4de02611dea4' },
];
