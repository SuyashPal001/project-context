import { describe, it, expect } from 'vitest'
import { rollAvatarVariations } from '../rollAvatarVariations.js'

// Deterministic pseudo-random source so every run rolls the same set.
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

const distinct = <T,>(values: T[]) => new Set(values).size === values.length

describe('rollAvatarVariations', () => {
  it('gives four Indian women who differ in every open attribute, all within the age range', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollAvatarVariations({ count: 4, look: 'Indian', gender: 'woman', ageMin: 22, ageMax: 45 }, seeded(seed))
      expect(set).toHaveLength(4)
      expect(set.every((v) => v.gender === 'woman' && v.look === 'Indian' && v.skinTone)).toBe(true)
      expect(set.every((v) => v.age >= 22 && v.age <= 45)).toBe(true)
      for (const key of ['age', 'faceShape', 'hair', 'wardrobe', 'place', 'gesture', 'skinTone'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
    }
  })

  it('puts an Indian look in Indian homes', () => {
    const set = rollAvatarVariations({ count: 4, look: 'Indian', gender: 'any', ageMin: 22, ageMax: 45 }, seeded(9))
    expect(set.every((v) => /Indian|steel|tulsi|jute|brass|grill|chikankari/i.test(v.place))).toBe(true)
  })

  it('makes a mix four different looks', () => {
    const set = rollAvatarVariations({ count: 4, look: 'a mix of 4 different looks', gender: 'woman', ageMin: 25, ageMax: 40 }, seeded(7))
    expect(distinct(set.map((v) => v.look))).toBe(true)
    expect(set.some((v) => /mix/i.test(v.look))).toBe(false)
  })

  it('keeps a free-text look as given and adds no skin tone for it', () => {
    const set = rollAvatarVariations({ count: 4, look: 'Korean', gender: 'man', ageMin: 30, ageMax: 50 }, seeded(3))
    expect(set.every((v) => v.look === 'Korean' && v.gender === 'man' && v.skinTone === undefined)).toBe(true)
    expect(distinct(set.map((v) => v.hair))).toBe(true)
  })

  it('alternates woman and man for gender any, without repeating hair or outfit within a gender', () => {
    const set = rollAvatarVariations({ count: 4, look: 'Indian', gender: 'any', ageMin: 20, ageMax: 50 }, seeded(11))
    expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
    const women = set.filter((v) => v.gender === 'woman')
    expect(distinct(women.map((v) => v.hair)) && distinct(women.map((v) => v.wardrobe))).toBe(true)
  })

  it('never rolls freckles or model-look wording', () => {
    const set = rollAvatarVariations({ count: 6, look: 'a mix', gender: 'any', ageMin: 18, ageMax: 70 }, seeded(5))
    expect(JSON.stringify(set)).not.toMatch(/freckle|model|symmetr/i)
  })
})

describe('rollCharacterVariations', () => {
  const OBJECTS = /diya|kulhad|mango|yarn|kite|pencil|bun|honey|pinecone|bulb/

  it('gives four characters that differ in every attribute, alternating creatures and objects', async () => {
    const { rollCharacterVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollCharacterVariations(4, seeded(seed))
      expect(set).toHaveLength(4)
      for (const key of ['character', 'material', 'palette', 'backdrop', 'personality'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
      expect(OBJECTS.test(set[0].character)).toBe(false)
      expect(OBJECTS.test(set[1].character)).toBe(true)
    }
  })

  it('keeps to creatures or objects when the brief asks for one kind', async () => {
    const { rollCharacterVariations } = await import('../rollAvatarVariations.js')
    const creatures = rollCharacterVariations(4, seeded(4), 'creatures')
    const things = rollCharacterVariations(4, seeded(4), 'objects')
    expect(creatures.every((v) => !OBJECTS.test(v.character)) && distinct(creatures.map((v) => v.character))).toBe(true)
    expect(things.every((v) => OBJECTS.test(v.character)) && distinct(things.map((v) => v.character))).toBe(true)
  })

  it('never rolls the generic mascots other libraries already show', async () => {
    const { rollCharacterVariations } = await import('../rollAvatarVariations.js')
    const all = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => rollCharacterVariations(6, seeded(seed))))
    expect(all).not.toMatch(/bunny|rabbit|hedgehog|fox|cactus|cloud|dumpling|skeleton/i)
  })

  it('reads as one short line', async () => {
    const { characterLine } = await import('../rollAvatarVariations.js')
    expect(characterLine({
      character: 'tiny axolotl with frilly gill fronds', material: 'glazed ceramic with small handmade irregularities',
      palette: 'peach and rose', backdrop: 'pale lilac', personality: 'caring and gently confident, giving a welcoming wave',
    })).toBe('tiny axolotl · glazed ceramic · caring and gently confident')
  })
})

