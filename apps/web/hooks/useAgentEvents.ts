'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import type { AgentEvent, Attachment } from '@/types/agent-events';

export interface UseAgentEventsOptions {
  conversationId?: string;
  agentId?: string;
  onThinking?: () => void;
  onMessageDelta?: (delta: string, messageId: string, responseConversationId?: string) => void;
  onMessageComplete?: (content: string, messageId: string, responseConversationId?: string) => void;
  onToolCalling?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, toolCallId: string, result: unknown, error?: string) => void;
  onCanvasUpdate?: (action: string, data: Record<string, unknown>) => void;
  onApprovalRequired?: (approvalId: string, toolName: string, description: string, args: Record<string, unknown>) => void;
  onError?: (code: string, message: string, recoverable: boolean) => void;
  onSessionEnded?: (reason: string, usage?: Record<string, unknown>) => void;
  /** Called when the ensure-ready check determines the container is still starting up. */
  onStatus?: (message: string) => void;
}

export function useAgentEvents(options: UseAgentEventsOptions) {
  const {
    conversationId,
    agentId,
    onThinking,
    onMessageDelta,
    onMessageComplete,
    onToolCalling,
    onToolResult,
    onCanvasUpdate,
    onApprovalRequired,
    onError,
    onSessionEnded,
    onStatus,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | undefined>(conversationId);
  
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const maxRetries = 5;
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const connectRef = useRef<() => void>(() => {});
  // Tracks whether we've already run the ensure-ready check this mount cycle.
  // Only runs once — reconnect retries skip it so they don't repeat the 90s wait.
  const hasEnsuredReadyRef = useRef(false);

  // Stable refs for all callbacks — the effect reads from these at call time
  // so the WS is never torn down just because a callback prop changed identity.
  const onThinkingRef = useRef(onThinking);
  const onMessageDeltaRef = useRef(onMessageDelta);
  const onMessageCompleteRef = useRef(onMessageComplete);
  const onToolCallingRef = useRef(onToolCalling);
  const onToolResultRef = useRef(onToolResult);
  const onCanvasUpdateRef = useRef(onCanvasUpdate);
  const onApprovalRequiredRef = useRef(onApprovalRequired);
  const onErrorRef = useRef(onError);
  const onSessionEndedRef = useRef(onSessionEnded);
  const onStatusRef = useRef(onStatus);
  const agentIdRef = useRef(agentId);

  // Keep refs current on every render without triggering the effect
  conversationIdRef.current = conversationId;
  onThinkingRef.current = onThinking;
  onMessageDeltaRef.current = onMessageDelta;
  onMessageCompleteRef.current = onMessageComplete;
  onToolCallingRef.current = onToolCalling;
  onToolResultRef.current = onToolResult;
  onCanvasUpdateRef.current = onCanvasUpdate;
  onApprovalRequiredRef.current = onApprovalRequired;
  onErrorRef.current = onError;
  onSessionEndedRef.current = onSessionEnded;
  onStatusRef.current = onStatus;
  agentIdRef.current = agentId;

  useEffect(() => {
    let isMounted = true;

    const connect = async () => {
      if (!isMounted || (wsRef.current &&
          (wsRef.current.readyState === WebSocket.OPEN ||
           wsRef.current.readyState === WebSocket.CONNECTING))) {
        return;
      }

      try {
        // Get Cognito access token from non-httpOnly cookie
        const token = document.cookie
          .split('; ')
          .find(row => row.startsWith('platform_access_token='))
          ?.split('=')[1];

        if (!token) {
          console.error('No platform_access_token found in cookies');
          return;
        }

        const idToken = document.cookie
          .split('; ')
          .find(row => row.startsWith('platform_id_token='))
          ?.split('=')[1];

        // ── Ensure agent container is ready (first connect only) ──────────────
        // Polls GET /agents/ensure-ready every 2s up to 60s. The backend checks
        // the relay's /health/:tenantId and triggers /provision if needed, then
        // returns immediately. We loop here because API Gateway's 29s hard timeout
        // prevents the Lambda from doing the wait itself.
        //
        // Loop-prevention: if AGENT_TIMEOUT fired in a previous page load, the flag
        // 'agent_timeout_hit' is set in sessionStorage. On the next load (after the
        // user clicks Refresh) we run exactly ONE poll. If the container is still not
        // ready we surface the error immediately instead of making the user wait 60s
        // again. If it's ready we clear the flag and proceed normally.
        if (!hasEnsuredReadyRef.current) {
          hasEnsuredReadyRef.current = true;
          const POLL_INTERVAL_MS = 2000;
          const TIMEOUT_MS = 60_000;

          const prevTimeout = typeof sessionStorage !== 'undefined'
            && sessionStorage.getItem('agent_timeout_hit') === '1';

          if (prevTimeout) {
            // Fast path: run one immediate health check before committing to the full loop
            let stillDown = true;
            try {
              const res = await fetch('/api/proxy/api/v1/agents/ensure-ready');
              if (res.ok) {
                const data = await res.json();
                if (data.ready === true) {
                  stillDown = false;
                  sessionStorage.removeItem('agent_timeout_hit');
                }
              }
            } catch { /* fall through — treat as still down */ }

            if (stillDown) {
              onStatusRef.current?.('');
              onErrorRef.current?.(
                'AGENT_TIMEOUT',
                'Your workspace is still starting up. This usually takes 2 minutes on first launch. Please refresh again in a moment.',
                true,
              );
              hasEnsuredReadyRef.current = false;
              return;
            }
            // Container recovered — fall through to WS connect
          } else {
            // Normal path: full polling loop up to 60s
            const startTime = Date.now();
            let agentReady = false;
            let firstPollDone = false;

            while (Date.now() - startTime < TIMEOUT_MS) {
              try {
                const res = await fetch('/api/proxy/api/v1/agents/ensure-ready');
                if (res.ok) {
                  const data = await res.json();
                  if (data.ready === true) {
                    agentReady = true;
                    break;
                  }
                  // First poll came back not-ready — show status in the loader
                  if (!firstPollDone && data.code === 'AGENT_NOT_READY') {
                    onStatusRef.current?.('Starting your workspace for the first time...');
                  }
                }
              } catch {
                // Network error — keep polling
              }
              firstPollDone = true;

              // Wait before next poll (skip wait on last iteration)
              if (Date.now() - startTime + POLL_INTERVAL_MS < TIMEOUT_MS) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
              } else {
                break;
              }
            }

            if (!agentReady) {
              console.error('[useAgentEvents] Agent container did not become ready within 60s');
              // Record timeout so the next page load short-circuits immediately
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('agent_timeout_hit', '1');
              }
              // Clear any stale status message before surfacing the error
              onStatusRef.current?.('');
              onErrorRef.current?.(
                'AGENT_TIMEOUT',
                'Your workspace is taking longer than expected to start. Please refresh the page to try again.',
                true,
              );
              hasEnsuredReadyRef.current = false; // allow retry on next connect attempt
              return;
            }
          }

          console.log('[useAgentEvents] Agent container ready — connecting WebSocket');
        }
        // ─────────────────────────────────────────────────────────────────────

        const wsUrl = process.env.NEXT_PUBLIC_AGENT_WS_URL || "wss://agent-orchestrator.projectcontext.co";

        if (!wsUrl) {
          console.error('NEXT_PUBLIC_AGENT_WS_URL is not defined');
          return;
        }

        // Connect to GCP relay with Cognito access token and idToken
        const wsFullUrl = `${wsUrl}/ws?token=${token}${idToken ? `&idToken=${idToken}` : ''}`;
        console.log('[useAgentEvents] Connecting to:', wsUrl, '(token length:', token.length, ')');
        
        const socket = new WebSocket(wsFullUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!isMounted) return;
          console.log('[useAgentEvents] WebSocket connected to GCP relay');
          setIsConnected(true);
          retryCountRef.current = 0;
          
          if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              // Standard ping for GCP relay
              socket.send(JSON.stringify({ type: 'ping' }));
            }
          }, 5 * 60 * 1000);
        };

        socket.onmessage = (eventMsg) => {
          try {
            const event = JSON.parse(eventMsg.data);

            switch (event.type) {
              case 'session.started':
                // Defensive handling as per instructions
                console.log('[useAgentEvents] Relay session started:', event.sessionId);
                sessionIdRef.current = event.sessionId || null;
                break;

              case 'delta':
                // Streaming chunk - relay diffs for us
                // Generate a stable messageId for this stream if we don't have one
                if (!currentMessageIdRef.current) {
                  currentMessageIdRef.current = event.messageId || crypto.randomUUID();
                }
                onMessageDeltaRef.current?.(event.text, currentMessageIdRef.current!, event.conversationId);
                break;

              case 'done':
                // Stream complete - clear thinking/loading state
                // Use the captured messageId and clear it for the next message
                if (currentMessageIdRef.current) {
                  // Pass final text if relay sends it, otherwise pass empty string to trigger preservation
                  onMessageCompleteRef.current?.(event.text || '', currentMessageIdRef.current, event.conversationId);
                  currentMessageIdRef.current = null;
                }
                break;

              case 'error':
                // Error from relay
                onErrorRef.current?.('ORCHESTRATOR_ERROR', event.message, false);
                break;

              case 'approval_request':
                // Agent needs approval before proceeding with a tool
                console.log('[useAgentEvents] Approval requested:', event.approvalId, event.toolName);
                onApprovalRequiredRef.current?.(
                  event.approvalId, 
                  event.toolName, 
                  event.description, 
                  event.arguments || {}
                );
                break;

              case 'ready':
                // Relay is ready to accept messages
                console.log('[useAgentEvents] Relay ready');
                break;

              case 'pong':
                // Keep-alive response
                break;

              default:
                console.warn('[useAgentEvents] Unknown event type from relay:', event.type);
            }
          } catch (err) {
            console.error('[useAgentEvents] Failed to parse message:', err);
          }
        };

        socket.onclose = (event) => {
          if (!isMounted) return;
          console.log(`[useAgentEvents] WebSocket disconnected. Code: ${event.code}, Reason: ${event.reason || 'none'}`);
          setIsConnected(false);
          
          if (retryCountRef.current < maxRetries) {
            retryCountRef.current++;
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            
            reconnectTimeoutRef.current = setTimeout(async () => {
                // If token is missing, attempt one refresh before trying to reconnect
                const currentToken = document.cookie
                  .split('; ')
                  .find(row => row.startsWith('platform_access_token='))
                  ?.split('=')[1];

                if (!currentToken) {
                    console.log('[useAgentEvents] Token missing on reconnect, triggering refresh...');
                    try {
                        await fetch('/api/auth/refresh', { method: 'POST' });
                    } catch (e) {
                        console.error('[useAgentEvents] Refresh failed on reconnect:', e);
                    }
                }
                
                connect();
            }, 3000);
          }
        };

        socket.onerror = (error) => {
          if (!isMounted) return;
          console.error('[useAgentEvents] WebSocket error details:', error);
          socket.close();
        };

      } catch (error) {
        console.error('Failed to fetch WebSocket token:', error);
      }
    };

    connectRef.current = connect;
    connect();

    return () => {
      isMounted = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };
  }, []);

  const sendMessage = useCallback(async (text: string, attachments?: Attachment[]) => {
    // If socket is dead, kick off reconnect before waiting
    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      retryCountRef.current = 0; // reset retry counter so reconnect is allowed
      connectRef.current();
    }

    const waitForOpen = (): Promise<boolean> => {
      return new Promise((resolve) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          resolve(true);
          return;
        }
        const timeout = setTimeout(() => resolve(false), 10000);
        const interval = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve(true);
          }
        }, 100);
      });
    };

    const isOpen = await waitForOpen();
    if (isOpen) {
      wsRef.current!.send(JSON.stringify({
        message: text,
        agentId: agentIdRef.current,
        conversationId: conversationIdRef.current,
        attachments
      }));
      return true;
    }
    console.error('WebSocket not open after 10s. Cannot send message.');
    return false;
  }, []);

  const sendApproval = useCallback(async (approvalId: string, decision: 'approved' | 'dismissed') => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: decision === 'approved' ? 'approve' : 'dismiss',
        approvalId,
      }));
      return true;
    }
    return false;
  }, []);

  return {
    isConnected,
    sessionId: sessionIdRef.current,
    sendMessage,
    sendApproval,
  };
}
