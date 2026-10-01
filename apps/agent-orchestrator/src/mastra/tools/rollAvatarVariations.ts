import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { emitToolStatus } from './generationStarted.js'

// A "variety roll" for avatar variations. Asking the model to "make the four
// different" still gave four look-alikes, so the differences are picked here in
// code: every attribute the brief leaves open is drawn without repeats across
// the set, so no two variations share an age band, face shape, hair, outfit,
// place or gesture. The roll only ever varies what the brief left open —
// look, gender and age range come from the brief and are never rolled over.
// Free: no generation, no credits.

type Gender = 'woman' | 'man'

const FACE_SHAPES = ['oval face', 'round face', 'heart-shaped face', 'long angular face', 'square-jawed face', 'soft diamond-shaped face']

const HAIR: Record<Gender, string[]> = {
  woman: [
    'shoulder-length wavy black hair worn loose with a center part',
    'short chin-length curly bob',
    'long straight hair in a low loose ponytail with a few flyaways',
    'collarbone-length hair with a soft wave and side-swept fringe',
    'long hair in a loose side braid',
    'mid-length layered hair tucked behind one ear',
  ],
  man: [
    'short neat crop',
    'medium wavy hair swept back',
    'close fade with a trimmed full beard',
    'short salt-and-pepper hair with light stubble',
    'thick hair with a side part and a neat mustache',
    'buzz cut with a short boxed beard',
  ],
}

const WARDROBE_INDIAN: Record<Gender, string[]> = {
  woman: [
    'indigo handloom cotton kurta with a small white geometric print',
    'plain sage-green cotton crew-neck T-shirt',
    'terracotta linen button-front shirt with sleeves rolled',
    'mustard cotton cardigan over a plain ivory top',
    'soft pink chikankari cotton kurti',
    'white cotton shirt with thin blue stripes',
  ],
  man: [
    'olive cotton kurta with rolled sleeves',
    'plain navy crew-neck T-shirt',
    'white linen shirt, top button open',
    'grey marl henley',
    'rust half-sleeve cotton shirt',
    'charcoal zip-up hoodie over a white T-shirt',
  ],
}

const WARDROBE_GENERAL: Record<Gender, string[]> = {
  woman: [
    'plain sage-green cotton crew-neck T-shirt',
    'terracotta linen button-front shirt with sleeves rolled',
    'cream chunky knit sweater',
    'mustard cotton cardigan over a plain white top',
    'light denim shirt, sleeves rolled',
    'soft grey hoodie',
  ],
  man: [
    'plain navy crew-neck T-shirt',
    'white linen shirt, top button open',
    'grey marl henley',
    'olive overshirt over a white T-shirt',
    'rust half-sleeve cotton shirt',
    'charcoal zip-up hoodie over a white T-shirt',
  ],
}

const PLACES = [
  'bright bedroom with a small vanity, softly blurred',
  'compact apartment kitchen with a daylight window',
  'shaded balcony with potted plants',
  'living room beside a window with a sofa and bookshelf',
  'home office corner with a desk and a plant',
  'bathroom vanity with a large mirror and pale tile',
]

// Homes that read as Indian at a glance, for an Indian look — the general
// list above renders as Western suburban interiors.
const PLACES_INDIAN = [
  'bedroom in an Indian apartment with printed cotton curtains and a wooden dressing table, softly blurred',
  'Indian home kitchen with steel utensils on open shelves and a window with a metal grill',
  'balcony of an Indian apartment block with potted tulsi and money plants and a railing',
  'living room with a wooden sofa, cotton cushions, a jute rug and a brass lamp',
  'study corner in an Indian flat with a steel almirah and a window grill behind',
  'bathroom with a small wall mirror, a steel bucket and patterned tiles',
]

const GESTURES = [
  'one open palm lifted as if explaining a point',
  'index finger loosely raised for emphasis',
  'one hand resting near the collarbone mid-thought',
  'counting a point off on two fingers',
  'a small shrug with one hand turned up',
  'hand gesturing toward the camera as if sharing a tip',
]

const INDIAN_SKIN_TONES = ['light wheatish skin', 'wheatish medium-brown skin', 'warm medium-brown skin', 'deep warm-brown skin', 'golden-brown skin', 'rich dark-brown skin']

const MIX_LOOKS = ['Indian', 'East Asian', 'Black', 'White', 'Latina/Latino', 'Middle Eastern', 'Southeast Asian']

// Fisher–Yates on a copy, with an injectable random source so tests are stable.
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Spreads `count` ages across [min, max]: one age per equal band, so the set never clusters. */
function spreadAges(min: number, max: number, count: number, random: () => number): number[] {
  const width = (max - min + 1) / count
  return Array.from({ length: count }, (_, i) => {
    const lo = Math.round(min + i * width)
    const hi = Math.max(lo, Math.round(min + (i + 1) * width) - 1)
    return lo + Math.floor(random() * (hi - lo + 1))
  })
}

export interface AvatarRollInput {
  count: number
  look: string
  gender: Gender | 'any'
  ageMin: number
  ageMax: number
}

export interface AvatarVariationSpec {
  gender: Gender
  age: number
  look: string
  skinTone?: string
  faceShape: string
  hair: string
  wardrobe: string
  place: string
  gesture: string
}

export function rollAvatarVariations(input: AvatarRollInput, random: () => number = Math.random): AvatarVariationSpec[] {
  const { count, gender, ageMin, ageMax } = input
  const look = input.look.trim()
  const isMix = /^(a )?mix\b/i.test(look) || look === ''
  const isIndian = /\bindian\b/i.test(look)

  const genders: Gender[] = Array.from({ length: count }, (_, i) =>
    gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender)
  const ages = shuffled(spreadAges(ageMin, ageMax, count, random), random)
  const looks = isMix ? shuffled(MIX_LOOKS, random) : []
  const skinTones = shuffled(INDIAN_SKIN_TONES, random)
  const faces = shuffled(FACE_SHAPES, random)
  const places = shuffled(PLACES, random)
  const placesIndian = shuffled(PLACES_INDIAN, random)
  const gestures = shuffled(GESTURES, random)
  const hair = { woman: shuffled(HAIR.woman, random), man: shuffled(HAIR.man, random) }
  const wardrobe = {
    indian: { woman: shuffled(WARDROBE_INDIAN.woman, random), man: shuffled(WARDROBE_INDIAN.man, random) },
    general: { woman: shuffled(WARDROBE_GENERAL.woman, random), man: shuffled(WARDROBE_GENERAL.man, random) },
  }
  // Per-gender counters, so a woman and a man never consume each other's picks.
  const hairUsed = { woman: 0, man: 0 }
  const wardrobeUsed = { indian: { woman: 0, man: 0 }, general: { woman: 0, man: 0 } }

  return genders.map((g, i) => {
    const personLook = isMix ? looks[i % looks.length] : look
    const indianLook = isIndian || personLook === 'Indian'
    const pool = indianLook ? 'indian' : 'general'
    return {
      gender: g,
      age: ages[i],
      look: personLook,
      ...(indianLook ? { skinTone: skinTones[i % skinTones.length] } : {}),
      faceShape: faces[i % faces.length],
      hair: hair[g][hairUsed[g]++ % hair[g].length],
      wardrobe: wardrobe[pool][g][wardrobeUsed[pool][g]++ % wardrobe[pool][g].length],
      place: indianLook ? placesIndian[i % placesIndian.length] : places[i % places.length],
      gesture: gestures[i % gestures.length],
    }
  })
}

/** "34 · Indian woman · shaded balcony with potted plants · indigo handloom cotton kurta…" — first clause of the place and outfit only, so a line fits. */
export function castingLine(v: AvatarVariationSpec): string {
  const short = (s: string) => s.split(/,| with /)[0].trim()
  return `${v.age} · ${v.look} ${v.gender} · ${short(v.place)} · ${short(v.wardrobe)}`
}

// Animated characters: original cozy 3D mascots, modelled on the ChatGPT
// concepts the user approved (a felt lantern, a stone pebble, a glazed
// teacup, a paper bird). What made those work: an invented subject with one
// signature feature, ONE tactile material, a palette with a matching plain
// studio backdrop, and a personality caught in an action. Generic cute
// animals (bunny, hedgehog, fox, cactus, cloud, dumpling) are left out on
// purpose — they are exactly what other mascot libraries already show.
const CHARACTER_CREATURES = [
  'little bumblebee with one crooked antenna',
  'tiny axolotl with frilly gill fronds',
  'round baby turtle with a patchwork shell',
  'small pangolin with petal-like overlapping scales',
  'little seahorse standing on its curled tail',
  'chubby firefly with a softly glowing tail',
  'tiny ladybird with a domed spotted back',
  'small chameleon with a spiral tail',
  'little koi fish walking on two broad fins',
  'baby owl with oversized tufted ears',
]

