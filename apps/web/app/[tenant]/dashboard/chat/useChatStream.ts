'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useChat } from '@/hooks/useChat';
import { toast } from 'sonner';
import type { CanvasAction, CanvasEventData, ArtifactType } from '@/components/platform/canvas/types';
import type { ToolCall, CompletedToolCall, Message, MessagePart, MessagesResponse, ArtifactRef, MessageAttachment } from '@/components/platform/chat/types';
import type { Conversation } from '@/components/platform/chat/types';
import type { ClarificationRequest, ClarificationQuestion, UploadRequest } from '@/components/platform/chat/types';
import { normalizeMessages } from '@/components/platform/chat/normalizeMessages';
import type { Attachment } from '@/types/agent-events';
import type { ChatStreamEventType } from '@/components/platform/personas/usePersonaAnimationState';
import { buildCreativeBriefMessage, creativeMessageDisplayText, parseCreativeBriefPresentation } from '@/components/platform/chat/creative-library/creativeBrief';

// Relay emits tool names using the JS variable name as key (e.g. savePRD, not save-prd)
// normTool lowercases and replaces _ with - so savePRD → saveprd, save-prd → save-prd
const SAVE_TOOL_NAMES = new Set(['save-prd', 'save-plan', 'save-tasks', 'saveprd', 'saveplan', 'savetasks', 'render-canvas', 'rendercanvas', 'render_canvas']);

// Orchestrator sends {fileId, name, type, size, generation?} per attachment (no
// local UI id) — synthesize one here, matching the shape reconcile()'s server
// refetch produces so the live and delayed paths converge on the same Message
// shape. Extracted as a named export (rather than inlined in onDone) so the
// field list — generation included — has one place to go stale, and so it's
// testable without mounting the hook: a prior fix here (2abec5ad/b43e03d9)
// dropped `generation` from this same map, and only surfaced when the API's
// own Zod schema was independently caught stripping it too.
export function mapStreamAttachments(
    attachmentsRaw: Array<{ fileId: string; name: string; type: string; size?: number; generation?: MessageAttachment['generation'] }>,
): MessageAttachment[] {
    return attachmentsRaw.map(a => ({
        id: crypto.randomUUID(),
        fileId: a.fileId,
        name: a.name,
        type: a.type,
        size: a.size,
        generation: a.generation,
    } satisfies MessageAttachment));
}
const sortByDate = (a: Message, b: Message) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

// --- Ordered message parts (see MessagePart in components/platform/chat/types) ---
//
// sortByDate can only order whole messages, and an assistant turn's createdAt is
// stamped once at its first token and never moves. So anything that arrives
// mid-turn (a clarifying question) could never be ordered against the text that
// came before and after it while both lived in separate message objects. These
// helpers record arrival order inside the turn instead.

/** Appends streamed text to the turn's open text part, or opens a new one. */
function appendTextPart(parts: MessagePart[] | undefined, delta: string, seq: number): MessagePart[] {
    const list = parts ? [...parts] : [];
    const last = list[list.length - 1];
    // Growing the open text part in place (rather than pushing one part per
    // token) is what keeps character-by-character streaming cheap: the parts
    // array identity changes, but its length and every earlier part's `seq`
    // key stay stable, so React reconciles the same nodes.
    if (last && last.type === 'text') {
        list[list.length - 1] = { ...last, text: last.text + delta };
        return list;
    }
    list.push({ seq, type: 'text', text: delta });
    return list;
}

/**
 * Squares the turn's text parts with the authoritative `fullText` from the
 * 'done' event. Normally they already agree (the same deltas built both), but
 * if the relay's final text diverges from what was streamed, the part list is
 * dropped so MessageItem falls back to rendering `content` — correct text
 * always wins over correct ordering.
 */
function reconcileParts(parts: MessagePart[] | undefined, fullText: string): MessagePart[] | undefined {
    if (!parts || parts.length === 0) return undefined;
    if (!fullText) return parts;
    const lastTextIdx = parts.map(p => p.type).lastIndexOf('text');
    if (lastTextIdx < 0) return parts;
    const prefix = parts
        .slice(0, lastTextIdx)
        .reduce((acc, p) => (p.type === 'text' ? acc + p.text : acc), '');
    const lastText = parts[lastTextIdx];
    if (lastText.type !== 'text') return parts;
    if (prefix + lastText.text === fullText) return parts;
    if (!fullText.startsWith(prefix)) return undefined;
    const next = [...parts];
    next[lastTextIdx] = { ...lastText, text: fullText.slice(prefix.length) };
    return next;
}

