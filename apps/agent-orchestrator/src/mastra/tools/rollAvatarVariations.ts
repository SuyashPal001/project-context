import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

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
      place: places[i % places.length],
      gesture: gestures[i % gestures.length],
    }
  })
}

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
  execute: async (inputData) => {
    const { count, look, gender, ageMin, ageMax } = inputData
    const lo = Math.min(ageMin, ageMax)
    const hi = Math.max(ageMin, ageMax)
    return { variations: rollAvatarVariations({ count, look, gender, ageMin: lo, ageMax: hi }) }
  },
})