const CHARACTER_OBJECTS = [
  'little clay diya with a flame-shaped tuft of hair',
  'small kulhad cup with a wisp of steam like a curl',
  'round ripe mango with a single leaf',
  'tiny ball of yarn with one loose curl of thread',
  'little paper kite with a ribbon tail',
  'small pencil stub with an eraser cap like a hat',
  'round bread bun with a scored top',
  'little honey jar with a wooden dipper crest',
  'small pinecone with layered scales',
  'tiny light bulb with a glowing filament heart',
]

const CHARACTER_MATERIALS = [
  'handmade felt with soft visible fibres',
  'soft velvet with a gentle sheen',
  'glazed ceramic with small handmade irregularities',
  'hand-shaped clay with faint fingerprint texture',
  'translucent gummy with tiny trapped bubbles',
  'folded matte paper with crisp creases and fibres',
  'stitched corduroy plush with neat seams',
  'chunky knitted wool',
]

// Body palette with a plain studio backdrop that sets it off.
const CHARACTER_PALETTES = [
  { palette: 'warm ivory and amber', backdrop: 'warm taupe' },
  { palette: 'apricot and cream', backdrop: 'pale blue-grey' },
  { palette: 'powder blue and muted indigo', backdrop: 'cool lavender-grey' },
  { palette: 'blue-grey with a coral accent', backdrop: 'pale sage' },
  { palette: 'peach and rose', backdrop: 'pale lilac' },
  { palette: 'cinnamon and sage green', backdrop: 'muted cream' },
  { palette: 'terracotta and mint green', backdrop: 'muted sand' },
  { palette: 'midnight blue with a gold line', backdrop: 'parchment' },
]

const CHARACTER_PERSONALITIES = [
  'shy but hopeful, small hands clasped near the chest',
  'quietly determined, taking a brave little step forward',
  'an energetic optimist, caught in a cheerful hop',
  'caring and gently confident, giving a welcoming wave',
  'curious and clever, head tilted toward the viewer',
  'relaxed and resourceful, strolling with purpose',
  'imaginative and mischievous, striking an inviting little pose',
  'thoughtful and quietly playful, one hand raised in a gentle hello',
]

export interface CharacterVariationSpec {
  character: string
  material: string
  palette: string
  backdrop: string
  personality: string
}

export type CharacterKind = 'mix' | 'creatures' | 'objects'

export function rollCharacterVariations(count: number, random: () => number = Math.random, kind: CharacterKind = 'mix'): CharacterVariationSpec[] {
  const creatures = shuffled(CHARACTER_CREATURES, random)
  const objects = shuffled(CHARACTER_OBJECTS, random)
  const materials = shuffled(CHARACTER_MATERIALS, random)
  const palettes = shuffled(CHARACTER_PALETTES, random)
  const personalities = shuffled(CHARACTER_PERSONALITIES, random)
  return Array.from({ length: count }, (_, i) => ({
    character: kind === 'creatures' ? creatures[i % creatures.length]
      : kind === 'objects' ? objects[i % objects.length]
      : i % 2 === 0 ? creatures[(i / 2) % creatures.length] : objects[((i - 1) / 2) % objects.length],
    material: materials[i % materials.length],
    ...palettes[i % palettes.length],
    personality: personalities[i % personalities.length],
  }))
}

/** "tiny axolotl · glazed ceramic · caring and gently confident" */
export function characterLine(v: CharacterVariationSpec): string {
  const short = (s: string) => s.split(/,| with /)[0].trim()
  return `${short(v.character)} · ${short(v.material)} · ${short(v.personality)}`
}

// Game heroes: original console-game character art, modelled on the ten
// game concepts the user approved (a forest pathfinder, a city courier, a
// frost guardian). Each is a role in its own world with one signature item,
// its own light and palette. The approved ten stay the user's own; these are
// new roles in the same spirit.
const GAME_ROLES = [
  { role: 'airship mechanic', world: 'a sky-harbour dock among clouds at sunrise', item: 'a brass multi-tool gauntlet', light: 'warm sunrise light, copper and teal palette' },
  { role: 'jungle temple cartographer', world: 'overgrown stone temple steps in drifting mist', item: 'a leather map case with a carved clasp', light: 'filtered green daylight, jade and ochre palette' },
  { role: 'monsoon fort archer', world: 'a carved sandstone fort rampart in heavy monsoon rain', item: 'an ornate recurve bow with brass fittings', light: 'stormy grey light with warm lamp accents, saffron and slate palette' },
  { role: 'mountain-pass courier', world: 'a high snowy mountain pass strung with faded cloth flags', item: 'a weatherproof satchel with a round bronze latch', light: 'cold blue-hour light, crimson and snow-white palette' },
  { role: 'deep-sea salvage diver', world: 'a flooded ancient harbour pierced by shafts of light', item: 'a heavy brass diving helmet carried under one arm', light: 'cool sea-teal light with amber lamps' },
  { role: 'orbital station medic', world: 'a space station corridor with a window onto a blue planet', item: 'a compact medical scanner strapped to one forearm', light: 'crisp white light with a soft orange rim' },
  { role: 'desert caravan guardian', world: 'wind-sculpted red dunes at golden hour', item: 'a long curved glaive with an indigo tassel', light: 'golden-hour light, indigo and sand palette' },
  { role: 'night-market hacker', world: 'a rain-soaked night market under glowing signs with no readable text', item: 'a folding holographic deck', light: 'magenta and cyan neon light' },
  { role: 'ice-forest ranger', world: 'a frozen birch forest at dawn', item: 'a white-fletched longbow and a fur-trimmed hood', light: 'pale dawn light, silver and moss palette' },
  { role: 'volcanic forge smith', world: 'a glowing forge carved into black basalt', item: 'a heavy plain war hammer', light: 'fiery orange light against deep shadow' },
]

const GAME_SKIN = ['deep brown skin', 'warm medium-brown skin', 'light olive skin', 'golden-tan skin', 'dark umber skin', 'wheatish brown skin', 'fair skin with rosy cheeks', 'warm copper-brown skin']

const GAME_HAIR: Record<Gender, string[]> = {
  woman: ['close-cropped silver hair', 'long dark braids tied back', 'a copper undercut', 'tightly coiled hair under a headwrap', 'a long black braid over one shoulder', 'short wavy auburn hair'],
  man: ['short curly black hair', 'long hair tied in a warrior knot', 'a shaved head with a short beard', 'swept-back grey hair', 'braided hair with a trimmed beard', 'messy dark hair with stubble'],
}

const GAME_EXPRESSIONS = ['gentle but formidable', 'alert and resourceful', 'calm and protective', 'focused and hopeful', 'wry and confident', 'thoughtful and a little haunted']

export interface GameHeroVariationSpec {
  gender: Gender
  age: number
  role: string
  world: string
  item: string
  light: string
  skin: string
  hair: string
  expression: string
}

export function rollGameHeroVariations(count: number, random: () => number = Math.random, gender: Gender | 'any' = 'any'): GameHeroVariationSpec[] {
  const roles = shuffled(GAME_ROLES, random)
  const skins = shuffled(GAME_SKIN, random)
  const expressions = shuffled(GAME_EXPRESSIONS, random)
  const ages = shuffled(spreadAges(22, 60, count, random), random)
  const hair = { woman: shuffled(GAME_HAIR.woman, random), man: shuffled(GAME_HAIR.man, random) }
  const hairUsed = { woman: 0, man: 0 }
  return Array.from({ length: count }, (_, i) => {
    const g: Gender = gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender
    return {
      gender: g,
      age: ages[i],
      ...roles[i % roles.length],
      skin: skins[i % skins.length],
      hair: hair[g][hairUsed[g]++ % hair[g].length],
      expression: expressions[i % expressions.length],
    }
  })
}

/** "41 · woman · monsoon fort archer" */
export function gameHeroLine(v: Pick<GameHeroVariationSpec, 'age' | 'gender' | 'role'>): string {
  return `${v.age} · ${v.gender} · ${v.role}`
}

