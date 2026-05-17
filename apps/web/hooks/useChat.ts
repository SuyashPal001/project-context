'use client';

import { useState, useRef, useCallback } from 'react';
import type { Attachment } from '@/types/agent-events';

const CHAT_ENDPOINT = 'https://agent-saas.fitnearn.com/api/chat';

function getAuthTokens() {
  const cookies = document.cookie.split('; ');
  const find = (name: string) => cookies.find(r => r.startsWith(`${name}=`))?.split('=')[1];
  return {
    accessToken: find('platform_access_token'),
    idToken: find('platform_id_token'),
  };
}

async function attemptRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE parser
// Accumulates raw bytes across chunk boundaries and emits complete events.
// An SSE event is terminated by a blank line (\n\n or \r\n\r\n).
// Each event may have multiple "field: value" lines; we care about
// "event:" and "data:".
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;   // value of the "event:" field, defaults to "message"
  data: string;   // raw value of the last "data:" field
}

class SSEParser {
  private buffer = '';

  /** Feed raw text; returns zero or more complete events. */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    // Split on double-newline (SSE event separator).
    // Keep the last segment in the buffer (may be incomplete).
    const parts = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = parts.pop() ?? '';

    for (const part of parts) {
      const event = this.parseBlock(part.trim());
      if (event) events.push(event);
    }

    return events;
  }

  private parseBlock(block: string): SSEEvent | null {
    if (!block) return null;

    let type = 'message';
    let data = '';

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
      // ignore "id:", "retry:", and comment lines (:)
    }

    if (!data) return null;
    return { type, data };
  }

  reset() {
    this.buffer = '';
  }
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export interface UseChatOptions {
  conversationId?: string;
  agentId?: string;
  onDelta?: (delta: string, messageId: string, conversationId?: string) => void;
  onDone?: (fullText: string, messageId: string, conversationId?: string, planResult?: unknown, artifactRef?: unknown) => void;
  onError?: (code: string, message: string) => void;
  onToolCall?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => void;
  onToolDone?: (toolCallId: string, toolName: string, result: Record<string, unknown>, results?: Array<{ title: string; domain: string; favicon?: string }>) => void;
  onApprovalRequired?: (approvalId: string, toolName: string, description: string, args: Record<string, unknown>) => void;
}

export interface UseChatReturn {
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>;
  sendApproval: (approvalId: string, decision: 'approved' | 'dismissed') => Promise<boolean>;
  cancel: () => void;
  isStreaming: boolean;
  isRetrying: boolean;
  streamingText: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChat(options: UseChatOptions): UseChatReturn {
  const {
    conversationId,
    agentId,
    onDelta,
    onDone,
    onError,
    onToolCall,
    onToolDone,
    onApprovalRequired,
  } = options;

  const [isStreaming, setIsStreaming] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [streamingText, setStreamingText] = useState('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const parserRef = useRef(new SSEParser());
  const sendMessageRef = useRef<((text: string, attachments?: Attachment[]) => Promise<void>) | null>(null);

  // Retry state
  const retryStartRef = useRef<number | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRetryPayloadRef = useRef<{ text: string; attachments?: Attachment[] } | null>(null);

  const RETRY_INTERVAL_MS = 5_000;
  const RETRY_MAX_MS = 90_000;

  // Keep latest option callbacks in refs so they never stale-close over props.
  const onDeltaRef = useRef(onDelta);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  const onToolCallRef = useRef(onToolCall);
  const onToolDoneRef = useRef(onToolDone);
  const onApprovalRequiredRef = useRef(onApprovalRequired);
  const conversationIdRef = useRef(conversationId);
  const agentIdRef = useRef(agentId);

  onDeltaRef.current = onDelta;
  onDoneRef.current = onDone;
  onErrorRef.current = onError;
  onToolCallRef.current = onToolCall;
  onToolDoneRef.current = onToolDone;
  onApprovalRequiredRef.current = onApprovalRequired;
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

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearRetry();
    setIsStreaming(false);
  }, [clearRetry]);

  const sendMessage = useCallback(async (text: string, attachments?: Attachment[]) => {
    // Abort any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Store payload for potential retries
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
      }),
      signal: controller.signal,
    });

    try {
      let response = await fetch(CHAT_ENDPOINT, buildRequest(token, idToken));

      // On 401: attempt silent token refresh, then retry once
      if (response.status === 401) {
        const refreshed = await attemptRefresh();
        if (!refreshed) {
          window.location.href = '/auth/login';
          return;
        }
        // Re-read cookies — refresh route sets new platform_access_token + platform_id_token
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

        // 4xx errors are non-retriable
        if (response.status >= 400 && response.status < 500) {
          clearRetry();
          onErrorRef.current?.('HTTP_ERROR', message);
          setIsStreaming(false);
          return;
        }

        // 5xx — retriable (container not ready / gateway error)
        setIsStreaming(false);
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
          onErrorRef.current?.('WARMUP_TIMEOUT', 'Taking longer than usual. Your workspace is still warming up — please try again in a moment.');
        }
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
            // data is plain text — treat as a delta
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

            case 'done': {
              const finalText = (payload.text as string) ?? accumulatedText;
              const msgId = currentMessageId ?? (payload.messageId as string) ?? crypto.randomUUID();
              const planResult = payload.planResult;
              const artifactRef = payload.artifactRef;
              // Successful response — clear any pending retry state
              clearRetry();
              onDoneRef.current?.(
                finalText,
                msgId,
                (payload.conversationId as string) ?? conversationIdRef.current,
                planResult,
                artifactRef,
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

              // Non-retriable relay errors
              if (code === 'AGENT_TIMEOUT' || code === 'AUTH_ERROR') {
                clearRetry();
                onErrorRef.current?.(code, msg);
                setIsStreaming(false);
                break;
              }

              // AGENT_ERROR and similar — retriable
              setIsStreaming(false);
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
                onErrorRef.current?.('WARMUP_TIMEOUT', 'Taking longer than usual. Your workspace is still warming up — please try again in a moment.');
              }
              break;
            }

            case 'tool_call': {
              const toolName = (payload.toolName || payload.tool) as string;
              const toolCallId = (payload.toolCallId || crypto.randomUUID()) as string;
              const args = (payload.arguments || payload.args) as Record<string, unknown> ?? {};
              onToolCallRef.current?.(
                toolName,
                toolCallId,
                args,
              );
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
        // User-initiated cancel — not an error
        return;
      }
      // Network / stream failure — retriable
      setIsStreaming(false);
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
        const message = err instanceof Error ? err.message : 'Stream failed';
        onErrorRef.current?.('WARMUP_TIMEOUT', 'Taking longer than usual. Your workspace is still warming up — please try again in a moment.');
        console.error('[useChat] stream error after max retry:', message);
      }
      return;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsStreaming(false);
      }
    }
  }, [clearRetry]);

  // Approval decisions are sent as a separate POST (no SSE response needed)
  const sendApproval = useCallback(async (
    approvalId: string,
    decision: 'approved' | 'dismissed',
  ): Promise<boolean> => {
    const token = document.cookie
      .split('; ')
      .find(row => row.startsWith('platform_access_token='))
      ?.split('=')[1];

    if (!token) return false;

    try {
      const res = await fetch(`${CHAT_ENDPOINT}/approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ approvalId, decision }),
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
    cancel,
    isStreaming,
    isRetrying,
    streamingText,
  };
}
