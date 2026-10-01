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
    // Picker filter chip. Omitted on the original UGC presenters.
    category?: AvatarCategory;
}

export type AvatarCategory = 'UGC' | 'Animation' | 'TVC';
export const AVATAR_CATEGORIES: readonly AvatarCategory[] = ['UGC', 'Animation', 'TVC'];
export const avatarCategory = (avatar: { category?: string | null }): AvatarCategory =>
    avatar.category === 'Animation' || avatar.category === 'TVC' ? avatar.category : 'UGC';

// Original synthetic portrait presets. These are still images, not generated videos.
export const CREATIVE_AVATARS: readonly CreativeAvatar[] = [
    { id: 'everyday-creator', name: 'Mira', role: 'Everyday creator', tone: 'Casual', image: '/creative/avatars/everyday-creator.jpg', assetId: '557e5751-adbb-4b4e-8b08-8e426e0ffcf5' },
    { id: 'tech-presenter', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', image: '/creative/avatars/tech-presenter.jpg', assetId: '8b6e9254-cc47-492c-bdc7-557ac6302e01' },
    { id: 'beauty-creator', name: 'Hana', role: 'Beauty creator', tone: 'Natural', image: '/creative/avatars/beauty-creator.jpg', assetId: '7df4d729-3611-4b15-8c49-ca691f2001b5' },
    { id: 'fitness-host', name: 'Samir', role: 'Fitness host', tone: 'Upbeat', image: '/creative/avatars/fitness-host-gym.jpg', assetId: '5f328586-1b58-4bf6-af32-de4d4b3dc14d' },
    { id: 'lifestyle-creator', name: 'Priya', role: 'Lifestyle creator', tone: 'Friendly', image: '/creative/avatars/lifestyle-creator-home.jpg', assetId: '90e08f84-458e-472f-8c04-8da7860d2afe' },
    { id: 'friendly-storyteller', name: 'Mateo', role: 'Friendly storyteller', tone: 'Conversational', image: '/creative/avatars/friendly-storyteller.jpg', assetId: '78d215f5-5a6d-43f2-acac-4de02611dea4' },
    { id: 'family-lifestyle-presenter', name: 'Anjali', role: 'Family lifestyle presenter', tone: 'Warm', image: '/creative/avatars/family-lifestyle-presenter.jpg', assetId: 'e75a419c-34e0-4956-9dde-31056dab21ed' },
    { id: 'senior-lifestyle-presenter', name: 'Elena', role: 'Senior lifestyle presenter', tone: 'Warm', image: '/creative/avatars/senior-lifestyle-presenter.jpg', assetId: '381d46e9-2e90-48f7-8f7d-4cf2c192c6dc' },
    { id: 'hair-wellness-educator', name: 'Meera', role: 'Hair & wellness educator', tone: 'Reassuring', image: '/creative/avatars/hair-wellness-educator.jpg', assetId: '11fff9df-63d4-4af1-bf90-25b6cb063899' },
    { id: 'travel-property-host', name: 'Marco', role: 'Travel & property host', tone: 'Relaxed', image: '/creative/avatars/travel-property-host.jpg', assetId: '46bc2640-97bf-4d75-b0fb-4d67a284fb33' },
    { id: 'music-producer-host', name: 'Naina', role: 'Music producer / livestream host', tone: 'Confident', image: '/creative/avatars/music-producer-host.jpg', assetId: 'b0d82af5-b504-4b87-9ae5-bbf23652ecdd' },
    { id: 'menswear-consultant', name: 'Rehaan', role: 'Menswear consultant', tone: 'Polished', image: '/creative/avatars/menswear-consultant.jpg', assetId: '3852c952-b308-44e4-ba30-57bc84cd7de6' },
    { id: 'travel-journalist', name: 'Ishita', role: 'Travel journalist', tone: 'Thoughtful', image: '/creative/avatars/travel-journalist.jpg', assetId: '41c09ed3-409c-4ed8-992c-faac13d80617' },
    { id: 'hardware-repair-reviewer', name: 'Callum', role: 'Hardware repair reviewer', tone: 'Practical', image: '/creative/avatars/hardware-repair-reviewer.jpg', assetId: '6e45da5d-1681-4fa1-a6b5-6e8032bcbe97' },
    { id: 'voiceover-audio-educator', name: 'Minjun', role: 'Voiceover & audio educator', tone: 'Thoughtful', image: '/creative/avatars/voiceover-audio-educator.jpg', assetId: 'd66f1008-113e-4853-96d9-84e975c29f9c' },
    { id: 'cosmetic-formulation-educator', name: 'Yuki', role: 'Cosmetic formulation educator', tone: 'Calm', image: '/creative/avatars/cosmetic-formulation-educator.jpg', assetId: '6328c470-6b46-400e-942c-ce37dbb79011' },
    { id: 'remote-project-consultant', name: 'Lucas', role: 'Remote project consultant', tone: 'Composed', image: '/creative/avatars/remote-project-consultant.jpg', assetId: 'eb56ba28-6a33-4e06-9745-24801b8fd265' },
    { id: 'customer-support-lead', name: 'Kevin', role: 'Customer support lead', tone: 'Capable', image: '/creative/avatars/customer-support-lead.jpg', assetId: 'e02dafab-2ada-45a5-a7cb-684564c0e1ed' },
    { id: 'cybersecurity-educator', name: 'Arnav', role: 'Cybersecurity educator', tone: 'Calm', image: '/creative/avatars/cybersecurity-educator.jpg', assetId: '96bbd8d3-5a1d-49e3-8090-e5b065969efc' },
    { id: 'partnerships-director', name: 'Alessandro', role: 'Partnerships director', tone: 'Engaged', image: '/creative/avatars/partnerships-director.jpg', assetId: '6dbe7b7c-c541-4760-8d40-17f6706dbebf' },
    { id: 'home-organization-creator', name: 'Divya', role: 'Home organization creator', tone: 'Playful', image: '/creative/avatars/home-organization-creator.jpg', assetId: '693d9a44-e1b2-4f1a-a551-18bb2dc0a5b6' },
    { id: 'career-coach', name: 'Haruto', role: 'Career coach', tone: 'Friendly', image: '/creative/avatars/career-coach.jpg', assetId: 'a4023a8f-145d-4dfc-9f72-2f8cf5fbb955' },
    { id: 'architectural-designer', name: 'Théo', role: 'Architectural designer', tone: 'Relaxed', image: '/creative/avatars/architectural-designer.jpg', assetId: '40f3f3e6-2d54-45b3-9d62-7e69a66d4bf6' },
    { id: 'creative-workshop-facilitator', name: 'Reema', role: 'Creative workshop facilitator', tone: 'Welcoming', image: '/creative/avatars/creative-workshop-facilitator.jpg', assetId: '9f1287bb-74ac-4dca-ab8e-3e30b4b98e4e' },
    { id: 'leadership-coach', name: 'Malcolm', role: 'Leadership coach', tone: 'Composed', image: '/creative/avatars/leadership-coach.jpg', assetId: 'bf601fd6-1996-4b16-a388-b320e4c4b2d5' },
    { id: 'financial-literacy-educator', name: 'Salvatore', role: 'Financial literacy educator', tone: 'Trusted', image: '/creative/avatars/financial-literacy-educator.jpg', assetId: '20c3b82c-a120-4414-8754-6bd0af541219' },
    { id: 'product-onboarding-specialist', name: 'Andre', role: 'Product onboarding specialist', tone: 'Attentive', image: '/creative/avatars/product-onboarding-specialist.jpg', assetId: '2b066f48-6249-4b52-bab8-a6a1338352ee' },
    { id: 'skincare-routine-educator', name: 'Simone', role: 'Skincare routine educator', tone: 'Candid', image: '/creative/avatars/skincare-routine-educator.jpg', assetId: '6017685b-7ec1-4a7b-9b64-a8b01e052d27' },
    { id: 'heritage-travel-host', name: 'Lakshmi', role: 'Heritage travel host', tone: 'Grounded', image: '/creative/avatars/heritage-travel-host.jpg', assetId: '06419d1b-1326-4566-aa47-3293fc4bde89' },
    { id: 'regional-cooking-educator', name: 'Sunita', role: 'Regional cooking educator', tone: 'Knowledgeable', image: '/creative/avatars/regional-cooking-educator.jpg', assetId: 'adc67be2-b2fa-45b6-a7d4-93f63e54b3d1' },
    { id: 'gemstone-appraiser', name: 'Vikram', role: 'Gemstone appraiser', tone: 'Trustworthy', image: '/creative/avatars/gemstone-appraiser.jpg', assetId: '6b94d81c-d4fc-49a6-ac12-7dfee41dd816' },
    { id: 'interior-design-consultant', name: 'Diego', role: 'Interior design consultant', tone: 'Cultured', image: '/creative/avatars/interior-design-consultant.jpg', assetId: '2118e1af-549b-4abc-81e9-f4d5a35473c5' },
    { id: 'beginner-fitness-instructor', name: 'Marisol', role: 'Beginner fitness instructor', tone: 'Energetic', image: '/creative/avatars/beginner-fitness-instructor.jpg', assetId: 'c1953627-d2ab-4e2b-ae04-312ab6ac9227' },
    { id: 'cricket-coach', name: 'Marcus', role: 'Cricket coach', tone: 'Energetic', image: '/creative/avatars/cricket-coach.jpg', assetId: 'e9a94a5b-1cec-43f3-832e-e4ebeaeaa87c' },
    { id: 'personal-finance-explainer', name: 'Pooja', role: 'Personal finance explainer', tone: 'Witty', image: '/creative/avatars/personal-finance-explainer.jpg', assetId: 'bb191ec5-ff78-480a-8717-c1d0a4dfa2e7' },
    { id: 'cultural-history-educator', name: 'Ashok', role: 'Cultural history educator', tone: 'Grounded', image: '/creative/avatars/cultural-history-educator.jpg', assetId: 'fb612a23-8291-483d-9b55-f737cd09b146' },
    { id: 'electronics-repair-educator', name: 'Jerome', role: 'Electronics repair educator', tone: 'Focused', image: '/creative/avatars/electronics-repair-educator.jpg', assetId: 'e313e54f-08d8-4db5-a801-2f909392bccd' },
    { id: 'community-health-educator', name: 'Naomi', role: 'Community health educator', tone: 'Credible', image: '/creative/avatars/community-health-educator.jpg', assetId: '7685839d-ee23-417d-b754-dfa04d3a7207' },
    { id: 'community-legal-advisor', name: 'Jaspreet', role: 'Community legal advisor', tone: 'Trustworthy', image: '/creative/avatars/community-legal-advisor.jpg', assetId: 'cc293484-0dba-4978-a981-e8047254f88e' },
    { id: 'motion-graphics-designer', name: 'Mia', role: 'Motion graphics designer', tone: 'Creative', image: '/creative/avatars/motion-graphics-designer.jpg', assetId: 'b63f1e13-8cfd-4dfd-9cbf-73e251b78feb' },
    { id: 'urban-gardening-advisor', name: 'Carmen', role: 'Urban gardening advisor', tone: 'Earthy', image: '/creative/avatars/urban-gardening-advisor.jpg', assetId: '685a0b07-24f2-45b3-a80e-f7f59068f46d' },
    { id: 'temple-history-educator', name: 'Radha', role: 'Temple history educator', tone: 'Scholarly', image: '/creative/avatars/temple-history-educator.jpg', assetId: '8e5d85ad-4826-4522-9f47-0abdce8f1ba3' },
    { id: 'beauty-skincare-presenter', name: 'Anaya', role: 'Beauty & skincare presenter', tone: 'Confident', image: '/creative/avatars/beauty-skincare-presenter.jpg', assetId: 'df9bf7e5-254a-40ee-86c6-8dcefce41ba0' },
    { id: 'fitness-running-host', name: 'Simran', role: 'Fitness & running host', tone: 'Direct', image: '/creative/avatars/fitness-running-host.jpg', assetId: 'd57ad98b-768c-4b58-b90e-fadb672e5530' },
    { id: 'eyewear-lifestyle-creator', name: 'Aiko', role: 'Eyewear lifestyle creator', tone: 'Assured', image: '/creative/avatars/eyewear-lifestyle-creator.jpg', assetId: '80464ff4-830b-4ef1-a215-a516387613f9' },
    { id: 'audio-music-creator', name: 'Zuri', role: 'Audio & music creator', tone: 'Friendly', image: '/creative/avatars/audio-music-creator.jpg', assetId: '95c565b5-03ea-4613-9492-b066c948c7ce' },
    { id: 'fragrance-beauty-presenter', name: 'Ayesha', role: 'Fragrance & beauty presenter', tone: 'Composed', image: '/creative/avatars/fragrance-beauty-presenter.jpg', assetId: '42bf72b6-0b14-4f2d-b46f-58079f876110' },
    { id: 'outdoor-adventure-host', name: 'Sofia', role: 'Outdoor adventure host', tone: 'Capable', image: '/creative/avatars/outdoor-adventure-host.jpg', assetId: '76a7ca61-cf55-46e8-8510-0bb488b25933' },
    { id: 'menswear-style-presenter', name: 'Karan', role: 'Menswear style presenter', tone: 'Composed', image: '/creative/avatars/menswear-style-presenter.jpg', assetId: '301f60ef-e630-4cd5-9528-75594d106099' },
    { id: 'fashion-accessories-presenter', name: 'Mila', role: 'Fashion accessories presenter', tone: 'Poised', image: '/creative/avatars/fashion-accessories-presenter.jpg', assetId: 'ae8a5191-f39a-4dea-9a24-80e92a20eb20' },
    { id: 'mascot-lumo', name: 'Lumo', role: 'Cozy 3D mascot · felt lantern', tone: 'Shy & hopeful', image: '/creative/avatars/mascot-lumo.jpg', assetId: '9e991669-46d8-4d3a-93f1-50f0a803ad4d', category: 'Animation' },
    { id: 'mascot-piko', name: 'Piko', role: 'Cozy 3D mascot · plush moth', tone: 'Brave & bashful', image: '/creative/avatars/mascot-piko.jpg', assetId: '7cb6a1f7-43a7-44c4-b14b-3cb923c3385c', category: 'Animation' },
    { id: 'mascot-pebbi', name: 'Pebbi', role: 'Cozy 3D mascot · river pebble', tone: 'Quietly determined', image: '/creative/avatars/mascot-pebbi.jpg', assetId: 'ca4d11a4-4348-4401-b803-ba449988e8b2', category: 'Animation' },
    { id: 'mascot-tali', name: 'Tali', role: 'Cozy 3D mascot · paper bird', tone: 'Curious & clever', image: '/creative/avatars/mascot-tali.jpg', assetId: '7372079d-0c56-40d5-b0b1-700d370721f1', category: 'Animation' },
    { id: 'mascot-sumi', name: 'Sumi', role: 'Cozy 3D mascot · ink drop', tone: 'Imaginative & mischievous', image: '/creative/avatars/mascot-sumi.jpg', assetId: 'f16cb519-31f8-4e7c-ab01-71afe3457d3d', category: 'Animation' },
    { id: 'mascot-fizz', name: 'Fizz', role: 'Cozy 3D mascot · gummy star', tone: 'Energetic optimist', image: '/creative/avatars/mascot-fizz.jpg', assetId: 'da7fed61-5d52-4e96-af4a-9e9bb9d6eb32', category: 'Animation' },
    { id: 'mascot-dotti', name: 'Dotti', role: 'Cozy 3D mascot · ceramic teacup', tone: 'Caring & confident', image: '/creative/avatars/mascot-dotti.jpg', assetId: 'e05b458c-8a30-4f08-9dbc-3fffb928e939', category: 'Animation' },
    { id: 'mascot-rolo', name: 'Rolo', role: 'Cozy 3D mascot · corduroy snail', tone: 'Relaxed & resourceful', image: '/creative/avatars/mascot-rolo.jpg', assetId: 'cbd78e17-cd66-45c7-b290-89863cc8169f', category: 'Animation' },
    { id: 'mascot-junu', name: 'Junu', role: 'Cozy 3D mascot · clay seedling', tone: 'Hopeful & resilient', image: '/creative/avatars/mascot-junu.jpg', assetId: '3eb9c30f-fb6d-4e0f-a268-c918062dfb8b', category: 'Animation' },
    { id: 'mascot-vela', name: 'Vela', role: 'Cozy 3D mascot · moon jelly', tone: 'Thoughtful & playful', image: '/creative/avatars/mascot-vela.jpg', assetId: '64c3f5b3-7ba4-4b69-bd1a-a3b8a0c4e169', category: 'Animation' },
    { id: 'game-kael', name: 'Kael', role: 'Game hero · forest pathfinder', tone: 'Gentle but formidable', image: '/creative/avatars/game-kael.jpg', assetId: 'deb87863-2ece-4702-ae38-fcc2630aa516', category: 'Animation' },
    { id: 'game-nera', name: 'Nera', role: 'Game hero · desert relic scholar', tone: 'Adventurous', image: '/creative/avatars/game-nera.jpg', assetId: 'd95cfef2-8325-4ed0-8308-2ae1f0f0be74', category: 'Animation' },
    { id: 'game-toren', name: 'Toren', role: 'Game hero · frost-forged guardian', tone: 'Calm & protective', image: '/creative/avatars/game-toren.jpg', assetId: 'eb0e577f-ab18-4f0e-9d3c-2acabe9054f0', category: 'Animation' },
    { id: 'game-mara', name: 'Mara', role: 'Game hero · post-collapse botanist', tone: 'Focused & hopeful', image: '/creative/avatars/game-mara.jpg', assetId: '525f1377-b351-41ef-bfba-a28aeabe2a3e', category: 'Animation' },
    { id: 'game-kiro', name: 'Kiro', role: 'Game hero · exploration robot', tone: 'Curious & approachable', image: '/creative/avatars/game-kiro.jpg', assetId: 'b5406809-7820-42f4-a724-2edbd8b044cc', category: 'Animation' },
    { id: 'game-barek', name: 'Barek', role: 'Game hero · volcanic highland guardian', tone: 'Intense & thoughtful', image: '/creative/avatars/game-barek.jpg', assetId: 'f3517870-7c01-4030-9c65-55138ae874e6', category: 'Animation' },
    { id: 'game-edda', name: 'Edda', role: 'Game hero · veteran sea guardian', tone: 'Fierce calm', image: '/creative/avatars/game-edda.jpg', assetId: 'e2468f80-eb17-4b46-8f1c-810a8285cc21', category: 'Animation' },
    { id: 'game-silas', name: 'Silas', role: 'Game hero · nocturnal alchemist', tone: 'Analytical', image: '/creative/avatars/game-silas.jpg', assetId: 'c4d56866-6991-4794-bdf2-092ab192920c', category: 'Animation' },
    { id: 'game-vexa', name: 'Vexa', role: 'Game hero · deep-space salvage pilot', tone: 'Wry & confident', image: '/creative/avatars/game-vexa.jpg', assetId: '53f7035f-96dc-4c69-833c-57d2ffa4eb62', category: 'Animation' },
    { id: 'anime-leora', name: 'Leora', role: 'Cinematic anime · rooftop lounge', tone: 'Poised & playful', image: '/creative/avatars/anime-leora.jpg', assetId: 'da16c8cb-be8d-4798-90ef-6dc01df42c46', category: 'Animation' },
    { id: 'anime-ren', name: 'Ren', role: 'Cinematic anime · gallery after dark', tone: 'Quietly charismatic', image: '/creative/avatars/anime-ren.jpg', assetId: '0771b2b8-c254-4777-9efd-be98cbb06035', category: 'Animation' },
    { id: 'anime-mira', name: 'Celeste', role: 'Cinematic anime · coastal terrace', tone: 'Composed & confident', image: '/creative/avatars/anime-mira.jpg', assetId: '5dfa8cc8-1a66-4541-8331-911052953066', category: 'Animation' },
    { id: 'anime-airi', name: 'Airi', role: 'Fantasy anime · sky-map cartographer', tone: 'Confident & curious', image: '/creative/avatars/anime-airi.jpg', assetId: '8c59c3f1-fa91-4db9-8643-a619a0eaf31d', category: 'Animation' },
    { id: 'anime-renna', name: 'Renna', role: 'Fantasy anime · glass-garden knight', tone: 'Calm & determined', image: '/creative/avatars/anime-renna.jpg', assetId: '2962dd59-0742-4634-af3e-95b4ce54dffe', category: 'Animation' },
    { id: 'chibi-anika', name: 'Anika', role: '3D chibi · festive little girl', tone: 'Playful & stubborn', image: '/creative/avatars/chibi-anika.jpg', assetId: '85e30c27-54ca-473e-9cfc-72c7a7d3aab9', category: 'Animation' },
    { id: 'chibi-ayaan', name: 'Ayaan', role: '3D chibi · determined little boy', tone: 'Funny & stubborn', image: '/creative/avatars/chibi-ayaan.jpg', assetId: '316cad61-bc30-4563-8d19-d78be910fc4b', category: 'Animation' },
    { id: 'chibi-zuri', name: 'Nia', role: '3D chibi · cheerful little girl', tone: 'Exuberant', image: '/creative/avatars/chibi-zuri.jpg', assetId: '4fc13bf5-30b2-4e45-95b3-dc7033da0627', category: 'Animation' },
    { id: 'storybook-kavya', name: 'Kavya', role: 'Storybook anime · home kitchen', tone: 'Kind & quietly amused', image: '/creative/avatars/storybook-kavya.jpg', assetId: 'e79121a5-9ea5-4159-a141-0f0c1f339810', category: 'Animation' },
    { id: 'storybook-meera', name: 'Gauri', role: 'Storybook anime · village bus window', tone: 'Calm & thoughtful', image: '/creative/avatars/storybook-meera.jpg', assetId: 'a0db4ee1-af4a-4a99-a5a8-1c2161682ee2', category: 'Animation' },
    { id: 'tvc-aroha', name: 'Aroha', role: 'TVC lead actress · evening gown', tone: 'Graceful & confident', image: '/creative/avatars/tvc-aroha.jpg', assetId: 'ec0d606e-07f6-461c-be1e-8b4048dccf5a', category: 'TVC' },
];
