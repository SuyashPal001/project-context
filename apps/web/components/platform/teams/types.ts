export interface Team {
    id: string;
    tenantId: string;
    name: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface TeamDetail extends Team {
    memberAgentIds: string[];
}

export interface TeamsResponse {
    data: Team[];
}

export interface TeamResponse {
    data: TeamDetail;
}
