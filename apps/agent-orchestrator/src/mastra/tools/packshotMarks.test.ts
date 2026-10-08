import { describe, it, expect } from 'vitest'
import {
  anyTransparent, chooseLogoSpot, containSize, isSvgFile, legalBandTop, logoLayout, logoRect, marksGraph, sniffImage,
  vegCorner, vegGeq, vegRect, vegSize,
} from './packshotMarks.js'

const LAND = { width: 1920, height: 1080 }
const PORT = { width: 1080, height: 1920 }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('what kind of file the logo is (X3)', () => {
  it.each([
    [PNG, 'png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'jpeg'],
    [Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'webp'],
    [Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'svg'],
    [Buffer.from('﻿  <svg viewBox="0 0 1 1"/>'), 'svg'],
    [Buffer.from('GIF89a'), 'other'],
    [Buffer.from(''), 'other'],
    [Buffer.from('<html><body>svg</body></html>'), 'other'],
  ])('%#: %s', (buf, kind) => {
    expect(sniffImage(buf as Buffer)).toBe(kind)
  })
  it('an SVG by type or by name', () => {
    expect(isSvgFile('image/svg+xml', '/x/logo')).toBe(true)
    expect(isSvgFile('application/octet-stream', '/x/logo.SVG')).toBe(true)
    expect(isSvgFile('image/png', '/x/logo.png')).toBe(false)
  })
})

describe('transparency is read from pixels, not the PNG type (X2, Review Focus 5)', () => {
  it('a decoded RGBA image is transparent only if some pixel is see-through', () => {
    expect(anyTransparent(Buffer.from([255, 0, 0, 255, 0, 0, 0, 255]))).toBe(false)
    expect(anyTransparent(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]))).toBe(true)
    expect(anyTransparent(Buffer.from([255, 0, 0, 249]))).toBe(true)
  })
})

describe('the logo box (M3, X1, X9)', () => {
  it('9% of the shorter side tall, at most 40% of the width, a 5% margin; a plate pads 8%', () => {
    expect(logoLayout(LAND, false)).toEqual({ boxW: 768, boxH: 97, pad: 0, radius: 0, margin: 54, shadow: 4 })
    expect(logoLayout(PORT, true)).toEqual({ boxW: 432, boxH: 97, pad: 8, radius: 17, margin: 54, shadow: 0 })
    expect(logoLayout({ width: 1280, height: 720 }, true)).toEqual({ boxW: 512, boxH: 65, pad: 5, radius: 12, margin: 36, shadow: 0 })
  })
  it.each([
    ['a 20:1 wordmark at 9:16', 2000, 100, 432, 97, { w: 432, h: 22 }],
    ['a 1:4 tall logo at 16:9', 200, 800, 768, 97, { w: 24, h: 97 }],
    ['a square logo at 16:9', 500, 500, 768, 97, { w: 97, h: 97 }],
    ['a 4:1 logo at 16:9', 800, 200, 768, 97, { w: 388, h: 97 }],
    ['a 4:1 logo inside a plate at 9:16', 800, 200, 416, 81, { w: 324, h: 81 }],
  ])('contains %s, keeping its aspect ratio', (_name, sw, sh, bw, bh, size) => {
    expect(containSize(sw, sh, bw, bh)).toEqual(size)
  })
})

describe('where the logo goes (M3, Review Focus 4)', () => {
  const size = { w: 340, h: 97 }
  it('top centre by default, inside the margin', () => {
    expect(logoRect('top-center', LAND, size, 54)).toEqual({ x: 790, y: 54, w: 340, h: 97 })
    expect(logoRect('top-right', LAND, size, 54)).toEqual({ x: 1526, y: 54, w: 340, h: 97 })
    expect(logoRect('top-left', LAND, size, 54)).toEqual({ x: 54, y: 54, w: 340, h: 97 })
    expect(chooseLogoSpot([], LAND, size, 54)).toBe('top-center')
  })
  it('moves to a clear top corner when a face is in the top band, never over the face', () => {
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.02, x1: 0.6, y1: 0.3 }], LAND, size, 54)).toBe('top-right')
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.02, x1: 0.95, y1: 0.3 }], LAND, size, 54)).toBe('top-left')
  })
  it('a face lower in the frame does not move it', () => {
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.8 }], LAND, size, 54)).toBe('top-center')
  })
  it('with no clear spot, takes the one that overlaps faces least', () => {
    expect(chooseLogoSpot([{ x0: 0, y0: 0, x1: 0.7, y1: 0.3 }, { x0: 0.85, y0: 0.05, x1: 0.9, y1: 0.1 }], LAND, size, 54)).toBe('top-right')
  })
})

