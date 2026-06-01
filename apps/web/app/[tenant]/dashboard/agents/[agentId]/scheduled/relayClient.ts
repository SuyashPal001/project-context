// Direct relay API client for schedule management.
// Relay auth uses platform_id_token (not httpOnly) as Bearer token.

const RELAY_BASE = process.env.NEXT_PUBLIC_AGENT_WS_URL?.replace(/^wss?:\/\//, 'https://') ?? "https://relay.projectcontext.co";

function getIdToken(): string {
  if (typeof document === "undefined") return "";
  const cookies = document.cookie.split("; ");
  return cookies.find((r) => r.startsWith("platform_id_token="))?.split("=")[1] ?? "";
}

function relayHeaders(agentId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${getIdToken()}`,
    "X-Agent-Id": agentId,
    "Content-Type": "application/json",
  };
}

export async function relayGet<T>(path: string, agentId: string): Promise<T> {
  const res = await fetch(`${RELAY_BASE}${path}`, {
    headers: relayHeaders(agentId),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function relayPost<T>(path: string, agentId: string, body: unknown): Promise<T> {
  const res = await fetch(`${RELAY_BASE}${path}`, {
    method: "POST",
    headers: relayHeaders(agentId),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function relayDelete(path: string, agentId: string): Promise<void> {
  const res = await fetch(`${RELAY_BASE}${path}`, {
    method: "DELETE",
    headers: relayHeaders(agentId),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export interface Schedule {
  id: string;
  workflowId: string;
  cron: string;
  timezone: string;
  nextFireAt: number;
  metadata?: { agentId?: string; tenantId?: string };
}

export interface SchedulesResponse {
  schedules: Schedule[];
}
