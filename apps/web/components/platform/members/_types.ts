export interface Member {
    id: string;
    userId: string | null;
    userName: string | null;
    userEmail: string | null;
    userAvatarUrl: string | null;
    roleId: string | null;
    roleName: string | null;
    memberType: "human" | "agent";
    status: "active" | "invited" | "suspended";
    joinedAt: string | null;
    agentId: string | null;
    agentName: string | null;
    agentType: string | null;
    invitedEmail: string | null;
}

export interface Role {
    id: string;
    name: string;
}
