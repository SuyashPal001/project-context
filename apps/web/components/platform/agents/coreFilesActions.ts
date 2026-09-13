import { api } from "@/lib/api";

export interface CoreFile {
    name: string;
    locked: boolean;
}

export interface CoreFilesResponse {
    data: CoreFile[];
}

export async function getCoreFiles(agentId: string): Promise<CoreFile[]> {
    const res = await api.get<CoreFilesResponse>(`/api/v1/agents/${agentId}/core-files`);
    return res.data;
}
