// The user's login token for a remake run, held in memory only for the length of the tool
// call that starts or resumes it. Mastra stores the request context inside every run
// snapshot, so the token must never be put there (3a review M1).
const tokens = new Map<string, string>()

export async function withRunToken<T>(runId: string, token: string, fn: () => Promise<T>): Promise<T> {
  tokens.set(runId, token)
  try { return await fn() } finally { tokens.delete(runId) }
}

export const runToken = (runId: string): string | undefined => tokens.get(runId)
