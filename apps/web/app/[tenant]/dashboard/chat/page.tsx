"use client"

import { useCallback, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PLANS } from "@/components/platform/billing/PlanSelectorDialog";
import { OlmoMark } from "@/components/platform/OlmoMark";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "@/components/platform/agents/agentTypeIcon";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { ConversationList } from "@/components/platform/chat/ConversationList";
import { MessageThread } from "@/components/platform/chat/MessageThread";
import { ChatTimelineNavigator } from "@/components/platform/chat/ChatTimelineNavigator";
import { ChatInput } from "@/components/platform/chat/ChatInput";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/components/platform/chat/useFileUpload";
import { WelcomeView } from "@/components/platform/chat/WelcomeView";
import { WizardView } from "@/components/platform/chat/WizardView";
import { AgentSelector } from "@/components/platform/chat/AgentSelector";
import { Canvas } from "@/components/platform/canvas/Canvas";
import { VoiceModal } from "@/components/platform/voice";
import { ChatHeader } from "./ChatHeader";
import { ChatListToggle } from "./ChatListToggle";
import { usePersonaAnimationState } from "@/components/platform/personas/usePersonaAnimationState";
import { useChatPage } from "./useChatPage";
import { useChatStream } from "./useChatStream";
import { shouldShowConversationWelcome } from "./conversationWelcomeState";
import { useCanvas } from "@/hooks/useCanvas";
import { useVoice } from "@/hooks/useVoice";
import { MessageSquare, RefreshCw, Calculator, Check, LayoutTemplate, UserRound, Package, Music, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CreditsPanel } from "@/components/platform/credits/CreditsPanel";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Message, MessagesResponse } from "@/components/platform/chat/types";
import { findPendingClarification, findPendingGenerationConfirm, findPendingUpload } from "@/components/platform/chat/pendingRequests";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FEATURE_FLAGS } from "@/lib/feature-flags";
import { parseFolderId } from "@/lib/folderScope";
import { CreativeLibrary } from '@/components/platform/chat/CreativeLibrary';
import { CreativeBriefChips } from '@/components/platform/chat/creative-library/CreativeBriefChips';
import {
    buildCreativeBriefMessage,
    countCreativeBriefAttachments,
    mergeCreativeBriefAttachments,
} from '@/components/platform/chat/creative-library/creativeBrief';
import {
    fieldForTab,
    isCreativeBriefStarted,
    tabForField,
    updateCreativeBrief,
    type CreativeBriefField,
    type CreativeLibraryTab,
    type CreativeSelection,
} from '@/components/platform/chat/creative-library/creativeBriefModel';
import { useCreativeBriefDraft } from '@/components/platform/chat/creative-library/useCreativeBriefDraft';
import type { Attachment } from '@/types/agent-events';

// Category shortcuts under the no-conversation-selected composer — Templates
// (proven ad-structure starting points), Avatars, Products, Audio. No "Browse"
// tab: research on comparable ad-creation tools (Creatify, Arcads,
// AdCreative.ai) turned up no evidence of a generic "browse everything" tab
// at any of them, only these four named, revenue-driving categories.
const EMPTY_STATE_LIBRARY_TABS = [
    { id: 'templates', label: 'Templates', icon: LayoutTemplate },
    { id: 'avatars', label: 'Avatars', icon: UserRound },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'audio', label: 'Audio', icon: Music },
] as const;

function ChatPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const folderId = parseFolderId(searchParams.get('folderId'));
    const page = useChatPage();
    const {
        tenantSlug, conversationId, conversationIdRef, firstName,
        isChatSidebarCollapsed, toggleChatSidebar,
        providers, activeAgents, isLoadingAgents, draftAgent,
        isLoadingConversations, isErrorConversations,
        selectedConversation, messages, isLoadingMessages,
        isDeleteDialogOpen, setIsDeleteDialogOpen,
        agentSelectorOpen, setAgentSelectorOpen,
        activePill, setActivePill,
        createConversation, updateAgentMutation, deleteConversation,
        handleSelectConversation, handleNewChat, startNewChat,
    } = page;

    // Same plan lookup AccountMenu.tsx uses: `plan` off the tenant JWT claim is
    // a raw id ('free', 'business', ...), mapped through the canonical PLANS
    // list for a display name and the next tier to upgrade into.
    const tenantClaims = useTenant();
    const planIndex = PLANS.findIndex(p => p.id === (tenantClaims.plan?.toLowerCase() || 'free'));
    const nextPlan = planIndex >= 0 && planIndex < PLANS.length - 1 ? PLANS[planIndex + 1] : null;
    const currentPlanName = planIndex >= 0 ? PLANS[planIndex].name : (tenantClaims.plan || 'Free');

    const queryClient = useQueryClient();
    const { isCanvasOpen, isCanvasExpanded, hasActivity, toggleCanvas, toggleExpand, openCanvas, handleCanvasUpdate, flushPending } = useCanvas();

    // Auto-collapse the conversation list the moment Canvas opens, giving
    // chat+canvas the room the two-column layout needs — same collapse the
    // PanelLeftClose button already does manually, just triggered
    // automatically on this one transition. Fires only on the false->true
    // edge (not on every render where canvas stays open) so it never fights
    // the user manually re-opening the list afterward.
    const wasCanvasOpenRef = useRef(false);
    useEffect(() => {
        if (isCanvasOpen && !wasCanvasOpenRef.current && !isChatSidebarCollapsed) {
            toggleChatSidebar();
        }
        wasCanvasOpenRef.current = isCanvasOpen;
    }, [isCanvasOpen]); // eslint-disable-line react-hooks/exhaustive-deps

    // The grant lives on the conversation, so it survives a reload and is not
    // something the client can talk itself into — the server decides what it says.
    const folderPrefix = selectedConversation?.metadata?.folderScope?.prefix;
    const allowMode = selectedConversation?.metadata?.allowMode;

    // Revoking is a server-side clear, not a UI toggle: the grant is what the
    // orchestrator enforces against, so the chip must not be able to lie about it.
    const revokeFolderScope = useMutation({
        mutationFn: () => api.patch(`/api/v1/conversations/${conversationId}`, { folderScope: null }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
        },
        onError: () => toast.error('Could not revoke folder access'),
    });

    // Spread into every ChatInput rather than rendered beside one of them: the
    // composer appears in three branches here, and a chip added to a single
    // branch is invisible in the others.
    const folderScopeProps = {
        folderPrefix,
        onRevokeFolder: () => revokeFolderScope.mutate(),
        isRevokingFolder: revokeFolderScope.isPending,
    };

    // Stored on the conversation (not client state) so it survives a reload
    // and the orchestrator enforces the same value the composer shows — same
    // reasoning as folderScope above.
    const setAllowMode = useMutation({
        mutationFn: (mode: 'ask' | 'auto') => api.patch(`/api/v1/conversations/${conversationId}`, { allowMode: mode }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
        },
        onError: () => toast.error('Could not change allow mode'),
    });

    const allowModeProps = {
        allowMode: allowMode ?? 'ask' as const,
        onAllowModeChange: (mode: 'ask' | 'auto') => setAllowMode.mutate(mode),
        // agentId gates the "/" palette (the public widget has no agent); a "/" pick applies to this conversation only.
        agentId: selectedConversation?.agentId ?? selectedConversation?.agent?.id,
    };

    // "/" skills live on the conversation, not the agent: a chip's X turns the
    // skill off for this conversation only. Same server-side storage and
    // invalidation as folderScope and allowMode above.
    const invokedSkills = selectedConversation?.metadata?.invokedSkills ?? [];
    const setInvokedSkills = useMutation({
        mutationFn: (next: Array<{ installId: string; skillId: string; name: string }>) =>
            api.patch(`/api/v1/conversations/${conversationId}`, { invokedSkills: next.length > 0 ? next : null }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
        },
        onError: () => toast.error('Could not turn that skill off'),
    });
    const skillProps = {
        invokedSkills,
        isTestChat: !!selectedConversation?.metadata?.testSkillInstallId,
        onRemoveInvokedSkill: (skillId: string) =>
            setInvokedSkills.mutate(invokedSkills.filter(s => s.skillId !== skillId)),
    };

    const stream = useChatStream({
        conversationId,
        conversationIdRef,
        agentId: selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id,
        folderId,
        folderPrefix,
        allowMode,
        selectedConversation,
        messages,
        handleCanvasUpdate,
        openCanvas,
    });
    const { sendMessage, sendApproval, sendGenerationConfirm, sendClarificationAnswer, sendUploadAnswer, cancel, isStreaming, isPreparingMessage, isRetrying, activeToolCalls, completedToolCalls, reasoningText, traceAfterSeq, eventError, warmupMessage, agentTimedOut, hasSentFirstMessage, lastStreamEvent, regenerate, editAndResubmit } = stream;

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
    // Same back-from-the-end scan MessageThread's overlays use — the request is
    // attached to the assistant turn it interrupted, not necessarily the last row.
    const awaitingClarificationReply = !!findPendingClarification(messages);

    // Mirrors awaitingClarificationReply: ApproveCost is the only input surface while a
    // generation confirm request is pending, so the normal composer stays hidden.
    const awaitingGenerationConfirmReply = !!findPendingGenerationConfirm(messages);

    // Mirrors awaitingClarificationReply: UploadRequestCard is the only input
    // surface while an upload request is pending.
    const awaitingUploadReply = !!findPendingUpload(messages);

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

    // Text typed into the no-conversation-selected composer, held until the
    // conversation handleNewChat() creates finishes loading — then sent once.
    // Cleared immediately after firing so a later empty (0-message) conversation
    // load never re-sends it.
    const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
    const [pendingFirstAttachments, setPendingFirstAttachments] = useState<Attachment[] | undefined>();
    // Allow-mode toggled in that same pre-conversation composer — allowMode is
    // stored on the conversation row, so there's nothing to PATCH until one
    // exists. Held here and applied once, same as pendingFirstMessage above.
    const [pendingAllowMode, setPendingAllowMode] = useState<'ask' | 'auto' | null>(null);
    const [pendingCreativeBrief, setPendingCreativeBrief] = useState(false);
    // Which library tab (Templates/Avatars/Products/Audio) is expanded under the
    // no-conversation-selected composer. Null collapses the panel.
    const [activeEmptyStateTab, setActiveEmptyStateTab] = useState<CreativeLibraryTab | null>(null);
    const creativeDraftStorageKey = `olmo:creative-brief:${tenantSlug}`;
    const { creativeBrief, setCreativeBrief, clearCreativeBrief } = useCreativeBriefDraft(creativeDraftStorageKey);
    const creativeBriefStarted = isCreativeBriefStarted(creativeBrief);
    const stagedFirstMessage = useMemo<Message | null>(() => pendingFirstMessage !== null && conversationId && messages.length === 0
        ? {
            id: `pending-first-message:${conversationId}`,
            conversationId,
            role: 'user',
            content: pendingFirstMessage,
            createdAt: new Date().toISOString(),
            attachments: pendingFirstAttachments?.map((attachment, index) => ({
                id: `pending-attachment:${index}:${attachment.fileId}`,
                fileId: attachment.fileId,
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
                previewUrl: attachment.previewUrl,
            })),
        }
        : null, [conversationId, messages.length, pendingFirstAttachments, pendingFirstMessage]);
    const displayedMessages = stagedFirstMessage ? [stagedFirstMessage] : messages;
    const showConversationWelcome = shouldShowConversationWelcome({
        hasSentFirstMessage,
        messageCount: messages.length,
        isLoadingMessages,
        hasPendingFirstMessage: pendingFirstMessage !== null,
    });

    const selectCreativeAsset = (selection: CreativeSelection) => {
        setCreativeBrief(current => updateCreativeBrief(current, selection));
    };

    const removeCreativeAsset = (field: CreativeBriefField) => {
        setCreativeBrief(current => ({ ...current, [field]: null }));
    };

    const validateCreativeBrief = ({ attachments, pendingAudio }: { attachments: Attachment[]; pendingAudio: boolean }) => {
        if (!creativeBriefStarted) return true;
        if (countCreativeBriefAttachments(attachments, creativeBrief, pendingAudio) > MAX_ATTACHMENTS_PER_MESSAGE) {
            toast.error(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
            return false;
        }
        return true;
    };

    const firstSendStartedRef = useRef(false);
    useEffect(() => {
        if (pendingFirstMessage === null) {
            firstSendStartedRef.current = false;
            return;
        }
        if (!conversationId || isLoadingMessages || messages.length > 0) return;
        if (firstSendStartedRef.current) return;
        firstSendStartedRef.current = true;
        const message = pendingFirstMessage;
        const attachments = pendingFirstAttachments;
        const allowModeToApply = pendingAllowMode && pendingAllowMode !== 'ask' ? pendingAllowMode : null;
        void (async () => {
            // The orchestrator reads allowMode off the conversation row while
            // handling the first message, so the PATCH must land before it is
            // sent. onError on the mutation already toasts; still send on failure
            // (falls back to 'ask', the safe default).
            if (allowModeToApply) {
                try { await setAllowMode.mutateAsync(allowModeToApply); } catch { /* toasted */ }
            }
            sendMessage(message, attachments);
            setPendingFirstMessage(null);
            setPendingFirstAttachments(undefined);
            if (pendingCreativeBrief) {
                clearCreativeBrief();
                setActiveEmptyStateTab(null);
                setPendingCreativeBrief(false);
            }
            setPendingAllowMode(null);
        })();
    }, [pendingFirstMessage, conversationId, isLoadingMessages, messages.length, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

    // A caller (e.g. the Skills page's "+ Create skill" button, or
    // SkillDetailModal's "Test in chat") can seed the very first message via
    // ?prompt= on a /chat URL — same idea as the empty-state composer's own
    // onSend below — queue it as pendingFirstMessage. Two shapes:
    //   - No ?id= yet: let handleNewChat's default agent create one first
    //     (create_skill flow). No router.replace to strip the param —
    //     createConversation's own onSuccess already router.push()es to a
    //     fresh `?id=...`, which drops `prompt` on its own.
    //   - ?id= already present (Test in chat — the conversation exists
    //     before navigation): just queue the send once its messages have
    //     settled empty. Note: this must arrive as ?id=, not
    //     ?conversationId= — useChatPage's own ?conversationId= -> ?id=
    //     normalization (its own router.replace) keeps only `id`, silently
    //     dropping `prompt` before this effect ever sees it.
    // Guarded by a ref so a re-render before either path settles never
    // queues it twice.
    const seededPromptFiredRef = useRef(false);
    useEffect(() => {
        const seededPrompt = searchParams.get('prompt');
        if (!seededPrompt || seededPromptFiredRef.current) return;
        // searchParams.get already URL-decodes — decoding again here would
        // throw on a prompt containing a literal '%' character.
        if (conversationId) {
            if (isLoadingMessages) return;
            seededPromptFiredRef.current = true;
            // An existing conversation may already have messages (e.g. the
            // param survived a back-navigation) — never inject into one that
            // isn't actually fresh.
            if (messages.length === 0) setPendingFirstMessage(seededPrompt);
            // No onSuccess push to piggyback on here (unlike the create-skill
            // path below) — this conversation already existed, so strip the
            // param ourselves once consumed, or a reload would leave a stale
            // ?prompt= sitting in the address bar indefinitely.
            router.replace(`/${tenantSlug}/dashboard/chat?id=${conversationId}`);
            return;
        }
        // handleNewChat() with no agentId falls back to activeAgents[0] — on a
        // fresh /chat visit (no react-query cache yet) that array is still []
        // while the ['agents'] query is in flight, so firing before it
        // resolves hit the "No active agents available" branch instead of
        // ever finding Olmo. Wait for it to settle first.
        if (isLoadingAgents) return;
        seededPromptFiredRef.current = true;
        setPendingFirstMessage(seededPrompt);
        handleNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, conversationId, isLoadingAgents, isLoadingMessages, messages.length]);

    const noopActivity = useCallback(() => {}, []);

    useEffect(() => {
        const canvasWindow = window as Window & { __openCanvas?: typeof openCanvas };
        canvasWindow.__openCanvas = openCanvas;
        return () => { delete canvasWindow.__openCanvas; };
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

    const handleGenerationConfirm = useCallback(async (messageId: string, confirmationId: string) => {
        const ok = await sendGenerationConfirm(confirmationId, 'approved');
        if (!ok) {
            console.error(`generation-confirm POST failed for confirmationId=${confirmationId}`);
            toast.error('Could not confirm generation. Please try again.');
        }
        // Mark the local card resolved even on failure — otherwise the overlay
        // stays up and the composer stays hidden (awaitingGenerationConfirmReply
        // reads this same status) with no way for the user to recover. A failed
        // POST is treated as declined since the tool-side pending entry may
        // already be gone (e.g. timed out, orchestrator restarted).
        const resolvedStatus: 'approved' | 'declined' = ok ? 'approved' : 'declined';
        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
            old ? { data: old.data.map(m => m.id === messageId ? { ...m, generationConfirmRequest: m.generationConfirmRequest ? { ...m.generationConfirmRequest, status: resolvedStatus, decisionAt: new Date().toISOString() } : undefined } : m) } : old
        );
    }, [conversationId, queryClient, sendGenerationConfirm]);

    const handleGenerationDecline = useCallback(async (messageId: string, confirmationId: string, reason?: string) => {
        const ok = await sendGenerationConfirm(confirmationId, 'declined', reason);
        if (!ok) {
            console.error(`generation-confirm POST failed for confirmationId=${confirmationId}`);
            toast.error('Could not record your response. Please try again.');
        }
        // Same recovery as handleGenerationConfirm above: resolve the local card
        // regardless of POST success so the composer becomes usable again.
        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
            old ? { data: old.data.map(m => m.id === messageId ? { ...m, generationConfirmRequest: m.generationConfirmRequest ? { ...m.generationConfirmRequest, status: 'declined' as const, decisionAt: new Date().toISOString(), ...(reason ? { declineReason: reason } : {}) } : undefined } : m) } : old
        );
    }, [conversationId, queryClient, sendGenerationConfirm]);

    // Tracks, per clarificationId, whether every answer submitted so far was a
    // skip — used to label the completed card "Skipped" only when the WHOLE
    // set was skipped, not just the final question answered.
    const clarificationAllSkippedRef = useRef<Map<string, boolean>>(new Map());
    // Accumulates each question's answer as it's submitted, keyed by
    // clarificationId then questionIndex — attached to the resolved request so
    // the "N answer(s)" summary card has real question/answer text to show.
    const clarificationAnswersRef = useRef<Map<string, Record<number, { selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean; files?: { fileId: string; name: string; type: string }[] }>>>(new Map());

    const handleClarificationAnswer = useCallback(async (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean; files?: { fileId: string; name: string; type: string }[] }, allAnswered?: boolean): Promise<boolean> => {
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
                old ? { data: old.data.map(m => m.id === messageId ? {
                    ...m,
                    // A turn can hold several clarification rounds — update only
                    // the one this answer belongs to, by id, and leave the other
                    // rounds' resolved cards untouched.
                    clarificationRequests: m.clarificationRequests?.map(r => r.id === clarificationId
                        ? { ...r, status: finalStatus, answeredAt: new Date().toISOString(), answers }
                        : r),
                } : m) } : old
            );
        } else {
            // Persist partial progress in the local cache so the card can restore
            // from it if a reload happens before all questions are answered.
            queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
                old ? { data: old.data.map(m => m.id === messageId ? {
                    ...m,
                    clarificationRequests: m.clarificationRequests?.map(r => r.id === clarificationId
                        ? { ...r, answers: { ...r.answers, [questionIndex]: answer } }
                        : r),
                } : m) } : old
            );
        }
        return true;
    }, [conversationId, queryClient, sendClarificationAnswer]);

    const handleUploadAnswer = useCallback(async (messageId: string, uploadId: string, answer: { files: { fileId: string; name: string; type: string }[]; freeText?: string; skipped?: boolean }): Promise<boolean> => {
        const ok = await sendUploadAnswer(uploadId, answer);
        if (!ok) {
            toast.error('Could not submit your upload. Please try again.');
            return false;
        }
        queryClient.setQueryData<MessagesResponse>(['messages', conversationId], old =>
            old ? {
                data: old.data.map(m => m.id === messageId ? {
                    ...m,
                    // Same per-round targeting as handleClarificationAnswer above.
                    uploadRequests: m.uploadRequests?.map(r => r.id === uploadId ? {
                        ...r,
                        status: answer.skipped ? 'skipped' as const : 'answered' as const,
                        answeredAt: new Date().toISOString(),
                        files: answer.files.map(f => ({ fileId: f.fileId, name: f.name, type: f.type })),
                        freeText: answer.freeText,
                    } : r),
                } : m),
            } : old
        );
        return true;
    }, [conversationId, queryClient, sendUploadAnswer]);

    const sidebarToggleButton = (
        <ChatListToggle
            collapsed={isChatSidebarCollapsed}
            onToggle={toggleChatSidebar}
            className="absolute top-6 left-4 z-10"
        />
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
                        onNewChat={startNewChat}
                    />
                </div>

                {/* Main Chat Area */}
                <div className="flex-1 flex flex-row min-w-0 bg-background relative overflow-hidden">
                    {/* Chat Panel */}
                    <div className={cn(
                        "relative flex flex-col overflow-hidden transition-all h-full min-w-0",
                        isCanvasExpanded ? "w-0 opacity-0 pointer-events-none" : "flex-1",
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
                                {showConversationWelcome ? (
                                    activePill !== null ? (
                                        <WizardView pill={activePill} onBack={() => setActivePill(null)} onSubmit={(prompt) => sendMessage(prompt)}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={isPreparingMessage} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} {...folderScopeProps} {...modelChangeProps} {...allowModeProps} {...skillProps} />
                                        </WizardView>
                                    ) : (
                                        <WelcomeView agent={selectedConversation.agent ?? null} firstName={firstName} onSelectPill={(pill) => setActivePill(pill)} onSend={(text) => setInputPrefill(text)} avatarLiveState={displayState}>
                                            <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={isPreparingMessage} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} prefill={inputPrefill} {...folderScopeProps} {...modelChangeProps} {...allowModeProps} {...skillProps} />
                                        </WelcomeView>
                                    )
                                ) : (
                                    <>
                                        <MessageThread messages={displayedMessages} isLoading={isLoadingMessages} isTyping={isStreaming || isPreparingMessage || isRetrying || stagedFirstMessage !== null} isStreaming={isStreaming || isPreparingMessage} isRetrying={isRetrying} activeToolCalls={Array.from(activeToolCalls.values())} completedToolCalls={completedToolCalls} reasoningText={reasoningText} traceAfterSeq={traceAfterSeq} error={eventError} warmupMessage={warmupMessage} onApprove={handleApprove} onDismiss={handleDismiss} onGenerationConfirm={handleGenerationConfirm} onGenerationDecline={handleGenerationDecline} onClarificationAnswer={handleClarificationAnswer} onUploadAnswer={handleUploadAnswer} onFollowUpSelect={(text) => { if (!isStreaming && !isPreparingMessage) sendMessage(text); }} onRegenerate={regenerate} onEditAndResubmit={editAndResubmit} agentAvatarUrl={selectedConversation.agent?.avatarUrl} agentPersona={selectedConversation.agent?.persona} agentIsDefault={selectedConversation.agent?.origin === "built_in"} agentName={selectedConversation.agent?.name} avatarLiveState={displayState} />
                                        <ChatTimelineNavigator messages={displayedMessages} />
                                        {!awaitingClarificationReply && !awaitingGenerationConfirmReply && !awaitingUploadReply && (
                                            <div className="shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                                                <ChatInput onSend={sendMessage} onStop={cancel} onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined} onMediaClick={(t) => toast.info(`Adding ${t}...`)} isLoading={isPreparingMessage} isStreaming={isStreaming} disabled={selectedConversation.status !== 'active'} {...folderScopeProps} {...allowModeProps} {...skillProps} providers={providers} llmProviderId={selectedConversation.agent?.llmProviderId} onModelChange={(id) => { if (selectedConversation.agent?.id) updateAgentMutation.mutate({ llmProviderId: id }); }} />
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        ) : isLoadingConversations ? (
                            // Mirrors the "Select a conversation" empty state below
                            // (icon square, heading, two-line paragraph, pill button)
                            // rather than three unrelated block sizes — the eventual
                            // state, not a generic loading shape.
                            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-background h-full relative">
                                {sidebarToggleButton}
                                <Skeleton className="h-16 w-16 rounded-2xl mb-6" />
                                <Skeleton className="h-5 w-40 mb-2" />
                                <Skeleton className="h-4 w-64 mb-1.5" />
                                <Skeleton className="h-4 w-48 mb-8" />
                                <Skeleton className="h-12 w-52 rounded-full" />
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
                            <div className="flex-1 flex flex-col items-center p-8 text-center bg-background h-full relative overflow-y-auto">
                                {sidebarToggleButton}
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <button
                                            type="button"
                                            data-testid="chat-empty-usage"
                                            className="absolute top-4 right-4 h-8 px-3 flex items-center gap-1.5 rounded-full border border-border/60 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                        >
                                            <Calculator className="h-3.5 w-3.5" />
                                            Usage
                                        </button>
                                    </PopoverTrigger>
                                    <PopoverContent side="bottom" align="end" className="p-0">
                                        <CreditsPanel />
                                    </PopoverContent>
                                </Popover>
                                {/* Two equal flex-1 spacers instead of justify-center + margin:
                                    centering a box with margin splits that margin between the two
                                    gaps rather than adding it to just one side, which made an
                                    earlier margin-based "shift down" attempt behave unpredictably.
                                    Equal spacers give a true, symmetric center. */}
                                <div className="flex-1 min-h-0" />
                                <div className="w-full max-w-2xl mx-auto flex flex-col items-center py-8">
                                    <div className="flex flex-col items-center gap-2 mb-8">
                                        {!draftAgent || draftAgent.origin === 'built_in' ? (
                                            <div className="flex items-center gap-1.5 opacity-80">
                                                <OlmoMark height={18} />
                                                <span className="text-sm font-semibold tracking-tight">Olmo Creative Agent</span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 opacity-80">
                                                <PersonaAvatar
                                                    persona={draftAgent.persona}
                                                    avatarUrl={draftAgent.avatarUrl}
                                                    size={18}
                                                    className="rounded-full h-[18px] w-[18px] shrink-0"
                                                    iconClassName="text-foreground/50"
                                                    icon={getAgentTypeIcon(draftAgent.type)}
                                                />
                                                <span className="text-sm font-semibold tracking-tight">{draftAgent.name}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium">
                                            <span className="text-muted-foreground">{currentPlanName} plan</span>
                                            {nextPlan && (
                                                <>
                                                    <span className="text-border">|</span>
                                                    <Link href={`/${tenantSlug}/dashboard/billing`} className="flex items-center gap-1 font-semibold text-foreground hover:opacity-80 transition-opacity">
                                                        <Zap className="h-3 w-3 fill-foreground shrink-0" />
                                                        Upgrade
                                                    </Link>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <h1 className="text-3xl font-bold tracking-tight mb-8">{firstName ? `Hi ${firstName}, what are we creating today?` : "What are we creating today?"}</h1>
                                    <div className="w-full">
                                        <ChatInput
                                            onSend={(text, attachments) => {
                                                const message = creativeBriefStarted ? buildCreativeBriefMessage(text, creativeBrief) : text;
                                                const mergedAttachments = creativeBriefStarted ? mergeCreativeBriefAttachments(attachments, creativeBrief) : attachments;
                                                setPendingFirstMessage(message);
                                                setPendingFirstAttachments(mergedAttachments);
                                                setPendingCreativeBrief(creativeBriefStarted);
                                                handleNewChat(draftAgent?.id);
                                                // Keep the pre-conversation composer intact. A successful
                                                // creation replaces this view; a failure remains fully editable.
                                                return false;
                                            }}
                                            onVoiceClick={FEATURE_FLAGS.chatVoice ? openVoice : undefined}
                                            onMediaClick={(t) => toast.info(`Adding ${t}...`)}
                                            isLoading={createConversation.isPending}
                                            isStreaming={false}
                                            agentId={draftAgent?.id}
                                            allowMode={pendingAllowMode ?? 'ask'}
                                            onAllowModeChange={setPendingAllowMode}
                                            hasSupplementalContent={creativeBriefStarted}
                                            supplementalContent={
                                                <CreativeBriefChips
                                                    brief={creativeBrief}
                                                    onEdit={(field) => setActiveEmptyStateTab(tabForField(field))}
                                                    onRemove={removeCreativeAsset}
                                                />
                                            }
                                            beforeSend={validateCreativeBrief}
                                            {...modelChangeProps}
                                        />
                                    </div>
                                    <div className="-mt-2 flex flex-wrap items-center justify-center gap-2">
                                        {EMPTY_STATE_LIBRARY_TABS.map((tab) => (
                                            <button
                                                key={tab.id}
                                                type="button"
                                                onClick={() => setActiveEmptyStateTab((cur) => (cur === tab.id ? null : tab.id))}
                                                className={cn(
                                                    "h-9 px-4 flex items-center gap-2 rounded-full border text-sm font-medium transition-colors",
                                                    activeEmptyStateTab === tab.id
                                                        ? "bg-foreground text-background border-foreground"
                                                        : "bg-card border-border text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                {creativeBrief[fieldForTab(tab.id)] ? <Check className="h-4 w-4" /> : <tab.icon className="h-4 w-4" />}
                                                {tab.label}
                                            </button>
                                        ))}
                                    </div>
                                    {activeEmptyStateTab && <CreativeLibrary tab={activeEmptyStateTab} brief={creativeBrief} onSelect={selectCreativeAsset} />}
                                </div>
                                <div className="flex-1 min-h-0" />
                            </div>
                        )}
                    </div>

                    {/* Canvas Panel */}
                    {FEATURE_FLAGS.chatCanvas && (
                        <div className={cn("transition-all overflow-hidden h-full z-10 bg-card", isCanvasExpanded ? "w-full flex-1" : (isCanvasOpen ? "w-1/2 border-l border-border shadow-[-8px_0_24px_-16px_rgba(0,0,0,0.25)]" : "w-0"))}>
                            <Canvas key={conversationId ?? 'new'} isOpen={isCanvasOpen} isExpanded={isCanvasExpanded} onExpand={toggleExpand} onCloseCanvas={toggleCanvas} onActivity={noopActivity} tenantSlug={tenantSlug} flushPending={flushPending} agentId={selectedConversation?.agentId ?? selectedConversation?.agent?.id ?? activeAgents[0]?.id} conversationId={conversationId ?? ''} />
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