describe('the veg mark (M4, X9)', () => {
  it('is 5% of the shorter side', () => {
    expect(vegSize(LAND)).toBe(54)
    expect(vegSize(PORT)).toBe(54)
    expect(vegSize({ width: 1280, height: 720 })).toBe(36)
  })
  it('goes in the bottom corner opposite the logo', () => {
    expect(vegCorner('top-center', [], LAND)).toBe('bottom-right')
    expect(vegCorner('top-left', [], LAND)).toBe('bottom-right')
    expect(vegCorner('top-right', [], LAND)).toBe('bottom-left')
    expect(vegCorner(undefined, [], LAND)).toBe('bottom-right')
  })
  it('switches bottom corners only to get off a face', () => {
    expect(vegCorner('top-center', [{ x0: 0.8, y0: 0.6, x1: 1, y1: 1 }], LAND)).toBe('bottom-left')
    expect(vegCorner('top-center', [{ x0: 0, y0: 0.6, x1: 1, y1: 1 }], LAND)).toBe('bottom-right')
  })
  it('sits inside the margin, or above the disclaimer box when one is over the packshot (Review Focus 4)', () => {
    expect(vegRect('bottom-right', LAND)).toEqual({ x: 1812, y: 972, w: 54, h: 54 })
    expect(vegRect('bottom-left', PORT)).toEqual({ x: 54, y: 1812, w: 54, h: 54 })
    expect(legalBandTop(LAND, 1)).toBe(901)
    expect(legalBandTop(LAND, 2)).toBe(825)
    expect(legalBandTop(PORT, 1)).toBe(1661)
    expect(legalBandTop(PORT, 2)).toBe(1586)
    expect(vegRect('bottom-right', LAND, 2)).toEqual({ x: 1812, y: 749, w: 54, h: 54 })
    expect(vegRect('bottom-right', PORT, 1)).toEqual({ x: 972, y: 1585, w: 54, h: 54 })
  })
  it('draws the FSSAI shapes in their colours, from numbers only', () => {
    const border = 'between(X,5,48)*between(Y,5,48)*(1-between(X,9,44)*between(Y,9,44))'
    const veg = `gt(${border}+lte(hypot(X-26.5,Y-26.5),11),0)`
    expect(vegGeq('veg', 54)).toBe(`geq=r='if(${veg},0,255)':g='if(${veg},128,255)':b='if(${veg},0,255)'`)
    const nonVeg = `gt(${border}+between(Y,16,38)*lte(abs(X-26.5)*22,(Y-16)*12),0)`
    expect(vegGeq('non_veg', 54)).toBe(`geq=r='if(${nonVeg},139,255)':g='if(${nonVeg},69,255)':b='if(${nonVeg},19,255)'`)
  })
})

describe('the marks graph: the same pass as the card, no user text', () => {
  const base = { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]' }
  it('a plated logo, then the veg mark, ending on [outv]', () => {
    const g = marksGraph({
      ...base,
      logo: { size: { w: 324, h: 81 }, rect: { x: 790, y: 54, w: 340, h: 97 }, plated: true, layout: logoLayout(LAND, true) },
      veg: { kind: 'veg', rect: { x: 1812, y: 972, w: 54, h: 54 } },
    })
    expect(g).toBe(
      '[2:v]scale=324:81,format=rgba,pad=340:97:8:8:color=white,' +
      "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(hypot(max(0,abs(X-W/2)-(W/2-17)),max(0,abs(Y-H/2)-(H/2-17))),17),0,255)'," +
      'fade=t=in:st=8.5:d=0.4:alpha=1[logo];' +
      "[carded][logo]overlay=790:54:enable='gte(t,8.5)'[withlogo];" +
      `color=c=white:s=54x54:r=30:d=10,format=gbrp,${vegGeq('veg', 54)},format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[veg];` +
      "[withlogo][veg]overlay=1812:972:enable='gte(t,8.5)'[outv]")
  })
  it('a transparent logo gets a soft shadow instead of a plate (X2)', () => {
    const g = marksGraph({ ...base, logo: { size: { w: 388, h: 97 }, rect: { x: 766, y: 54, w: 388, h: 97 }, plated: false, layout: logoLayout(LAND, false) } })
    expect(g).toBe(
      '[2:v]scale=388:97,format=rgba,split[lgf][lgs];' +
      '[lgs]pad=404:113:8:8:color=black@0,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,format=yuva444p,boxblur=luma_radius=4:luma_power=1:alpha_radius=4:alpha_power=1,fade=t=in:st=8.5:d=0.4:alpha=1[lgsh];' +
      '[lgf]fade=t=in:st=8.5:d=0.4:alpha=1[logo];' +
      "[carded][lgsh]overlay=762:50:enable='gte(t,8.5)'[shadowed];" +
      "[shadowed][logo]overlay=766:54:enable='gte(t,8.5)'[outv]")
  })
  it('the veg mark alone', () => {
    expect(marksGraph({ ...base, veg: { kind: 'non_veg', rect: { x: 54, y: 972, w: 54, h: 54 } } })).toBe(
      `color=c=white:s=54x54:r=30:d=10,format=gbrp,${vegGeq('non_veg', 54)},format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[veg];` +
      "[carded][veg]overlay=54:972:enable='gte(t,8.5)'[outv]")
  })
})
