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
export function gameHeroLine(v: GameHeroVariationSpec): string {
  return `${v.age} · ${v.gender} · ${v.role}`
}

export const rollCharacterVariationsTool = createTool({
  id: 'roll-character-variations',
  description: 'Picks distinct details for animated-character avatar variations, all different across the set. Style "mascot": per variation an original character, one material, a palette with its studio backdrop and a personality caught in an action. Style "game hero": per variation a role in its own world, a signature item, light and palette, age, skin, hair and expression. Call once before writing animated-character variation prompts. Free.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(6).default(4),
    style: z.enum(['mascot', 'game hero']).default('mascot').describe('From the brief: "mascot" (cozy 3D mascot) or "game hero" (console-game character art)'),
    kind: z.enum(['mix', 'creatures', 'objects']).default('mix').describe('Mascots only, from the brief: "creatures", "objects" (objects or food), or "mix" (creatures and objects alternate) when it leaves this open'),
    gender: z.enum(['woman', 'man', 'any']).default('any').describe('Game heroes only, from the brief; "any" alternates woman and man'),
  }),
  execute: async (inputData, execContext) => {
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
