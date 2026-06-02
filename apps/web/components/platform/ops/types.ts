export interface OpsTenant {
    id: string
    name: string
    slug: string
    type: 'individual' | 'startup' | 'business' | 'enterprise'
    status: 'active' | 'suspended' | 'deleted'
    plan: string
    createdAt: string
}

export interface OpsTenantsResponse {
    tenants: OpsTenant[]
    total: number
    page: number
    totalPages: number
}

export interface OpsOverride {
    id: string
    tenantName: string
    featureKey: string
    enabled: boolean | null
    valueLimit: number | null
    unlimited: boolean | null
    reason: string
    grantedBy: string
    expiresAt: string | null
    status: 'active' | 'expired' | 'revoked'
}

export interface OpsOverridesResponse {
    overrides: OpsOverride[]
    total: number
    page: number
    totalPages: number
}

export interface OpsMember {
    membershipId: string
    memberType: 'human' | 'agent'
    status: 'active' | 'invited' | 'suspended'
    joinedAt: string | null
    createdAt: string
    userId: string | null
    userName: string | null
    userEmail: string | null
    roleName: string | null
}

export interface OpsTenantOverride {
    id: string
    featureKey: string
    featureName: string
    enabled: boolean | null
    valueLimit: number | null
    unlimited: boolean | null
    reason: string | null
    grantedBy: string
    expiresAt: string | null
    revokedAt: string | null
    createdAt: string
    status: 'active' | 'expired' | 'revoked'
}

export interface OpsAuditEntry {
    id: string
    tenantId: string
    tenantName: string | null
    actorId: string
    actorType: 'human' | 'agent' | 'system'
    action: string
    resource: string
    resourceId: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
}

export interface OpsAuditResponse {
    entries: OpsAuditEntry[]
    total: number
    page: number
    totalPages: number
}

export interface OpsProvider {
    id: string
    provider: 'openai' | 'anthropic' | 'mistral' | 'openrouter' | 'kimi' | 'vertex'
    model: string
    displayName: string
    isDefault: boolean
    status: 'live' | 'coming_soon'
    createdAt: string
    tenantsUsing: number
}

export interface OpsProvidersResponse {
    providers: OpsProvider[]
}

export interface OpsTenantDetailResponse {
    tenant: OpsTenant
    members: OpsMember[]
    stats: {
        memberCount: number
        activeAgents: number
        totalConversations: number
    }
    overrides: OpsTenantOverride[]
}

export interface OpsKnowledgeGap {
    id: string
    tenantId: string
    tenantName: string | null
    question: string
    timesAsked: number
    lastSeenAt: string
    status: 'open' | 'resolved'
}

export interface OpsKnowledgeGapsResponse {
    gaps: OpsKnowledgeGap[]
    total: number
}

export interface OpsEvalScore {
    tenantId: string
    tenantName: string | null
    avgQualityScore: number | null
    ragHitRate: number | null
    thumbsUpPct: number | null
    trend: 'up' | 'down' | 'stable'
}

export interface OpsEvalScoresResponse {
    scores: OpsEvalScore[]
}

export interface OpsToolPerf {
    toolName: string
    tenantId: string
    tenantName: string | null
    callCount: number
    successRate: number | null
    avgLatencyMs: number | null
    lastError: string | null
    lastSeen: string | null
}

export interface OpsToolPerfResponse {
    tools: OpsToolPerf[]
}

export interface OpsEvalResult {
    id: string
    tenantId: string
    tenantName: string | null
    messagePreview: string | null
    dimension: string
    score: number | null
    reasoning: string | null
    model: string | null
    createdAt: string | null
}

export interface OpsEvalResultsResponse {
    results: OpsEvalResult[]
    total: number
    page: number
    totalPages: number
}

export interface OpsFinopsTenantRow {
    tenantId: string
    tenantName: string | null
    cost: number
    inputTokens: number
    outputTokens: number
    conversationCount: number
}

export interface OpsFinopsConversationRow {
    conversationId: string
    tenantId: string
    tenantName: string | null
    cost: number
    inputTokens: number | null
    outputTokens: number | null
    createdAt: string | null
}

export interface OpsFinopsResponse {
    totalCost: number
    totalInputTokens: number
    totalOutputTokens: number
    avgCostPerConversation: number
    activeTenantsWithSpend: number
    byTenant: OpsFinopsTenantRow[]
    topConversations: OpsFinopsConversationRow[]
}

export interface OpsOverviewStats {
    activeTenants: number
    avgEvalScore: number | null
    openKnowledgeGaps: number
    totalCostThisMonth: number | null
}

export interface OpsTeamMember {
    id: string
    name: string
    email: string
    createdAt: string
}

export interface OpsTeamResponse {
    team: OpsTeamMember[]
}
