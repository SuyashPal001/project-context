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
    /** Live per-item progress for a batch generation call (generate_videos/generate_images) — set as batch_item_progress SSE events arrive, before the tool call itself resolves. */
    batchProgress?: { done: number; total: number };
}

export interface ApprovalRequest {
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
    description: string;
    status: 'pending' | 'approved' | 'dismissed';
    decisionAt?: string;
}

export interface GenerationConfirmRequest {
    id: string;
    resourceType: string;
    subject: string;
    label: string;
    /** What is being approved — rendered inside the card so the user reads the
     *  content, not just its title. Absent for cost-only confirmations. */
    preview?: string;
    status: 'pending' | 'approved' | 'declined';
    decisionAt?: string;
    declineReason?: string;
    /** Number of items in a batch generation. Absent for single-item tools. */
    count?: number;
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
    /** When set, the question expects min-max options selected together
     *  (e.g. "select exactly 3 partner logos") — renders as checkboxes. */
    multiSelect?: { min: number; max: number };
}

export interface ClarificationAnswer {
    files?: { fileId: string; name: string; type: string }[];
    selectedIndex?: number;
    /** Set when the question is multiSelect — parallel to selectedIndex, never both. */
    selectedIndices?: number[];
    freeText?: string;
    skipped?: boolean;
}

export interface ClarificationRequest {
    id: string;
    questions: ClarificationQuestion[];
    status: 'pending' | 'answered' | 'skipped' | 'expired';
    answeredAt?: string;
    // Per-question answer actually given, keyed by question index — populated
    // once the request resolves, powers the resolved "N answer(s)" summary card.
    answers?: Record<number, ClarificationAnswer>;
}

export interface UploadedFileRef {
    fileId: string;
    name: string;
    type: string;
}

export interface UploadRequest {
    id: string;
    prompt: string;
    minFiles: number;
    maxFiles: number;
    status: 'pending' | 'answered' | 'skipped' | 'expired';
    answeredAt?: string;
    // Populated once the request resolves, powers the resolved summary card.
    files?: UploadedFileRef[];
    freeText?: string;
}

export interface MessageAttachment {
    id: string;        // local UI id (uuid)
    fileId?: string;   // S3 fileId — used to re-fetch presigned URL on reload
    name: string;
    type: string;
    size?: number;
    previewUrl?: string;
    generation?: { creditsUsedMicro: string; model: string };
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
    /** seq of the last message part that arrived before the first tool call /
     *  reasoning delta. Text parts at or below it render ABOVE the trace, the
     *  rest below, so the trace sits where it happened in the turn. Client-only. */
    afterSeq?: number;
    // Populated live by useChatStream's onDone for the turn that just finished.
    // A message loaded from GET /messages only carries the durable summary
    // (elapsedSec + toolCallCount persisted in messages.completed_trace) — the
    // per-call cards were never persisted, so toolCalls is absent there.
    toolCalls?: CompletedToolCall[];
    toolCallCount?: number;
    // Same not-persisted-server-side caveat as toolCalls above.
    reasoningText?: string;
    // How long the reasoning phase itself took (first reasoning-delta to last),
    // distinct from elapsedSec (the whole turn). Powers the completed
    // "Thought for Ns" label. Persisted server-side, unlike toolCalls/reasoningText.
    reasoningElapsedSec?: number;
}

/**
 * One ordered piece of a streaming assistant turn.
 *
 * A turn is not just "text, then cards": the agent can write text, stop to ask
 * a clarifying question, and then keep writing after it's answered. Modelling
 * the turn as `content: string` plus one `clarificationRequest` field rendered
 * in a fixed template slot can only ever produce "all the text, then the card"
 * (or the reverse) — never the card at the point it was actually asked. So the
 * stream handler (useChatStream) also records what it received, in arrival
 * order, as `Message.parts`, each tagged with a monotonic `seq` assigned at
 * receipt time, and MessageItem renders that list directly.
 *
 * Request parts carry only the id: the request objects themselves stay on the
 * message (`clarificationRequests` / `uploadRequests`), which is what the answer
 * handlers in chat/page.tsx mutate, so there is exactly one source of truth for
 * each one's status/answers. A part whose id matches no entry renders nothing.
 *
 * Those two fields are LISTS, one entry per round, precisely because a single
 * turn can ask several times ("which repo?" → answer → work → "which branch?"
 * → answer → work). They were single objects once; each new round overwrote the
 * previous one, so every earlier round's part stopped matching and its resolved
 * card silently vanished from the transcript.
 *
 * `tool_call` exists so the model covers everything that lands in a turn, but
 * is not populated today — live tool calls render through LiveTrace /
 * TraceSummary as a collapsed summary above the text, deliberately, and moving
 * them inline is a UX change rather than an ordering fix.
 *
 * Parts are live-stream-only. The reconcile refetch in useChatStream's onDone
 * replaces the cache with the server's copy, which has no parts (nor any
 * clarification rows — those are client-only), and rendering falls back to the
 * plain `content` string.
 */
export type MessagePart =
    | { seq: number; type: 'text'; text: string }
    | { seq: number; type: 'tool_call'; toolCallId: string }
    | { seq: number; type: 'clarification'; clarificationId: string }
    | { seq: number; type: 'upload'; uploadId: string };

export interface Message {
    id: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    createdAt: string;
    /** Ordered arrival-order view of this turn — see MessagePart. When present,
     *  MessageItem renders from it instead of the fixed per-field template. */
    parts?: MessagePart[];
    toolCalls?: ToolCall[];
    approvalRequest?: ApprovalRequest;
    generationConfirmRequest?: GenerationConfirmRequest;
    /** Every clarification round raised during this turn, in the order they
     *  were asked — see the note above MessagePart. At most one entry is ever
     *  'pending'; the rest are resolved rounds kept so their summary cards keep
     *  rendering at their own positions. */
    clarificationRequests?: ClarificationRequest[];
    /** Same as clarificationRequests, for upload requests. */
    uploadRequests?: UploadRequest[];
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
    citations?: Array<{ name: string; score: number }>;
    suggestedFollowUps?: string[];
    // Skills picked via "/" in the composer at the moment this message was
    // sent — a durable snapshot, same idea as attachments. Rendered as chips
    // under the message so the confirmation survives the reconcile refetch
    // that would otherwise wipe a client-only annotation.
    skillsUsed?: Array<{ id: string; name: string }>;
}

export interface Conversation {
    id: string;
    tenantId: string;
    agentId: string;
    title: string;
    status: 'active' | 'archived';
    createdAt: string;
    agent?: Agent;
    /** Newest user/assistant message, truncated server-side to 160 chars.
     *  Null for a conversation with nothing but placeholders in it. */
    lastMessage?: { role: string; content: string; createdAt: string } | null;
    /** Server-side grant: which Drive folder this conversation's agent may read.
     *  Enforcement lives in the orchestrator's tools — this is display only.
     *  allowMode: 'ask' (default) shows the ApproveCost card before every
     *  generation tool call; 'auto' skips it — enforced in
     *  confirmGenerationOrDecline, not just hidden client-side. */
    metadata?: {
        folderScope?: { prefix: string };
        allowMode?: 'ask' | 'auto';
        /** Set on a Test-in-chat conversation, which runs exactly this one skill. */
        testSkillInstallId?: string;
        /** Skills turned on in this conversation with "/". Never attached to the agent. */
        invokedSkills?: Array<{ installId: string; skillId: string; name: string }>;
    } | null;
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
    result?: Record<string, unknown>;
}
