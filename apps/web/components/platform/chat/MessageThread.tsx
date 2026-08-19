"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Message, CompletedToolCall, PlanResult } from "./types";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { useRouter, useParams } from "next/navigation";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MessageItem } from "./MessageItem";
import { ClarificationCard } from "./ClarificationCard";

interface MessageThreadProps {
    messages: Message[];
    isLoading?: boolean;
    isTyping?: boolean;
    isStreaming?: boolean;
    isRetrying?: boolean;
    activeToolCalls?: Message["toolCalls"];
    completedToolCalls?: CompletedToolCall[];
    reasoningText?: string;
    error?: string | null;
    warmupMessage?: string | null;
    onApprove?: (messageId: string, approvalId: string) => void;
    onDismiss?: (messageId: string, approvalId: string) => void;
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }, allAnswered?: boolean) => void;
    onFollowUpSelect?: (text: string) => void;
    onRegenerate?: (message: Message) => void;
    onEditAndResubmit?: (message: Message, newContent: string) => void;
}

export function MessageThread({ messages, isLoading, isTyping, isStreaming, isRetrying, activeToolCalls, completedToolCalls, reasoningText, error, warmupMessage, onApprove, onDismiss, onClarificationAnswer, onFollowUpSelect, onRegenerate, onEditAndResubmit }: MessageThreadProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // Marks where real content ends and the reserved bottom spacer begins.
    // scrollHeight now always includes that spacer (~one pane's worth of
    // empty space, unconditionally, so the top-anchor scroll always has room
    // to scroll into — see the spacer render below), so anything that used to
    // treat scrollHeight as "the bottom" needs to use this instead, or it'll
    // scroll into/measure against blank space rather than the last message.
    const contentEndRef = useRef<HTMLDivElement>(null);
    const [freshUrls, setFreshUrls] = useState<Record<string, string>>({});
    const failedUrlsRef = useRef<Set<string>>(new Set());
    const isRefreshingUrlsRef = useRef(false);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [creatingPlanId, setCreatingPlanId] = useState<string | null>(null);
    const [planErrors, setPlanErrors] = useState<Record<string, string>>({});
    const { tenantId, userId } = useTenant();
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;

    // The relay doesn't close the SSE stream while a clarifying question is
    // outstanding — it just idles until the user answers via sendClarificationAnswer
    // — so isStreaming stays true and ThinkingIndicator's elapsed-time timer would
    // otherwise run forever. Derive "blocked on the user" straight from message
    // state (last message's clarificationRequest still 'pending') rather than from
    // isStreaming, so the status line reflects who's actually supposed to act next.
    const lastMessage = messages[messages.length - 1];
    // The pending clarification takes over the panel (see the overlay render below)
    // instead of rendering inline — MessageItem deliberately skips it while pending.
    const pendingClarificationMessage = lastMessage?.clarificationRequest?.status === 'pending' ? lastMessage : undefined;
    const awaitingReply = pendingClarificationMessage !== undefined;
    // Whether onDelta has already created a row for the turn currently in
    // progress. Before that (tool calls/reasoning firing with no text yet),
    // the trailing ThinkingIndicator below owns the live status display —
    // once the row exists, MessageItem renders the same content itself,
    // inside that row, so the two must never both render at once.
    const hasStreamingMessage = messages.some(m => m.isStreaming);

    // Tracks which conversation/message we last scrolled for, so this effect can
    // tell "a fresh conversation just loaded" from "a new user message was just
    // sent" from "the assistant's message is still growing in place" — those need
    // three different scroll behaviors, not one blanket scrollTop = scrollHeight.
    const scrollStateRef = useRef<{ conversationId: string | null; lastMessageId: string | null }>({ conversationId: null, lastMessageId: null });

    useEffect(() => {
        const el = scrollRef.current;
        if (!el || messages.length === 0) return;
        const last = messages[messages.length - 1];
        const conversationId = messages[0]?.conversationId ?? null;
        const state = scrollStateRef.current;

        const isConversationSwitch = conversationId !== state.conversationId;
        const isNewLastMessage = last.id !== state.lastMessageId;
        state.conversationId = conversationId;
        state.lastMessageId = last.id;

        // Anchor the most recent user message near the top instead of pinning to
        // the bottom, so its reply has room to grow below it without everything
        // feeling glued to the input — matches the reference product. Falls back
        // to jumping to the very bottom only if the conversation somehow has no
        // user message yet (e.g. an assistant-initiated thread).
        const anchorToLastUserMessage = (behavior: ScrollBehavior) => {
            const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
            const target = lastUserMessage ? document.getElementById(`message-${lastUserMessage.id}`) : null;
            if (target) el.scrollTo({ top: Math.max(0, target.offsetTop - 16), behavior });
            else el.scrollTo({ top: el.scrollHeight, behavior });
        };

        if (isConversationSwitch) {
            // Freshly loaded history — jump straight there, no animation.
            anchorToLastUserMessage('auto');
            return;
        }

        // Same message still streaming/updating in place — leave the scroll
        // position alone instead of chasing the bottom on every token.
        if (!isNewLastMessage) return;

        if (last.role === 'user') {
            // Instant, not smooth: a smooth scroll leaves an animation window
            // during which the assistant's placeholder row mounts and its own
            // StreamingMessage effect can issue a competing scrollIntoView,
            // interrupting this one before it finishes (see StreamingMessage.tsx).
            // An instant jump has no window for that race to land in.
            anchorToLastUserMessage('auto');
        }
    }, [messages]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => {
            const contentEnd = contentEndRef.current?.offsetTop ?? el.scrollHeight;
            const distanceFromBottom = contentEnd - el.scrollTop - el.clientHeight;
            setShowScrollToBottom(distanceFromBottom > 200);
        };
        el.addEventListener('scroll', onScroll);
        return () => el.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        const refreshUrls = async () => {
            if (isRefreshingUrlsRef.current) return;
            const toRefresh = messages.flatMap(m => m.attachments || [])
                .filter(att => att.fileId && (!att.previewUrl || att.previewUrl.startsWith('blob:')))
                .filter(att => !freshUrls[att.fileId!] && !failedUrlsRef.current.has(att.fileId!));

            if (toRefresh.length === 0) return;

            isRefreshingUrlsRef.current = true;
            try {
                const results = await Promise.all(
                    toRefresh.map(async (att) => {
                        try {
                            const { presignedUrl } = await api.get<{ presignedUrl: string }>(
                                `/api/v1/files/${encodeURIComponent(att.fileId!)}/presigned-url`
                            );
                            return { fileId: att.fileId!, url: presignedUrl };
                        } catch (err) {
                            console.error('Failed to refresh URL for', att.fileId, err);
                            failedUrlsRef.current.add(att.fileId!);
                            return null;
                        }
                    })
                );

                const newUrls = results.reduce((acc, curr) => {
                    if (curr) acc[curr.fileId] = curr.url;
                    return acc;
                }, {} as Record<string, string>);

                if (Object.keys(newUrls).length > 0) {
                    setFreshUrls(prev => ({ ...prev, ...newUrls }));
                }
            } finally {
                isRefreshingUrlsRef.current = false;
            }
        };

        refreshUrls();
    }, [messages]);

    const handleCreateInSystem = async (messageId: string, planResult: PlanResult) => {
        if (creatingPlanId) return;
        setCreatingPlanId(messageId);
        try {
            const { planId } = await api.post<{ planId: string }>('/api/tasks/create-plan', {
                tenantId,
                userId,
                prdData: planResult.prdData,
            });
            router.push(`/${tenantSlug}/dashboard/plans/${planId}`);
        } catch (err: any) {
            setPlanErrors(prev => ({ ...prev, [messageId]: err?.message ?? 'Failed to create plan' }));
        } finally {
            setCreatingPlanId(null);
        }
    };

    if (isLoading && messages.length === 0) {
        return (
            <div className="flex-1 min-h-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                    <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    <p className="text-sm text-muted-foreground">Loading messages...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="relative flex-1 min-h-0 overflow-hidden" style={{ containerType: 'size' }}>
        <div ref={scrollRef} className="h-full px-4 md:px-8 py-4 overflow-y-auto custom-scrollbar">
            <div className="max-w-4xl mx-auto space-y-2 pb-4">
                {messages.length === 0 && !isTyping && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                            <MessageSquare className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <h3 className="text-lg font-medium">No messages yet</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                            Send a message to start the conversation.
                        </p>
                    </div>
                )}

                {messages.map((message, i) => {
                    const prevRole = i > 0 ? messages[i - 1].role : null;
                    const isLastMessage = i === messages.length - 1;
                    return (
                        <MessageItem
                            key={message.id}
                            message={message}
                            isFirstInSequence={prevRole === null || prevRole !== message.role}
                            isNewExchange={prevRole !== null && prevRole !== message.role}
                            isLastMessage={isLastMessage}
                            freshUrls={freshUrls}
                            onApprove={onApprove}
                            onDismiss={onDismiss}
                            onClarificationAnswer={onClarificationAnswer}
                            onFollowUpSelect={onFollowUpSelect}
                            onRegenerate={onRegenerate}
                            onEditAndResubmit={onEditAndResubmit}
                            isStreaming={isStreaming}
                            creatingPlanId={creatingPlanId}
                            planErrors={planErrors}
                            onCreateInSystem={handleCreateInSystem}
                            activeToolCalls={message.isStreaming ? activeToolCalls : undefined}
                            completedToolCalls={message.isStreaming ? completedToolCalls : undefined}
                            liveReasoningText={message.isStreaming ? reasoningText : undefined}
                        />
                    );
                })}

                {awaitingReply ? (
                    <WaitingForReplyIndicator />
                ) : (isStreaming || isRetrying) && !hasStreamingMessage ? (
                    <ThinkingIndicator
                        isRetrying={isRetrying ?? false}
                        isStreaming={isStreaming ?? false}
                        activeToolCalls={activeToolCalls ?? []}
                        completedToolCalls={completedToolCalls ?? []}
                        reasoningText={reasoningText ?? ''}
                    />
                ) : isTyping && !hasStreamingMessage ? (
                    <ThinkingDots label="Thinking..." />
                ) : null}

                {error && (
                    <div className="flex justify-center mt-6">
                        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg text-sm max-w-[80%] text-center">
                            {error}
                        </div>
                    </div>
                )}

                {warmupMessage && (
                    <div className="flex justify-center mt-6">
                        <div className="bg-muted/50 border border-border text-muted-foreground px-4 py-3 rounded-lg text-sm max-w-[80%] text-center">
                            {warmupMessage}
                        </div>
                    </div>
                )}

                {/* Unconditionally reserves ~one pane's worth of room below the last
                    message, regardless of how much prior history already exists above
                    it. A flex-1/min-h-full filler isn't enough here: it only tops the
                    column up to one viewport total, so once existing history already
                    exceeds the pane's height (any real, ongoing conversation) it
                    collapses to zero and the anchor-to-top scroll below has nothing to
                    scroll into again. cqh reads the *pane's own* height (via
                    containerType: 'size' on the non-scrolling wrapper two levels up,
                    right below), independent of how tall the scrollable content is —
                    pure CSS, computed by the browser's layout engine on every reflow,
                    no JS measurement to race. */}
                {messages.length > 0 && (
                    <div ref={contentEndRef} aria-hidden style={{ height: 'calc(100cqh - 160px)' }} />
                )}
            </div>
        </div>
        {pendingClarificationMessage && (
            // Anchored toward the bottom of the panel (near where ChatInput sits just
            // below this wrapper) rather than dead-center, so it reads as the next
            // step in the conversation instead of a modal dropped in empty space.
            <div className="absolute inset-0 z-40 flex items-end justify-center pb-6 bg-background/90 backdrop-blur-sm px-4">
                <ClarificationCard
                    key={pendingClarificationMessage.clarificationRequest!.id}
                    request={pendingClarificationMessage.clarificationRequest!}
                    onAnswer={(answer, allAnswered) => onClarificationAnswer?.(
                        pendingClarificationMessage.id,
                        pendingClarificationMessage.clarificationRequest!.id,
                        answer.questionIndex,
                        { selectedIndex: answer.selectedIndex, freeText: answer.freeText, skipped: answer.skipped },
                        allAnswered,
                    ) ?? Promise.resolve(true)}
                />
            </div>
        )}
        {showScrollToBottom && (
            <button
                type="button"
                onClick={() => scrollRef.current?.scrollTo({ top: contentEndRef.current?.offsetTop ?? scrollRef.current.scrollHeight, behavior: 'smooth' })}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 h-8 w-8 rounded-full bg-secondary shadow-md flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 5.5L7 9.5L11 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            </button>
        )}
        </div>
    );
}