describe('rollGameHeroVariations', () => {
  it('gives four adults in different roles, worlds, skin, hair and expressions, alternating women and men', async () => {
    const { rollGameHeroVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollGameHeroVariations(4, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      expect(set.every((v) => v.age >= 22 && v.age <= 60)).toBe(true)
      for (const key of ['role', 'world', 'item', 'light', 'skin', 'hair', 'expression', 'age'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
    }
  })

  it('keeps one gender when the brief gives it', async () => {
    const { rollGameHeroVariations } = await import('../rollAvatarVariations.js')
    const set = rollGameHeroVariations(4, seeded(2), 'woman')
    expect(set.every((v) => v.gender === 'woman') && distinct(set.map((v) => v.hair))).toBe(true)
  })
})

describe('rollAnimeVariations', () => {
  it('gives four adults with different outfits, scenes and looks, alternating women and men, never armour or weapons', async () => {
    const { rollAnimeVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollAnimeVariations(4, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      expect(set.every((v) => v.age >= 24 && v.age <= 45)).toBe(true)
      for (const key of ['skin', 'eyes', 'outfit', 'scene', 'pose', 'expression'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
      expect(JSON.stringify(set)).not.toMatch(/armou?r|sword|weapon|bow\b|spear/i)
    }
  })
})

describe('rollFantasyAnimeVariations', () => {
  it('gives four adults in different roles, worlds, items and looks, alternating women and men', async () => {
    const { rollFantasyAnimeVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollFantasyAnimeVariations(4, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      expect(set.every((v) => v.age >= 22 && v.age <= 45)).toBe(true)
      for (const key of ['role', 'world', 'item', 'palette', 'skin', 'hair', 'eyes', 'expression'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
    }
  })
})

describe('rollChibiVariations', () => {
  it('casts four different family members, alternating girls/women and boys/men, all in modest outfits', async () => {
    const { rollChibiVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollChibiVariations(4, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      for (const key of ['who', 'look', 'outfit', 'scene', 'pose'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
      expect(JSON.stringify(set)).not.toMatch(/bikini|swim|crop top|lingerie|revealing/i)
      expect(set.every((v) => v.scene.length > 0)).toBe(true)
    }
  })

  it('dresses an Indian look in Indian outfits with Indian skin tones', async () => {
    const { rollChibiVariations } = await import('../rollAvatarVariations.js')
    const set = rollChibiVariations(4, seeded(6), 'Indian')
    expect(set.every((v) => v.look === 'Indian' && v.skinTone && /kurta|frock|pavadai|anarkali|salwar|sherwani|checked/.test(v.outfit))).toBe(true)
  })
})

describe('rollStorybookVariations', () => {
  it('gives four adults in different everyday moments, outfits and looks', async () => {
    const { rollStorybookVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollStorybookVariations(4, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      expect(set.every((v) => v.age >= 22 && v.age <= 45)).toBe(true)
      for (const key of ['look', 'outfit', 'moment', 'expression'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
    }
  })

  it('puts an Indian look in Indian places and clothes', async () => {
    const { rollStorybookVariations } = await import('../rollAvatarVariations.js')
    const set = rollStorybookVariations(4, seeded(3), 'Indian', 'woman')
    expect(set.every((v) => /saree|kurta|salwar|kurti/.test(v.outfit))).toBe(true)
    expect(set.every((v) => /chai|tulsi|rangoli|railway|jasmine|ghat|library|rooftop|bicycle/.test(v.moment))).toBe(true)
    expect(distinct(set.map((v) => v.moment))).toBe(true)
  })
})

describe('rollTvcVariations', () => {
  it('casts four actors who differ in age, face, hair, wardrobe and set, within the range', async () => {
    const { rollTvcVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollTvcVariations({ count: 4, look: 'a mix of 4 different looks', gender: 'any', ageMin: 22, ageMax: 45 }, seeded(seed))
      expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
      expect(set.every((v) => v.age >= 22 && v.age <= 45)).toBe(true)
      for (const key of ['age', 'look', 'faceShape', 'wardrobe', 'set'] as const) {
        expect(distinct(set.map((v) => v[key]))).toBe(true)
      }
    }
  })

  it('dresses an Indian look in Indian wardrobe on Indian or neutral sets', async () => {
    const { rollTvcVariations } = await import('../rollAvatarVariations.js')
    const set = rollTvcVariations({ count: 4, look: 'Indian', gender: 'woman', ageMin: 22, ageMax: 40 }, seeded(8))
    expect(set.every((v) => v.skinTone && /saree|lehenga|anarkali|sharara|pantsuit/.test(v.wardrobe))).toBe(true)
    expect(distinct(set.map((v) => v.set))).toBe(true)
  })

  it('casts a skincare actor skin-first, in soft wardrobe on bright beauty sets', async () => {
    const { rollTvcVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 20; seed++) {
      const set = rollTvcVariations({ count: 4, category: 'beauty', look: 'a mix of 4 different looks', gender: 'any', ageMin: 22, ageMax: 45 }, seeded(seed))
      expect(set.every((v) => !/suit|tuxedo|gown|overcoat|blazer/.test(v.wardrobe))).toBe(true)
      expect(set.every((v) => /vanity|studio|bedroom|window|spa/.test(v.set))).toBe(true)
      expect(set.every((v) => /minimal makeup/.test(v.grooming))).toBe(true)
      expect(distinct(set.map((v) => v.wardrobe))).toBe(true)
      expect(distinct(set.map((v) => v.anchor))).toBe(true)
    }
  })

  it('gives a jewellery actor a facial anchor so it never competes with the product', async () => {
    const { rollTvcVariations } = await import('../rollAvatarVariations.js')
    const set = rollTvcVariations({ count: 4, category: 'jewellery', look: 'Indian', gender: 'woman', ageMin: 22, ageMax: 40 }, seeded(3))
    expect(set.every((v) => /beauty mark|dimple|gap|scar/.test(v.anchor))).toBe(true)
    expect(set.every((v) => /neck and ears/.test(v.grooming))).toBe(true)
    expect(distinct(set.map((v) => v.anchor))).toBe(true)
  })

  it('keeps the premium pools when no category is given', async () => {
    const { rollTvcVariations } = await import('../rollAvatarVariations.js')
    const set = rollTvcVariations({ count: 4, look: 'Indian', gender: 'man', ageMin: 22, ageMax: 45 }, seeded(4))
    expect(set.every((v) => /bandhgala|sherwani|suit|kurta|tuxedo/.test(v.wardrobe))).toBe(true)
    expect(set.every((v) => v.anchor.length > 0 && /polished makeup/.test(v.grooming))).toBe(true)
  })
})

describe('normalizeTvcCategory', () => {
  it('passes valid categories through unchanged', async () => {
    const { normalizeTvcCategory } = await import('../rollAvatarVariations.js')
    for (const category of ['beauty', 'jewellery', 'fashion', 'home', 'food', 'professional', 'premium']) {
      expect(normalizeTvcCategory(category)).toBe(category)
    }
  })

  it('maps an unknown category to the nearest valid one', async () => {
    const { normalizeTvcCategory } = await import('../rollAvatarVariations.js')
    expect(normalizeTvcCategory('beverage')).toBe('food')
    expect(normalizeTvcCategory('drink')).toBe('food')
    expect(normalizeTvcCategory('skincare')).toBe('beauty')
    expect(normalizeTvcCategory('apparel')).toBe('fashion')
    expect(normalizeTvcCategory('furniture')).toBe('home')
    expect(normalizeTvcCategory('luxury')).toBe('premium')
    expect(normalizeTvcCategory('tech')).toBe('professional')
  })

  it('is case-insensitive and tolerates whitespace', async () => {
    const { normalizeTvcCategory } = await import('../rollAvatarVariations.js')
    expect(normalizeTvcCategory(' Beverage ')).toBe('food')
    expect(normalizeTvcCategory('BEAUTY')).toBe('beauty')
  })

  it('falls back to premium for anything unrecognised, and undefined for no input', async () => {
    const { normalizeTvcCategory } = await import('../rollAvatarVariations.js')
    expect(normalizeTvcCategory('spaceship')).toBe('premium')
    expect(normalizeTvcCategory(undefined)).toBeUndefined()
    expect(normalizeTvcCategory('')).toBeUndefined()
  })
})

describe('rollToonVariations', () => {
  it('casts four different everyday people for the pixar, 2D flat and claymation styles', async () => {
    const { rollToonVariations } = await import('../rollAvatarVariations.js')
    const set = rollToonVariations(4, seeded(5), 'Indian')
    expect(set.map((v) => v.gender)).toEqual(['woman', 'man', 'woman', 'man'])
    expect(set.every((v) => v.look === 'Indian' && v.skinTone && v.age >= 22 && v.age <= 60)).toBe(true)
    for (const key of ['place', 'gesture', 'age'] as const) expect(distinct(set.map((v) => v[key]))).toBe(true)
  })
})

describe('rollClayVariations', () => {
  it('casts four different clay characters, each with its own job, feature, palette, expression and backdrop', async () => {
    const { rollClayVariations, clayLine } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 10; seed++) {
      const set = rollClayVariations(4, seeded(seed), 'Indian')
      expect(set.every((v) => v.look === 'Indian' && v.skinTone && v.age >= 22 && v.age <= 65)).toBe(true)
      for (const key of ['role', 'feature', 'palette', 'expression', 'backdrop'] as const) expect(distinct(set.map((v) => v[key]))).toBe(true)
      expect(set.every((v) => /backdrop$/.test(v.backdrop))).toBe(true)
      expect(set.every((v) => !/wink|closed eye/.test(v.expression))).toBe(true)
      expect(clayLine(set[0])).toMatch(/^\d+ · Indian (woman|man) · /)
    }
  })
})

describe('rollCuteClayVariations', () => {
  it('casts four young cute-clay characters with different outfits, palettes, expressions and backdrops', async () => {
    const { rollCuteClayVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 10; seed++) {
      const set = rollCuteClayVariations(4, seeded(seed), 'a mix')
      expect(set.every((v) => v.age >= 20 && v.age <= 40)).toBe(true)
      for (const key of ['outfit', 'palette', 'expression', 'backdrop'] as const) expect(distinct(set.map((v) => v[key]))).toBe(true)
    }
  })
})

describe('rollFamily3dVariations and rollDrama3dVariations', () => {
  it('casts four different 3D family-film characters on plain studio backdrops', async () => {
    const { rollFamily3dVariations } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 10; seed++) {
      const set = rollFamily3dVariations(4, seeded(seed), 'Indian')
      expect(set.every((v) => v.age >= 22 && v.age <= 70 && /studio backdrop$/.test(v.backdrop))).toBe(true)
      for (const key of ['prop', 'feature', 'expression', 'backdrop'] as const) expect(distinct(set.map((v) => v[key]))).toBe(true)
    }
  })

  it('casts four different adult movie-drama characters, each with its own emotion and place', async () => {
    const { rollDrama3dVariations, drama3dLine } = await import('../rollAvatarVariations.js')
    for (let seed = 1; seed <= 10; seed++) {
      const set = rollDrama3dVariations(4, seeded(seed), 'a mix')
      expect(set.every((v) => v.age >= 22 && v.age <= 50)).toBe(true)
      for (const key of ['expression', 'place'] as const) expect(distinct(set.map((v) => v[key]))).toBe(true)
      expect(set.every((v) => !/wink|closed eye/.test(v.expression))).toBe(true)
      expect(drama3dLine(set[0])).not.toContain(',')
    }
  })
})

describe('castingLine', () => {
  it('reads as one short line: age, look and gender, place and outfit without their extra clauses', async () => {
    const { castingLine } = await import('../rollAvatarVariations.js')
    expect(castingLine({
      gender: 'woman', age: 34, look: 'Indian', skinTone: 'warm medium-brown skin', faceShape: 'oval face',
      hair: 'long braid', wardrobe: 'indigo handloom cotton kurta with a small white geometric print',
      place: 'shaded balcony with potted plants', gesture: 'open palm',
    })).toBe('34 · Indian woman · shaded balcony · indigo handloom cotton kurta')
  })
})
