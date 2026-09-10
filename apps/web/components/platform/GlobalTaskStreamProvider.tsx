'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * GlobalTaskStreamProvider
 *
 * Opens a single tenant-scoped WebSocket connection for the lifetime of the
 * dashboard layout (survives navigation between board ↔ detail views).
 *
 * Handles ALL WebSocket event types so that useTaskStream does not need to
 * open a second connection. Two concurrent connections caused a race condition
 * where the relay routed events to whichever socket connected last — if that
 * was this provider, delta/tool/thinking events were silently dropped.
 *
 * Event types handled:
 *   task.status.changed        — board + detail cache, toasts, awaiting_approval invalidation
 *   task.step.created          — appends step to detail cache with dedup
 *   task.step.delta            — sets step.liveText (streaming text)
 *   task.step.tool_call        — appends tool call entry to step.liveActivity
 *   task.step.tool_result      — marks last open tool_call as completed
 *   task.step.thinking         — sets step.agentThinking = true
 *   task.step.updated          — step status, agentOutput, timestamps
 *   task.clarification.requested — task status → blocked, appends event
 *   task.comment.added         — appends to ['task-comments', taskId]
 *   workflow_run.awaiting_approval — invalidates ['agent-runs'], toasts
 *
 * BUG-10: Reconnect behaviour
 *   - Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap, max 6 retries.
 *   - On successful reconnect: invalidates ['tasks'] and ['task'] prefix so the
 *     board and any open detail view catch up on events missed during the gap.
 *   - Shows a subtle "Reconnecting…" badge while disconnected (only after the
 *     first successful connection, so it never flashes on initial page load).
 */