function ThinkingDots({ label = 'Thinking...' }: { label?: string }) {
    return (
        <div className="flex items-start gap-4 animate-in fade-in duration-300">
            <AgentOrb size={40} state="thinking" />
            <div className="flex items-center gap-2 pt-1.5">
                <span className="flex gap-[3px] items-center">
                    <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
                    <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
                    <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce" />
                </span>
                <span className="shimmer-text text-sm text-primary/80 font-mono">{label}</span>
            </div>
        </div>
    );
}

// Static, un-animated counterpart to ThinkingIndicator/ThinkingDots — rendered instead of
// either whenever the last message is blocking on a pending clarificationRequest. No timer,
// no shimmer: the agent isn't doing anything, so nothing here should look like it's working.
function WaitingForReplyIndicator() {
    return (
        <div className="flex items-start gap-4 animate-in fade-in duration-300">
            <AgentOrb size={40} state="idle" />
            <div className="flex items-center gap-2 pt-1.5 text-muted-foreground">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M9.5 9a2.5 2.5 0 0 1 4.83-.92c-.28.7-.77 1.1-1.33 1.5-.62.44-1 .8-1 1.67" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="12" cy="16.25" r="0.75" fill="currentColor" />
                </svg>
                <span className="text-sm font-mono">Waiting for your reply</span>
            </div>
        </div>
    );
}
