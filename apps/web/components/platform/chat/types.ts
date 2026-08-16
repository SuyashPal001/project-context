import { Agent } from "../agents/types";

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
    id: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    query: string;
    result?: unknown;
    error?: string;
    isLoading?: boolean;
    durationMs?: number;
}

export interface ApprovalRequest {
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
    description: string;
    status: 'pending' | 'approved' | 'dismissed';
    decisionAt?: string;
}

export interface ClarificationOption {
    label: string;
    rationale?: string;
}

export interface ClarificationQuestion {
    prompt: string;
    options: ClarificationOption[];
    allowFreeText?: boolean;
    allowSkip?: boolean;
}

export interface ClarificationRequest {
    id: string;
    questions: ClarificationQuestion[];
    status: 'pending' | 'answered' | 'skipped';
    answeredAt?: string;
}

export interface MessageAttachment {
    id: string;        // local UI id (uuid)
    fileId?: string;   // S3 fileId — used to re-fetch presigned URL on reload
    name: string;
    type: string;
    size?: number;
    previewUrl?: string;
}

export interface PrdTask {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: 'low' | 'medium' | 'high' | 'urgent';
    estimatedHours?: number;
    type: 'feature' | 'bug' | 'chore' | 'spike';
}

export interface PrdMilestone {
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    tasks: PrdTask[];
}

export interface PrdData {
    plan: {
        title: string;
        description: string;
        targetDate?: string;
    };
    milestones: PrdMilestone[];
    risks: string[];
    totalEstimatedHours?: number;
}

export interface PlanResult {
    summary: string;
    dodPassed: boolean;
    prdData: PrdData;
}

export interface ArtifactRef {
    type: 'prd' | 'roadmap' | 'tasks';
    entityId: string;
    title: string;
    content: string;
    // Mastra HITL: approval-gate resumption data persisted on the message
    pmRunId?: string;
    pmStepId?: string;
}

export interface CompletedTrace {
    elapsedSec: number;
    // Populated live by useChatStream's onDone for the turn that just finished.
    // A message loaded from GET /messages only carries the durable summary
    // (elapsedSec + toolCallCount persisted in messages.completed_trace) — the
    // per-call cards were never persisted, so toolCalls is absent there.
    toolCalls?: CompletedToolCall[];
    toolCallCount?: number;
}

export interface Message {
    id: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    createdAt: string;
    toolCalls?: ToolCall[];
    approvalRequest?: ApprovalRequest;
    clarificationRequest?: ClarificationRequest;
    isStreaming?: boolean;
    attachments?: MessageAttachment[];
    planResult?: PlanResult;
    artifactRef?: ArtifactRef;
    // Snapshot of "how long this turn took / what tools it used", stashed once
    // streaming finishes (see useChatStream's onDone). Lives on the message
    // itself — not on ThinkingIndicator's component state — so the collapsed
    // "Worked for Ns" summary survives ThinkingIndicator unmounting the moment
    // isStreaming flips false, and stays visible on scroll-back/re-render.
    completedTrace?: CompletedTrace;
}

export interface Conversation {
    id: string;
    tenantId: string;
    agentId: string;
    title: string;
    status: 'active' | 'archived';
    createdAt: string;
    agent?: Agent;
}

export interface ConversationsResponse {
    data: Conversation[];
}

export interface MessagesResponse {
    data: Message[];
}

export interface CreateConversationRequest {
    agentId: string;
    title?: string;
}

export interface SendMessageRequest {
    content: string;
}

export interface ToolCallSearchResult {
    title: string;
    domain: string;
    favicon?: string;
}

export interface CompletedToolCall {
    id: string;
    toolName: string;
    query: string;
    results?: ToolCallSearchResult[];
}
