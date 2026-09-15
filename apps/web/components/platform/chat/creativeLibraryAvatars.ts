export interface CreativeAvatar {
    id: string;
    name: string;
    role: string;
    tone: string;
    image: string;
}

// Original synthetic portrait presets. These are still images, not generated videos.
export const CREATIVE_AVATARS: readonly CreativeAvatar[] = [
    { id: 'everyday-creator', name: 'Mira', role: 'Everyday creator', tone: 'Casual', image: '/creative/avatars/everyday-creator.jpg' },
    { id: 'tech-presenter', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', image: '/creative/avatars/tech-presenter.jpg' },
    { id: 'beauty-creator', name: 'Hana', role: 'Beauty creator', tone: 'Natural', image: '/creative/avatars/beauty-creator.jpg' },
    { id: 'fitness-host', name: 'Samir', role: 'Fitness host', tone: 'Upbeat', image: '/creative/avatars/fitness-host-gym.jpg' },
    { id: 'lifestyle-creator', name: 'Priya', role: 'Lifestyle creator', tone: 'Friendly', image: '/creative/avatars/lifestyle-creator-home.jpg' },
    { id: 'friendly-storyteller', name: 'Mateo', role: 'Friendly storyteller', tone: 'Conversational', image: '/creative/avatars/friendly-storyteller.jpg' },
];
