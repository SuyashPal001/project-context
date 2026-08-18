"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { MessageThread } from "@/components/platform/chat/MessageThread";
import { ChatInput } from "@/components/platform/chat/ChatInput";
import { Message, MessagesResponse, Conversation } from "@/components/platform/chat/types";
import { Bot, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface WidgetChatProps {
    tenantId: string;
    agentId: string;
    externalUserId?: string;
}

export function WidgetChat({ tenantId, agentId, externalUserId }: WidgetChatProps) {
    const queryClient = useQueryClient();
    const [conversationId, setConversationId] = useState<string | null>(null);

    // Load conversationId from localStorage on mount
    useEffect(() => {
        const key = `saas-widget-conv-${tenantId}-${agentId}`;
        const stored = localStorage.getItem(key);
        if (stored) {
            setConversationId(stored);
        }
    }, [tenantId, agentId]);

    // Persist conversationId
    useEffect(() => {
        if (conversationId) {
            const key = `saas-widget-conv-${tenantId}-${agentId}`;
            localStorage.setItem(key, conversationId);
        }
    }, [conversationId, tenantId, agentId]);

    // Fetch messages
    const { data: messagesData, isLoading: isLoadingMessages, refetch: refetchMessages } = useQuery<MessagesResponse>({
        queryKey: ["widget-messages", conversationId],
        queryFn: () => api.get<MessagesResponse>(`/api/v1/widget/conversations/${conversationId}/messages`),
        enabled: !!conversationId,
        refetchInterval: (query) => {
            const data = query.state.data as MessagesResponse | undefined;
            const lastMessage = data?.data?.[data.data.length - 1];
            return lastMessage?.role === 'user' ? 2000 : false;
        }
    });

    const messages = messagesData?.data || [];

    // Create conversation mutation
    const createConversation = useMutation({
        mutationFn: () => 
            api.post<Conversation>("/api/v1/widget/conversations", { 
                tenantId, 
                agentId, 
                externalUserId,
                metadata: { source: 'widget_iframe' }
            }),
        onSuccess: (newConv) => {
            setConversationId(newConv.id);
        },
        onError: (error: any) => {
            toast.error("Failed to start conversation");
            console.error(error);
        }
    });

    // Send message mutation
    const sendMessage = useMutation({
        mutationFn: async (content: string) => {
            let currentId = conversationId;
            
            // Lazy create conversation on first message
            if (!currentId) {
                const newConv = await createConversation.mutateAsync();
                currentId = newConv.id;
            }

            return api.post<Message>(`/api/v1/widget/conversations/${currentId}/messages`, { content });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["widget-messages", conversationId] });
            refetchMessages();
        },
        onError: (error: any) => {
            toast.error(error.data?.error || "Failed to send message");
        }
    });

    const isTyping = useMemo(() => {
        if (!messages.length) return false;
        const lastMessage = messages[messages.length - 1];
        return lastMessage.role === 'user';
    }, [messages]);

    const handleSendMessage = (content: string) => {
        sendMessage.mutate(content);
    };

    const handleReset = () => {
        if (window.confirm("Start a new conversation?")) {
            const key = `saas-widget-conv-${tenantId}-${agentId}`;
            localStorage.removeItem(key);
            setConversationId(null);
            queryClient.setQueryData(["widget-messages", conversationId], null);
        }
    };

    const handleClose = () => {
        window.parent.postMessage('close-saas-widget', '*');
    };

    return (
        <div className="flex flex-col h-screen bg-background border-none overflow-hidden font-sans">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-slate-900 text-white shrink-0">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-white/10 flex items-center justify-center border border-white/20">
                        <Bot className="h-4 w-4" />
                    </div>
                    <span className="font-semibold text-sm">Chat Support</span>
                </div>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-white/70 hover:text-white hover:bg-white/10" onClick={handleReset}>
                        <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-white/70 hover:text-white hover:bg-white/10" onClick={handleClose}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden pointer-events-auto">
                <MessageThread 
                    messages={messages} 
                    isLoading={isLoadingMessages && !!conversationId} 
                    isTyping={isTyping || sendMessage.isPending}
                />
            </div>

            {/* Input */}
            <div className="shrink-0 p-3 bg-background border-t border-border">
                <ChatInput 
                    onSend={handleSendMessage} 
                    isLoading={sendMessage.isPending || isTyping}
                />
                <div className="mt-2 text-[10px] text-center text-muted-foreground flex items-center justify-center gap-1">
                    <span>Powered by</span>
                    <a
                        href="https://projectcontext.co"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold flex items-center gap-0.5 hover:text-foreground transition-colors"
                    >
                        <Bot className="h-2.5 w-2.5" />
                        Saarthi Workflow
                    </a>
                </div>
            </div>
        </div>
    );
}