// Cinematic anime: mature, elegant hand-drawn 2D anime portraits, modelled on
// the three concepts the user approved (Leora in a rooftop lounge, Ren in an
// art gallery after dark, Mira seated on a coastal terrace at blue hour) — contemporary evening fashion, a night-city
// setting, face and personality first. No fantasy armour or weapons.
const ANIME_SCENES = [
  'a quiet jazz bar with warm amber lamps',
  'a rain-streaked café window at night with soft neon reflections',
  'a hotel lobby staircase with brass rails',
  'a riverside promenade at blue hour with distant city lights',
  'a bookshop aisle after closing, lit by warm lamps',
  'a rooftop garden with string lights above the city',
  'a train platform at dusk under soft lights',
  'a theatre foyer with velvet curtains and gold sconces',
  'a terrace above a coastal city at blue hour, flowers in soft silhouette',
]

const ANIME_OUTFITS: Record<Gender, string[]> = {
  woman: [
    'an emerald satin slip dress with a thin gold chain belt',
    'a tailored ivory pantsuit over a black camisole',
    'a midnight-blue velvet wrap dress',
    'a saffron silk saree with a modern sleeveless blouse',
    'a charcoal trench coat over a black turtleneck',
    'a plum one-shoulder evening dress',
  ],
  man: [
    'a charcoal double-breasted suit with an open collar',
    'a camel overcoat over a black knit sweater',
    'a black bandhgala jacket with brass buttons',
    'a white linen shirt with rolled sleeves and dark tailored trousers',
    'a deep green velvet blazer over a cream shirt',
    'a navy suit with a loosened silk tie',
  ],
}

const ANIME_HAIR: Record<Gender, string[]> = {
  woman: ['long straight black hair with a centre part', 'a sleek chin-length bob', 'long loose auburn waves', 'a low twisted bun with face-framing strands', 'shoulder-length softly curled dark hair', 'a long side-swept braid'],
  man: ['neatly styled dark wavy hair', 'short tousled black hair', 'swept-back hair with a few loose strands', 'a clean short crop', 'longer hair tied at the nape', 'soft curls falling over the forehead'],
}

const ANIME_POSES = [
  'leaning against a wall with one hand in a pocket',
  'one hand resting lightly on a railing',
  'glancing back over one shoulder',
  'adjusting a cuff',
  'standing with arms loosely crossed',
  'one hand touching the edge of a doorframe',
  'seated naturally with one arm resting beside them',
]

const ANIME_EXPRESSIONS = ['a poised playful smile', 'a thoughtful gaze', 'a quiet confident half-smile', 'a warm amused look', 'a composed, charismatic look', 'a soft curious look']

const ANIME_EYES = ['warm amber eyes', 'soft grey-violet eyes', 'deep brown eyes', 'grey-green eyes', 'dark hazel eyes', 'clear honey-brown eyes']

export interface AnimeVariationSpec {
  gender: Gender
  age: number
  skin: string
  hair: string
  eyes: string
  outfit: string
  scene: string
  pose: string
  expression: string
}

export function rollAnimeVariations(count: number, random: () => number = Math.random, gender: Gender | 'any' = 'any'): AnimeVariationSpec[] {
  const scenes = shuffled(ANIME_SCENES, random)
  const skins = shuffled(GAME_SKIN, random)
  const eyes = shuffled(ANIME_EYES, random)
  const poses = shuffled(ANIME_POSES, random)
  const expressions = shuffled(ANIME_EXPRESSIONS, random)
  const ages = shuffled(spreadAges(24, 45, count, random), random)
  const hair = { woman: shuffled(ANIME_HAIR.woman, random), man: shuffled(ANIME_HAIR.man, random) }
  const outfits = { woman: shuffled(ANIME_OUTFITS.woman, random), man: shuffled(ANIME_OUTFITS.man, random) }
  const used = { woman: 0, man: 0 }
  return Array.from({ length: count }, (_, i) => {
    const g: Gender = gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender
    const n = used[g]++
    return {
      gender: g,
      age: ages[i],
      skin: skins[i % skins.length],
      hair: hair[g][n % hair[g].length],
      eyes: eyes[i % eyes.length],
      outfit: outfits[g][n % outfits[g].length],
      scene: scenes[i % scenes.length],
      pose: poses[i % poses.length],
      expression: expressions[i % expressions.length],
    }
  })
}

/** "woman · an emerald satin slip dress · a quiet jazz bar" */
export function animeLine(v: AnimeVariationSpec): string {
  const short = (s: string) => s.split(/,| with | at /)[0].trim()
  return `${v.gender} · ${short(v.outfit)} · ${short(v.scene)}`
}

// Fantasy anime: hand-painted 2D anime game key art, modelled on the two
// concepts the user approved (Airi, a sky-map cartographer above a cloud
// city; Renna, a glass-garden knight). Each is an adult role in its own
// painterly world with an elaborate but coherent costume and one signature
// item. No creatures or mounts: one character only.
const FANTASY_ROLES = [
  { role: 'lantern-festival mage', world: 'a river city strung with paper lanterns at night', item: 'a staff hung with tiny glass lanterns', palette: 'warm gold and deep indigo' },
  { role: 'sky-ship navigator', world: 'the deck of a wooden airship above sunset clouds', item: 'a brass spyglass', palette: 'amber and sky blue' },
  { role: 'desert star-reader', world: 'a moonlit desert observatory of carved sandstone arches', item: 'a folding bronze star chart', palette: 'midnight blue and sand gold' },
  { role: 'forest spirit archer', world: 'an ancient giant forest with glowing moss at dusk', item: 'an ornate wooden bow wrapped in vines', palette: 'emerald and soft gold' },
  { role: 'tide-temple keeper', world: 'a sea temple with waves breaking on marble steps', item: 'a pearl-tipped staff', palette: 'aqua and pearl white' },
  { role: 'snow-peak wanderer', world: 'a snowy mountain monastery hung with bronze bells', item: 'a carved walking staff and a fur-lined cloak', palette: 'ice blue and crimson' },
  { role: 'clockwork-city inventor', world: 'a city of brass towers and turning gears at golden hour', item: 'a clockwork gauntlet', palette: 'copper and teal' },
  { role: 'blossom-courtyard duelist', world: 'a courtyard of falling blossoms in morning light', item: 'a slim sheathed blade with a silk tassel', palette: 'blush pink and ink black' },
]

const FANTASY_HAIR: Record<Gender, string[]> = {
  woman: ['short copper curls', 'a long auburn braid', 'long silver hair with a jewelled clip', 'a black bob with a single blue streak', 'long wavy honey-blonde hair', 'high-tied dark hair with loose strands'],
  man: ['tousled silver-white hair', 'shoulder-length black hair tied back', 'short spiky auburn hair', 'long dark hair in a single braid', 'windswept sandy hair', 'a neat dark undercut'],
}

export interface FantasyAnimeVariationSpec {
  gender: Gender
  age: number
  role: string
  world: string
  item: string
  palette: string
  skin: string
  hair: string
  eyes: string
  expression: string
}

export function rollFantasyAnimeVariations(count: number, random: () => number = Math.random, gender: Gender | 'any' = 'any'): FantasyAnimeVariationSpec[] {
  const roles = shuffled(FANTASY_ROLES, random)
  const skins = shuffled(GAME_SKIN, random)
  const eyes = shuffled(ANIME_EYES, random)
  const expressions = shuffled(ANIME_EXPRESSIONS, random)
  const ages = shuffled(spreadAges(22, 45, count, random), random)
  const hair = { woman: shuffled(FANTASY_HAIR.woman, random), man: shuffled(FANTASY_HAIR.man, random) }
  const used = { woman: 0, man: 0 }
  return Array.from({ length: count }, (_, i) => {
    const g: Gender = gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender
    return {
      gender: g,
      age: ages[i],
      ...roles[i % roles.length],
      skin: skins[i % skins.length],
      hair: hair[g][used[g]++ % hair[g].length],
      eyes: eyes[i % eyes.length],
      expression: expressions[i % expressions.length],
    }
  })
}

