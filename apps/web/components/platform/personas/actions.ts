import { api } from "@/lib/api";
import type { Agent, AgentsResponse } from "@/components/platform/agents/types";
import type { PersonaSummary } from "./types";

export async function hirePersona(persona: PersonaSummary): Promise<Agent> {
    const res = await api.post<{ data: { agent: Agent } }>("/api/v1/agents", {
        name: persona.name,
        type: "custom",
        personaId: persona.id,
    });
    return res.data.agent;
}

export interface FireDependencyError {
    status: 409;
    data: { shiftsCount: number; teamsCount: number };
}

// Throws ApiError(409, { shiftsCount, teamsCount }) when the employee has
// active Shifts/Teams — callers should show that confirmation, then retry
// with force:true once the user confirms.
export async function firePersonaAgent(agentId: string, opts?: { force?: boolean }): Promise<void> {
    await api.del(`/api/v1/agents/${agentId}`, { force: opts?.force ?? false });
}

export function findAgentForPersona(agents: AgentsResponse["data"], personaId: string): Agent | undefined {
    return agents.find((a) => a.persona?.id === personaId && a.status === "active");
}
