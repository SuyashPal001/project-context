export type AcceptanceCriterion = { text: string; checked: boolean }
export type Attachment = { fileId: string; name: string; size: number; type: string }

export type Task = {
    id: string
    sequenceId?: number | null
    agentId: string | null
    assigneeId: string | null
    createdBy?: string | null
    parentTaskId?: string | null
    milestoneId?: string | null
    planId?: string | null
    title: string
    description?: string | null
    descriptionHtml?: string | null
    referenceText?: string | null
    status: 'backlog' | 'todo' | 'planning' | 'awaiting_approval' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled'
    priority: 'low' | 'medium' | 'high' | 'urgent'
    estimatedHours?: string | number | null
    confidenceScore?: string | number | null
    acceptanceCriteria?: AcceptanceCriterion[] | null
    planApprovedAt?: string | null
    blockedReason?: string | null
    createdAt: string
    updatedAt: string
    dueDate?: string | null
    startedAt?: string | null
    upvotes: number
    downvotes: number
    links: string[]
    attachmentFileIds: string[]
}

export type AgentsResponse = { data: { id: string; name: string; status: string }[] }
export type MembersResponse = { members: { userId: string; userName: string | null; userEmail: string; roleName: string; status: 'active' | 'invited' | 'suspended' }[] }

export type Assignee = { type: 'agent'; id: string; name: string } | { type: 'member'; id: string; name: string }

export type Step = {
    id: string
    stepNumber: number
    title: string
    description?: string | null
    toolName?: string | null
    reasoning?: string | null
    summary?: string | null
    estimatedHours?: string | number | null
    confidenceScore?: string | number | null
    status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
    humanFeedback?: string | null
    agentOutput?: string | null
    liveText?: string
    liveActivity?: Array<{
        type: 'tool_call'
        toolName: string
        toolInput?: string
        completed?: boolean
        durationMs?: number
        resultSummary?: string
        startedAt?: number
    }>
    agentThinking?: boolean
    feedbackHistory?: { date: string; content: string }[] | null
}

export type TaskEvent = {
    id: string
    actorType: 'agent' | 'human' | 'system'
    actorName?: string
    eventType: string
    payload?: Record<string, any>
    createdAt: string
}

export type TaskComment = {
    id: string
    taskId: string
    authorId: string
    authorType: 'member' | 'agent'
    authorName: string
    content: string
    contentHtml?: string | null
    parentId: string | null
    createdAt: string
    updatedAt: string
}

export type TaskDetailResponse = {
    data: {
        task: Task
        steps: Step[]
        events: TaskEvent[]
        agent?: { name: string }
        assignee?: { name: string }
    }
}

export type TimelineTrackedField =
    | 'title'
    | 'description'
    | 'acceptanceCriteria'
    | 'estimatedHours'

export type TimelineRow =
    | { kind: 'origin'; at: string; content: string }
    | {
        kind: 'revision'
        at: string
        id: string
        field: TimelineTrackedField
        originalContent: unknown
        correctedContent: unknown
        actorType: 'human' | 'agent'
        actorName?: string | null
    }
    | {
        kind: 'event'
        at: string
        id: string
        eventType: string
        actorType: 'agent' | 'human' | 'system'
        actorName?: string | null
        payload?: Record<string, any>
    }

export type TimelineResponse = {
    data: TimelineRow[]
}
