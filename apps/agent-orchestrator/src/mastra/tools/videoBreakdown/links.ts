import { z } from 'zod'

// People paste links without https:// ("facebook.com/reel/..."); add it rather than refuse.
export function normalizeLink(url: string): string {
  const t = url.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`
}

// A video link, with or without https:// — normalised before use.
export const linkSchema = z.string().min(1).describe('A video link, with or without https://')
