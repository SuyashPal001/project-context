// TVC Part 2.2 (spec 2026-10-09 M3, M4, X1–X4, X9): the brand logo and the
// FSSAI veg / non-veg mark on the packshot, as pure rules. composite_end_card
// lays both in its one ffmpeg pass. Every size is a share of the REAL frame's
// shorter side; every filter string here is built from numbers and fixed
// words only — no user text ever reaches it.
import { LEGAL_BOX_PADDING, LEGAL_PLAY_RES_Y, legalAssFontSize, type Frame } from './legalText.js'
import type { Box } from './tvcChecks.js'

export const LOGO_IS_PRODUCT_PHOTO = 'LOGO_IS_PRODUCT_PHOTO: the logo is the product photo; ask the user for the brand\'s logo file (PNG, JPG or WebP)'
export const LOGO_NOT_RASTER = 'LOGO_NOT_RASTER: upload the logo as PNG, JPG or WebP'
export const LOGO_NOT_IMAGE = 'LOGO_NOT_IMAGE: the logo must be an image file (PNG, JPG or WebP); ask the user to upload one'
export const LOGO_UNCHECKED = 'LOGO_UNCHECKED: could not read the logo; try again'

export const LOGO_HEIGHT_SHARE = 0.09
export const LOGO_MAX_WIDTH_SHARE = 0.4
export const MARK_MARGIN_SHARE = 0.05
export const PLATE_PAD_SHARE = 0.08
const PLATE_RADIUS_SHARE = 0.18
const SHADOW_SHARE = 0.004
export const VEG_SIZE_SHARE = 0.05
/** The gap kept between the veg mark and the disclaimer box above it. */
const LEGAL_GAP_SHARE = 0.02
const MARK_DISSOLVE_SECONDS = 0.4
/** overlay_text's legal style: MarginV 160 from the bottom (PlayRes units). */
const LEGAL_MARGIN_V = 160

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg' | 'other'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** X3: what the logo file really is, from its bytes (never its name). */
export function sniffImage(buf: Buffer): ImageKind {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart()
  if (head.startsWith('<') && /<svg[\s>/]/i.test(head)) return 'svg'
  return 'other'
}

export const isSvgFile = (mimeType: string, pathname: string): boolean =>
  /^image\/svg/i.test(mimeType) || /\.svgz?$/i.test(pathname)

/** X2: a logo counts as transparent only when a decoded pixel is see-through,
 *  so an RGBA PNG whose alpha is all opaque (a white box baked in) still gets
 *  the plate. `rgba` is raw RGBA bytes. */
export function anyTransparent(rgba: Buffer): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) return true
  return false
}

export interface LogoLayout { boxW: number; boxH: number; pad: number; radius: number; margin: number; shadow: number }

/** M3/X1: the box the visible logo (its plate included) must fit. */
export function logoLayout(frame: Frame, plated: boolean): LogoLayout {
  const s = Math.min(frame.width, frame.height)
  const boxH = Math.round(LOGO_HEIGHT_SHARE * s)
  return {
    boxW: Math.round(LOGO_MAX_WIDTH_SHARE * frame.width),
    boxH,
    pad: plated ? Math.round(PLATE_PAD_SHARE * boxH) : 0,
    radius: plated ? Math.round(PLATE_RADIUS_SHARE * boxH) : 0,
    margin: Math.round(MARK_MARGIN_SHARE * s),
    shadow: plated ? 0 : Math.max(2, Math.round(SHADOW_SHARE * s)),
  }
}

/** X1: fit inside maxW x maxH, keeping the aspect ratio (a small logo is scaled up to the box). */
export function containSize(srcW: number, srcH: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(maxW / srcW, maxH / srcH)
  return { w: Math.max(1, Math.round(srcW * k)), h: Math.max(1, Math.round(srcH * k)) }
}

