import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInstagramProfile } from './tikhub.js'

const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/tikhub-user.json', import.meta.url), 'utf8'))

describe('parseInstagramProfile', () => {
  it('reads name, bio, picture and captions from a real response', () => {
    const p = parseInstagramProfile(fixture, 'mamaearth.in')
    expect(p?.handle).toBe('mamaearth.in')
    expect(p?.fullName).toBeTruthy()
    expect(p?.profilePicUrl).toMatch(/^https:\/\//)
    expect(p?.captions.length).toBeGreaterThan(0)
    expect(p!.captions.length).toBeLessThanOrEqual(12)
  })

  it('returns null for an empty or error response', () => {
    expect(parseInstagramProfile({}, 'x')).toBeNull()
    expect(parseInstagramProfile({ code: 400, data: null }, 'x')).toBeNull()
  })
})