// 3D chibi: polished, expressive family-film 3D characters with rounded chibi
// proportions, modelled on the three concepts the user approved (Anika in a
// spring garden, Ayaan with a comically stubborn frown, Zuri bouncing into
// frame). Two of the three stand on a plain pastel studio backdrop, so half
// the places are studio backdrops; expressions are big and a little comic.
// A family cast — children, young adults and grandparents — always fully
// clothed and age-appropriate.
const CHIBI_CAST: { who: string; gender: Gender; age: number; hair: string[] }[] = [
  { who: 'little girl', gender: 'woman', age: 7, hair: ['two puffy pigtails tied with ribbons', 'a short bob with a star-shaped clip', 'a long braid with a small flower'] },
  { who: 'little boy', gender: 'man', age: 8, hair: ['messy short hair with a cowlick', 'soft curly hair', 'neatly side-parted hair'] },
  { who: 'young woman', gender: 'woman', age: 28, hair: ['a high ponytail', 'shoulder-length wavy hair', 'a loose low bun'] },
  { who: 'young man', gender: 'man', age: 30, hair: ['short tousled hair', 'a neat undercut', 'wavy hair swept back'] },
  { who: 'grandmother', gender: 'woman', age: 66, hair: ['a silver bun', 'short curly grey hair'] },
  { who: 'grandfather', gender: 'man', age: 68, hair: ['white hair with round glasses', 'a bald crown with a white moustache'] },
]

const CHIBI_OUTFITS_INDIAN: Record<Gender, string[]> = {
  woman: ['a mustard cotton frock with a mirror-work yoke', 'a teal silk pavadai with a gold border', 'a lilac anarkali with a light dupatta draped securely', 'a peach cotton salwar kameez with a printed dupatta'],
  man: ['a white kurta with a saffron nehru jacket', 'a sky-blue kurta pyjama', 'a cream sherwani with a maroon stole', 'a checked half-sleeve shirt with shorts and a small backpack'],
}

const CHIBI_OUTFITS_GENERAL: Record<Gender, string[]> = {
  woman: ['a yellow raincoat with red rain boots', 'denim dungarees over a striped tee', 'a floral sundress with a straw hat', 'a cozy knitted cardigan over a pleated skirt'],
  man: ['a green hoodie with sneakers', 'a checked flannel shirt with corduroy trousers', 'a denim jacket over a white tee', 'a striped polo with khaki shorts'],
}

const CHIBI_SCENES = [
  'a plain warm-neutral studio backdrop with a soft floor shadow',
  'a clean pale sky-blue studio backdrop with a soft floor shadow',
  'a soft mint studio backdrop with a soft floor shadow',
  'a pale peach studio backdrop with a soft floor shadow',
  'a sunny courtyard hung with marigold garlands',
  'a monsoon street with puddles and bright umbrellas',
  'a rooftop at kite-flying time under a pastel sky',
  'a little bookshop corner with lanterns',
]

const CHIBI_POSES = [
  'arms folded and one foot planted forward, with a comically determined frown',
  'one hand waving and one knee bent as if just bounced into frame, with an exuberant sideways grin',
  'hands on hips, chin up, with a proud cheeky smile',
  'giggling with both hands pressed to the cheeks',
  'head tilted and one finger on the chin, with a comically puzzled look',
  'mid-twirl with arms out and a delighted open smile',
]

export interface ChibiVariationSpec {
  who: string
  gender: Gender
  age: number
  look: string
  skinTone?: string
  hair: string
  outfit: string
  scene: string
  pose: string
}

export function rollChibiVariations(count: number, random: () => number = Math.random, look = 'a mix'): ChibiVariationSpec[] {
  const trimmed = look.trim()
  const isMix = /^(a )?mix\b/i.test(trimmed) || trimmed === ''
  const isIndian = /\bindian\b/i.test(trimmed)
  // Alternate girls/women and boys/men, spread across the age groups.
  const women = shuffled(CHIBI_CAST.filter((c) => c.gender === 'woman'), random)
  const men = shuffled(CHIBI_CAST.filter((c) => c.gender === 'man'), random)
  const looks = shuffled(MIX_LOOKS, random)
  const skins = shuffled(INDIAN_SKIN_TONES, random)
  const scenes = shuffled(CHIBI_SCENES, random)
  const poses = shuffled(CHIBI_POSES, random)
  const outfits = {
    indian: { woman: shuffled(CHIBI_OUTFITS_INDIAN.woman, random), man: shuffled(CHIBI_OUTFITS_INDIAN.man, random) },
    general: { woman: shuffled(CHIBI_OUTFITS_GENERAL.woman, random), man: shuffled(CHIBI_OUTFITS_GENERAL.man, random) },
  }
  const used = { indian: { woman: 0, man: 0 }, general: { woman: 0, man: 0 } }
  return Array.from({ length: count }, (_, i) => {
    const cast = i % 2 === 0 ? women[(i / 2) % women.length] : men[((i - 1) / 2) % men.length]
    const personLook = isMix ? looks[i % looks.length] : trimmed
    const indianLook = isIndian || personLook === 'Indian'
    const pool = indianLook ? 'indian' : 'general'
    return {
      who: cast.who,
      gender: cast.gender,
      age: cast.age,
      look: personLook,
      ...(indianLook ? { skinTone: skins[i % skins.length] } : {}),
      hair: cast.hair[Math.floor(random() * cast.hair.length)],
      outfit: outfits[pool][cast.gender][used[pool][cast.gender]++ % outfits[pool][cast.gender].length],
      scene: scenes[i % scenes.length],
      pose: poses[i % poses.length],
    }
  })
}

/** "Indian little girl · a teal silk pavadai · a sunny courtyard" */
export function chibiLine(v: ChibiVariationSpec): string {
  const short = (s: string) => s.split(/,| with | hung | under | in /)[0].trim()
  return `${v.look} ${v.who} · ${short(v.outfit)} · ${short(v.scene)}`
}

// Storybook anime: warm hand-painted 2D anime of quiet everyday life,
// modelled on the concepts the user picked (Kavya carrying a basket of
// vegetables through a kitchen of brass and steel pots; Meera at a bus
// window above paddy fields). Each person is caught in one small everyday
// moment in a lived-in place. An Indian look gets Indian places and clothes.
const STORYBOOK_MOMENTS_INDIAN = [
  'on a rooftop terrace pegging washing in an afternoon breeze',
  'at a small tea stall on a rainy evening, holding a glass of chai',
  'in a courtyard beside a tulsi planter, finishing a rangoli',
  'walking a bicycle down a tree-lined lane',
  'on a railway platform beside a steel trunk, waiting for a train',
  'at a flower market stall, stringing jasmine garlands',
  'in a library reading room under slow ceiling fans, reading a book',
  'on riverside ghat steps at dusk with a small brass lamp',
]

const STORYBOOK_MOMENTS_GENERAL = [
  'in a seaside-town bakery at dawn, carrying a tray of bread',
  'at the window of a hillside tram, gazing out at the view',
  'on a sunlit rooftop pegging washing in a breeze',
  'in a cozy bookshop, reaching for a book on a high shelf',
  'at a rainy bus stop, sheltering under a big umbrella',
  'tending tomato plants in a small balcony garden',
  'walking a bicycle down a country lane lined with wildflowers',
  'at a market stall, choosing fruit from a crate',
]

const STORYBOOK_OUTFITS_INDIAN: Record<Gender, string[]> = {
  woman: ['a maroon handloom saree with a mango-motif border', 'an indigo block-print kurta with a white dupatta', 'a green cotton salwar kameez', 'a peach chikankari kurti', 'a sky-blue cotton saree with a thin silver border'],
  man: ['a white cotton kurta with rolled sleeves', 'a checked half-sleeve shirt with trousers and a cloth jhola bag', 'a mustard kurta', 'a faded blue shirt with a folded veshti', 'a grey sweater vest over a white shirt'],
}

const STORYBOOK_OUTFITS_GENERAL: Record<Gender, string[]> = {
  woman: ['a cream blouse with a long olive skirt', 'a striped linen shirt-dress', 'a knitted cardigan over a floral dress', 'dungarees over a white tee with a headscarf', 'a navy pinafore dress with a yellow blouse'],
  man: ['a rolled-sleeve white shirt with braces', 'a cable-knit sweater with corduroy trousers', 'a denim work shirt', 'a flat cap with a tweed waistcoat', 'a checked flannel shirt'],
}

const STORYBOOK_EXPRESSIONS = ['a soft content smile', 'a quiet thoughtful gaze', 'a warm amused look', 'a gentle faraway look', 'a small shy smile', 'a bright, open smile']

export interface StorybookVariationSpec {
  gender: Gender
  age: number
  look: string
  skin: string
  hair: string
  outfit: string
  moment: string
  expression: string
}

