/**
 * Seeds the six avatar presets as platform-owned creative_library_assets
 * rows, each pointing at a real S3 object under a platform-owned prefix
 * (not a tenant's files table).
 *
 * The bytes for each row must already exist in S3 at
 * `creative-library/avatars/{slug}.jpg` before this seed is meaningful —
 * see this file's `uploadSeedImages` for a one-time upload of the same
 * 6 JPGs already bundled at apps/web/public/creative/avatars/*.jpg.
 *
 * Idempotent: safe to re-run.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:creative-library-assets
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import postgres from 'postgres';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getBucketFromSSM } from '@serverless-saas/storage';

// Fixed, not gen_random_uuid() — the web app's creativeLibraryAvatars.ts
// hardcodes these same values as each preset's assetId, so a picked
// preset's fileId is known client-side without any DB read. Regenerating
// these would silently break every existing chat message that references
// one.
export interface AvatarAssetSeed {
  id: string;
  slug: string;
  name: string;
  role: string;
  tone: string;
  localImagePath: string; // relative to apps/web/public
  // Picker filter. Omitted on the original 50, which are all UGC presenters.
  category?: AvatarCategory;
}

export type AvatarCategory = 'UGC' | 'Animation' | 'TVC';

export const AVATAR_ASSETS: AvatarAssetSeed[] = [
  // Original 6 — image bytes refreshed (avatar-037..042 from the avtaar set), same
  // fixed ids/slugs, so no existing chat-message reference breaks.
  { id: '557e5751-adbb-4b4e-8b08-8e426e0ffcf5', slug: 'everyday-creator', name: 'Mira', role: 'Everyday creator', tone: 'Casual', localImagePath: 'creative/avatars/everyday-creator.jpg' },
  { id: '8b6e9254-cc47-492c-bdc7-557ac6302e01', slug: 'tech-presenter', name: 'Arjun', role: 'Tech presenter', tone: 'Clear', localImagePath: 'creative/avatars/tech-presenter.jpg' },
  { id: '7df4d729-3611-4b15-8c49-ca691f2001b5', slug: 'beauty-creator', name: 'Hana', role: 'Beauty creator', tone: 'Natural', localImagePath: 'creative/avatars/beauty-creator.jpg' },
  { id: '5f328586-1b58-4bf6-af32-de4d4b3dc14d', slug: 'fitness-host', name: 'Samir', role: 'Fitness host', tone: 'Upbeat', localImagePath: 'creative/avatars/fitness-host-gym.jpg' },
  { id: '90e08f84-458e-472f-8c04-8da7860d2afe', slug: 'lifestyle-creator', name: 'Priya', role: 'Lifestyle creator', tone: 'Friendly', localImagePath: 'creative/avatars/lifestyle-creator-home.jpg' },
  { id: '78d215f5-5a6d-43f2-acac-4de02611dea4', slug: 'friendly-storyteller', name: 'Mateo', role: 'Friendly storyteller', tone: 'Conversational', localImagePath: 'creative/avatars/friendly-storyteller.jpg' },

  // 44 new presets (avatar-001..036, 043..050 from the avtaar set).
  { id: 'e75a419c-34e0-4956-9dde-31056dab21ed', slug: 'family-lifestyle-presenter', name: 'Anjali', role: 'Family lifestyle presenter', tone: 'Warm', localImagePath: 'creative/avatars/family-lifestyle-presenter.jpg' },
  { id: '381d46e9-2e90-48f7-8f7d-4cf2c192c6dc', slug: 'senior-lifestyle-presenter', name: 'Elena', role: 'Senior lifestyle presenter', tone: 'Warm', localImagePath: 'creative/avatars/senior-lifestyle-presenter.jpg' },
  { id: '11fff9df-63d4-4af1-bf90-25b6cb063899', slug: 'hair-wellness-educator', name: 'Meera', role: 'Hair & wellness educator', tone: 'Reassuring', localImagePath: 'creative/avatars/hair-wellness-educator.jpg' },
  { id: '46bc2640-97bf-4d75-b0fb-4d67a284fb33', slug: 'travel-property-host', name: 'Marco', role: 'Travel & property host', tone: 'Relaxed', localImagePath: 'creative/avatars/travel-property-host.jpg' },
  { id: 'b0d82af5-b504-4b87-9ae5-bbf23652ecdd', slug: 'music-producer-host', name: 'Naina', role: 'Music producer / livestream host', tone: 'Confident', localImagePath: 'creative/avatars/music-producer-host.jpg' },
  { id: '3852c952-b308-44e4-ba30-57bc84cd7de6', slug: 'menswear-consultant', name: 'Rehaan', role: 'Menswear consultant', tone: 'Polished', localImagePath: 'creative/avatars/menswear-consultant.jpg' },
  { id: '41c09ed3-409c-4ed8-992c-faac13d80617', slug: 'travel-journalist', name: 'Ishita', role: 'Travel journalist', tone: 'Thoughtful', localImagePath: 'creative/avatars/travel-journalist.jpg' },
  { id: '6e45da5d-1681-4fa1-a6b5-6e8032bcbe97', slug: 'hardware-repair-reviewer', name: 'Callum', role: 'Hardware repair reviewer', tone: 'Practical', localImagePath: 'creative/avatars/hardware-repair-reviewer.jpg' },
  { id: 'd66f1008-113e-4853-96d9-84e975c29f9c', slug: 'voiceover-audio-educator', name: 'Minjun', role: 'Voiceover & audio educator', tone: 'Thoughtful', localImagePath: 'creative/avatars/voiceover-audio-educator.jpg' },
  { id: '6328c470-6b46-400e-942c-ce37dbb79011', slug: 'cosmetic-formulation-educator', name: 'Yuki', role: 'Cosmetic formulation educator', tone: 'Calm', localImagePath: 'creative/avatars/cosmetic-formulation-educator.jpg' },
  { id: 'eb56ba28-6a33-4e06-9745-24801b8fd265', slug: 'remote-project-consultant', name: 'Lucas', role: 'Remote project consultant', tone: 'Composed', localImagePath: 'creative/avatars/remote-project-consultant.jpg' },
  { id: 'e02dafab-2ada-45a5-a7cb-684564c0e1ed', slug: 'customer-support-lead', name: 'Kevin', role: 'Customer support lead', tone: 'Capable', localImagePath: 'creative/avatars/customer-support-lead.jpg' },
  { id: '96bbd8d3-5a1d-49e3-8090-e5b065969efc', slug: 'cybersecurity-educator', name: 'Arnav', role: 'Cybersecurity educator', tone: 'Calm', localImagePath: 'creative/avatars/cybersecurity-educator.jpg' },
  { id: '6dbe7b7c-c541-4760-8d40-17f6706dbebf', slug: 'partnerships-director', name: 'Alessandro', role: 'Partnerships director', tone: 'Engaged', localImagePath: 'creative/avatars/partnerships-director.jpg' },
  { id: '693d9a44-e1b2-4f1a-a551-18bb2dc0a5b6', slug: 'home-organization-creator', name: 'Divya', role: 'Home organization creator', tone: 'Playful', localImagePath: 'creative/avatars/home-organization-creator.jpg' },
  { id: 'a4023a8f-145d-4dfc-9f72-2f8cf5fbb955', slug: 'career-coach', name: 'Haruto', role: 'Career coach', tone: 'Friendly', localImagePath: 'creative/avatars/career-coach.jpg' },
  { id: '40f3f3e6-2d54-45b3-9d62-7e69a66d4bf6', slug: 'architectural-designer', name: 'Théo', role: 'Architectural designer', tone: 'Relaxed', localImagePath: 'creative/avatars/architectural-designer.jpg' },
  { id: '9f1287bb-74ac-4dca-ab8e-3e30b4b98e4e', slug: 'creative-workshop-facilitator', name: 'Reema', role: 'Creative workshop facilitator', tone: 'Welcoming', localImagePath: 'creative/avatars/creative-workshop-facilitator.jpg' },
  { id: 'bf601fd6-1996-4b16-a388-b320e4c4b2d5', slug: 'leadership-coach', name: 'Malcolm', role: 'Leadership coach', tone: 'Composed', localImagePath: 'creative/avatars/leadership-coach.jpg' },
  { id: '20c3b82c-a120-4414-8754-6bd0af541219', slug: 'financial-literacy-educator', name: 'Salvatore', role: 'Financial literacy educator', tone: 'Trusted', localImagePath: 'creative/avatars/financial-literacy-educator.jpg' },
  { id: '2b066f48-6249-4b52-bab8-a6a1338352ee', slug: 'product-onboarding-specialist', name: 'Andre', role: 'Product onboarding specialist', tone: 'Attentive', localImagePath: 'creative/avatars/product-onboarding-specialist.jpg' },
  { id: '6017685b-7ec1-4a7b-9b64-a8b01e052d27', slug: 'skincare-routine-educator', name: 'Simone', role: 'Skincare routine educator', tone: 'Candid', localImagePath: 'creative/avatars/skincare-routine-educator.jpg' },
  { id: '06419d1b-1326-4566-aa47-3293fc4bde89', slug: 'heritage-travel-host', name: 'Lakshmi', role: 'Heritage travel host', tone: 'Grounded', localImagePath: 'creative/avatars/heritage-travel-host.jpg' },
  { id: 'adc67be2-b2fa-45b6-a7d4-93f63e54b3d1', slug: 'regional-cooking-educator', name: 'Sunita', role: 'Regional cooking educator', tone: 'Knowledgeable', localImagePath: 'creative/avatars/regional-cooking-educator.jpg' },
  { id: '6b94d81c-d4fc-49a6-ac12-7dfee41dd816', slug: 'gemstone-appraiser', name: 'Vikram', role: 'Gemstone appraiser', tone: 'Trustworthy', localImagePath: 'creative/avatars/gemstone-appraiser.jpg' },
  { id: '2118e1af-549b-4abc-81e9-f4d5a35473c5', slug: 'interior-design-consultant', name: 'Diego', role: 'Interior design consultant', tone: 'Cultured', localImagePath: 'creative/avatars/interior-design-consultant.jpg' },
  { id: 'c1953627-d2ab-4e2b-ae04-312ab6ac9227', slug: 'beginner-fitness-instructor', name: 'Marisol', role: 'Beginner fitness instructor', tone: 'Energetic', localImagePath: 'creative/avatars/beginner-fitness-instructor.jpg' },
  { id: 'e9a94a5b-1cec-43f3-832e-e4ebeaeaa87c', slug: 'cricket-coach', name: 'Marcus', role: 'Cricket coach', tone: 'Energetic', localImagePath: 'creative/avatars/cricket-coach.jpg' },
  { id: 'bb191ec5-ff78-480a-8717-c1d0a4dfa2e7', slug: 'personal-finance-explainer', name: 'Pooja', role: 'Personal finance explainer', tone: 'Witty', localImagePath: 'creative/avatars/personal-finance-explainer.jpg' },
  { id: 'fb612a23-8291-483d-9b55-f737cd09b146', slug: 'cultural-history-educator', name: 'Ashok', role: 'Cultural history educator', tone: 'Grounded', localImagePath: 'creative/avatars/cultural-history-educator.jpg' },
  { id: 'e313e54f-08d8-4db5-a801-2f909392bccd', slug: 'electronics-repair-educator', name: 'Jerome', role: 'Electronics repair educator', tone: 'Focused', localImagePath: 'creative/avatars/electronics-repair-educator.jpg' },
  { id: '7685839d-ee23-417d-b754-dfa04d3a7207', slug: 'community-health-educator', name: 'Naomi', role: 'Community health educator', tone: 'Credible', localImagePath: 'creative/avatars/community-health-educator.jpg' },
  { id: 'cc293484-0dba-4978-a981-e8047254f88e', slug: 'community-legal-advisor', name: 'Jaspreet', role: 'Community legal advisor', tone: 'Trustworthy', localImagePath: 'creative/avatars/community-legal-advisor.jpg' },
  { id: 'b63f1e13-8cfd-4dfd-9cbf-73e251b78feb', slug: 'motion-graphics-designer', name: 'Mia', role: 'Motion graphics designer', tone: 'Creative', localImagePath: 'creative/avatars/motion-graphics-designer.jpg' },
  { id: '685a0b07-24f2-45b3-a80e-f7f59068f46d', slug: 'urban-gardening-advisor', name: 'Carmen', role: 'Urban gardening advisor', tone: 'Earthy', localImagePath: 'creative/avatars/urban-gardening-advisor.jpg' },
  { id: '8e5d85ad-4826-4522-9f47-0abdce8f1ba3', slug: 'temple-history-educator', name: 'Radha', role: 'Temple history educator', tone: 'Scholarly', localImagePath: 'creative/avatars/temple-history-educator.jpg' },
  { id: 'df9bf7e5-254a-40ee-86c6-8dcefce41ba0', slug: 'beauty-skincare-presenter', name: 'Anaya', role: 'Beauty & skincare presenter', tone: 'Confident', localImagePath: 'creative/avatars/beauty-skincare-presenter.jpg' },
  { id: 'd57ad98b-768c-4b58-b90e-fadb672e5530', slug: 'fitness-running-host', name: 'Simran', role: 'Fitness & running host', tone: 'Direct', localImagePath: 'creative/avatars/fitness-running-host.jpg' },
  { id: '80464ff4-830b-4ef1-a215-a516387613f9', slug: 'eyewear-lifestyle-creator', name: 'Aiko', role: 'Eyewear lifestyle creator', tone: 'Assured', localImagePath: 'creative/avatars/eyewear-lifestyle-creator.jpg' },
  { id: '95c565b5-03ea-4613-9492-b066c948c7ce', slug: 'audio-music-creator', name: 'Zuri', role: 'Audio & music creator', tone: 'Friendly', localImagePath: 'creative/avatars/audio-music-creator.jpg' },
  { id: '42bf72b6-0b14-4f2d-b46f-58079f876110', slug: 'fragrance-beauty-presenter', name: 'Ayesha', role: 'Fragrance & beauty presenter', tone: 'Composed', localImagePath: 'creative/avatars/fragrance-beauty-presenter.jpg' },
  { id: '76a7ca61-cf55-46e8-8510-0bb488b25933', slug: 'outdoor-adventure-host', name: 'Sofia', role: 'Outdoor adventure host', tone: 'Capable', localImagePath: 'creative/avatars/outdoor-adventure-host.jpg' },
  { id: '301f60ef-e630-4cd5-9528-75594d106099', slug: 'menswear-style-presenter', name: 'Karan', role: 'Menswear style presenter', tone: 'Composed', localImagePath: 'creative/avatars/menswear-style-presenter.jpg' },
  { id: 'ae8a5191-f39a-4dea-9a24-80e92a20eb20', slug: 'fashion-accessories-presenter', name: 'Mila', role: 'Fashion accessories presenter', tone: 'Poised', localImagePath: 'creative/avatars/fashion-accessories-presenter.jpg' },

  // 30 approved animated and TVC characters (worktree feat/animated-avatars,
  // docs/design-references/*). Ivo, the tenth game hero, is left out: his
  // sneakers carry a real brand logo.
  { id: '9e991669-46d8-4d3a-93f1-50f0a803ad4d', slug: 'mascot-lumo', name: 'Lumo', role: 'Cozy 3D mascot · felt lantern', tone: 'Shy & hopeful', localImagePath: 'creative/avatars/mascot-lumo.jpg', category: 'Animation' },
  { id: '7cb6a1f7-43a7-44c4-b14b-3cb923c3385c', slug: 'mascot-piko', name: 'Piko', role: 'Cozy 3D mascot · plush moth', tone: 'Brave & bashful', localImagePath: 'creative/avatars/mascot-piko.jpg', category: 'Animation' },
  { id: 'ca4d11a4-4348-4401-b803-ba449988e8b2', slug: 'mascot-pebbi', name: 'Pebbi', role: 'Cozy 3D mascot · river pebble', tone: 'Quietly determined', localImagePath: 'creative/avatars/mascot-pebbi.jpg', category: 'Animation' },
  { id: '7372079d-0c56-40d5-b0b1-700d370721f1', slug: 'mascot-tali', name: 'Tali', role: 'Cozy 3D mascot · paper bird', tone: 'Curious & clever', localImagePath: 'creative/avatars/mascot-tali.jpg', category: 'Animation' },
  { id: 'f16cb519-31f8-4e7c-ab01-71afe3457d3d', slug: 'mascot-sumi', name: 'Sumi', role: 'Cozy 3D mascot · ink drop', tone: 'Imaginative & mischievous', localImagePath: 'creative/avatars/mascot-sumi.jpg', category: 'Animation' },
  { id: 'da7fed61-5d52-4e96-af4a-9e9bb9d6eb32', slug: 'mascot-fizz', name: 'Fizz', role: 'Cozy 3D mascot · gummy star', tone: 'Energetic optimist', localImagePath: 'creative/avatars/mascot-fizz.jpg', category: 'Animation' },
  { id: 'e05b458c-8a30-4f08-9dbc-3fffb928e939', slug: 'mascot-dotti', name: 'Dotti', role: 'Cozy 3D mascot · ceramic teacup', tone: 'Caring & confident', localImagePath: 'creative/avatars/mascot-dotti.jpg', category: 'Animation' },
  { id: 'cbd78e17-cd66-45c7-b290-89863cc8169f', slug: 'mascot-rolo', name: 'Rolo', role: 'Cozy 3D mascot · corduroy snail', tone: 'Relaxed & resourceful', localImagePath: 'creative/avatars/mascot-rolo.jpg', category: 'Animation' },
  { id: '3eb9c30f-fb6d-4e0f-a268-c918062dfb8b', slug: 'mascot-junu', name: 'Junu', role: 'Cozy 3D mascot · clay seedling', tone: 'Hopeful & resilient', localImagePath: 'creative/avatars/mascot-junu.jpg', category: 'Animation' },
  { id: '64c3f5b3-7ba4-4b69-bd1a-a3b8a0c4e169', slug: 'mascot-vela', name: 'Vela', role: 'Cozy 3D mascot · moon jelly', tone: 'Thoughtful & playful', localImagePath: 'creative/avatars/mascot-vela.jpg', category: 'Animation' },
  { id: 'deb87863-2ece-4702-ae38-fcc2630aa516', slug: 'game-kael', name: 'Kael', role: 'Game hero · forest pathfinder', tone: 'Gentle but formidable', localImagePath: 'creative/avatars/game-kael.jpg', category: 'Animation' },
  { id: 'd95cfef2-8325-4ed0-8308-2ae1f0f0be74', slug: 'game-nera', name: 'Nera', role: 'Game hero · desert relic scholar', tone: 'Adventurous', localImagePath: 'creative/avatars/game-nera.jpg', category: 'Animation' },
  { id: 'eb0e577f-ab18-4f0e-9d3c-2acabe9054f0', slug: 'game-toren', name: 'Toren', role: 'Game hero · frost-forged guardian', tone: 'Calm & protective', localImagePath: 'creative/avatars/game-toren.jpg', category: 'Animation' },
  { id: '525f1377-b351-41ef-bfba-a28aeabe2a3e', slug: 'game-mara', name: 'Mara', role: 'Game hero · post-collapse botanist', tone: 'Focused & hopeful', localImagePath: 'creative/avatars/game-mara.jpg', category: 'Animation' },
  { id: 'b5406809-7820-42f4-a724-2edbd8b044cc', slug: 'game-kiro', name: 'Kiro', role: 'Game hero · exploration robot', tone: 'Curious & approachable', localImagePath: 'creative/avatars/game-kiro.jpg', category: 'Animation' },
  { id: 'f3517870-7c01-4030-9c65-55138ae874e6', slug: 'game-barek', name: 'Barek', role: 'Game hero · volcanic highland guardian', tone: 'Intense & thoughtful', localImagePath: 'creative/avatars/game-barek.jpg', category: 'Animation' },
  { id: 'e2468f80-eb17-4b46-8f1c-810a8285cc21', slug: 'game-edda', name: 'Edda', role: 'Game hero · veteran sea guardian', tone: 'Fierce calm', localImagePath: 'creative/avatars/game-edda.jpg', category: 'Animation' },
  { id: 'c4d56866-6991-4794-bdf2-092ab192920c', slug: 'game-silas', name: 'Silas', role: 'Game hero · nocturnal alchemist', tone: 'Analytical', localImagePath: 'creative/avatars/game-silas.jpg', category: 'Animation' },
  { id: '53f7035f-96dc-4c69-833c-57d2ffa4eb62', slug: 'game-vexa', name: 'Vexa', role: 'Game hero · deep-space salvage pilot', tone: 'Wry & confident', localImagePath: 'creative/avatars/game-vexa.jpg', category: 'Animation' },
  { id: 'da16c8cb-be8d-4798-90ef-6dc01df42c46', slug: 'anime-leora', name: 'Leora', role: 'Cinematic anime · rooftop lounge', tone: 'Poised & playful', localImagePath: 'creative/avatars/anime-leora.jpg', category: 'Animation' },
  { id: '0771b2b8-c254-4777-9efd-be98cbb06035', slug: 'anime-ren', name: 'Ren', role: 'Cinematic anime · gallery after dark', tone: 'Quietly charismatic', localImagePath: 'creative/avatars/anime-ren.jpg', category: 'Animation' },
  { id: '5dfa8cc8-1a66-4541-8331-911052953066', slug: 'anime-mira', name: 'Celeste', role: 'Cinematic anime · coastal terrace', tone: 'Composed & confident', localImagePath: 'creative/avatars/anime-mira.jpg', category: 'Animation' },
  { id: '8c59c3f1-fa91-4db9-8643-a619a0eaf31d', slug: 'anime-airi', name: 'Airi', role: 'Fantasy anime · sky-map cartographer', tone: 'Confident & curious', localImagePath: 'creative/avatars/anime-airi.jpg', category: 'Animation' },
  { id: '2962dd59-0742-4634-af3e-95b4ce54dffe', slug: 'anime-renna', name: 'Renna', role: 'Fantasy anime · glass-garden knight', tone: 'Calm & determined', localImagePath: 'creative/avatars/anime-renna.jpg', category: 'Animation' },
  { id: '85e30c27-54ca-473e-9cfc-72c7a7d3aab9', slug: 'chibi-anika', name: 'Anika', role: '3D chibi · festive little girl', tone: 'Playful & stubborn', localImagePath: 'creative/avatars/chibi-anika.jpg', category: 'Animation' },
  { id: '316cad61-bc30-4563-8d19-d78be910fc4b', slug: 'chibi-ayaan', name: 'Ayaan', role: '3D chibi · determined little boy', tone: 'Funny & stubborn', localImagePath: 'creative/avatars/chibi-ayaan.jpg', category: 'Animation' },
  { id: '4fc13bf5-30b2-4e45-95b3-dc7033da0627', slug: 'chibi-zuri', name: 'Nia', role: '3D chibi · cheerful little girl', tone: 'Exuberant', localImagePath: 'creative/avatars/chibi-zuri.jpg', category: 'Animation' },
  { id: 'e79121a5-9ea5-4159-a141-0f0c1f339810', slug: 'storybook-kavya', name: 'Kavya', role: 'Storybook anime · home kitchen', tone: 'Kind & quietly amused', localImagePath: 'creative/avatars/storybook-kavya.jpg', category: 'Animation' },
  { id: 'a0db4ee1-af4a-4a99-a5a8-1c2161682ee2', slug: 'storybook-meera', name: 'Gauri', role: 'Storybook anime · village bus window', tone: 'Calm & thoughtful', localImagePath: 'creative/avatars/storybook-meera.jpg', category: 'Animation' },
  { id: 'ec0d606e-07f6-461c-be1e-8b4048dccf5a', slug: 'tvc-aroha', name: 'Aroha', role: 'TVC lead actress · evening gown', tone: 'Graceful & confident', localImagePath: 'creative/avatars/tvc-aroha.jpg', category: 'TVC' },
];

function storageKeyFor(slug: string): string {
  return `creative-library/avatars/${slug}.jpg`;
}

async function uploadSeedImages(): Promise<void> {
  const bucket = await getBucketFromSSM();
  if (!bucket) throw new Error('Unable to resolve documents bucket (DOCUMENTS_BUCKET / SSM param empty)');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  // From this file's directory (products/agent-platform/packages/api/seeds/),
  // '../../../../..' climbs 5 levels to the repo root, then into apps/web/public.
  const webPublicDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/web/public');

  for (const a of AVATAR_ASSETS) {
    const bytes = readFileSync(join(webPublicDir, a.localImagePath));
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKeyFor(a.slug),
      Body: bytes,
      ContentType: 'image/jpeg',
    }));
    console.log(`[seed:creative-library-assets] uploaded ${a.slug} to s3://${bucket}/${storageKeyFor(a.slug)}`);
  }
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  await uploadSeedImages();

  const sql = postgres(url, { max: 1 });
  try {
    for (const a of AVATAR_ASSETS) {
      await sql`
        INSERT INTO creative_library_assets (
          id, tenant_id, slug, kind, name, attributes, storage_key, mime_type, status
        ) VALUES (
          ${a.id}, NULL, ${a.slug}, 'avatar', ${a.name},
          ${sql.json({ role: a.role, tone: a.tone, category: a.category ?? 'UGC' })}, ${storageKeyFor(a.slug)}, 'image/jpeg', 'active'
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          attributes = EXCLUDED.attributes,
          storage_key = EXCLUDED.storage_key,
          updated_at = now()
      `;
      console.log(`[seed:creative-library-assets] upserted ${a.slug}`);
    }
  } finally {
    await sql.end();
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  run().catch((err) => {
    console.error('[seed:creative-library-assets] failed', err);
    process.exit(1);
  });
}
