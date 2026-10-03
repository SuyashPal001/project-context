import type pg from 'pg'
import { offeredVoiceProvider, voiceProviderOf } from '@serverless-saas/database'
import { makeAppPool } from '../../db.js'

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = makeAppPool(2)
    _pool.on('error', (err) => console.error('[narrationVoice] pool error:', err.message))
  }
  return _pool
}

// Narration may only use a voice the platform currently offers: one in
// voice_catalogue, from the engine VOICE_PROVIDER selects. This catches a voice
// id carried over in working memory from an older chat (e.g. a Cartesia voice
// after the switch to Gemini) and any id or name the model made up.
export async function checkNarrationVoice(voiceId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { rows } = await getPool().query<{ name: string }>('SELECT name FROM voice_catalogue WHERE provider_id = $1', [voiceId])
  if (rows.length === 0) {
    return { ok: false, reason: `"${voiceId}" is not a voice in the library. Call list_casting_assets with kind "voice" and use an id from that list exactly.` }
  }
  if (voiceProviderOf(voiceId) !== offeredVoiceProvider()) {
    return { ok: false, reason: `${rows[0].name} is no longer offered. Call list_casting_assets with kind "voice", then ask the user to pick one of the current voices before narrating.` }
  }
  return { ok: true }
}