export function rollStorybookVariations(count: number, random: () => number = Math.random, look = 'a mix', gender: Gender | 'any' = 'any'): StorybookVariationSpec[] {
  const trimmed = look.trim()
  const isMix = /^(a )?mix\b/i.test(trimmed) || trimmed === ''
  const isIndian = /\bindian\b/i.test(trimmed)
  const looks = shuffled(MIX_LOOKS, random)
  const indianSkins = shuffled(INDIAN_SKIN_TONES, random)
  const skins = shuffled(GAME_SKIN, random)
  const ages = shuffled(spreadAges(22, 45, count, random), random)
  const expressions = shuffled(STORYBOOK_EXPRESSIONS, random)
  const hair = { woman: shuffled(HAIR.woman, random), man: shuffled(HAIR.man, random) }
  const moments = { indian: shuffled(STORYBOOK_MOMENTS_INDIAN, random), general: shuffled(STORYBOOK_MOMENTS_GENERAL, random) }
  const outfits = {
    indian: { woman: shuffled(STORYBOOK_OUTFITS_INDIAN.woman, random), man: shuffled(STORYBOOK_OUTFITS_INDIAN.man, random) },
    general: { woman: shuffled(STORYBOOK_OUTFITS_GENERAL.woman, random), man: shuffled(STORYBOOK_OUTFITS_GENERAL.man, random) },
  }
  const used = { hair: { woman: 0, man: 0 }, indian: { woman: 0, man: 0 }, general: { woman: 0, man: 0 }, moment: { indian: 0, general: 0 } }
  return Array.from({ length: count }, (_, i) => {
    const g: Gender = gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender
    const personLook = isMix ? looks[i % looks.length] : trimmed
    const pool = isIndian || personLook === 'Indian' ? 'indian' : 'general'
    return {
      gender: g,
      age: ages[i],
      look: personLook,
      skin: pool === 'indian' ? indianSkins[i % indianSkins.length] : skins[i % skins.length],
      hair: hair[g][used.hair[g]++ % hair[g].length],
      outfit: outfits[pool][g][used[pool][g]++ % outfits[pool][g].length],
      moment: moments[pool][used.moment[pool]++ % moments[pool].length],
      expression: expressions[i % expressions.length],
    }
  })
}

/** "Indian woman · a maroon handloom saree · at a small tea stall" */
export function storybookLine(v: StorybookVariationSpec): string {
  const short = (s: string) => s.split(/,| with /)[0].trim()
  return `${v.look} ${v.gender} · ${short(v.outfit)} · ${short(v.moment)}`
}

// TVC actors: polished lead actors for TV-commercial avatars, cast like a
// premium brand shoot — styled wardrobe, a commercial set, cinema lighting.
// An Indian look gets Indian festive and formal wardrobe and Indian sets.
const TVC_WARDROBE_INDIAN: Record<Gender, string[]> = {
  woman: [
    'an ivory silk saree with a gold zari border and a sleeveless blouse',
    'a deep emerald velvet lehenga with antique-gold embroidery',
    'a mustard chanderi anarkali with a sheer dupatta',
    'a wine-red organza saree with a sequinned border',
    'a powder-blue sharara set with mirror work',
    'a tailored ivory pantsuit with a silk camisole',
  ],
  man: [
    'a midnight-blue bandhgala with antique buttons',
    'an ivory raw-silk sherwani with a maroon stole',
    'a charcoal three-piece suit',
    'a pastel linen kurta with a nehru jacket',
    'a black tuxedo with an open collar',
    'a sand-coloured linen suit over a white shirt',
  ],
}

const TVC_WARDROBE_GENERAL: Record<Gender, string[]> = {
  woman: [
    'a powder-blue satin slip gown',
    'a black tailored tuxedo dress',
    'a camel wrap coat over a cream knit',
    'an emerald silk midi dress',
    'a white structured shirt dress with a slim belt',
    'a rust linen co-ord set',
  ],
  man: [
    'a navy double-breasted suit',
    'a camel overcoat over a black turtleneck',
    'a white linen shirt with tailored grey trousers',
    'a black tuxedo with a bow tie',
    'a deep green velvet blazer over a cream shirt',
    'a light-blue oxford shirt with chinos',
  ],
}

const TVC_SETS = [
  'a clean light-grey studio seamless',
  'a luxury living-room set with warm practical lamps',
  'a sunlit marble terrace set',
  'a premium modern kitchen set in morning light',
  'a boutique hotel lobby set',
  'a rooftop set at golden hour',
]

const TVC_SETS_INDIAN = [
  'a clean light-grey studio seamless',
  'a haveli courtyard set with carved sandstone arches',
  'a festive home set with diyas and marigold garlands',
  'a luxury living-room set with brass lamps and silk cushions',
  'a sunlit terrace set with bougainvillea',
  'a premium modern kitchen set in morning light',
]

// Casting fits the product, the way a real TVC brief does: a skincare actor
// is cast skin-first in soft minimal wardrobe on a bright vanity set, not in
// a suit on a terrace. Each category brings its own wardrobe, sets and
// grooming; "premium" (jewellery, fashion, or nothing named) keeps the dressy
// pools above.
export type TvcCategory = 'beauty' | 'jewellery' | 'fashion' | 'home' | 'food' | 'professional' | 'premium'

interface TvcCategoryPools {
  wardrobe: { indian: Record<Gender, string[]>; general: Record<Gender, string[]> }
  sets: { indian: string[]; general: string[] }
  grooming: string
}

const TVC_PREMIUM: TvcCategoryPools = {
  wardrobe: { indian: TVC_WARDROBE_INDIAN, general: TVC_WARDROBE_GENERAL },
  sets: { indian: TVC_SETS_INDIAN, general: TVC_SETS },
  grooming: 'professional grooming and polished makeup',
}

