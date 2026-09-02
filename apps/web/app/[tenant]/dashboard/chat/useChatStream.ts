'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useChat } from '@/hooks/useChat';
import { toast } from 'sonner';
import type { CanvasAction, CanvasEventData, ArtifactType } from '@/components/platform/canvas/types';
import type { ToolCall, CompletedToolCall, Message, MessagesResponse, ArtifactRef, MessageAttachment } from '@/components/platform/chat/types';
import type { Conversation } from '@/components/platform/chat/types';
import type { ClarificationRequest, ClarificationQuestion } from '@/components/platform/chat/types';
import type { Attachment } from '@/types/agent-events';
import type { ChatStreamEventType } from '@/components/platform/personas/usePersonaAnimationState';

// Relay emits tool names using the JS variable name as key (e.g. savePRD, not save-prd)
// normTool lowercases and replaces _ with - so savePRD → saveprd, save-prd → save-prd
const SAVE_TOOL_NAMES = new Set(['save-prd', 'save-plan', 'save-tasks', 'saveprd', 'saveplan', 'savetasks', 'render-canvas', 'rendercanvas', 'render_canvas']);
const sortByDate = (a: Message, b: Message) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

interface Params {
    conversationId: string | null;
    conversationIdRef: React.MutableRefObject<string | null>;
    agentId: string | undefined;
    folderId?: string;
    folderPrefix?: string;
    selectedConversation: Conversation | undefined;
    messages: Message[];
    handleCanvasUpdate: (action: CanvasAction, data: CanvasEventData) => void;
    openCanvas: () => void;
}

export function useChatStream({ conversationId, conversationIdRef, agentId, folderId, folderPrefix, selectedConversation, messages, handleCanvasUpdate, openCanvas }: Params) {
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

    const { sendMessage: sendChatMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying } = useChat({
        conversationId: conversationId || undefined,
        agentId,
        folderId,
        folderPrefix,

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
                    data[idx] = { ...data[idx], content: data[idx].content + delta, isStreaming: true };
                } else {
                    data.push({ id: messageId, conversationId: conversationIdRef.current!, role: 'assistant', content: delta, createdAt: new Date().toISOString(), isStreaming: true });
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
                // Orchestrator sends {fileId, name, type, size} per attachment (no local
                // UI id) — synthesize one here, matching the shape reconcile()'s server
                // refetch produces so the live and delayed paths converge on the same
                // Message shape.
                const atts = attachmentsRaw && Array.isArray(attachmentsRaw) && attachmentsRaw.length > 0
                    ? { attachments: (attachmentsRaw as Array<{ fileId: string; name: string; type: string; size?: number }>).map(a => ({ id: crypto.randomUUID(), fileId: a.fileId, name: a.name, type: a.type, size: a.size } satisfies MessageAttachment)) }
                    : {};
                if (idx >= 0) {
                    data[idx] = { ...data[idx], content: fullText || data[idx].content, isStreaming: false, ...plan, ...aref, ...trace, ...cites, ...followUps, ...atts };
                } else {
                    const zIdx = data.findIndex(m => m.isStreaming === true);
                    if (zIdx >= 0) {
                        data[zIdx] = { ...data[zIdx], isStreaming: false, content: fullText || data[zIdx].content, ...plan, ...aref, ...trace, ...cites, ...followUps, ...atts };
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
                        const idx = fresh.data.findIndex(m => m.id === messageId);
                        if (idx < 0) {
                            if (attempt < 4) setTimeout(() => reconcile(attempt + 1), 2000);
                            return;
                        }
                        // The DB only stores the {elapsedSec, toolCallCount} summary of
                        // completedTrace, not the detailed per-call cards this `trace`
                        // object carries — re-merge the full client trace back on.
                        const data = [...fresh.data];
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
            const query = String(args?.query ?? args?.filename ?? args?.subject ?? '');
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

        onClarificationRequired: useCallback((clarificationId: string, questions: ClarificationQuestion[]) => {
            // A malformed/empty payload would leave ClarificationCard indexing an empty
            // array (request.questions[pageIndex]) and crash — skip building the card.
            if (questions.length === 0) return;
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const request: ClarificationRequest = { id: clarificationId, questions, status: 'pending' };
                const msg: Message = {
                    id: crypto.randomUUID(),
                    conversationId: conversationIdRef.current!,
                    role: 'assistant',
                    content: '',
                    createdAt: new Date().toISOString(),
                    clarificationRequest: request,
                };
                return old ? { data: [...old.data, msg] } : { data: [msg] };
            });
        }, [queryClient]),
    });

    // Cancel any in-flight stream when navigating to a different conversation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { return () => { cancel(); }; }, [conversationId]);

    const sendMessage = async (content: string, attachments?: Attachment[]) => {
        if (!content.trim() && (!attachments || attachments.length === 0)) return;

        // Auto-generate title for new conversations
        if (!selectedConversation?.title && messages.length === 0 && content.trim()) {
            const words = content.trim().split(/\s+/);
            const title = words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');
            api.patch(`/api/v1/conversations/${conversationId}`, { title }).catch(console.error);
        }

        // Enrich media/doc attachments with presigned S3 URLs for the relay
        let enriched = attachments;
        if (attachments && attachments.length > 0) {
            const PRESIGN_TYPES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
            enriched = await Promise.all(attachments.map(async att => {
                if (PRESIGN_TYPES.some(t => att.type?.startsWith(t) || att.type === t)) {
                    try {
                        const { presignedUrl } = await api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(att.fileId)}/presigned-url`);
                        return { ...att, presignedUrl };
                    } catch { return att; }
                }
                return att;
            }));
        }

        // Optimistic user message
        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old => {
            const msg: Message = {
                id: crypto.randomUUID(), conversationId: conversationId!, role: 'user', content,
                attachments: attachments?.map(a => ({ id: crypto.randomUUID(), fileId: a.fileId, name: a.name, type: a.type, size: a.size, previewUrl: a.previewUrl })),
                createdAt: new Date().toISOString(),
            };
            return { data: [...(old?.data ?? []), msg].sort(sortByDate) };
        });

        setEventError(null);
        setWarmupMessage(null);
        setHasSentFirstMessage(true);
        streamStartRef.current = Date.now();
        setReasoningText('');
        await sendChatMessage(content, enriched);
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
        if (isStreaming) return;
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
        })));
    };

    const editAndResubmit = async (userMessage: Message, newContent: string) => {
        if (isStreaming) return;
        await truncateFrom(userMessage.createdAt);
        await sendMessage(newContent);
    };

    return {
        sendMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying,
        activeToolCalls, completedToolCalls, reasoningText,
        eventError, warmupMessage, agentTimedOut, hasSentFirstMessage,
        lastStreamEvent, regenerate, editAndResubmit,
    };
}
