import { api } from "@/lib/api";
import type { Agent, AgentsResponse } from "@/components/platform/agents/types";
import type { PersonaDetail } from "./types";

export async function hirePersona(persona: PersonaDetail): Promise<Agent> {
    const res = await api.post<{ data: { agent: Agent } }>("/api/v1/agents", {
        name: persona.name,
        type: "custom",
        personaId: persona.id,
    });
    return res.data.agent;
}

export async function firePersonaAgent(agentId: string): Promise<void> {
    await api.patch(`/api/v1/agents/${agentId}`, { status: "paused" });
}

export function findAgentForPersona(agents: AgentsResponse["data"], personaId: string): Agent | undefined {
    return agents.find((a) => a.persona?.id === personaId && a.status === "active");
}