/**
 * Whether this message is already blocking on an in-turn request the user
 * hasn't resolved. Both a pending clarification and a pending upload render as
 * a full-panel `absolute inset-0` takeover in MessageThread, so a message that
 * hosted one of each at once would stack two overlays on top of each other —
 * hence a message may host at most one *unresolved* request at a time.
 */
function hasUnresolvedRequest(m: Message): boolean {
    return (m.clarificationRequests ?? []).some(r => r.status === 'pending')
        || (m.uploadRequests ?? []).some(r => r.status === 'pending');
}

/**
 * Attaches a clarification/upload request to the assistant turn it interrupted,
 * as the next part after whatever text has arrived so far. That's what puts the
 * resolved summary card back at the point the question was actually asked: text
 * written after the answer opens a new text part BELOW it, instead of merging
 * into one blob that sorts above the card.
 *
 * `turnMessageId` is this turn's assistant message id (useChat mints it on the
 * first event of the turn, request events included), so the request lands on the
 * right message even when it is the FIRST event of the turn and no row exists
 * yet — the row is created here with that id, and the turn's later text-deltas
 * reconcile into it rather than into a second, disconnected message.
 *
 * A message already blocking on an unresolved request of the *other* kind can't
 * host this one (two stacked overlays), so that case falls back to a placeholder
 * message of its own. A resolved request of the same kind is APPENDED next to,
 * never replaced: a turn that asks three times keeps all three request objects
 * (and three parts), so each round's resolved card keeps rendering at its own
 * position. Replacing them — the original shape — left the two earlier parts
 * pointing at ids that no longer existed, and their cards silently vanished.
 */
function appendRequest(m: Message, kind: 'clarification' | 'upload', request: ClarificationRequest | UploadRequest): Partial<Message> {
    return kind === 'clarification'
        ? { clarificationRequests: [...(m.clarificationRequests ?? []), request as ClarificationRequest] }
        : { uploadRequests: [...(m.uploadRequests ?? []), request as UploadRequest] };
}

function attachInTurnRequest(
    data: Message[],
    turnMessageId: string | undefined,
    conversationId: string,
    kind: 'clarification' | 'upload',
    request: ClarificationRequest | UploadRequest,
    part: MessagePart,
): Message[] {
    const idx = turnMessageId
        ? data.findIndex(m => m.id === turnMessageId)
        : data.findIndex(m => m.isStreaming === true && m.role === 'assistant');
    if (idx >= 0 && !hasUnresolvedRequest(data[idx])) {
        const next = [...data];
        next[idx] = { ...next[idx], ...appendRequest(next[idx], kind, request), parts: [...(next[idx].parts ?? []), part] };
        return next;
    }
    const base: Message = {
        // Only adopt the turn id when no row for it exists yet; a blocked
        // existing turn must not be overwritten by its own placeholder.
        id: idx < 0 && turnMessageId ? turnMessageId : crypto.randomUUID(),
        conversationId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        parts: [part],
    };
    return [...data, { ...base, ...appendRequest(base, kind, request) }];
}

interface Params {
    conversationId: string | null;
    conversationIdRef: React.MutableRefObject<string | null>;
    agentId: string | undefined;
    folderId?: string;
    folderPrefix?: string;
    allowMode?: 'ask' | 'auto';
    selectedConversation: Conversation | undefined;
    messages: Message[];
    handleCanvasUpdate: (action: CanvasAction, data: CanvasEventData) => void;
    openCanvas: () => void;
}

