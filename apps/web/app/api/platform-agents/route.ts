// Server-side route: fetches Mastra-registered agents from the relay
// (localhost:3001 is reachable from Next.js server; not publicly exposed).
// Used by AgentsView to show AI-PARAS / Document Intelligence alongside DB agents.

const RELAY_URL = process.env.RELAY_INTERNAL_URL ?? 'http://localhost:3001'

export async function GET() {
  try {
    const res = await fetch(`${RELAY_URL}/api/mastra/agents`, {
      next: { revalidate: 60 }, // cache 60s
    })
    if (!res.ok) {
      return Response.json({ agents: [] })
    }
    const data = await res.json()
    return Response.json(data)
  } catch {
    // Relay unreachable — return empty gracefully
    return Response.json({ agents: [] })
  }
}
