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