const TVC_CATEGORIES: Record<Exclude<TvcCategory, 'premium' | 'fashion'>, TvcCategoryPools> = {
  beauty: {
    wardrobe: {
      indian: {
        woman: ['a soft white chikankari kurta', 'an ivory mulmul kurta with a sheer dupatta', 'a blush-pink silk blouse', 'a pastel cotton saree with a thin border', 'a peach cotton kurta with tiny buttons', 'a sage mulmul kurti'],
        man: ['a white cotton kurta', 'a pastel linen shirt', 'a sage cotton kurta', 'an ivory linen kurta', 'a beige mulmul kurta', 'a soft blue cotton kurta'],
      },
      general: {
        woman: ['a soft white ribbed knit top', 'an ivory silk camisole', 'a blush-pink cashmere wrap', 'an oatmeal off-shoulder knit', 'a white cotton bathrobe', 'a sage satin slip top'],
        man: ['a crisp white t-shirt', 'a heather-grey crew-neck knit', 'an open-collar white linen shirt', 'a navy henley', 'a grey waffle bathrobe', 'a soft beige knit polo'],
      },
    },
    sets: {
      indian: ['a bright white bathroom vanity set with soft daylight', 'a clean pastel studio seamless', 'a sunlit bedroom set with sheer curtains', 'a soft daylight window set with a marble ledge and a brass bowl', 'a minimalist spa set with stone and greenery', 'a clean light-grey studio seamless'],
      general: ['a bright white bathroom vanity set with soft daylight', 'a clean pastel studio seamless', 'a sunlit bedroom set with sheer curtains', 'a soft daylight window set with a marble ledge', 'a minimalist spa set with stone and greenery', 'a clean light-grey studio seamless'],
    },
    grooming: 'fresh, dewy, glowing skin with minimal makeup so the skin carries the shot, healthy natural hair',
  },
  jewellery: {
    wardrobe: TVC_PREMIUM.wardrobe,
    sets: TVC_PREMIUM.sets,
    grooming: 'polished makeup, hair styled away from the neck and ears so jewellery shows, clean bare neckline and wrists ready for the product',
  },
  home: {
    wardrobe: {
      indian: {
        woman: ['a soft-printed cotton salwar kameez', 'a pastel cotton kurta with palazzos', 'a light cotton saree', 'a cream cardigan over a cotton kurta', 'a chambray shirt with linen trousers', 'a mint cotton kurta'],
        man: ['a casual pastel kurta', 'a chambray shirt', 'a striped linen shirt', 'a heather-grey polo', 'a cream cotton kurta with a light jacket', 'a soft navy henley'],
      },
      general: {
        woman: ['a cream cardigan over a white tee', 'a chambray shirt', 'a striped linen shirt', 'a pastel cotton shirt dress', 'a soft grey knit sweater', 'a sage linen blouse'],
        man: ['a chambray shirt', 'a striped linen shirt', 'a heather-grey polo', 'a soft navy henley', 'a cream knit sweater', 'a light denim shirt'],
      },
    },
    sets: {
      indian: ['a bright modern Indian kitchen set', 'a warm family living-room set with soft daylight', 'a sunlit dining set', 'a tidy laundry-room set', 'a calm bedroom set with daylight', 'a clean light-grey studio seamless'],
      general: ['a bright modern kitchen set', 'a warm family living-room set with soft daylight', 'a sunlit dining set', 'a tidy laundry-room set', 'a calm bedroom set with daylight', 'a clean light-grey studio seamless'],
    },
    grooming: 'natural, approachable grooming with light everyday makeup',
  },
  food: {
    wardrobe: {
      indian: {
        woman: ['a bright cotton kurta', 'a mustard cotton top with jeans', 'a coral cotton saree', 'a white linen shirt', 'a printed cotton co-ord set', 'a soft denim shirt'],
        man: ['a bright cotton kurta', 'a crisp white t-shirt', 'a striped linen shirt', 'a soft denim shirt', 'a pastel polo', 'a mustard henley'],
      },
      general: {
        woman: ['a white linen shirt', 'a mustard knit top', 'a striped breton top', 'a soft denim shirt', 'a coral cotton dress', 'a cream cardigan'],
        man: ['a crisp white t-shirt', 'a striped linen shirt', 'a soft denim shirt', 'a pastel polo', 'a navy henley', 'a mustard knit sweater'],
      },
    },
    sets: {
      indian: ['a bright modern Indian kitchen set', 'a family dining-table set in warm light', 'a festive dining set with brass thalis', 'a cosy café set', 'a sunny balcony breakfast set', 'a clean light-grey studio seamless'],
      general: ['a bright modern kitchen set', 'a family dining-table set in warm light', 'a cosy café set', 'a sunny breakfast-nook set', 'a picnic set on a lawn', 'a clean light-grey studio seamless'],
    },
    grooming: 'natural, warm grooming with light everyday makeup',
  },
  professional: {
    wardrobe: {
      indian: {
        woman: ['a navy tailored blazer over a silk blouse', 'a crisp white shirt with a grey blazer', 'a handloom cotton saree with a structured blouse', 'a charcoal pantsuit', 'a straight-cut kurta with a tailored jacket', 'a camel blazer over a cream top'],
        man: ['a navy suit with an open-collar shirt', 'a crisp white shirt with a grey blazer', 'a charcoal bandhgala', 'a light-blue shirt with a navy blazer', 'a camel blazer over a white tee', 'a grey suit with a knit tie'],
      },
      general: {
        woman: ['a navy tailored blazer over a silk blouse', 'a crisp white shirt with a grey blazer', 'a charcoal pantsuit', 'a camel blazer over a cream top', 'a black sheath dress with a blazer', 'a soft blue shirt with tailored trousers'],
        man: ['a navy suit with an open-collar shirt', 'a crisp white shirt with a grey blazer', 'a light-blue shirt with a navy blazer', 'a camel blazer over a white tee', 'a grey suit with a knit tie', 'a charcoal turtleneck under a blazer'],
      },
    },
    sets: {
      indian: ['a bright modern office set with glass walls', 'a calm home-office set', 'a clean clinic set', 'a modern meeting-room set', 'a city-view lounge set', 'a clean light-grey studio seamless'],
      general: ['a bright modern office set with glass walls', 'a calm home-office set', 'a clean clinic set', 'a modern meeting-room set', 'a city-view lounge set', 'a clean light-grey studio seamless'],
    },
    grooming: 'neat, trustworthy grooming with natural makeup',
  },
}

function tvcPools(category: TvcCategory | undefined): TvcCategoryPools {
  if (!category || category === 'premium' || category === 'fashion') return TVC_PREMIUM
  return TVC_CATEGORIES[category]
}

// One signature anchor per actor — the small detail that makes them
// recognisable across every ad and is locked on the continuity bible. A
// jewellery actor gets a facial anchor instead, so it never competes with the
// product they wear.
const TVC_ANCHORS: Record<Gender, string[]> = {
  woman: ['small gold hoop earrings', 'a thin gold chain with a tiny pendant', 'a slim leather-strap watch', 'a single pearl stud in each ear', 'tortoiseshell glasses', 'a delicate stacked ring on the right hand'],
  man: ['a steel-bracelet watch', 'a thin silver ring on the right hand', 'round wire-frame glasses', 'a neat short beard', 'a braided leather bracelet', 'a classic leather-strap watch'],
}

const TVC_FACIAL_ANCHORS = [
  'a small beauty mark near the left eyebrow',
  'a soft dimple in the left cheek',
  'a small beauty mark above the upper lip',
  'a slight gap between the front teeth',
  'a faint scar through the right eyebrow',
  'a small beauty mark on the right cheekbone',
]

export interface TvcVariationSpec {
  gender: Gender
  age: number
  look: string
  skinTone?: string
  faceShape: string
  hair: string
  wardrobe: string
  set: string
  grooming: string
  anchor: string
}

export interface TvcRollInput extends AvatarRollInput {
  category?: TvcCategory
}

export function rollTvcVariations(input: TvcRollInput, random: () => number = Math.random): TvcVariationSpec[] {
  const { count, gender, ageMin, ageMax } = input
  const look = input.look.trim()
  const isMix = /^(a )?mix\b/i.test(look) || look === ''
  const isIndian = /\bindian\b/i.test(look)
  const pools = tvcPools(input.category)
  const genders: Gender[] = Array.from({ length: count }, (_, i) =>
    gender === 'any' ? (i % 2 === 0 ? 'woman' : 'man') : gender)
  const ages = shuffled(spreadAges(ageMin, ageMax, count, random), random)
  const looks = isMix ? shuffled(MIX_LOOKS, random) : []
  const skinTones = shuffled(INDIAN_SKIN_TONES, random)
  const faces = shuffled(FACE_SHAPES, random)
  const sets = { indian: shuffled(pools.sets.indian, random), general: shuffled(pools.sets.general, random) }
  const hair = { woman: shuffled(HAIR.woman, random), man: shuffled(HAIR.man, random) }
  const wardrobe = {
    indian: { woman: shuffled(pools.wardrobe.indian.woman, random), man: shuffled(pools.wardrobe.indian.man, random) },
    general: { woman: shuffled(pools.wardrobe.general.woman, random), man: shuffled(pools.wardrobe.general.man, random) },
  }
  const facialAnchors = input.category === 'jewellery' ? shuffled(TVC_FACIAL_ANCHORS, random) : []
  const anchors = { woman: shuffled(TVC_ANCHORS.woman, random), man: shuffled(TVC_ANCHORS.man, random) }
  const used = { hair: { woman: 0, man: 0 }, indian: { woman: 0, man: 0 }, general: { woman: 0, man: 0 }, set: { indian: 0, general: 0 }, anchor: { woman: 0, man: 0 } }
  return genders.map((g, i) => {
    const personLook = isMix ? looks[i % looks.length] : look
    const pool = isIndian || personLook === 'Indian' ? 'indian' : 'general'
    return {
      gender: g,
      age: ages[i],
      look: personLook,
      ...(pool === 'indian' ? { skinTone: skinTones[i % skinTones.length] } : {}),
      faceShape: faces[i % faces.length],
      hair: hair[g][used.hair[g]++ % hair[g].length],
      wardrobe: wardrobe[pool][g][used[pool][g]++ % wardrobe[pool][g].length],
      set: sets[pool][used.set[pool]++ % sets[pool].length],
      grooming: pools.grooming,
      anchor: facialAnchors.length > 0 ? facialAnchors[i % facialAnchors.length] : anchors[g][used.anchor[g]++ % anchors[g].length],
    }
  })
}

/** "31 · Indian woman · an ivory silk saree · a haveli courtyard set" */
export function tvcLine(v: TvcVariationSpec): string {
  const short = (s: string) => s.split(/,| with /)[0].trim()
  return `${v.age} · ${v.look} ${v.gender} · ${short(v.wardrobe)} · ${short(v.set)}`
}

