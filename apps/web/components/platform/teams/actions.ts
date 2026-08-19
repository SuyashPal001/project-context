import { api } from "@/lib/api";
import type { Team, TeamDetail, TeamResponse } from "./types";

export async function createTeam(name: string): Promise<Team> {
    const res = await api.post<{ data: Team }>("/api/v1/teams", { name });
    return res.data;
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
    const res = await api.get<TeamResponse>(`/api/v1/teams/${teamId}`);
    return res.data;
}

export async function renameTeam(teamId: string, name: string): Promise<Team> {
    const res = await api.patch<{ data: Team }>(`/api/v1/teams/${teamId}`, { name });
    return res.data;
}

export async function deleteTeam(teamId: string): Promise<void> {
    await api.del(`/api/v1/teams/${teamId}`);
}

export async function addTeamMember(teamId: string, agentId: string): Promise<void> {
    await api.post(`/api/v1/teams/${teamId}/members/${agentId}`);
}

export async function removeTeamMember(teamId: string, agentId: string): Promise<void> {
    await api.del(`/api/v1/teams/${teamId}/members/${agentId}`);
}
