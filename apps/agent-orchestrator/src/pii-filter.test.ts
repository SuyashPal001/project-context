import { describe, expect, it } from 'vitest'
import { filterPII , filterTypedPII } from './pii-filter.js'

describe('filterPII address rule', () => {
  it('leaves creative prompt words alone', () => {
    const prompts = [
      'a mustard cotton kurta with a fine block-print border, small gold earrings, sitting at a desk with a glass of chai. Style: premium',
      'one hand resting lightly on the doorframe; warm golden city bokeh',
      'a flat 2D vector character for my household cleaning brand, a coffee house scene, the plot of the ad',
      'a house 3D render, the plot in 4k',
    ]
    for (const p of prompts) expect(filterPII(p).sanitized).toBe(p)
  })

  it('still masks a house number and the street after it', () => {
    expect(filterPII('Deliver to Flat 302, Sai Residency, Andheri East. Call me.').sanitized)
      .toBe('Deliver to [ADDRESS_1] Call me.')
    expect(filterPII('House no. 12, MG Road').sanitized).toBe('[ADDRESS_1]')
    expect(filterPII('H.No 4-5/2, Jubilee Hills').sanitized).toBe('[ADDRESS_1]')
    expect(filterPII('block 7, Sector 62 Noida').sanitized).toBe('[ADDRESS_1]')
  })
})

describe('filterTypedPII', () => {
  it('leaves the creative brief data block alone, so a digit-led file id is not read as a bank account', () => {
    const block = '<!-- olmo-creative-brief:v1:%7B%22fileId%22%3A%2212345678%2D4ed9%22%7D -->'
    const out = filterTypedPII(`make my ad ${block}`)
    expect(out.sanitized).toBe(`make my ad ${block}`)
    expect(decodeURIComponent(out.sanitized.slice(out.sanitized.indexOf('v1:') + 3, -4))).toContain('12345678-4ed9')
  })

  it('still masks what the user typed', () => {
    const out = filterTypedPII('call 9876543210 <!-- olmo-creative-brief:v1:%7B%7D -->')
    expect(out.sanitized).not.toContain('9876543210')
    expect(out.sanitized.endsWith('<!-- olmo-creative-brief:v1:%7B%7D -->')).toBe(true)
  })
})

describe('links are never masked (2026-10-15: a Facebook reel id became [CARD_1])', () => {
  it.each([
    'facebook.com/reel/1479672313280365/?s=ifu',
    'https://www.facebook.com/reel/1479672313280365/',
    'https://x.com/primevideouk/status/1578401165338976258',
    'https://www.instagram.com/p/DdzH5VVgmYT/',
    'https://www.youtube.com/shorts/tsWUZRydnLY',
    'www.facebook.com/watch/?v=987654321012345',
    'https://lnkd.in/p/gTyWfJqy',
  ])('keeps %s intact', (url) => {
    expect(filterPII(`break this down ${url} please`).sanitized).toBe(`break this down ${url} please`)
  })

  it('still masks a card number and an email next to a link', () => {
    const r = filterPII('card 4111111111111111, mail me at a.b@gmail.com, video https://www.facebook.com/reel/1479672313280365/')
    expect(r.sanitized).toBe('card [CARD_1], mail me at [EMAIL_1], video https://www.facebook.com/reel/1479672313280365/')
  })

  it('keeps a link wrapped in brackets or followed by a full stop', () => {
    expect(filterPII('(see https://x.com/a/status/1578401165338976258).').sanitized).toBe('(see https://x.com/a/status/1578401165338976258).')
  })

  it('a bare domain without a path is not treated as a link (emails stay masked)', () => {
    expect(filterPII('write to rahul@gmail.com').sanitized).toBe('write to [EMAIL_1]')
  })
})