export const rollTvcVariationsTool = createTool({
  id: 'roll-tvc-variations',
  description: 'Picks distinct details for TVC actor avatar variations so no two look alike: per variation an age, look, face shape, hair, styled wardrobe, commercial set, grooming and one signature anchor, all different across the set, within the look, gender and age range from the brief. Wardrobe, sets and grooming fit the product category. Call once before writing TVC variation prompts. Free.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(6).default(4),
    category: z.enum(['beauty', 'jewellery', 'fashion', 'home', 'food', 'professional', 'premium']).optional()
      .describe('What the actor is for: beauty (skincare, makeup, haircare, personal care), jewellery, fashion (apparel), home (appliances, cleaning, home goods), food (food & beverages), professional (finance, insurance, health, tech, services); premium when nothing fits or nothing is named'),
    look: z.string().describe('The look from the brief exactly as given: "a mix of 4 different looks", "Indian", or the user\'s own words'),
    gender: z.enum(['woman', 'man', 'any']).describe('From the brief; "any" alternates woman and man'),
    ageMin: z.number().int().min(18).max(90).describe('Youngest age the brief allows (18 or older)'),
    ageMax: z.number().int().min(18).max(90).describe('Oldest age the brief allows'),
  }),
  execute: async (inputData, execContext) => {
    const { count, category, look, gender, ageMin, ageMax } = inputData
    const variations = rollTvcVariations({ count, category, look, gender, ageMin: Math.min(ageMin, ageMax), ageMax: Math.max(ageMin, ageMax) })
    emitToolStatus(execContext, `Casting ${variations.length} actors`, variations.map(tvcLine))
    return { variations }
  },
})

// Pixar-style 3D, 2D flat and claymation: the three looks the animated ad
// flow already renders (directorAgent's STYLE "3d_pixar" / "2d_flat" /
// "claymation"), offered as avatar styles so a character made in one of them
// animates in the same look later. Everyday people in everyday places — the
// style carries the character.
export interface ToonVariationSpec {
  gender: Gender
  age: number
  look: string
  skinTone?: string
  hair: string
  outfit: string
  place: string
  gesture: string
}

export function rollToonVariations(count: number, random: () => number = Math.random, look = 'a mix', gender: Gender | 'any' = 'any'): ToonVariationSpec[] {
  const people = rollAvatarVariations({ count, look, gender, ageMin: 22, ageMax: 60 }, random)
  return people.map((p) => ({
    gender: p.gender, age: p.age, look: p.look,
    ...(p.skinTone ? { skinTone: p.skinTone } : {}),
    hair: p.hair, outfit: p.wardrobe, place: p.place.replace(/, softly blurred$/, ''), gesture: p.gesture,
  }))
}

/** "34 · Indian woman · terracotta linen shirt · shaded balcony" */
export function toonLine(v: ToonVariationSpec): string {
  const short = (s: string) => s.split(/,| with /)[0].trim()
  return `${v.age} · ${v.look} ${v.gender} · ${short(v.outfit)} · ${short(v.place)}`
}

// Claymation: a handmade plasticine puppet of an everyday person, modelled on
// the approved Codex concepts (Hari, Arjun, Farida) and the user's own pick
// (Milo). What made them work: a job with one small prop, ONE sculpted
// signature feature, an outfit in 3-4 clay colours, a quirky expression, and a
// plain cloth backdrop so the avatar reuses cleanly. The expression stays
// quirky without closing an eye or covering the face — the still is the
// identity reference later, and a wink there carries into the sheet.
const CLAY_ROLES: Array<{ role: string; prop: string; outfit: Record<Gender, string> }> = [
  { role: 'corner-shop owner', prop: 'a little paper bag of groceries', outfit: { woman: 'a cotton saree with a contrast border', man: 'a half-sleeve shirt and a sleeveless sweater' } },
  { role: 'gardener', prop: 'a tiny trowel', outfit: { woman: 'a long kurta, rolled trousers and a sun hat', man: 'a knitted sweater vest over a shirt and rolled trousers' } },
  { role: 'delivery rider', prop: 'a small taped parcel', outfit: { woman: 'a zip jacket, jeans and sneakers', man: 'a zip jacket, jeans and sneakers' } },
  { role: 'home chef', prop: 'a wooden spoon', outfit: { woman: 'a kurta with a striped apron', man: 'a shirt with rolled sleeves and a striped apron' } },
  { role: 'tea-stall owner', prop: 'a little steel kettle', outfit: { woman: 'a cotton saree with a shawl', man: 'a checked shirt and a towel over one shoulder' } },
  { role: 'school teacher', prop: 'a stack of books', outfit: { woman: 'a cardigan over a kurta', man: 'a cardigan, shirt and trousers' } },
  { role: 'house painter', prop: 'a paintbrush', outfit: { woman: 'dungarees with paint splodges', man: 'dungarees with paint splodges' } },
  { role: 'tailor', prop: 'a measuring tape round the neck', outfit: { woman: 'a printed kurta and dupatta', man: 'a waistcoat over a shirt' } },
]

const CLAY_FEATURES = [
  'a big round clay nose',
  'bushy, very expressive eyebrows',
  'big sticking-out ears',
  'a gap-toothed grin',
  'round rosy cheeks',
  'round wire glasses',
  'a tall swept-up quiff of hair',
  'freckles pressed into the clay',
]

const CLAY_PALETTES = [
  'cobalt blue, tomato red and sunny yellow',
  'mustard, teal and cream',
  'terracotta, olive and off-white',
  'plum, peach and mint',
  'navy, coral and butter yellow',
  'forest green, rust and beige',
  'sky blue, orange and white',
  'maroon, gold and slate grey',
]

const CLAY_BACKDROPS = [
  'a warm sand-beige cloth backdrop',
  'a pale sage cloth backdrop',
  'a dusty-pink paper backdrop',
  'a soft sky-blue cloth backdrop',
  'a creamy oat paper backdrop',
  'a pale peach cloth backdrop',
]

const CLAY_EXPRESSIONS = [
  'a cheeky sideways grin with one eyebrow raised',
  'a big delighted toothy grin, head tilted',
  'a wide-eyed surprised "oh!" with raised eyebrows',
  'a proud chin-up smile, one hand on the hip',
  'a sheepish lopsided smile with a little shrug',
  'a mischievous grin, leaning forward slightly',
]

export interface ClayVariationSpec {
  gender: Gender
  age: number
  look: string
  skinTone?: string
  hair: string
  role: string
  prop: string
  outfit: string
  palette: string
  feature: string
  expression: string
  backdrop: string
}

export function rollClayVariations(count: number, random: () => number = Math.random, look = 'a mix', gender: Gender | 'any' = 'any'): ClayVariationSpec[] {
  const people = rollAvatarVariations({ count, look, gender, ageMin: 22, ageMax: 65 }, random)
  const roles = shuffled(CLAY_ROLES, random)
  const features = shuffled(CLAY_FEATURES, random)
  const palettes = shuffled(CLAY_PALETTES, random)
  const backdrops = shuffled(CLAY_BACKDROPS, random)
  const expressions = shuffled(CLAY_EXPRESSIONS, random)
  return people.map((p, i) => {
    const r = roles[i % roles.length]
    return {
      gender: p.gender, age: p.age, look: p.look,
      ...(p.skinTone ? { skinTone: p.skinTone } : {}),
      hair: p.hair, role: r.role, prop: r.prop, outfit: r.outfit[p.gender],
      palette: palettes[i % palettes.length], feature: features[i % features.length],
      expression: expressions[i % expressions.length], backdrop: backdrops[i % backdrops.length],
    }
  })
}

// Cute claymation: the chunkier, toy-like clay look of the user's own pick
// (Milo) — simple rounded shapes, bright primary clay, playful casual
// outfits, no job or prop. Kept beside the detailed film look above because
// it reads younger and suits kids' and family brands.
const CUTE_CLAY_OUTFITS: Record<Gender, string[]> = {
  woman: ['a colour-block varsity jacket, a T-shirt and rolled jeans', 'chunky dungarees over a striped top', 'a bright raincoat with big buttons and wellies', 'a puffy hoodie, a short skirt over leggings and sneakers', 'a knitted jumper with a big heart patch and wide trousers'],
  man: ['a colour-block varsity jacket, a T-shirt and patched jeans', 'baggy dungarees over a polka-dot top', 'a bright raincoat with toggles and wellies', 'a puffy hoodie, cargo shorts and high-top sneakers', 'a knitted jumper with a big star patch and rolled trousers'],
}

