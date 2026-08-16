'use client';
import { useState, useRef, useMemo, useEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSidebar } from '@/components/platform/SidebarContext';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { toast } from 'sonner';
import type { PillType } from '@/components/platform/chat/WizardView';
import type { Conversation, ConversationsResponse, MessagesResponse } from '@/components/platform/chat/types';
import type { Agent } from '@/components/platform/agents/types';

interface LLMProvider {
    id: string; provider: string; model: string;
    displayName: string; isDefault: boolean;
    status: 'live' | 'coming_soon';
}

export function useChatPage() {
    const params = useParams();
    const searchParams = useSearchParams();
    const router = useRouter();
    const queryClient = useQueryClient();

    const tenantSlug = params.tenant as string;
    const rawConvId = searchParams.get('id');
    const incomingConvId = searchParams.get('conversationId');
    const incomingAgentId = searchParams.get('agentId');

    const conversationId = rawConvId ?? incomingConvId;
    const conversationIdRef = useRef(conversationId);
    conversationIdRef.current = conversationId;

    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);
    const [activePill, setActivePill] = useState<PillType | null>(null);
    const autoCreatingRef = useRef(false);

    // Normalise ?conversationId= → ?id= so the standard selection path handles it
    useEffect(() => {
        if (incomingConvId) router.replace(`/${tenantSlug}/dashboard/chat?id=${incomingConvId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [incomingConvId]);

    const { isChatSidebarCollapsed, toggleChatSidebar } = useSidebar();
    const tenantClaims = useTenant();
    const firstName = 'Gov Officer';

    const { data: providersData } = useQuery<{ providers: LLMProvider[] }>({
        queryKey: ['llm-providers'],
        queryFn: () => api.get('/api/v1/llm-providers'),
    });
    const providers = providersData?.providers ?? [];

    const { data: agentsData } = useQuery<{ data: Agent[] }>({
        queryKey: ['agents'],
        queryFn: () => api.get('/api/v1/agents'),
    });
    const activeAgents = agentsData?.data?.filter(a => a.status === 'active') ?? [];

    const { data: conversationsData, isLoading: isLoadingConversations, isError: isErrorConversations } = useQuery<ConversationsResponse>({
        queryKey: ['conversations'],
        queryFn: () => api.get('/api/v1/conversations'),
    });
    const conversations = conversationsData?.data ?? [];

    const { data: activeConversationData } = useQuery<{ data: Conversation }>({
        queryKey: ['conversation', conversationId],
        queryFn: () => api.get(`/api/v1/conversations/${conversationId}`),
        enabled: !!conversationId,
    });

    const selectedConversation = useMemo(
        () => activeConversationData?.data ?? conversations.find(c => c.id === conversationId),
        [activeConversationData, conversations, conversationId],
    );

    const { data: messagesData, isLoading: isLoadingMessages } = useQuery<MessagesResponse>({
        queryKey: ['messages', conversationId],
        queryFn: async () => {
            const res = await api.get<MessagesResponse>(`/api/v1/conversations/${conversationId}/messages`);
            const sorted = [...res.data].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            return { ...res, data: sorted };
        },
        enabled: !!conversationId,
        // Client-only state (e.g. a pending clarificationRequest pushed into this
        // query's cache by useChatStream) has no server-side row yet. A focus
        // refetch would replace the cache with the server's copy — which never had
        // it — and silently wipe an in-progress ClarificationCard. Disabled here
        // (not globally) since this is the only query that holds such synthetic data.
        refetchOnWindowFocus: false,
    });
    const messages = messagesData?.data ?? [];

    const createConversation = useMutation({
        mutationFn: (agentId: string) => api.post<{ data: Conversation }>('/api/v1/conversations', { agentId }),
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
            router.push(`/${tenantSlug}/dashboard/chat?id=${res.data.id}`);
            toast.success('Conversation started');
        },
        onError: (err: any) => {
            const msg = err.data?.error;
            toast.error(typeof msg === 'string' ? msg : msg?.message || 'Failed to start conversation');
        },
    });

    const silentCreateConversation = useMutation({
        mutationFn: (agentId: string) => api.post<{ data: Conversation }>('/api/v1/conversations', { agentId }),
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
            router.push(`/${tenantSlug}/dashboard/chat?id=${res.data.id}`);
        },
        onError: () => { autoCreatingRef.current = false; },
    });

    const updateAgentMutation = useMutation({
        mutationFn: (values: { llmProviderId: string }) => {
            const agentId = selectedConversation?.agentId || selectedConversation?.agent?.id;
            return api.patch(`/api/v1/agents/${agentId}`, values);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
            toast.success('AI Model updated');
        },
        onError: (err: any) => { toast.error(err.data?.message || 'Failed to update model'); },
    });

    const deleteConversation = useMutation({
        mutationFn: (id: string) => api.del(`/api/v1/conversations/${id}`),
        onSuccess: (_, deletedId) => {
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
            toast.success('Conversation archived');
            if (conversationId === deletedId) router.push(`/${tenantSlug}/dashboard/chat`);
        },
        onError: (err: any) => { toast.error(err.data?.message || 'Failed to archive conversation'); },
    });

    // Auto-create a conversation for first-time users
    useEffect(() => {
        if (!isLoadingConversations && !isErrorConversations && conversations.length === 0 &&
            !conversationId && activeAgents.length > 0 && !autoCreatingRef.current) {
            autoCreatingRef.current = true;
            silentCreateConversation.mutate(activeAgents[0].id);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoadingConversations, isErrorConversations, conversations.length, conversationId, activeAgents.length]);

    // Auto-create a conversation when ?agentId= is in the URL
    useEffect(() => {
        if (!incomingAgentId || conversationId || autoCreatingRef.current || isLoadingConversations) return;
        autoCreatingRef.current = true;
        api.post<{ data: Conversation }>('/api/v1/conversations', { agentId: incomingAgentId })
            .then((res) => {
                queryClient.invalidateQueries({ queryKey: ['conversations'] });
                router.replace(`/${tenantSlug}/dashboard/chat?id=${res.data.id}`);
            })
            .catch(() => { autoCreatingRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [incomingAgentId, conversationId, isLoadingConversations]);

    const handleSelectConversation = (conv: Conversation) =>
        router.push(`/${tenantSlug}/dashboard/chat?id=${conv.id}`);

    const handleNewChat = (agentId?: string) => {
        if (agentId) {
            createConversation.mutate(agentId);
            return;
        }
        if (activeAgents.length === 0) {
            toast.error('No active agents available. Please create one first.');
        } else if (activeAgents.length === 1) {
            createConversation.mutate(activeAgents[0].id);
        } else {
            setAgentSelectorOpen(true);
        }
    };

    return {
        tenantSlug, conversationId, conversationIdRef, firstName,
        isChatSidebarCollapsed, toggleChatSidebar,
        providers, activeAgents,
        conversations, isLoadingConversations, isErrorConversations,
        selectedConversation, messages, isLoadingMessages,
        isDeleteDialogOpen, setIsDeleteDialogOpen,
        agentSelectorOpen, setAgentSelectorOpen,
        activePill, setActivePill,
        queryClient, createConversation, updateAgentMutation, deleteConversation,
        handleSelectConversation, handleNewChat,
    };
}
