'use client';

import { useState, useRef, useCallback } from 'react';
import type { Attachment } from '@/types/agent-events';
import { SSEParser } from './useChat/sseParser';
import { getAuthTokens, attemptRefresh } from './useChat/auth';
import type { ClarificationQuestion } from '@/components/platform/chat/types';

const CHAT_ENDPOINT = `${process.env.NEXT_PUBLIC_AGENT_CHAT_URL ?? 'https://projectcontext.co'}/api/chat`;
const RETRY_INTERVAL_MS = 5_000;
const RETRY_MAX_MS = 90_000;
const WARMUP_MESSAGE = 'Taking longer than usual. Your workspace is still warming up — please try again in a moment.';

export interface UseChatOptions {
    conversationId?: string;
    agentId?: string;
    folderId?: string;
    folderPrefix?: string;
    onDelta?: (delta: string, messageId: string, conversationId?: string) => void;
    onReasoning?: (delta: string) => void;
    onDone?: (fullText: string, messageId: string, conversationId?: string, planResult?: unknown, artifactRef?: unknown, citations?: unknown, suggestedFollowUps?: unknown, attachments?: unknown) => void;
    onError?: (code: string, message: string) => void;
    onToolCall?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => void;
    onToolDone?: (toolCallId: string, toolName: string, result: Record<string, unknown>, results?: Array<{ title: string; domain: string; favicon?: string }>) => void;
    onApprovalRequired?: (approvalId: string, toolName: string, description: string, args: Record<string, unknown>) => void;
    onGenerationConfirmRequired?: (confirmationId: string, resourceType: string, subject: string, label: string) => void;
    onClarificationRequired?: (clarificationId: string, questions: ClarificationQuestion[]) => void;
}

export interface UseChatReturn {
    sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>;
    sendApproval: (approvalId: string, decision: 'approved' | 'dismissed') => Promise<boolean>;
    sendGenerationConfirm: (confirmationId: string, decision: 'approved' | 'declined', reason?: string) => Promise<boolean>;
    sendClarificationAnswer: (clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }) => Promise<boolean>;
    cancel: () => void;
    isStreaming: boolean;
    isRetrying: boolean;
    streamingText: string;
}

