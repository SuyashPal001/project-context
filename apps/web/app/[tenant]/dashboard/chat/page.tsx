"use client"

import { useCallback, Suspense, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConversationList } from "@/components/platform/chat/ConversationList";
import { MessageThread } from "@/components/platform/chat/MessageThread";
import { ChatInput } from "@/components/platform/chat/ChatInput";
import { WelcomeView } from "@/components/platform/chat/WelcomeView";
import { WizardView } from "@/components/platform/chat/WizardView";
import { AgentSelector } from "@/components/platform/chat/AgentSelector";
import { Canvas } from "@/components/platform/canvas/Canvas";
import { VoiceModal } from "@/components/platform/voice";
import { ChatHeader } from "./ChatHeader";
import { useChatPage } from "./useChatPage";
import { useChatStream } from "./useChatStream";
import { useCanvas } from "@/hooks/useCanvas";
import { useVoice } from "@/hooks/useVoice";
import { MessageSquare, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { MessagesResponse } from "@/components/platform/chat/types";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function ChatPage() {
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
        selectedConversation,
        messages,
        handleCanvasUpdate,
        openCanvas,
    });
    const { sendMessage, sendApproval, cancel, isStreaming, isRetrying, activeToolCalls, completedToolCalls, eventError, warmupMessage, agentTimedOut, hasSentFirstMessage } = stream;

    const { isModalOpen, session, openVoice, closeVoice, handleTap } = useVoice({ conversationId: conversationId || undefined });

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

    const hasContent = !!(messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.content.length > 0);

    const modelChangeProps = {
        providers,
        llmProviderId: selectedConversation?.agent?.llmProviderId ?? activeAgents[0]?.llmProviderId,
        onModelChange: (providerId: string) => {
            const agentId = selectedConversation?.agent?.id ?? activeAgents[0]?.id;
            if (agentId) updateAgentMutation.mutate({ llmProviderId: providerId });
        },
    };

    return (
        <div className="flex bg-background h-[calc(100vh-64px)] overflow-hidden relative w-full">
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
                    "flex flex-col border-r border-border transition-all duration-300 ease-in-out bg-background/50 backdrop-blur-sm z-20 overflow-hidden relative",
                    isChatSidebarCollapsed ? "w-0 opacity-0 pointer-events-none -translate-x-full" : "w-1/4 min-w-[280px] opacity-100 translate-x-0"
                )}>
                    <ConversationList selectedId={conversationId || undefined} onSelect={handleSelectConversation} onNewChat={handleNewChat} />
                </div>

                {/* Main Chat Area */}
                <div className="flex-1 flex flex-row min-w-0 bg-background relative overflow-hidden">
                    {/* Chat Panel */}
                    <div className={cn(
                        "flex flex-col overflow-hidden transition-all h-full",
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
                                />
                                {!hasSentFirstMessage && messages.length === 0 && !isLoadingMessages ? (
                                    activePill !== null ? (
                                        <WizardView pill={activePill} onBack={() => setActivePill(null)} onSubmit={(prompt) => sendMessage(prompt)}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={openVoice} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} {...modelChangeProps} />
                                        </WizardView>
                                    ) : (
                                        <WelcomeView agent={selectedConversation.agent ?? null} firstName={firstName} onSelectPill={(pill) => setActivePill(pill)} onSend={sendMessage}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={openVoice} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} {...modelChangeProps} />
                                        </WelcomeView>
                                    )
                                ) : (
                                    <>
                                        <MessageThread messages={messages} isLoading={isLoadingMessages} isTyping={isStreaming || isRetrying} isStreaming={isStreaming} isRetrying={isRetrying} hasContent={hasContent} activeToolCalls={Array.from(activeToolCalls.values())} completedToolCalls={completedToolCalls} error={eventError} warmupMessage={warmupMessage} onApprove={handleApprove} onDismiss={handleDismiss} />
                                        <div className="shrink-0 pt-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={openVoice} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={false} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} providers={providers} llmProviderId={selectedConversation.agent?.llmProviderId} onModelChange={(id) => { if (selectedConversation.agent?.id) updateAgentMutation.mutate({ llmProviderId: id }); }} />
                                        </div>
                                    </>
                                )}
                            </>
                        ) : isLoadingConversations ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background h-full">
                                <div className="space-y-4 w-full max-w-sm">
                                    <Skeleton className="h-12 w-full" /><Skeleton className="h-40 w-full" /><Skeleton className="h-10 w-32 mx-auto rounded-full" />
                                </div>
                            </div>
                        ) : isErrorConversations ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background h-full">
                                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-6 border border-border"><MessageSquare className="h-8 w-8 text-muted-foreground" /></div>
                                <h2 className="text-2xl font-bold tracking-tight mb-2">Failed to load chats</h2>
                                <p className="text-muted-foreground max-w-sm mb-8">There was an error loading your conversations. Please try again.</p>
                                <Button onClick={() => queryClient.invalidateQueries({ queryKey: ['conversations'] })} size="lg" className="rounded-full shadow-lg h-12 px-6">Retry Loading</Button>
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background h-full">
                                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-6 border border-border"><MessageSquare className="h-8 w-8 text-muted-foreground" /></div>
                                <h2 className="text-2xl font-bold tracking-tight mb-2">Select a conversation</h2>
                                <p className="text-muted-foreground max-w-sm mb-8">Select an existing conversation from the list or start a new one.</p>
                                <Button onClick={() => handleNewChat()} size="lg" className="rounded-full shadow-lg h-12 px-6 gap-2"><Plus className="h-4 w-4" />Start New Conversation</Button>
                            </div>
                        )}
                    </div>

                    {/* Canvas Panel */}
                    <div className={cn("transition-all overflow-hidden h-full z-10 bg-background", isCanvasExpanded ? "w-full flex-1" : (isCanvasOpen ? "w-1/2 border-l border-border" : "w-0"))}>
                        <Canvas isOpen={isCanvasOpen} isExpanded={isCanvasExpanded} onExpand={toggleExpand} onActivity={noopActivity} tenantSlug={tenantSlug} flushPending={flushPending} agentId={selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id} />
                    </div>
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

            <VoiceModal isOpen={isModalOpen} onClose={closeVoice} session={session} onTap={handleTap} />
        </div>
    );
}

export default function ChatPageShell() {
    return <Suspense><ChatPage /></Suspense>;
}