export function useChatStream({ conversationId, conversationIdRef, agentId, folderId, folderPrefix, allowMode, selectedConversation, messages, handleCanvasUpdate, openCanvas }: Params) {
    const queryClient = useQueryClient();
    const [eventError, setEventError] = useState<string | null>(null);
    // Carries a seq alongside the event type so a repeated identical event (e.g. a second
    // consecutive 'error') always produces a new object, guaranteeing the setState call is
    // never a same-value no-op that React silently skips re-rendering for.
    const [lastStreamEvent, setLastStreamEvent] = useState<{ type: ChatStreamEventType; seq: number } | null>(null);
    const streamEventSeqRef = useRef(0);
    const emitStreamEvent = useCallback((type: ChatStreamEventType) => {
        setLastStreamEvent({ type, seq: ++streamEventSeqRef.current });
    }, []);
    const [agentTimedOut, setAgentTimedOut] = useState(false);
    const [warmupMessage, setWarmupMessage] = useState<string | null>(null);
    const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
    // Attachment URLs are resolved before useChat starts its stream. Keep that
    // interval visible to callers so the optimistic row cannot be edited or
    // submitted twice while its original request is still being prepared.
    // The ref closes the same-tick gap before React commits the state update.
    const [isPreparingMessage, setIsPreparingMessage] = useState(false);
    const isPreparingMessageRef = useRef(false);
    const [activeToolCalls, setActiveToolCalls] = useState<Map<string, ToolCall>>(new Map());
    const [completedToolCalls, setCompletedToolCalls] = useState<CompletedToolCall[]>([]);
    // Mirrors completedToolCalls synchronously — onDone is a useCallback that
    // closes over completedToolCalls, but a 'tool_done' SSE event immediately
    // followed by 'done' in the same stream tick can fire before React commits
    // the setCompletedToolCalls update, leaving onDone reading the stale
    // (pre-append) array and building a trace with an empty toolCalls list.
    const completedToolCallsRef = useRef<CompletedToolCall[]>([]);
    // Extended-thinking trace for the live "thinking it through" row — never part of
    // the persisted message, reset per turn in sendMessage/onDone below.
    const [reasoningText, setReasoningText] = useState('');
    // Mirrors reasoningText for onDone (registered once via useChat) to read
    // without going stale — same reason streamStartRef/artifactRefRef exist.
    const reasoningTextRef = useRef('');
    // Tracks how long the reasoning phase itself took — first reasoning-delta
    // timestamp to the last one received — separate from streamStartRef (the
    // whole turn's elapsed time). Powers the completed "Thought for Ns" label,
    // reset per turn alongside reasoningTextRef.
    const reasoningStartRef = useRef<number | null>(null);
    const reasoningLastRef = useRef<number | null>(null);
    const artifactToolActiveRef = useRef<string | null>(null);
    const artifactRefRef = useRef<ArtifactRef | null>(null);
    // When the current turn's streaming began — used to compute the elapsed
    // time stashed onto the assistant Message as `completedTrace` in onDone,
    // since ThinkingIndicator (which used to own this timer) gets unmounted
    // by MessageThread the instant isStreaming flips false.
    const streamStartRef = useRef<number | null>(null);
    // Monotonic counter handing every message part its arrival-order `seq`
    // (also its React key). Reset per turn in sendMessage — parts only ever
    // sort within a single message.
    const partSeqRef = useRef(0);

    const handleToolDone = useCallback((toolCallId: string, results?: Array<{ title: string; domain: string; favicon?: string }>, result?: Record<string, unknown>) => {
        const call = activeToolCalls.get(toolCallId);
        if (!call) return;
        setCompletedToolCalls(prev => {
            const next = [...prev, { ...call, results, result }];
            completedToolCallsRef.current = next;
            return next;
        });
        setActiveToolCalls(prev => { const next = new Map(prev); next.delete(toolCallId); return next; });
    }, [activeToolCalls]);

    const { sendMessage: sendChatMessage, sendApproval, sendGenerationConfirm, sendClarificationAnswer, sendUploadAnswer, cancel, isStreaming, isRetrying } = useChat({
        conversationId: conversationId || undefined,
        agentId,
        folderId,
        folderPrefix,
        allowMode,

        onReasoning: useCallback((delta: string) => {
            emitStreamEvent('reasoning');
            if (reasoningStartRef.current === null) reasoningStartRef.current = Date.now();
            reasoningLastRef.current = Date.now();
            setReasoningText(prev => {
                const next = prev + delta;
                reasoningTextRef.current = next;
                return next;
            });
        }, [emitStreamEvent]),

        onDelta: useCallback((delta: string, messageId: string) => {
            emitStreamEvent('delta');
            if (activeToolCalls.size > 0) activeToolCalls.forEach((_, id) => handleToolDone(id, undefined));
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const data = old ? [...old.data] : [];
                const idx = data.findIndex(m => m.id === messageId);
                if (idx >= 0) {
                    const prevParts = data[idx].parts;
                    const nextParts = appendTextPart(prevParts, delta, partSeqRef.current + 1);
                    // The seq is only actually consumed when a NEW text part was
                    // opened — appending into the open one reuses its seq.
                    if (nextParts.length !== (prevParts?.length ?? 0)) partSeqRef.current++;
                    data[idx] = { ...data[idx], content: data[idx].content + delta, parts: nextParts, isStreaming: true };
                } else {
                    data.push({ id: messageId, conversationId: conversationIdRef.current!, role: 'assistant', content: delta, parts: [{ seq: ++partSeqRef.current, type: 'text', text: delta }], createdAt: new Date().toISOString(), isStreaming: true });
                }
                return { data: [...data].sort(sortByDate) };
            });
        }, [queryClient, activeToolCalls, handleToolDone]),

        onDone: useCallback((fullText: string, messageId: string, _convId?: string, planResult?: unknown, artifactRefRaw?: unknown, citationsRaw?: unknown, suggestedFollowUpsRaw?: unknown, attachmentsRaw?: unknown) => {
            emitStreamEvent('done');
            if (artifactToolActiveRef.current) {
                const aref = artifactRefRef.current;
                handleCanvasUpdate('artifact_done', {
                    entityId: aref?.entityId ?? undefined,
                    entityMeta: { pmRunId: aref?.pmRunId, pmStepId: aref?.pmStepId },
                });
                artifactToolActiveRef.current = null;
            }
            artifactRefRef.current = null;
            const artifactRef = artifactRefRaw as ArtifactRef | undefined ?? undefined;
            // If relay attached pmRunId/pmStepId (HITL workflow started), push them into Canvas state
            if (artifactRef?.pmRunId && artifactRef?.pmStepId) {
                handleCanvasUpdate('artifact_done', {
                    entityId: artifactRef.entityId,
                    entityMeta: { pmRunId: artifactRef.pmRunId, pmStepId: artifactRef.pmStepId },
                });
            }

            // Compute the same "did this turn take a while / did it use tools" trace
            // ThinkingIndicator used to compute internally, and stash it on the
            // Message so MessageItem can render the collapsed summary after this
            // component (and ThinkingIndicator) unmounts.
            const elapsedSec = streamStartRef.current !== null
                ? Math.max(0, Math.floor((Date.now() - streamStartRef.current) / 1000))
                : 0;
            streamStartRef.current = null;
            const reasoningTextAtDone = reasoningTextRef.current;
            const reasoningElapsedSec = reasoningStartRef.current !== null && reasoningLastRef.current !== null
                ? Math.max(1, Math.round((reasoningLastRef.current - reasoningStartRef.current) / 1000))
                : undefined;
            reasoningStartRef.current = null;
            reasoningLastRef.current = null;
            const toolCallsAtDone = completedToolCallsRef.current;
            const hadTrace = toolCallsAtDone.length > 0 || elapsedSec >= 2 || !!reasoningTextAtDone;
            const trace = hadTrace ? { completedTrace: { elapsedSec, toolCalls: toolCallsAtDone, reasoningText: reasoningTextAtDone || undefined, reasoningElapsedSec } } : {};

            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const data = old ? [...old.data] : [];
                const idx = data.findIndex(m => m.id === messageId);
                const plan = planResult ? { planResult: planResult as Message['planResult'] } : {};
                const aref = artifactRef ? { artifactRef: artifactRef as ArtifactRef } : {};
                const cites = citationsRaw && Array.isArray(citationsRaw) && citationsRaw.length > 0
                    ? { citations: citationsRaw as Message['citations'] }
                    : {};
                const followUps = suggestedFollowUpsRaw && Array.isArray(suggestedFollowUpsRaw) && suggestedFollowUpsRaw.length > 0
                    ? { suggestedFollowUps: suggestedFollowUpsRaw as string[] }
                    : {};
                const atts = attachmentsRaw && Array.isArray(attachmentsRaw) && attachmentsRaw.length > 0
                    ? { attachments: mapStreamAttachments(attachmentsRaw as Array<{ fileId: string; name: string; type: string; size?: number; generation?: MessageAttachment['generation'] }>) }
                    : {};
                // planResult replaces the rendered body with its own summary, so the
                // streamed part list no longer describes what's on screen — drop it
                // and let MessageItem render the legacy way.
                const settleParts = (m: Message) => ({ parts: planResult ? undefined : reconcileParts(m.parts, fullText || m.content) });
                if (idx >= 0) {
                    data[idx] = { ...data[idx], content: fullText || data[idx].content, isStreaming: false, ...settleParts(data[idx]), ...plan, ...aref, ...trace, ...cites, ...followUps, ...atts };
                } else {
                    const zIdx = data.findIndex(m => m.isStreaming === true);
                    if (zIdx >= 0) {
                        data[zIdx] = { ...data[zIdx], isStreaming: false, content: fullText || data[zIdx].content, ...settleParts(data[zIdx]), ...plan, ...aref, ...trace, ...cites, ...followUps, ...atts };
                    } else if (fullText || 'attachments' in atts) {
                        // A tool-only turn (e.g. generate_image with no narrated text) still
                        // has to land here — gating on fullText alone silently dropped the
                        // whole message, attachments included, whenever the model replied
                        // with zero text deltas.
                        data.push({ id: messageId, conversationId: conversationIdRef.current!, role: 'assistant', content: fullText, createdAt: new Date().toISOString(), isStreaming: false, ...plan, ...aref, ...trace, ...cites, ...followUps, ...atts });
                    }
                }
                return { data: [...data].sort(sortByDate) };
            });
            setTimeout(() => { setActiveToolCalls(new Map()); setCompletedToolCalls([]); completedToolCallsRef.current = []; setReasoningText(''); reasoningTextRef.current = ''; }, 1500);
            setTimeout(() => {
                const conversationId = conversationIdRef.current;
                if (!conversationId) return;

                // The backend persists this turn's messages asynchronously (fire-and-forget,
                // right after the 'done' SSE event) — on a cold Lambda that save can take
                // longer than this delay. A blind invalidateQueries() would then overwrite
                // the correct optimistic message list with an incomplete server response,
                // making the conversation appear empty. Instead: fetch fresh data without
                // committing it, only replace the cache once the assistant message we're
                // waiting on actually shows up, and retry a few times if it hasn't yet —
                // never regress the UI to a state with fewer messages than it already has.
                const reconcile = (attempt: number): void => {
                    queryClient.fetchQuery<MessagesResponse>({
                        queryKey: ['messages', conversationId],
                        queryFn: () => api.get<MessagesResponse>(`/api/v1/conversations/${conversationId}/messages`),
                    }).then(fresh => {
                        // The server still stores one clarification/upload request
                        // per message row — lift it into the client's per-round
                        // list shape before it reaches the cache.
                        const normalized = normalizeMessages(fresh.data);
                        const idx = normalized.findIndex(m => m.id === messageId);
                        if (idx < 0) {
                            if (attempt < 4) setTimeout(() => reconcile(attempt + 1), 2000);
                            return;
                        }
                        // The DB only stores the {elapsedSec, toolCallCount} summary of
                        // completedTrace, not the detailed per-call cards this `trace`
                        // object carries — re-merge the full client trace back on.
                        const data = [...normalized];
                        if (hadTrace) data[idx] = { ...data[idx], ...trace };
                        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], { data });
                    }).catch(() => {
                        if (attempt < 4) setTimeout(() => reconcile(attempt + 1), 2000);
                    });
                };
                reconcile(0);

                queryClient.invalidateQueries({ queryKey: ['conversations'] });
                queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
                queryClient.invalidateQueries({ queryKey: ['conversation-assets', conversationId] });
            }, 2000);
        }, [queryClient, handleCanvasUpdate]),

        onError: useCallback((code: string, message: string) => {
            emitStreamEvent('error');
            if (code === 'AGENT_TIMEOUT') { setAgentTimedOut(true); return; }
            if (code === 'WARMUP_TIMEOUT') { setWarmupMessage(message); return; }
            setEventError(`[${code}] ${message}`);
            toast.error(message);
        }, []),

        onToolCall: useCallback((toolName: string, toolCallId: string, args: Record<string, unknown>) => {
            emitStreamEvent('tool_call');
            const query = String(args?.query ?? args?.filename ?? args?.subject ?? args?.prompt ?? '');
            setActiveToolCalls(prev => { const next = new Map(prev); next.set(toolCallId, { id: toolCallId, toolName, arguments: args, isLoading: true, query }); return next; });
            const normTool = toolName.toLowerCase().replace(/_/g, '-');
            // Only open canvas when an actual save tool fires — this is the definitive signal
            // that a PRD/roadmap/tasks artifact is being persisted. Never open on agent delegation
            // events (agent-prdagent etc.) because those also fire during clarifying questions.
            if (SAVE_TOOL_NAMES.has(normTool)) {
                const type: ArtifactType =
                    normTool === 'saveprd' ? 'prd' :
                    normTool === 'saveplan' ? 'roadmap' :
                    (normTool === 'savetasks' || normTool === 'save-tasks') ? 'tasks' :
                    (String(args.type ?? 'document') as ArtifactType);
                artifactToolActiveRef.current = normTool;
                openCanvas();
                handleCanvasUpdate('artifact_start', { artifactType: type, artifactTitle: String(args.title ?? type.toUpperCase()) });
            }
        }, [handleCanvasUpdate, openCanvas]),

        onToolDone: useCallback((toolCallId: string, toolName: string, result: Record<string, unknown>, results?: Array<{ title: string; domain: string; favicon?: string }>) => {
            emitStreamEvent('tool_done');
            handleToolDone(toolCallId, results, result);
            if (!SAVE_TOOL_NAMES.has(toolName.toLowerCase().replace(/_/g, '-')) || !artifactToolActiveRef.current) return;

            const content = typeof result.content === 'string' ? result.content : '';
            const entityId = (result?.prdId ?? result?.planId ?? result?.taskBoardId) as string | undefined;
            const normTool2 = toolName.toLowerCase().replace(/_/g, '-');
            const artifactType = normTool2 === 'saveprd' ? 'prd' : normTool2 === 'saveplan' ? 'roadmap' : 'tasks';
            const artifactTitle = String(result.title ?? artifactType.toUpperCase());
            if (entityId) artifactRefRef.current = { type: artifactType as ArtifactRef['type'], entityId, title: artifactTitle, content, pmRunId: undefined, pmStepId: undefined };

            // Clear ref immediately so subsequent text-delta from parent agent goes to chat only
            artifactToolActiveRef.current = null;

            if (!content) {
                handleCanvasUpdate('artifact_done', { entityId, entityMeta: result });
                return;
            }

            // Fake-stream content into artifact panel chunk by chunk (30 chars / 6ms ≈ 2.5s for 12k chars)
            const CHUNK = 30;
            const DELAY = 6;
            const total = Math.ceil(content.length / CHUNK);
            for (let i = 0; i < total; i++) {
                setTimeout(() => {
                    handleCanvasUpdate('artifact_chunk', { chunk: content.slice(i * CHUNK, (i + 1) * CHUNK) });
                    if (i === total - 1) {
                        handleCanvasUpdate('artifact_done', { entityId, entityMeta: result });
                    }
                }, i * DELAY);
            }
        }, [handleToolDone, handleCanvasUpdate]),

        onApprovalRequired: useCallback((approvalId: string, toolName: string, description: string, args: Record<string, unknown>) => {
            emitStreamEvent('approval_request');
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const msg: Message = { id: crypto.randomUUID(), conversationId: conversationIdRef.current!, role: 'assistant', content: '', createdAt: new Date().toISOString(), approvalRequest: { id: approvalId, toolName, description, arguments: args, status: 'pending' } };
                return old ? { data: [...old.data, msg] } : { data: [msg] };
            });
        }, [queryClient]),

        onGenerationConfirmRequired: useCallback((confirmationId: string, resourceType: string, subject: string, label: string, preview?: string) => {
            emitStreamEvent('generation_confirm_request');
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const msg: Message = {
                    id: crypto.randomUUID(),
                    conversationId: conversationIdRef.current!,
                    role: 'assistant',
                    content: '',
                    createdAt: new Date().toISOString(),
                    generationConfirmRequest: { id: confirmationId, resourceType, subject, label, status: 'pending', ...(preview ? { preview } : {}) },
                };
                return old ? { data: [...old.data, msg] } : { data: [msg] };
            });
        }, [queryClient]),

        onClarificationRequired: useCallback((clarificationId: string, questions: ClarificationQuestion[], turnMessageId: string) => {
            // A malformed/empty payload would leave ClarificationCard indexing an empty
            // array (request.questions[pageIndex]) and crash — skip building the card.
            if (questions.length === 0) return;
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const request: ClarificationRequest = { id: clarificationId, questions, status: 'pending' };
                const seq = ++partSeqRef.current;
                const data = attachInTurnRequest(
                    old ? [...old.data] : [],
                    turnMessageId,
                    conversationIdRef.current!,
                    'clarification',
                    request,
                    { seq, type: 'clarification', clarificationId },
                );
                return { data };
            });
        }, [queryClient]),

        onUploadRequired: useCallback((uploadId: string, prompt: string, minFiles: number, maxFiles: number, turnMessageId: string) => {
            if (!prompt) return;
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const request: UploadRequest = { id: uploadId, prompt, minFiles, maxFiles, status: 'pending' };
                const seq = ++partSeqRef.current;
                // Same in-turn attachment as onClarificationRequired above.
                const data = attachInTurnRequest(
                    old ? [...old.data] : [],
                    turnMessageId,
                    conversationIdRef.current!,
                    'upload',
                    request,
                    { seq, type: 'upload', uploadId },
                );
                return { data };
            });
        }, [queryClient]),
    });

    // Cancel any in-flight stream when SWITCHING to a different conversation —
    // deliberately not a cleanup function, which would also fire on a plain
    // unmount (navigating to another page entirely). That previously aborted
    // the fetch on any navigation away from /chat, and the orchestrator's SSE
    // route can't tell that apart from the user clicking Stop (both are just
    // "client disconnected" to it) — it discards the whole in-flight turn
    // rather than persisting the reply (see chatStream.ts's isStreamClosed
    // guard). Leaving the page should let the agent keep working; only an
    // actual conversation switch should cancel it.
    const prevConversationIdRef = useRef(conversationId);
    useEffect(() => {
        if (prevConversationIdRef.current !== conversationId) cancel();
        prevConversationIdRef.current = conversationId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationId]);

    const sendMessage = async (content: string, attachments?: Attachment[], skillsUsed?: Array<{ id: string; name: string }>) => {
        if (!content.trim() && (!attachments || attachments.length === 0)) return;
        if (isStreaming || isPreparingMessageRef.current) return;

        isPreparingMessageRef.current = true;
        setIsPreparingMessage(true);
        const displayContent = creativeMessageDisplayText(content);

        // Title is generated server-side (chatStream.ts) from the first
        // message's content once the agent's reply is known — this flag just
        // tells the orchestrator this is that first turn.
        const isFirstMessage = !selectedConversation?.title && messages.length === 0 && displayContent.trim().length > 0;

        // Show the user's turn immediately. Resolving presigned attachment URLs
        // can take long enough for the empty-conversation welcome screen to flash
        // between navigation and the first message without this optimistic insert.
        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old => {
            const msg: Message = {
                id: crypto.randomUUID(), conversationId: conversationId!, role: 'user', content,
                attachments: attachments?.map(a => ({ id: crypto.randomUUID(), fileId: a.fileId, name: a.name, type: a.type, size: a.size, previewUrl: a.previewUrl })),
                skillsUsed: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
                createdAt: new Date().toISOString(),
            };
            return { data: [...(old?.data ?? []), msg].sort(sortByDate) };
        });
        setHasSentFirstMessage(true);

        try {
            // Enrich media/doc attachments with presigned S3 URLs for the relay.
            let enriched = attachments;
            if (attachments && attachments.length > 0) {
                const PRESIGN_TYPES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
                enriched = await Promise.all(attachments.map(async att => {
                    if (PRESIGN_TYPES.some(t => att.type?.startsWith(t) || att.type === t)) {
                        try {
                            const { presignedUrl } = await api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(att.fileId)}/presigned-url`);
                            return { ...att, presignedUrl };
                        } catch (err) {
                            // Only retry on 404 (fileId genuinely not in
                            // the tenant files table — e.g. a
                            // creative_library_assets id, such as an
                            // avatar preset picked in the composer).
                            // /files/:id/presigned-url also 403s when the
                            // caller lacks files:read — that case must
                            // fail here, not silently fall through to a
                            // route with a different access model.
                            if ((err as { status?: number }).status !== 404) return att;
                            try {
                                const { presignedUrl } = await api.get<{ presignedUrl: string }>(`/api/v1/creative-library-assets/${encodeURIComponent(att.fileId)}/presigned-url`);
                                return { ...att, presignedUrl };
                            } catch { return att; }
                        }
                    }
                    return att;
                }));
            }

            setEventError(null);
            setWarmupMessage(null);
            streamStartRef.current = Date.now();
            partSeqRef.current = 0;
            setReasoningText('');
            // useChat marks the transport as streaming synchronously before its
            // first await, so control passes directly from preparation to the
            // existing streaming state without enabling the composer between.
            const streamPromise = sendChatMessage(content, enriched, skillsUsed, isFirstMessage);
            isPreparingMessageRef.current = false;
            setIsPreparingMessage(false);
            await streamPromise;
        } finally {
            isPreparingMessageRef.current = false;
            setIsPreparingMessage(false);
        }
    };

    // Truncate app DB + Mastra memory from fromTimestamp onward, then optimistically
    // remove those messages from the React Query cache.
    const truncateFrom = async (fromTimestamp: string) => {
        const cid = conversationIdRef.current;
        if (!cid) return;
        // Optimistic cache update
        queryClient.setQueryData<MessagesResponse>(['messages', cid], old => {
            if (!old) return old;
            return { data: old.data.filter(m => m.createdAt < fromTimestamp) };
        });
        // Server-side delete
        await api.del(`/api/v1/conversations/${cid}/messages/truncate`, { fromTimestamp });
    };

    const regenerate = async (assistantMessage: Message) => {
        if (isStreaming || isPreparingMessageRef.current) return;
        // Find the user message immediately before this assistant message
        const currentMessages = queryClient.getQueryData<MessagesResponse>(['messages', conversationIdRef.current]);
        const msgList = currentMessages?.data ?? [];
        const idx = msgList.findIndex(m => m.id === assistantMessage.id);
        const userMsg = idx > 0 ? msgList[idx - 1] : null;
        if (!userMsg || userMsg.role !== 'user') return;

        await truncateFrom(assistantMessage.createdAt);
        // Re-send the user's original message
        await sendMessage(userMsg.content, userMsg.attachments?.map(a => ({
            fileId: a.fileId ?? a.id,
            name: a.name,
            type: a.type,
            size: a.size,
            previewUrl: a.previewUrl,
        })), userMsg.skillsUsed);
    };

    const editAndResubmit = async (userMessage: Message, newContent: string) => {
        if (isStreaming || isPreparingMessageRef.current) return;
        const presentation = parseCreativeBriefPresentation(userMessage.content);
        const content = presentation
            ? buildCreativeBriefMessage(newContent, presentation.brief)
            : newContent;
        const attachments = userMessage.attachments?.map(a => ({
            fileId: a.fileId ?? a.id,
            name: a.name,
            type: a.type,
            size: a.size,
            previewUrl: a.previewUrl,
        }));
        await truncateFrom(userMessage.createdAt);
        await sendMessage(content, attachments, userMessage.skillsUsed);
    };

    return {
        sendMessage, sendApproval, sendGenerationConfirm, sendClarificationAnswer, sendUploadAnswer, cancel, isStreaming, isPreparingMessage, isRetrying,
        activeToolCalls, completedToolCalls, reasoningText,
        eventError, warmupMessage, agentTimedOut, hasSentFirstMessage,
        lastStreamEvent, regenerate, editAndResubmit,
    };
}