export function GlobalTaskStreamProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const maxRetries = 6;
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track last known status per task so toasts are transition-aware
  const taskStatusMap = useRef<Map<string, string>>(new Map());
  // Only show the reconnecting badge after the first successful connection —
  // prevents a flash on initial load when the socket hasn't opened yet.
  const hasConnectedRef = useRef(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const connect = async () => {
      if (!isMounted || (wsRef.current && wsRef.current.readyState === WebSocket.OPEN)) return;

      try {
        const response = await api.get<{ token: string }>('/api/v1/auth/ws-token');
        const token = response.token;
        const wsUrl = process.env.NEXT_PUBLIC_WS_URL;

        if (!wsUrl) {
          console.error('[GlobalTaskStream] NEXT_PUBLIC_WS_URL is not defined');
          return;
        }

        const socket = new WebSocket(`${wsUrl}?token=${token}`);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!isMounted) return;
          const wasReconnect = retryCountRef.current > 0;
          retryCountRef.current = 0;
          hasConnectedRef.current = true;
          setIsReconnecting(false);

          if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ action: 'ping' }));
            }
          }, 5 * 60 * 1000);

          // BUG-10: On reconnect, invalidate board and all open detail caches so the
          // UI catches up on any task.status.changed events missed during the gap.
          if (wasReconnect) {
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
            queryClient.invalidateQueries({ queryKey: ['task'] });
          }
        };

        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as { type: string; [key: string]: unknown };
            if (message.type === 'pong') return;

            if (message.type === 'task.status.changed') {
              const taskId = message.taskId as string;
              const status = message.status as string;
              if (!taskId || !status) return;

              const prevStatus = taskStatusMap.current.get(taskId);
              taskStatusMap.current.set(taskId, status);

              // Update detail cache
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.task) return old;
                if (status === 'planning') {
                  return {
                    ...old,
                    data: { ...old.data, task: { ...old.data.task, status }, steps: [] },
                  };
                }
                // Retry from blocked (execution failure) — clear stale steps so old
                // done/failed steps don't persist alongside the new execution run.
                if (status === 'in_progress' && old.data.task.status === 'blocked') {
                  return {
                    ...old,
                    data: { ...old.data, task: { ...old.data.task, status }, steps: [] },
                  };
                }
                return {
                  ...old,
                  data: { ...old.data, task: { ...old.data.task, status } },
                };
              });

              // Update board list cache
              queryClient.setQueryData(['tasks'], (old: any) => {
                if (!old?.data) return old;
                return {
                  ...old,
                  data: old.data.map((t: any) => (t.id === taskId ? { ...t, status } : t)),
                };
              });

              if (status === 'awaiting_approval') {
                // Steps just landed in DB — invalidate so detail cache gets them
                queryClient.invalidateQueries({ queryKey: ['task', taskId] });
                toast('Plan ready for review', {
                  description: 'Your agent has prepared a plan. Review and approve to start execution.',
                });
              } else if (status === 'review') {
                toast.success('Task complete', {
                  description: 'The agent finished. Review the results.',
                });
              } else if (status === 'blocked' && prevStatus === 'in_progress') {
                toast.error('Task is blocked', {
                  description: 'The agent encountered an issue during execution.',
                });
              }
            } else if (message.type === 'task.step.created') {
              const taskId = message.taskId as string;
              const step = message.step as {
                id: string;
                stepNumber: number;
                title: string;
                description: string | null;
                toolName: string | null;
                confidenceScore: string | null;
                status: 'pending';
              };
              if (!taskId || !step?.id) return;

              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data) return old;
                const existing: any[] = old.data.steps ?? [];
                if (existing.some((s: any) => s.id === step.id)) return old;
                return {
                  ...old,
                  data: { ...old.data, steps: [...existing, step] },
                };
              });
            } else if (message.type === 'task.step.delta') {
              const taskId = message.taskId as string;
              const stepId = message.stepId as string;
              const text = message.text as string;
              if (!taskId || !stepId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.steps) return old;
                return {
                  ...old,
                  data: {
                    ...old.data,
                    steps: old.data.steps.map((s: any) =>
                      s.id === stepId ? { ...s, liveText: text } : s
                    ),
                  },
                };
              });
            } else if (message.type === 'task.step.tool_call') {
              const taskId = message.taskId as string;
              const stepId = message.stepId as string;
              const toolName = message.toolName as string;
              const toolInput = message.toolInput as string | undefined;
              if (!taskId || !stepId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.steps) return old;
                return {
                  ...old,
                  data: {
                    ...old.data,
                    steps: old.data.steps.map((s: any) =>
                      s.id === stepId
                        ? { ...s, liveActivity: [...(s.liveActivity ?? []), { type: 'tool_call', toolName, toolInput, startedAt: Date.now() }] }
                        : s
                    ),
                  },
                };
              });
            } else if (message.type === 'task.step.tool_result') {
              const taskId = message.taskId as string;
              const stepId = message.stepId as string;
              const toolName = message.toolName as string;
              const durationMs = message.durationMs as number | undefined;
              const resultSummary = message.resultSummary as string | undefined;
              if (!taskId || !stepId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.steps) return old;
                return {
                  ...old,
                  data: {
                    ...old.data,
                    steps: old.data.steps.map((s: any) => {
                      if (s.id !== stepId) return s;
                      const existing: any[] = s.liveActivity ?? [];
                      let matched = false;
                      const updated = [...existing].reverse().map((item: any) => {
                        if (!matched && item.type === 'tool_call' && item.toolName === toolName && !item.completed) {
                          matched = true;
                          return { ...item, completed: true, durationMs, resultSummary };
                        }
                        return item;
                      }).reverse();
                      return { ...s, liveActivity: updated };
                    }),
                  },
                };
              });
            } else if (message.type === 'task.step.thinking') {
              const taskId = message.taskId as string;
              const stepId = message.stepId as string;
              if (!taskId || !stepId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.steps) return old;
                return {
                  ...old,
                  data: {
                    ...old.data,
                    steps: old.data.steps.map((s: any) =>
                      s.id === stepId ? { ...s, agentThinking: true } : s
                    ),
                  },
                };
              });
            } else if (message.type === 'task.step.updated') {
              const taskId = message.taskId as string;
              const stepId = message.stepId as string;
              const status = message.status as string;
              const agentOutput = message.agentOutput as string | undefined;
              if (!taskId || !stepId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data?.steps) return old;
                return {
                  ...old,
                  data: {
                    ...old.data,
                    steps: old.data.steps.map((s: any) =>
                      s.id === stepId
                        ? {
                            ...s,
                            status,
                            ...(agentOutput !== undefined && { agentOutput }),
                            ...(status === 'running' && { startedAt: new Date().toISOString() }),
                            ...(status === 'done' && { completedAt: new Date().toISOString() }),
                            ...(['done', 'failed', 'skipped'].includes(status) && {
                              liveText: undefined,
                              liveActivity: undefined,
                              agentThinking: undefined,
                            }),
                          }
                        : s
                    ),
                  },
                };
              });
            } else if (message.type === 'task.clarification.requested') {
              const taskId = message.taskId as string;
              const questions = message.questions as string[] | string;
              const blockedReason = message.blockedReason as string | undefined;
              if (!taskId) return;
              queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data) return old;
                const newEvent = {
                  id: crypto.randomUUID(),
                  taskId,
                  eventType: 'clarification_requested',
                  payload: { questions },
                  createdAt: new Date().toISOString(),
                };
                return {
                  ...old,
                  data: {
                    ...old.data,
                    task: {
                      ...old.data.task,
                      status: 'blocked',
                      blockedReason: blockedReason ?? old.data.task.blockedReason,
                    },
                    events: [...(old.data.events ?? []), newEvent],
                  },
                };
              });
            } else if (message.type === 'task.comment.added') {
              const taskId = message.taskId as string;
              const comment = message.comment as {
                id: string; taskId: string; authorId: string;
                authorType: 'member' | 'agent'; authorName: string;
                content: string; parentId: string | null;
                createdAt: string; updatedAt: string;
              };
              if (!taskId || !comment?.id) return;
              queryClient.setQueryData(['task-comments', taskId], (old: any) => {
                const existing: any[] = old?.data ?? [];
                if (existing.some((c: any) => c.id === comment.id)) return old;
                return { ...old, data: [...existing, comment] };
              });
            } else if (message.type === 'workflow_run.awaiting_approval') {
              // Pushed from products/agent-platform/packages/api/routes/internal/workflows.ts
              // whenever a workflow run's status update carries a non-null pendingApproval.
              // No cache write — the runs list/detail views read pendingApproval straight
              // from the API, so invalidating is enough to pick it up.
              const workflowRunId = message.workflowRunId as string;
              if (!workflowRunId) return;
              queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
              toast('Approval needed', {
                description: 'A workflow run is waiting for your approval.',
              });
            }
          } catch {
            // ignore malformed messages
          }
        };

        socket.onclose = () => {
          if (!isMounted) return;
          if (retryCountRef.current < maxRetries) {
            retryCountRef.current++;
            // BUG-10: Exponential backoff — 1s, 2s, 4s, 8s, 16s, 30s cap.
            const delay = Math.min(1000 * Math.pow(2, retryCountRef.current - 1), 30_000);
            if (hasConnectedRef.current) {
              setIsReconnecting(true);
            }
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          }
        };

        socket.onerror = () => {
          if (!isMounted) return;
          socket.close();
        };
      } catch (error) {
        console.error('[GlobalTaskStream] Connection failed:', error);
      }
    };

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
  }, [queryClient]);

  return (
    <>
      {children}
      {/* BUG-10: Subtle reconnecting badge — only shown after the first successful
          connection drops, never on initial page load. */}
      {isReconnecting && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-600 dark:text-yellow-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />
          Reconnecting…
        </div>
      )}
    </>
  );
}
