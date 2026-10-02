import { describe, expect, it } from 'vitest'
import { filterPII } from './pii-filter.js'

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
