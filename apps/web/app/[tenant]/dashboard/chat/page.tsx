"use client"

import { useCallback, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ConversationList } from "@/components/platform/chat/ConversationList";
import { MessageThread } from "@/components/platform/chat/MessageThread";
import { ChatTimelineNavigator } from "@/components/platform/chat/ChatTimelineNavigator";
import { ChatInput } from "@/components/platform/chat/ChatInput";
import { WelcomeView } from "@/components/platform/chat/WelcomeView";
import { WizardView } from "@/components/platform/chat/WizardView";
import { AgentSelector } from "@/components/platform/chat/AgentSelector";
import { Canvas } from "@/components/platform/canvas/Canvas";
import { VoiceModal } from "@/components/platform/voice";
import { ChatHeader } from "./ChatHeader";
import { usePersonaAnimationState } from "@/components/platform/personas/usePersonaAnimationState";
import { useChatPage } from "./useChatPage";
import { useChatStream } from "./useChatStream";
import { useCanvas } from "@/hooks/useCanvas";
import { useVoice } from "@/hooks/useVoice";
import { MessageSquare, Plus, RefreshCw, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { MessagesResponse } from "@/components/platform/chat/types";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FEATURE_FLAGS } from "@/lib/feature-flags";

function ChatPage() {
    const searchParams = useSearchParams();
    const folderId = searchParams.get('folderId') ?? undefined;
    const page = useChatPage();
    const {
        tenantSlug, conversationId, conversationIdRef, firstName,
        isChatSidebarCollapsed, toggleChatSidebar,
        providers, activeAgents,
        conversations, isLoadingConversations, isErrorConversations,
        selectedConversation, messages, isLoadingMessages,
        isDeleteDialogOpen, setIsDeleteDialogOpen,
        agentSelectorOpen, setAgentSelectorOpen,
        activePill, setActivePill,
        createConversation, updateAgentMutation, deleteConversation,
        handleSelectConversation, handleNewChat,
    } = page;

    const queryClient = useQueryClient();
    const { isCanvasOpen, isCanvasExpanded, hasActivity, toggleCanvas, toggleExpand, openCanvas, handleCanvasUpdate, flushPending } = useCanvas();

    const stream = useChatStream({
        conversationId,
        conversationIdRef,
        agentId: selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id,
        folderId,
        selectedConversation,
        messages,
        handleCanvasUpdate,
        openCanvas,
    });
    const { sendMessage, sendApproval, sendClarificationAnswer, cancel, isStreaming, isRetrying, activeToolCalls, completedToolCalls, reasoningText, eventError, warmupMessage, agentTimedOut, hasSentFirstMessage, lastStreamEvent, regenerate, editAndResubmit } = stream;

    const { state: animationState, onStreamEvent } = usePersonaAnimationState();
    const [decayedState, setDecayedState] = useState<typeof animationState>('idle');
    const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastArtifactMessageIdRef = useRef<string | null>(null);
    // Which conversation lastArtifactMessageIdRef's seed/last-dispatched value belongs to.
    // Distinct from decayedStateConversationIdRef below: this one is only allowed to update
    // once messages for the new conversation have actually settled (!isLoadingMessages), so
    // it never seeds off a stale/empty messages array from the instant conversationId changes.
    const seededArtifactConversationIdRef = useRef<string | null>(null);
    // Tracks which conversation decayedState currently belongs to, so the effect below can
    // tell "animationState changed because of a real stream event in THIS conversation" apart
    // from "animationState is just stale leftover from the PREVIOUS conversation".
    const decayedStateConversationIdRef = useRef(conversationId);

    useEffect(() => {
        if (!lastStreamEvent) return;
        onStreamEvent(lastStreamEvent.type);
    }, [lastStreamEvent, onStreamEvent]);

    // While a clarifying question is pending, ClarificationCard's own free-text field
    // is the only input surface (see MessageThread's takeover overlay) — the normal
    // composer stays hidden so it doesn't sit directly underneath as a second,
    // redundant input, and so the overlay can expand into the freed space.
    const awaitingClarificationReply = messages[messages.length - 1]?.clarificationRequest?.status === 'pending';

    useEffect(() => {
        if (isLoadingMessages) return; // wait for messages to actually reflect `conversationId` before seeding or dispatching
        const latest = messages[messages.length - 1];
        const latestHasArtifact = latest?.role === 'assistant' && !!latest.artifactRef;

        if (conversationId !== seededArtifactConversationIdRef.current) {
            // First settled pass for this conversation: seed from its own latest message
            // instead of dispatching. A historical artifact already on the latest message
            // is "already seen", not "just produced" — dispatching here would show `review`
            // for an artifact that was saved hours/days ago, on every switch/reopen.
            seededArtifactConversationIdRef.current = conversationId;
            lastArtifactMessageIdRef.current = latestHasArtifact ? latest!.id : null;
            return;
        }

        // Same conversation as last settled pass: a genuinely new/changed artifact-bearing
        // message is a live event and should dispatch.
        if (latestHasArtifact && latest!.id !== lastArtifactMessageIdRef.current) {
            lastArtifactMessageIdRef.current = latest!.id;
            onStreamEvent('artifact_ready');
        }
    }, [conversationId, messages, isLoadingMessages, onStreamEvent]);

    // Single effect drives decayedState from two triggers: a genuinely new animationState
    // (normal decay behavior) OR a conversation switch (instant reset, no decay, no flash of
    // the previous conversation's terminal state). Merging them into one effect keyed on both
    // deps avoids the two-phase race a dispatch-then-separate-decay-effect design would hit.
    useEffect(() => {
        if (decayTimerRef.current) clearTimeout(decayTimerRef.current);

        if (conversationId !== decayedStateConversationIdRef.current) {
            decayedStateConversationIdRef.current = conversationId;
            setDecayedState('idle');
            return;
        }

        setDecayedState(animationState);
        if (animationState === 'done' || animationState === 'failed') {
            decayTimerRef.current = setTimeout(() => setDecayedState('idle'), 2500);
        }
        return () => {
            if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
        };
    }, [animationState, conversationId]);

    const isNewConversation = messages.length === 0 && !isLoadingMessages;
    const displayState = isNewConversation ? 'waving' : decayedState;

    const { isModalOpen, session, openVoice, closeVoice, handleTap } = useVoice({ conversationId: conversationId || undefined });
    const [inputPrefill, setInputPrefill] = useState('');

    const noopActivity = useCallback(() => {}, []);

    useEffect(() => {
        (window as any).__openCanvas = openCanvas;
        return () => { delete (window as any).__openCanvas; };
    }, [openCanvas]);

    const handleApprove = useCallback(async (messageId: string, approvalId: string) => {
        const ok = await sendApproval(approvalId, 'approved');
        if (ok) queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
            old ? { data: old.data.map(m => m.id === messageId ? { ...m, approvalRequest: m.approvalRequest ? { ...m.approvalRequest, status: 'approved' as const, decisionAt: new Date().toISOString() } : undefined } : m) } : old
        );
    }, [conversationId, queryClient, sendApproval]);

    const handleDismiss = useCallback(async (messageId: string, approvalId: string) => {
        const ok = await sendApproval(approvalId, 'dismissed');
        if (ok) queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
            old ? { data: old.data.map(m => m.id === messageId ? { ...m, approvalRequest: m.approvalRequest ? { ...m.approvalRequest, status: 'dismissed' as const, decisionAt: new Date().toISOString() } : undefined } : m) } : old
        );
    }, [conversationId, queryClient, sendApproval]);

    // Tracks, per clarificationId, whether every answer submitted so far was a
    // skip — used to label the completed card "Skipped" only when the WHOLE
    // set was skipped, not just the final question answered.
    const clarificationAllSkippedRef = useRef<Map<string, boolean>>(new Map());
    // Accumulates each question's answer as it's submitted, keyed by
    // clarificationId then questionIndex — attached to the resolved request so
    // the "N answer(s)" summary card has real question/answer text to show.
    const clarificationAnswersRef = useRef<Map<string, Record<number, { selectedIndex?: number; freeText?: string; skipped?: boolean }>>>(new Map());

    const handleClarificationAnswer = useCallback(async (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }, allAnswered?: boolean): Promise<boolean> => {
        const ok = await sendClarificationAnswer(clarificationId, questionIndex, answer);
        if (!ok) {
            toast.error('Could not submit your answer. Please try again.');
            return false;
        }
        const tracker = clarificationAllSkippedRef.current;
        const wasAllSkippedSoFar = tracker.get(clarificationId) ?? true;
        tracker.set(clarificationId, wasAllSkippedSoFar && !!answer.skipped);

        const answersMap = clarificationAnswersRef.current.get(clarificationId) ?? {};
        answersMap[questionIndex] = answer;
        clarificationAnswersRef.current.set(clarificationId, answersMap);

        // Mirror handleApprove/handleDismiss: flip the request's status in the
        // local cache once EVERY question has been answered — `allAnswered`
        // reflects the full answered-index set, not just "this was the last
        // page", since chevron nav lets the user submit out of order.
        if (allAnswered) {
            const finalStatus = (tracker.get(clarificationId) ?? false) ? 'skipped' as const : 'answered' as const;
            const answers = clarificationAnswersRef.current.get(clarificationId);
            tracker.delete(clarificationId);
            clarificationAnswersRef.current.delete(clarificationId);
            queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
                old ? { data: old.data.map(m => m.id === messageId ? { ...m, clarificationRequest: m.clarificationRequest ? { ...m.clarificationRequest, status: finalStatus, answeredAt: new Date().toISOString(), answers } : undefined } : m) } : old
            );
        } else {
            // Persist partial progress in the local cache so the card can restore
            // from it if a reload happens before all questions are answered.
            queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
                old ? { data: old.data.map(m => m.id === messageId ? { ...m, clarificationRequest: m.clarificationRequest ? { ...m.clarificationRequest, answers: { ...m.clarificationRequest.answers, [questionIndex]: answer } } : undefined } : m) } : old
            );
        }
        return true;
    }, [conversationId, queryClient, sendClarificationAnswer]);

    const sidebarToggleButton = (
        <Button
            variant="ghost" size="icon"
            onClick={toggleChatSidebar}
            className="absolute top-6 left-4 z-10 h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
            {isChatSidebarCollapsed
                ? <PanelLeftOpen className="h-4 w-4" />
                : <PanelLeftClose className="h-4 w-4" />}
        </Button>
    );

    const modelChangeProps = {
        providers,
        llmProviderId: selectedConversation?.agent?.llmProviderId ?? activeAgents[0]?.llmProviderId,
        onModelChange: (providerId: string) => {
            const agentId = selectedConversation?.agent?.id ?? activeAgents[0]?.id;
            if (agentId) updateAgentMutation.mutate({ llmProviderId: providerId });
        },
    };

    return (
        <div className="flex bg-background h-full overflow-hidden relative w-full">
            {agentTimedOut && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background gap-4">
                    <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                        <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center border border-border">
                            <RefreshCw className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <h2 className="text-lg font-semibold tracking-tight">Your workspace is warming up</h2>
                        <p className="text-sm text-muted-foreground">This can take up to 2 minutes on first launch. Please refresh to try again.</p>
                        <Button onClick={() => window.location.reload()} className="mt-2">Refresh</Button>
                    </div>
                </div>
            )}
            <div className="flex flex-1 overflow-hidden relative">
                {/* Conversations Sidebar */}
                <div className={cn(
                    "flex flex-col border-r border-border transition-all duration-300 ease-in-out bg-[var(--messages-panel)] z-20 overflow-hidden relative",
                    isChatSidebarCollapsed ? "w-0 opacity-0 pointer-events-none -translate-x-full" : "w-60 opacity-100 translate-x-0"
                )}>
                    <ConversationList
                        selectedId={conversationId || undefined}
                        onSelect={handleSelectConversation}
                        onNewChat={handleNewChat}
                    />
                </div>

                {/* Main Chat Area */}
                <div className="flex-1 flex flex-row min-w-0 bg-background relative overflow-hidden">
                    {/* Chat Panel */}
                    <div className={cn(
                        "relative flex flex-col overflow-hidden transition-all h-full min-w-0",
                        isCanvasExpanded ? "w-0 opacity-0 pointer-events-none" : "flex-1",
                        isCanvasOpen ? "border-r border-border" : ""
                    )}>
                        {selectedConversation ? (
                            <>
                                <ChatHeader
                                    selectedConversation={selectedConversation}
                                    isChatSidebarCollapsed={isChatSidebarCollapsed}
                                    toggleChatSidebar={toggleChatSidebar}
                                    isCanvasOpen={isCanvasOpen}
                                    hasActivity={hasActivity}
                                    toggleCanvas={toggleCanvas}
                                    onArchive={() => setIsDeleteDialogOpen(true)}
                                    state={displayState}
                                />
                                {!hasSentFirstMessage && messages.length === 0 && !isLoadingMessages ? (
                                    activePill !== null ? (
                                        <WizardView pill={activePill} onBack={() => setActivePill(null)} onSubmit={(prompt) => sendMessage(prompt)}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} {...modelChangeProps} />
                                        </WizardView>
                                    ) : (
                                        <WelcomeView agent={selectedConversation.agent ?? null} firstName={firstName} onSelectPill={(pill) => setActivePill(pill)} onSend={(text) => setInputPrefill(text)} avatarLiveState={displayState}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} prefill={inputPrefill} {...modelChangeProps} />
                                        </WelcomeView>
                                    )
                                ) : (
                                    <>
                                        <MessageThread messages={messages} isLoading={isLoadingMessages} isTyping={isStreaming || isRetrying} isStreaming={isStreaming} isRetrying={isRetrying} activeToolCalls={Array.from(activeToolCalls.values())} completedToolCalls={completedToolCalls} reasoningText={reasoningText} error={eventError} warmupMessage={warmupMessage} onApprove={handleApprove} onDismiss={handleDismiss} onClarificationAnswer={handleClarificationAnswer} onFollowUpSelect={(text) => { if (!isStreaming) sendMessage(text); }} onRegenerate={regenerate} onEditAndResubmit={editAndResubmit} agentAvatarUrl={selectedConversation.agent?.avatarUrl} avatarLiveState={displayState} />
                                        <ChatTimelineNavigator messages={messages} />
                                        {!awaitingClarificationReply && (
                                            <div className="shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                                                <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} providers={providers} llmProviderId={selectedConversation.agent?.llmProviderId} onModelChange={(id) => { if (selectedConversation.agent?.id) updateAgentMutation.mutate({ llmProviderId: id }); }} />
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        ) : isLoadingConversations ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background h-full relative">
                                {sidebarToggleButton}
                                <div className="space-y-4 w-full max-w-sm">
                                    <Skeleton className="h-12 w-full" /><Skeleton className="h-40 w-full" /><Skeleton className="h-10 w-32 mx-auto rounded-full" />
                                </div>
                            </div>
                        ) : isErrorConversations ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background h-full relative">
                                {sidebarToggleButton}
                                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-6 border border-border"><MessageSquare className="h-8 w-8 text-muted-foreground" /></div>
                                <h2 className="text-lg font-bold tracking-tight mb-2">Failed to load chats</h2>
                                <p className="text-muted-foreground max-w-sm mb-8">There was an error loading your conversations. Please try again.</p>
                                <Button onClick={() => queryClient.invalidateQueries({ queryKey: ['conversations'] })} size="lg" className="rounded-full shadow-lg h-12 px-6">Retry Loading</Button>
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background h-full relative">
                                {sidebarToggleButton}
                                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-6 border border-border"><MessageSquare className="h-8 w-8 text-muted-foreground" /></div>
                                <h2 className="text-lg font-bold tracking-tight mb-2">Select a conversation</h2>
                                <p className="text-muted-foreground max-w-sm mb-8">Select an existing conversation from the list or start a new one.</p>
                                <Button onClick={() => handleNewChat()} size="lg" className="rounded-full shadow-lg h-12 px-6 gap-2"><Plus className="h-4 w-4" />Start New Conversation</Button>
                            </div>
                        )}
                    </div>

                    {/* Canvas Panel */}
                    {FEATURE_FLAGS.chatCanvas && (
                        <div className={cn("transition-all overflow-hidden h-full z-10 bg-background", isCanvasExpanded ? "w-full flex-1" : (isCanvasOpen ? "w-1/2 border-l border-border" : "w-0"))}>
                            <Canvas isOpen={isCanvasOpen} isExpanded={isCanvasExpanded} onExpand={toggleExpand} onActivity={noopActivity} tenantSlug={tenantSlug} flushPending={flushPending} agentId={selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id} conversationId={conversationId ?? ''} />
                        </div>
                    )}
                </div>
            </div>

            <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Archive Conversation?</AlertDialogTitle>
                        <AlertDialogDescription>This will move the conversation to your archives. You can still access it later if needed.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (conversationId) { deleteConversation.mutate(conversationId); setIsDeleteDialogOpen(false); } }}>Archive</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AgentSelector
                open={agentSelectorOpen}
                onOpenChange={setAgentSelectorOpen}
                onSelect={(agent) => { setAgentSelectorOpen(false); createConversation.mutate(agent.id); }}
            />

            {FEATURE_FLAGS.chatVoice && <VoiceModal isOpen={isModalOpen} onClose={closeVoice} session={session} onTap={handleTap} />}
        </div>
    );
}

export default function ChatPageShell() {
    return <Suspense><ChatPage /></Suspense>;
}