const CUTE_CLAY_PALETTES = [
  'cobalt blue, tomato red and sunny yellow',
  'grass green, orange and sky blue',
  'bubblegum pink, teal and lemon yellow',
  'purple, lime and white',
  'red, navy and cream',
  'turquoise, coral and mustard',
]

export interface CuteClayVariationSpec {
  gender: Gender
  age: number
  look: string
  skinTone?: string
  hair: string
  outfit: string
  palette: string
  expression: string
  backdrop: string
}

export function rollCuteClayVariations(count: number, random: () => number = Math.random, look = 'a mix', gender: Gender | 'any' = 'any'): CuteClayVariationSpec[] {
  const people = rollAvatarVariations({ count, look, gender, ageMin: 20, ageMax: 40 }, random)
  const outfits = { woman: shuffled(CUTE_CLAY_OUTFITS.woman, random), man: shuffled(CUTE_CLAY_OUTFITS.man, random) }
  const used = { woman: 0, man: 0 }
  const palettes = shuffled(CUTE_CLAY_PALETTES, random)
  const backdrops = shuffled(CLAY_BACKDROPS, random)
  const expressions = shuffled(CLAY_EXPRESSIONS, random)
  return people.map((p, i) => ({
    gender: p.gender, age: p.age, look: p.look,
    ...(p.skinTone ? { skinTone: p.skinTone } : {}),
    hair: p.hair, outfit: outfits[p.gender][used[p.gender]++ % outfits[p.gender].length],
    palette: palettes[i % palettes.length], expression: expressions[i % expressions.length], backdrop: backdrops[i % backdrops.length],
  }))
}

/** "Indian woman · chunky dungarees · grass green, orange and sky blue" */
export function cuteClayLine(v: CuteClayVariationSpec): string {
  return `${v.look} ${v.gender} · ${v.outfit.split(/,| over /)[0].trim()} · ${v.palette}`
}

/** "58 · Indian man · gardener · big round clay nose" */
export function clayLine(v: ClayVariationSpec): string {
  return `${v.age} · ${v.look} ${v.gender} · ${v.role} · ${v.feature.replace(/^an? /, '')}`
}

export const rollCharacterVariationsTool = createTool({
  id: 'roll-character-variations',
  description: 'Picks distinct details for animated-character avatar variations, all different across the set. Style "mascot": per variation an original character, one material, a palette with its studio backdrop and a personality caught in an action. Style "game hero": per variation a role in its own world, a signature item, light and palette, age, skin, hair and expression. Style "cinematic anime": per variation skin, hair, eyes, an elegant outfit, a night-city scene, pose and expression. Style "fantasy anime": per variation a role in its own painterly world, a signature item, palette, age, skin, hair, eyes and expression. Style "3d chibi": per variation a family-cast member (child, young adult or grandparent), look, hair, outfit, scene and pose. Style "storybook anime": per variation age, look, skin, hair, outfit, an everyday moment in a lived-in place, and expression. Styles "pixar 3d" and "2d flat": per variation age, look, skin tone, hair, everyday outfit, place and gesture. Style "claymation": per variation age, look, skin tone, hair, an everyday job with one small prop and its outfit, a 3-4 colour clay palette, one sculpted signature feature, a quirky expression and a plain cloth backdrop. Style "cute claymation": per variation age, look, skin tone, hair, a playful casual outfit, a bright clay palette, a quirky expression and a plain cloth backdrop. Call once before writing animated-character variation prompts. Free.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(6).default(4),
    style: z.enum(['mascot', 'game hero', 'cinematic anime', 'fantasy anime', '3d chibi', 'storybook anime', 'pixar 3d', '2d flat', 'claymation', 'cute claymation']).default('mascot').describe('From the brief: "mascot" (cozy 3D mascot), "game hero" (console-game character art), "cinematic anime" (elegant 2D anime), "fantasy anime" (2D anime game key art) "3d chibi" (family-film 3D chibi) "storybook anime" (warm hand-painted everyday life), "pixar 3d", "2d flat" or "claymation" (detailed stop-motion film characters), or "cute claymation" (chunky toy-like clay for kids and family)'),
    look: z.string().default('a mix').describe('3D chibi, storybook anime, pixar 3d, 2d flat, claymation and cute claymation only: the look from the brief exactly as given — "a mix", "Indian", or the user\'s own words'),
    kind: z.enum(['mix', 'creatures', 'objects']).default('mix').describe('Mascots only, from the brief: "creatures", "objects" (objects or food), or "mix" (creatures and objects alternate) when it leaves this open'),
    gender: z.enum(['woman', 'man', 'any']).default('any').describe('Every people style (not mascots or 3D chibi), from the brief; "any" alternates woman and man'),
  }),
  execute: async (inputData, execContext) => {
    if (inputData.style === 'cute claymation') {
      const people = rollCuteClayVariations(inputData.count, Math.random, inputData.look, inputData.gender)
      emitToolStatus(execContext, `Casting ${people.length} characters`, people.map(cuteClayLine))
      return { variations: people }
    }
    if (inputData.style === 'claymation') {
      const people = rollClayVariations(inputData.count, Math.random, inputData.look, inputData.gender)
      emitToolStatus(execContext, `Casting ${people.length} characters`, people.map(clayLine))
      return { variations: people }
    }
    if (inputData.style === 'pixar 3d' || inputData.style === '2d flat') {
      const people = rollToonVariations(inputData.count, Math.random, inputData.look, inputData.gender)
      emitToolStatus(execContext, `Casting ${people.length} characters`, people.map(toonLine))
      return { variations: people }
    }
    if (inputData.style === 'storybook anime') {
      const people = rollStorybookVariations(inputData.count, Math.random, inputData.look, inputData.gender)
      emitToolStatus(execContext, `Casting ${people.length} characters`, people.map(storybookLine))
      return { variations: people }
    }
    if (inputData.style === '3d chibi') {
      const cast = rollChibiVariations(inputData.count, Math.random, inputData.look)
      emitToolStatus(execContext, `Casting ${cast.length} characters`, cast.map(chibiLine))
      return { variations: cast }
    }
    if (inputData.style === 'fantasy anime') {
      const heroes = rollFantasyAnimeVariations(inputData.count, Math.random, inputData.gender)
      emitToolStatus(execContext, `Casting ${heroes.length} characters`, heroes.map(gameHeroLine))
      return { variations: heroes }
    }
    if (inputData.style === 'cinematic anime') {
      const people = rollAnimeVariations(inputData.count, Math.random, inputData.gender)
      emitToolStatus(execContext, `Casting ${people.length} characters`, people.map(animeLine))
      return { variations: people }
    }
    if (inputData.style === 'game hero') {
      const heroes = rollGameHeroVariations(inputData.count, Math.random, inputData.gender)
      emitToolStatus(execContext, `Casting ${heroes.length} characters`, heroes.map(gameHeroLine))
      return { variations: heroes }
    }
    const variations = rollCharacterVariations(inputData.count, Math.random, inputData.kind)
    emitToolStatus(execContext, `Casting ${variations.length} characters`, variations.map(characterLine))
    return { variations }
  },
})

export const rollAvatarVariationsTool = createTool({
  id: 'roll-avatar-variations',
  description: 'Picks distinct details for avatar variations so no two look alike: per variation an age, face shape, hair, outfit, place and gesture, all different across the set, within the look, gender and age range from the brief. Call once before writing the variation prompts. Free.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(6).default(4),
    look: z.string().describe('The look from the brief exactly as given: "a mix of 4 different looks", "Indian", or the user\'s own words'),
    gender: z.enum(['woman', 'man', 'any']).describe('From the brief; "any" alternates woman and man'),
    ageMin: z.number().int().min(18).max(90).describe('Youngest age the brief allows (18 or older)'),
    ageMax: z.number().int().min(18).max(90).describe('Oldest age the brief allows'),
  }),
  execute: async (inputData, execContext) => {
    const { count, look, gender, ageMin, ageMax } = inputData
    const lo = Math.min(ageMin, ageMax)
    const hi = Math.max(ageMin, ageMax)
    const variations = rollAvatarVariations({ count, look, gender, ageMin: lo, ageMax: hi })
    // Director spends a while writing the prompts after this — show who is
    // being cast meanwhile, instead of a bare "Preparing…".
    emitToolStatus(execContext, `Casting ${variations.length} people`, variations.map(castingLine))
    return { variations }
  },
})