export type LogoSpot = 'top-center' | 'top-right' | 'top-left'
export type Corner = 'bottom-right' | 'bottom-left'
export interface Rect { x: number; y: number; w: number; h: number }

export function logoRect(spot: LogoSpot, frame: Frame, size: { w: number; h: number }, margin: number): Rect {
  const x = spot === 'top-center' ? Math.round((frame.width - size.w) / 2) : spot === 'top-left' ? margin : frame.width - margin - size.w
  return { x, y: margin, w: size.w, h: size.h }
}

function faceOverlap(rect: Rect, faces: Box[], frame: Frame): number {
  return faces.reduce((sum, f) => {
    const w = Math.min(rect.x + rect.w, f.x1 * frame.width) - Math.max(rect.x, f.x0 * frame.width)
    const h = Math.min(rect.y + rect.h, f.y1 * frame.height) - Math.max(rect.y, f.y0 * frame.height)
    return sum + (w > 0 && h > 0 ? w * h : 0)
  }, 0)
}

/** M3: top centre, or the first clear top corner; with none clear, the least overlap. */
export function chooseLogoSpot(faces: Box[], frame: Frame, size: { w: number; h: number }, margin: number): LogoSpot {
  const spots: LogoSpot[] = ['top-center', 'top-right', 'top-left']
  const overlaps = spots.map((s) => faceOverlap(logoRect(s, frame, size, margin), faces, frame))
  const clear = spots.find((_, i) => overlaps[i] === 0)
  return clear ?? spots[overlaps.indexOf(Math.min(...overlaps))]
}

export const vegSize = (frame: Frame): number => Math.max(16, Math.round(VEG_SIZE_SHARE * Math.min(frame.width, frame.height)))

/** The top edge (px) of overlay_text's legal box with `lines` lines: MarginV,
 *  the lines and the box padding, in PlayRes units scaled to the real height. */
export function legalBandTop(frame: Frame, lines: number): number {
  const playRes = LEGAL_MARGIN_V + lines * legalAssFontSize(frame) + 2 * LEGAL_BOX_PADDING
  return Math.floor(frame.height - playRes * frame.height / LEGAL_PLAY_RES_Y)
}

/** M4: inside the margin, and above the disclaimer box when one is on screen. */
export function vegRect(corner: Corner, frame: Frame, disclaimerLines?: number): Rect {
  const s = Math.min(frame.width, frame.height)
  const n = vegSize(frame)
  const margin = Math.round(MARK_MARGIN_SHARE * s)
  let bottom = frame.height - margin
  if (disclaimerLines) bottom = Math.min(bottom, legalBandTop(frame, disclaimerLines) - Math.round(LEGAL_GAP_SHARE * s))
  return { x: corner === 'bottom-right' ? frame.width - margin - n : margin, y: bottom - n, w: n, h: n }
}

/** M4: the bottom corner opposite the logo; the other one only to get off a face. */
export function vegCorner(logoSpot: LogoSpot | undefined, faces: Box[], frame: Frame, disclaimerLines?: number): Corner {
  const preferred: Corner = logoSpot === 'top-right' ? 'bottom-left' : 'bottom-right'
  const other: Corner = preferred === 'bottom-right' ? 'bottom-left' : 'bottom-right'
  const hit = (c: Corner) => faceOverlap(vegRect(c, frame, disclaimerLines), faces, frame) > 0
  return hit(preferred) && !hit(other) ? other : preferred
}

const VEG_RGB = [0, 128, 0] as const          // #008000
const NON_VEG_RGB = [139, 69, 19] as const    // #8B4513, the 2021 FSSAI non-veg colour

/** M4: the mark on an n×n white square: a square outline plus a filled dot
 *  (veg) or an upward triangle (non-veg). One geq; numbers only. */