export function useChat(options: UseChatOptions): UseChatReturn {
    const {
        conversationId,
        agentId,
        folderId,
        folderPrefix,
        onDelta,
        onReasoning,
        onDone,
        onError,
        onToolCall,
        onToolDone,
        onApprovalRequired,
        onGenerationConfirmRequired,
        onClarificationRequired,
    } = options;

    const [isStreaming, setIsStreaming] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);
    const [streamingText, setStreamingText] = useState('');

    const abortControllerRef = useRef<AbortController | null>(null);
    const parserRef = useRef(new SSEParser());
    const sendMessageRef = useRef<((text: string, attachments?: Attachment[]) => Promise<void>) | null>(null);

    const retryStartRef = useRef<number | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingRetryPayloadRef = useRef<{ text: string; attachments?: Attachment[] } | null>(null);

    // Keep latest option callbacks in refs so they never stale-close over props.
    const onDeltaRef = useRef(onDelta);
    const onReasoningRef = useRef(onReasoning);
    const onDoneRef = useRef(onDone);
    const onErrorRef = useRef(onError);
    const onToolCallRef = useRef(onToolCall);
    const onToolDoneRef = useRef(onToolDone);
    const onApprovalRequiredRef = useRef(onApprovalRequired);
    const onGenerationConfirmRequiredRef = useRef(onGenerationConfirmRequired);
    const onClarificationRequiredRef = useRef(onClarificationRequired);
    const conversationIdRef = useRef(conversationId);
    const agentIdRef = useRef(agentId);
    const folderIdRef = useRef(folderId);
    const folderPrefixRef = useRef(folderPrefix);

    onDeltaRef.current = onDelta;
    onReasoningRef.current = onReasoning;
    folderIdRef.current = folderId;
    folderPrefixRef.current = folderPrefix;
    onDoneRef.current = onDone;
    onErrorRef.current = onError;
    onToolCallRef.current = onToolCall;
    onToolDoneRef.current = onToolDone;
    onApprovalRequiredRef.current = onApprovalRequired;
    onGenerationConfirmRequiredRef.current = onGenerationConfirmRequired;
    onClarificationRequiredRef.current = onClarificationRequired;
    conversationIdRef.current = conversationId;
    agentIdRef.current = agentId;

    const clearRetry = useCallback(() => {
        if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        retryStartRef.current = null;
        pendingRetryPayloadRef.current = null;
        setIsRetrying(false);
    }, []);

    const scheduleRetry = useCallback(() => {
        const now = Date.now();
        if (retryStartRef.current === null) retryStartRef.current = now;
        if (now - retryStartRef.current < RETRY_MAX_MS) {
            setIsRetrying(true);
            retryTimerRef.current = setTimeout(() => {
                if (pendingRetryPayloadRef.current) {
                    sendMessageRef.current?.(
                        pendingRetryPayloadRef.current.text,
                        pendingRetryPayloadRef.current.attachments,
                    );
                }
            }, RETRY_INTERVAL_MS);
        } else {
            clearRetry();
            onErrorRef.current?.('WARMUP_TIMEOUT', WARMUP_MESSAGE);
        }
    }, [clearRetry]);

    const cancel = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        clearRetry();
        setIsStreaming(false);
    }, [clearRetry]);

    const sendMessage = useCallback(async (text: string, attachments?: Attachment[]) => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        pendingRetryPayloadRef.current = { text, attachments };

        let { accessToken: token, idToken } = getAuthTokens();

        if (!token) {
            clearRetry();
            onErrorRef.current?.('AUTH_ERROR', 'No platform_access_token found in cookies');
            return;
        }

        parserRef.current.reset();
        setStreamingText('');
        setIsStreaming(true);

        let accumulatedText = '';
        let currentMessageId: string | null = null;

        const buildRequest = (accessToken: string, currentIdToken: string | undefined) => ({
            method: 'POST' as const,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                ...(currentIdToken ? { 'X-Id-Token': currentIdToken } : {}),
                'Accept': 'text/event-stream',
            },
            body: JSON.stringify({
                message: text,
                agentId: agentIdRef.current,
                conversationId: conversationIdRef.current,
                attachments,
                ...(folderIdRef.current ? { folderId: folderIdRef.current } : {}),
                ...(folderPrefixRef.current ? { folderPrefix: folderPrefixRef.current } : {}),
            }),
            signal: controller.signal,
        });

        try {
            let response = await fetch(CHAT_ENDPOINT, buildRequest(token, idToken));

            if (response.status === 401) {
                const refreshed = await attemptRefresh();
                if (!refreshed) {
                    window.location.href = '/auth/login';
                    return;
                }
                const refreshedTokens = getAuthTokens();
                if (!refreshedTokens.accessToken) {
                    window.location.href = '/auth/login';
                    return;
                }
                token = refreshedTokens.accessToken;
                idToken = refreshedTokens.idToken;
                response = await fetch(CHAT_ENDPOINT, buildRequest(token, idToken));
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                let message = `HTTP ${response.status}`;
                try {
                    const parsed = JSON.parse(body);
                    message = parsed.message || parsed.error || message;
                } catch {
                    // ignore
                }

                if (response.status >= 400 && response.status < 500) {
                    clearRetry();
                    onErrorRef.current?.('HTTP_ERROR', message);
                    setIsStreaming(false);
                    return;
                }

                // 5xx — retriable
                setIsStreaming(false);
                scheduleRetry();
                return;
            }

            if (!response.body) {
                onErrorRef.current?.('STREAM_ERROR', 'Response body is null');
                setIsStreaming(false);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let authExpired = false;

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const events = parserRef.current.push(chunk);

                for (const event of events) {
                    let payload: Record<string, unknown> = {};
                    try {
                        payload = JSON.parse(event.data);
                    } catch {
                        payload = { text: event.data };
                    }

                    switch (event.type) {
                        case 'delta':
                        case 'message': {
                            const deltaText = (payload.text as string) ?? '';
                            if (!currentMessageId) {
                                currentMessageId = (payload.messageId as string) ?? crypto.randomUUID();
                            }
                            accumulatedText += deltaText;
                            setStreamingText(accumulatedText);
                            onDeltaRef.current?.(
                                deltaText,
                                currentMessageId,
                                (payload.conversationId as string) ?? conversationIdRef.current,
                            );
                            break;
                        }

                        case 'reasoning': {
                            const reasoningDelta = (payload.text as string) ?? '';
                            if (reasoningDelta) onReasoningRef.current?.(reasoningDelta);
                            break;
                        }

                        case 'done': {
                            const finalText = (payload.text as string) ?? accumulatedText;
                            const msgId = currentMessageId ?? (payload.messageId as string) ?? crypto.randomUUID();
                            const planResult = payload.planResult;
                            const artifactRef = payload.artifactRef;
                            const citations = payload.citations;
                            const suggestedFollowUps = payload.suggestedFollowUps;
                            const attachments = payload.attachments;
                            clearRetry();
                            onDoneRef.current?.(
                                finalText,
                                msgId,
                                (payload.conversationId as string) ?? conversationIdRef.current,
                                planResult,
                                artifactRef,
                                citations,
                                suggestedFollowUps,
                                attachments,
                            );
                            currentMessageId = null;
                            accumulatedText = '';
                            setStreamingText('');
                            setIsStreaming(false);
                            break;
                        }

                        case 'error': {
                            const code = (payload.code as string) ?? 'AGENT_ERROR';
                            const msg = (payload.message as string) ?? 'Unknown error';

                            if (code === 'AGENT_TIMEOUT' || code === 'AUTH_ERROR') {
                                clearRetry();
                                onErrorRef.current?.(code, msg);
                                setIsStreaming(false);
                                break;
                            }

                            setIsStreaming(false);
                            scheduleRetry();
                            break;
                        }

                        case 'tool_call': {
                            const toolName = (payload.toolName || payload.tool) as string;
                            const toolCallId = (payload.toolCallId || crypto.randomUUID()) as string;
                            const args = (payload.arguments || payload.args) as Record<string, unknown> ?? {};
                            onToolCallRef.current?.(toolName, toolCallId, args);
                            break;
                        }

                        case 'tool_done': {
                            onToolDoneRef.current?.(
                                payload.toolCallId as string,
                                payload.toolName as string ?? '',
                                payload.result as Record<string, unknown> ?? {},
                                payload.results as Array<{ title: string; domain: string; favicon?: string }> | undefined,
                            );
                            break;
                        }

                        case 'approval_request': {
                            onApprovalRequiredRef.current?.(
                                payload.approvalId as string,
                                payload.toolName as string,
                                payload.description as string,
                                (payload.arguments as Record<string, unknown>) ?? {},
                            );
                            break;
                        }

                        case 'generation_confirm_request': {
                            onGenerationConfirmRequiredRef.current?.(
                                payload.confirmationId as string,
                                payload.resourceType as string,
                                payload.subject as string,
                                payload.label as string,
                            );
                            break;
                        }

                        case 'clarification_request': {
                            onClarificationRequiredRef.current?.(
                                payload.clarificationId as string,
                                (payload.questions as ClarificationQuestion[]) ?? [],
                            );
                            break;
                        }

                        case 'auth_expired': {
                            authExpired = true;
                            break;
                        }

                        default:
                            console.warn('[useChat] Unknown SSE event type:', event.type, payload);
                    }
                }

                if (authExpired) break;
            }

            if (authExpired) {
                setIsStreaming(false);
                const refreshed = await attemptRefresh();
                if (!refreshed) {
                    window.location.href = '/auth/login';
                    return;
                }
                const refreshedTokens = getAuthTokens();
                if (!refreshedTokens.accessToken) {
                    window.location.href = '/auth/login';
                    return;
                }
                await sendMessageRef.current?.(text, attachments).catch(console.error);
                return;
            }
        } catch (err: unknown) {
            if ((err as Error).name === 'AbortError') {
                return;
            }
            const message = err instanceof Error ? err.message : 'Stream failed';
            console.error('[useChat] stream error:', message);
            setIsStreaming(false);
            scheduleRetry();
            return;
        } finally {
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
                setIsStreaming(false);
            }
        }
    }, [clearRetry, scheduleRetry]);

    const sendApproval = useCallback(async (
        approvalId: string,
        decision: 'approved' | 'dismissed',
    ): Promise<boolean> => {
        const { accessToken } = getAuthTokens();
        if (!accessToken) return false;

        try {
            const res = await fetch(`${CHAT_ENDPOINT}/approval`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ approvalId, decision }),
            });
            return res.ok;
        } catch {
            return false;
        }
    }, []);

    const sendGenerationConfirm = useCallback(async (
        confirmationId: string,
        decision: 'approved' | 'declined',
        reason?: string,
    ): Promise<boolean> => {
        const { accessToken } = getAuthTokens();
        if (!accessToken) return false;

        try {
            const res = await fetch(`${CHAT_ENDPOINT}/generation-confirm`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ confirmationId, decision, ...(reason ? { reason } : {}) }),
            });
            return res.ok;
        } catch {
            return false;
        }
    }, []);

    const sendClarificationAnswer = useCallback(async (
        clarificationId: string,
        questionIndex: number,
        answer: { selectedIndex?: number; freeText?: string; skipped?: boolean },
    ): Promise<boolean> => {
        const { accessToken } = getAuthTokens();
        if (!accessToken) return false;

        try {
            const res = await fetch(`${CHAT_ENDPOINT}/clarification`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ clarificationId, questionIndex, ...answer }),
            });
            return res.ok;
        } catch {
            return false;
        }
    }, []);

    sendMessageRef.current = sendMessage;

    return {
        sendMessage,
        sendApproval,
        sendGenerationConfirm,
        sendClarificationAnswer,
        cancel,
        isStreaming,
        isRetrying,
        streamingText,
    };
}
