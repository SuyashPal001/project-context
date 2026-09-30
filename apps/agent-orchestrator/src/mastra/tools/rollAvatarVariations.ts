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

// Animated characters: lifelike 3D creatures and plush mascots rather than
// people. Half the set are animals and half are objects, so four characters
// are never four near-identical furry animals.
const CHARACTER_ANIMALS = [
  'long-eared bunny', 'round hedgehog', 'big-eared fennec fox', 'red panda', 'fluffy baby owl',
  'sleepy sloth', 'penguin chick', 'chubby kitten', 'sea otter', 'little frog',
]

const CHARACTER_OBJECTS = [
  'plush cactus with tiny arms', 'fluffy cloud', 'steamed dumpling', 'mushroom sprite with a spotted cap',
  'round avocado', 'little teacup', 'dewdrop-shaped water sprite', 'soft peach',
]

const CHARACTER_MATERIALS = [
  'soft realistic fur with fine individual strands',
  'felted wool plush with visible fibres',
  'chunky knitted-yarn texture',
  'velvety plush fabric with small stitched seams',
  'smooth soft-touch vinyl with a satin sheen',
  'fuzzy cotton-candy fluff',
]

const CHARACTER_ACCESSORIES = [
  'a leafy green knitted hood',
  'a chunky blue knit scarf',
  'pastel over-ear headphones',
  'round wire-rim glasses',
  'a small cross-body satchel',
  'a tiny yellow raincoat',
  'a striped knit beanie',
  'a little canvas apron',
]

const CHARACTER_PLACES = [
  'cozy bedroom with rumpled knit blankets and warm lamp glow',
  'sunlit windowsill with potted plants',
  'mossy forest floor in dappled light',
  'kitchen counter in soft morning light',
  'plain soft-grey studio backdrop',
  'bookshelf corner with warm fairy lights',
]

const CHARACTER_POSES = [
  'standing with small paws or hands clasped in front',
  'waving one small hand at the viewer',
  'sitting with legs stretched out',
  'leaning forward with curiosity',
  'hugging a tiny cushion',
  'standing proudly with hands on hips',
]

const CHARACTER_EXPRESSIONS = [
  'curious wide-eyed look',
  'shy happy smile',
  'sleepy contented look',
  'cheeky grin',
  'bright excited look',
  'warm gentle smile',
]

export interface CharacterVariationSpec {
  character: string
  material: string
  accessory: string
  place: string
  pose: string
  expression: string
}

export function rollCharacterVariations(count: number, random: () => number = Math.random): CharacterVariationSpec[] {
  const animals = shuffled(CHARACTER_ANIMALS, random)
  const objects = shuffled(CHARACTER_OBJECTS, random)
  const materials = shuffled(CHARACTER_MATERIALS, random)
  const accessories = shuffled(CHARACTER_ACCESSORIES, random)
  const places = shuffled(CHARACTER_PLACES, random)
  const poses = shuffled(CHARACTER_POSES, random)
  const expressions = shuffled(CHARACTER_EXPRESSIONS, random)
  return Array.from({ length: count }, (_, i) => ({
    character: i % 2 === 0 ? animals[(i / 2) % animals.length] : objects[((i - 1) / 2) % objects.length],
    material: materials[i % materials.length],
    accessory: accessories[i % accessories.length],
    place: places[i % places.length],
    pose: poses[i % poses.length],
    expression: expressions[i % expressions.length],
  }))
}

/** "red panda · a chunky blue knit scarf · cozy bedroom" */
export function characterLine(v: CharacterVariationSpec): string {
  const short = (s: string) => s.split(/,| with | in /)[0].trim()
  return `${v.character} · ${v.accessory} · ${short(v.place)}`
}

export const rollCharacterVariationsTool = createTool({
  id: 'roll-character-variations',
  description: 'Picks distinct details for animated-character avatar variations — per variation a character (animals and objects alternate), material, accessory, place, pose and expression, all different across the set. Call once before writing animated-character variation prompts. Free.',
  inputSchema: z.object({
    count: z.number().int().min(1).max(6).default(4),
  }),
  execute: async (inputData, execContext) => {
    const variations = rollCharacterVariations(inputData.count)
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