export function vegGeq(kind: 'veg' | 'non_veg', n: number): string {
  const m = Math.round(n * 0.1)
  const t = Math.max(2, Math.round(n * 0.08))
  const c = (n - 1) / 2
  const border = `between(X,${m},${n - 1 - m})*between(Y,${m},${n - 1 - m})*(1-between(X,${m + t},${n - 1 - m - t})*between(Y,${m + t},${n - 1 - m - t}))`
  let shape: string
  if (kind === 'veg') {
    shape = `lte(hypot(X-${c},Y-${c}),${Math.round(n * 0.2)})`
  } else {
    const ty = Math.round(n * 0.3), by = Math.round(n * 0.7), hb = Math.round(n * 0.22)
    shape = `between(Y,${ty},${by})*lte(abs(X-${c})*${by - ty},(Y-${ty})*${hb})`
  }
  const [r, g, b] = kind === 'veg' ? VEG_RGB : NON_VEG_RGB
  const on = `gt(${border}+${shape},0)`
  return `geq=r='if(${on},${r},255)':g='if(${on},${g},255)':b='if(${on},${b},255)'`
}

export interface Marks {
  logo?: { size: { w: number; h: number }; rect: Rect; plated: boolean; layout: LogoLayout }
  veg?: { kind: 'veg' | 'non_veg'; rect: Rect }
  dissolveStart: number
  totalSeconds: number
  /** The ffmpeg input label of the logo, e.g. "[2:v]". */
  logoInput: string
}

const fadeIn = (st: number) => `fade=t=in:st=${st}:d=${MARK_DISSOLVE_SECONDS}:alpha=1`
const gate = (st: number) => `enable='gte(t,${st})'`

/** The marks as filter-graph text, from `from` (the carded video) to [outv].
 *  They dissolve in with the card. A plated logo sits on a rounded white
 *  plate; a transparent one gets a soft dark shadow (X2). */
export function marksGraph(m: Marks, from = '[carded]'): string {
  const parts: string[] = []
  const ds = m.dissolveStart
  let last = from
  if (m.logo) {
    const { size: { w, h }, rect, layout } = m.logo
    const out = m.veg ? '[withlogo]' : '[outv]'
    if (m.logo.plated) {
      const p = layout.pad, r = layout.radius
      parts.push(`${m.logoInput}scale=${w}:${h},format=rgba,pad=${w + 2 * p}:${h + 2 * p}:${p}:${p}:color=white,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(hypot(max(0,abs(X-W/2)-(W/2-${r})),max(0,abs(Y-H/2)-(H/2-${r}))),${r}),0,255)',${fadeIn(ds)}[logo]`)
      parts.push(`${last}[logo]overlay=${rect.x}:${rect.y}:${gate(ds)}${out}`)
    } else {
      const s = layout.shadow
      parts.push(`${m.logoInput}scale=${w}:${h},format=rgba,split[lgf][lgs]`)
      parts.push(`[lgs]pad=${w + 4 * s}:${h + 4 * s}:${2 * s}:${2 * s}:color=black@0,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,format=yuva444p,boxblur=luma_radius=${s}:luma_power=1:alpha_radius=${s}:alpha_power=1,${fadeIn(ds)}[lgsh]`)
      parts.push(`[lgf]${fadeIn(ds)}[logo]`)
      parts.push(`${last}[lgsh]overlay=${rect.x - s}:${rect.y - s}:${gate(ds)}[shadowed]`)
      parts.push(`[shadowed][logo]overlay=${rect.x}:${rect.y}:${gate(ds)}${out}`)
    }
    last = out
  }
  if (m.veg) {
    const n = m.veg.rect.w
    parts.push(`color=c=white:s=${n}x${n}:r=30:d=${m.totalSeconds},format=gbrp,${vegGeq(m.veg.kind, n)},format=rgba,${fadeIn(ds)}[veg]`)
    parts.push(`${last}[veg]overlay=${m.veg.rect.x}:${m.veg.rect.y}:${gate(ds)}[outv]`)
  }
  return parts.join(';')
}
