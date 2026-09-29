import { validateToken } from './auth.js'

// A chat turn used to keep the id token its first request carried for its
// whole life. Cognito id tokens last an hour, so a turn that started late in
// a token's life — and then waited on an approval card or a question — made
// every later API call with an expired token: 401s, "SOURCE_IMAGE_UNAVAILABLE"
// on a real file, an avatar that never saved. The moments a turn waits on the
// user are exactly when the browser holds a fresh token, so the approve /
// answer / upload routes hand it over here, per conversation, and the turn
// and its tools read the latest one.
const freshIdTokens = new Map<string, string>()

/**
 * Stores the caller's X-Id-Token for this conversation's running turn — only
 * if it verifies and belongs to the same user as the already-verified access
 * token. Anything else is ignored: the turn keeps the token it has.
 */
export async function acceptFreshIdToken(conversationId: string | undefined, idTokenHeader: string | undefined, callerSub: string | undefined): Promise<string | null> {
  if (!conversationId || !idTokenHeader || !callerSub) return null
  try {
    const payload = await validateToken(idTokenHeader)
    if (payload.sub !== callerSub) return null
    freshIdTokens.set(conversationId, idTokenHeader)
    return idTokenHeader
  } catch {
    return null
  }
}

/** The newest id token handed over for this conversation, else `fallback`. */
export function latestIdToken(conversationId: string | undefined, fallback: string): string {
  return (conversationId && freshIdTokens.get(conversationId)) || fallback
}

/** A new turn brings its own token; drop any older hand-over. */
export function clearFreshIdToken(conversationId: string | undefined): void {
  if (conversationId) freshIdTokens.delete(conversationId)
}
