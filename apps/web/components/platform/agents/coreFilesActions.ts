import { api } from "@/lib/api";

export interface CoreFile {
    name: string;
    locked: boolean;
}

export interface CoreFilesResponse {
    data: CoreFile[];
}

export interface AgentMemory {
    content: string;
    updatedAt: string | null;
}

export interface AgentMemoryResponse {
    data: AgentMemory;
}

export async function getCoreFiles(agentId: string): Promise<CoreFile[]> {
    const res = await api.get<CoreFilesResponse>(`/api/v1/agents/${agentId}/core-files`);
    return res.data;
}

export async function getAgentMemory(agentId: string): Promise<AgentMemory> {
    const res = await api.get<AgentMemoryResponse>(`/api/v1/agents/${agentId}/memory`);
    return res.data;
}

export async function saveAgentMemory(agentId: string, content: string): Promise<AgentMemory> {
    const res = await api.put<AgentMemoryResponse>(`/api/v1/agents/${agentId}/memory`, { content });
    return res.data;
}
