import type { InstagramFacts } from './types.js'

const TIKHUB_URL = 'https://api.tikhub.io/api/v1/instagram/v1/fetch_user_info_by_username_v2'
const TIMEOUT_MS = 15_000
const MAX_CAPTIONS = 12

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseInstagramProfile(json: unknown, handle: string): InstagramFacts | null {
  const d = (json as { data?: any })?.data
  const user = d?.data?.user ?? d?.user ?? (d?.username ? d : null)
  if (!user || typeof user !== 'object') return null
  const edges: any[] = user.edge_owner_to_timeline_media?.edges ?? []
  const captions = edges
    .map((e) => str(e?.node?.edge_media_to_caption?.edges?.[0]?.node?.text))
    .filter((c): c is string => !!c)
    .slice(0, MAX_CAPTIONS)
  const pic = str(user.profile_pic_url_hd) ?? str(user.profile_pic_url)
  return {
    handle,
    fullName: str(user.full_name),
    bio: str(user.biography),
    externalUrl: str(user.external_url),
    profilePicUrl: pic && pic.startsWith('https://') ? pic : null,
    captions,
  }
}

/** One TikHub call. Null on any failure (logged). Not cost-logged yet — TikHub cost tracking is a follow-up. */
export async function fetchInstagramProfile(handle: string): Promise<InstagramFacts | null> {
  const key = process.env.TIKHUB_API_KEY
  if (!key) {
    console.error('[tikhub] TIKHUB_API_KEY not set')
    return null
  }
  try {
    const res = await fetch(`${TIKHUB_URL}?username=${encodeURIComponent(handle)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error('[tikhub] HTTP', res.status, { handle })
      return null
    }
    return parseInstagramProfile(await res.json(), handle)
  } catch (err) {
    console.error('[tikhub] failed', { handle, error: (err as Error).message })
    return null
  }
}
