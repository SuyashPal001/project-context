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
];
