'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useChat } from '@/hooks/useChat';
import { toast } from 'sonner';
import type { CanvasAction, CanvasEventData, ArtifactType } from '@/components/platform/canvas/types';
import type { ToolCall, CompletedToolCall, Message, MessagesResponse, ArtifactRef } from '@/components/platform/chat/types';
import type { Conversation } from '@/components/platform/chat/types';
import type { Attachment } from '@/types/agent-events';

// Relay emits tool names using the JS variable name as key (e.g. savePRD, not save-prd)
// normTool lowercases and replaces _ with - so savePRD → saveprd, save-prd → save-prd
const SAVE_TOOL_NAMES = new Set(['save-prd', 'save-plan', 'save-tasks', 'saveprd', 'saveplan', 'savetasks']);
const sortByDate = (a: Message, b: Message) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

interface Params {
    conversationId: string | null;
    conversationIdRef: React.MutableRefObject<string | null>;
    agentId: string | undefined;
    selectedConversation: Conversation | undefined;
    messages: Message[];
    handleCanvasUpdate: (action: CanvasAction, data: CanvasEventData) => void;
    openCanvas: () => void;
}

export function useChatStream({ conversationId, conversationIdRef, agentId, selectedConversation, messages, handleCanvasUpdate, openCanvas }: Params) {
    const queryClient = useQueryClient();
    const [eventError, setEventError] = useState<string | null>(null);
    const [agentTimedOut, setAgentTimedOut] = useState(false);
    const [warmupMessage, setWarmupMessage] = useState<string | null>(null);
    const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
    const [activeToolCalls, setActiveToolCalls] = useState<Map<string, ToolCall>>(new Map());
    const [completedToolCalls, setCompletedToolCalls] = useState<CompletedToolCall[]>([]);
    const artifactToolActiveRef = useRef<string | null>(null);
    const artifactRefRef = useRef<ArtifactRef | null>(null);

    const handleToolDone = useCallback((toolCallId: string, results?: Array<{ title: string; domain: string; favicon?: string }>) => {
        const call = activeToolCalls.get(toolCallId);
        if (!call) return;
        setCompletedToolCalls(prev => [...prev, { ...call, results }]);
        setActiveToolCalls(prev => { const next = new Map(prev); next.delete(toolCallId); return next; });
    }, [activeToolCalls]);

    const { sendMessage: sendChatMessage, sendApproval, cancel, isStreaming, isRetrying } = useChat({
        conversationId: conversationId || undefined,
        agentId,

        onDelta: useCallback((delta: string, messageId: string) => {
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

        onDone: useCallback((fullText: string, messageId: string, _convId?: string, planResult?: unknown, artifactRefRaw?: unknown) => {
            if (artifactToolActiveRef.current) {
                handleCanvasUpdate('artifact_done', { entityId: undefined, entityMeta: undefined });
                artifactToolActiveRef.current = null;
            }
            artifactRefRef.current = null;
            const artifactRef = artifactRefRaw as ArtifactRef | undefined ?? undefined;
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const data = old ? [...old.data] : [];
                const idx = data.findIndex(m => m.id === messageId);
                const plan = planResult ? { planResult: planResult as Message['planResult'] } : {};
                const aref = artifactRef ? { artifactRef: artifactRef as ArtifactRef } : {};
                if (idx >= 0) {
                    data[idx] = { ...data[idx], content: fullText || data[idx].content, isStreaming: false, ...plan, ...aref };
                } else {
                    const zIdx = data.findIndex(m => m.isStreaming === true);
                    if (zIdx >= 0) {
                        data[zIdx] = { ...data[zIdx], isStreaming: false, content: fullText || data[zIdx].content, ...plan, ...aref };
                    } else if (fullText) {
                        data.push({ id: messageId, conversationId: conversationIdRef.current!, role: 'assistant', content: fullText, createdAt: new Date().toISOString(), isStreaming: false, ...plan, ...aref });
                    }
                }
                return { data: [...data].sort(sortByDate) };
            });
            setTimeout(() => { setActiveToolCalls(new Map()); setCompletedToolCalls([]); }, 1500);
            setTimeout(() => {
                queryClient.invalidateQueries({ queryKey: ['messages', conversationIdRef.current] });
                queryClient.invalidateQueries({ queryKey: ['conversations'] });
                queryClient.invalidateQueries({ queryKey: ['conversation', conversationIdRef.current] });
            }, 2000);
        }, [queryClient, handleCanvasUpdate]),

        onError: useCallback((code: string, message: string) => {
            if (code === 'AGENT_TIMEOUT') { setAgentTimedOut(true); return; }
            if (code === 'WARMUP_TIMEOUT') { setWarmupMessage(message); return; }
            setEventError(`[${code}] ${message}`);
            toast.error(message);
        }, []),

        onToolCall: useCallback((toolName: string, toolCallId: string, args: Record<string, unknown>) => {
            const query = String(args?.query ?? args?.filename ?? args?.subject ?? '');
            setActiveToolCalls(prev => { const next = new Map(prev); next.set(toolCallId, { id: toolCallId, toolName, arguments: args, isLoading: true, query }); return next; });
            const normTool = toolName.toLowerCase().replace(/_/g, '-');
            // Only open canvas when an actual save tool fires — this is the definitive signal
            // that a PRD/roadmap/tasks artifact is being persisted. Never open on agent delegation
            // events (agent-prdagent etc.) because those also fire during clarifying questions.
            if (SAVE_TOOL_NAMES.has(normTool)) {
                const type = normTool === 'saveprd' ? 'prd' : normTool === 'saveplan' ? 'roadmap' : 'tasks';
                artifactToolActiveRef.current = normTool;
                openCanvas();
                handleCanvasUpdate('artifact_start', { artifactType: type as ArtifactType, artifactTitle: String(args.title ?? type.toUpperCase()) });
            }
        }, [handleCanvasUpdate, openCanvas]),

        onToolDone: useCallback((toolCallId: string, toolName: string, result: Record<string, unknown>, results?: Array<{ title: string; domain: string; favicon?: string }>) => {
            handleToolDone(toolCallId, results);
            if (!SAVE_TOOL_NAMES.has(toolName.toLowerCase().replace(/_/g, '-')) || !artifactToolActiveRef.current) return;

            const content = typeof result.content === 'string' ? result.content : '';
            const entityId = (result?.prdId ?? result?.planId ?? result?.taskBoardId) as string | undefined;
            const normTool2 = toolName.toLowerCase().replace(/_/g, '-');
            const artifactType = normTool2 === 'saveprd' ? 'prd' : normTool2 === 'saveplan' ? 'roadmap' : 'tasks';
            const artifactTitle = String(result.title ?? artifactType.toUpperCase());
            if (entityId) artifactRefRef.current = { type: artifactType as ArtifactRef['type'], entityId, title: artifactTitle, content };

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
            queryClient.setQueryData<MessagesResponse>(['messages', conversationIdRef.current], old => {
                const msg: Message = { id: crypto.randomUUID(), conversationId: conversationIdRef.current!, role: 'assistant', content: '', createdAt: new Date().toISOString(), approvalRequest: { id: approvalId, toolName, description, arguments: args, status: 'pending' } };
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

        // Pre-save user message with fileIds so they survive page refresh
        if (attachments?.some(a => a.fileId)) {
            api.post(`/api/v1/conversations/${conversationId}/messages/save`, {
                role: 'user', content,
                attachments: attachments.map(a => ({ fileId: a.fileId, name: a.name, type: a.type, size: a.size })),
            }).catch(err => console.warn('[pre-save]', err));
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
        await sendChatMessage(content, enriched);
    };

    return {
        sendMessage, sendApproval, cancel, isStreaming, isRetrying,
        activeToolCalls, completedToolCalls,
        eventError, warmupMessage, agentTimedOut, hasSentFirstMessage,
    };
}
