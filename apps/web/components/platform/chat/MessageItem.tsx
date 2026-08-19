'use client';

import { useState, useRef } from "react";
import { Terminal, Info, Image as ImageIcon, RotateCcw, Pencil, Check, X } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Message, PlanResult, ToolCall, CompletedToolCall } from "./types";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatMarkdownComponents } from './markdownComponents';
import { ToolCallCard } from "./ToolCallCard";
import { TraceSummary } from "./TraceSummary";
import { LiveTrace } from "./ThinkingIndicator";
import { ApprovalCard } from "./ApprovalCard";
import { ClarificationCard } from "./ClarificationCard";
import { StreamingMessage } from "./StreamingMessage";
import { MessageFeedback } from "./MessageFeedback";
import { PlanCard } from "./PlanCard";
import { ChatArtifactCard } from "../canvas/ChatArtifactCard";
import { InlineAttachmentCard } from "./InlineAttachmentCard";
import { CitationStrip } from "./CitationStrip";
import { FollowUpChips } from "./FollowUpChips";

interface MessageItemProps {
    message: Message;
    freshUrls: Record<string, string>;
    isFirstInSequence?: boolean;
    // True only for the single first assistant message in the whole
    // conversation — this is what actually gates the orb avatar. Distinct
    // from isFirstInSequence (which still gates the "Assistant" label and
    // exchange spacing), since the orb should show once per conversation,
    // not once per reply-turn.
    isFirstAssistantMessage?: boolean;
    isNewExchange?: boolean;
    onApprove?: (messageId: string, approvalId: string) => void;
    onDismiss?: (messageId: string, approvalId: string) => void;
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }, allAnswered?: boolean) => void;
    creatingPlanId: string | null;
    planErrors: Record<string, string>;
    onCreateInSystem: (messageId: string, planResult: PlanResult) => Promise<void>;
    // Only ever set for the one message currently being streamed into (see
    // MessageThread) — powers the live "Working for Ns / tool calls /
    // reasoning" display inside this row, above the text, instead of as a
    // trailing element after the whole message list.
    activeToolCalls?: ToolCall[];
    completedToolCalls?: CompletedToolCall[];
    liveReasoningText?: string;
    onFollowUpSelect?: (text: string) => void;
    onRegenerate?: (message: Message) => void;
    onEditAndResubmit?: (message: Message, newContent: string) => void;
    isLastMessage?: boolean;
    isStreaming?: boolean;
}

export function MessageItem({
    message,
    freshUrls,
    isFirstInSequence,
    isFirstAssistantMessage,
    isNewExchange,
    onApprove,
    onDismiss,
    onClarificationAnswer,
    creatingPlanId,
    planErrors,
    onCreateInSystem,
    activeToolCalls,
    completedToolCalls,
    liveReasoningText,
    onFollowUpSelect,
    onRegenerate,
    onEditAndResubmit,
    isLastMessage,
    isStreaming,
}: MessageItemProps) {
    const isAssistant = message.role === 'assistant';
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system' || message.role === 'tool';

    const [userExpanded, setUserExpanded] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const editTextareaRef = useRef<HTMLTextAreaElement>(null);
    const USER_TRUNCATE_LEN = 280;
    const isLongUserMessage = isUser && message.content.length > USER_TRUNCATE_LEN;
    const displayedUserContent = isLongUserMessage && !userExpanded
        ? message.content.slice(0, USER_TRUNCATE_LEN) + '…'
        : message.content;

    if (isSystem) {
        return (
            <div className="flex justify-center my-4">
                <div className="bg-muted px-3 py-1 rounded-full text-[10px] flex items-center gap-2 text-muted-foreground uppercase tracking-wider font-semibold">
                    {message.role === 'tool' ? <Terminal className="h-3 w-3" /> : <Info className="h-3 w-3" />}
                    {message.role}: {message.content}
                </div>
            </div>
        );
    }

    const markdownContent = isAssistant && message.planResult
        ? message.planResult.summary
        : isUser ? displayedUserContent : message.content;

    return (
        <div id={`message-${message.id}`} className={cn(
            "flex items-start gap-4 group/msg min-w-0",
            isUser ? "flex-row-reverse" : "flex-row",
            isNewExchange && "mt-6"
        )}>
            {isAssistant && (
                isFirstAssistantMessage
                    ? <AgentOrb size={40} state="idle" />
                    // Same-width empty spacer for every other assistant message, so the
                    // text column still lines up under the very first message's avatar
                    // instead of every later reply re-rendering its own icon.
                    : <div className="w-10 shrink-0" />
            )}

            <div className={cn(
                "flex flex-col gap-1 flex-1 min-w-0",
                isUser ? "items-end max-w-[75%]" : "items-start w-full"
            )}>
                {isAssistant && isFirstInSequence && (
                    <span className="text-[10px] font-mono tracking-[0.08em] text-muted-foreground/50 uppercase select-none mb-1 block">
                        Assistant
                    </span>
                )}

                {isAssistant && message.artifactRef && (
                    <ChatArtifactCard {...message.artifactRef} />
                )}

                {isAssistant && message.planResult && (
                    <PlanCard
                        data={message.planResult}
                        onCreateInSystem={() => onCreateInSystem(message.id, message.planResult!)}
                        isCreating={creatingPlanId === message.id}
                        errorMessage={planErrors[message.id]}
                    />
                )}

                {isAssistant && message.isStreaming && (activeToolCalls?.length || completedToolCalls?.length || liveReasoningText) ? (
                    <LiveTrace
                        isStreaming
                        activeToolCalls={activeToolCalls ?? []}
                        completedToolCalls={completedToolCalls ?? []}
                        reasoningText={liveReasoningText}
                    />
                ) : isAssistant && !message.isStreaming && message.completedTrace && (
                    <TraceSummary
                        elapsedSec={message.completedTrace.elapsedSec}
                        toolCalls={message.completedTrace.toolCalls ?? []}
                        reasoningText={message.completedTrace.reasoningText}
                        reasoningElapsedSec={message.completedTrace.reasoningElapsedSec}
                    />
                )}

                {isUser && isEditing ? (
                    <div className="w-full flex flex-col gap-2" style={{ maxWidth: '75%' }}>
                        <textarea
                            ref={editTextareaRef}
                            value={editContent}
                            onChange={e => setEditContent(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (editContent.trim()) {
                                        onEditAndResubmit?.(message, editContent.trim());
                                        setIsEditing(false);
                                    }
                                }
                                if (e.key === 'Escape') setIsEditing(false);
                            }}
                            className="w-full px-4 py-3 text-sm rounded-xl border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                            rows={3}
                            autoFocus
                        />
                        <div className="flex gap-2 justify-end">
                            <button
                                type="button"
                                onClick={() => setIsEditing(false)}
                                className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
                            >
                                <X className="h-3 w-3" /> Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (editContent.trim()) {
                                        onEditAndResubmit?.(message, editContent.trim());
                                        setIsEditing(false);
                                    }
                                }}
                                className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                <Check className="h-3 w-3" /> Send
                            </button>
                        </div>
                    </div>
                ) : (markdownContent.trim() || (isAssistant && message.isStreaming)) && (
                    <div
                        className={cn(
                            "text-sm relative min-w-0 break-words",
                            isUser
                                ? "px-5 py-4 bg-muted border border-border/50 text-foreground leading-[1.55]"
                                : "text-foreground/90 leading-[1.75] w-full"
                        )}
                        style={isUser ? { borderRadius: '18px 18px 4px 18px' } : undefined}
                    >
                        {isAssistant && message.isStreaming ? (
                            <StreamingMessage
                                isStreaming={true}
                                content={message.content}
                            />
                        ) : (
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={chatMarkdownComponents}
                            >
                                {markdownContent}
                            </ReactMarkdown>
                        )}
                        {isUser && !isStreaming && onEditAndResubmit && (
                            <button
                                type="button"
                                onClick={() => { setEditContent(message.content); setIsEditing(true); }}
                                className="absolute -top-2 -left-8 opacity-0 group-hover/msg:opacity-100 transition-opacity p-1.5 rounded-full hover:bg-muted text-muted-foreground/60 hover:text-foreground"
                                title="Edit message"
                            >
                                <Pencil className="h-3 w-3" />
                            </button>
                        )}
                        {isLongUserMessage && (
                            <button
                                type="button"
                                onClick={() => setUserExpanded(e => !e)}
                                className="text-xs text-muted-foreground hover:text-foreground underline mt-1"
                            >
                                {userExpanded ? 'Show less' : 'Show more'}
                            </button>
                        )}
                    </div>
                )}

                {isAssistant && !message.isStreaming && message.citations && message.citations.length > 0 && (
                    <CitationStrip citations={message.citations} />
                )}

                {isAssistant && !message.isStreaming && isLastMessage && message.suggestedFollowUps && message.suggestedFollowUps.length > 0 && onFollowUpSelect && (
                    <FollowUpChips suggestions={message.suggestedFollowUps} onSelect={onFollowUpSelect} />
                )}

                {message.attachments && message.attachments.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-2 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {message.attachments.map((file, index) => {
                            const url = (file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null;
                            return <InlineAttachmentCard key={file.id ?? `att-${index}`} file={file} url={url} />;
                        })}
                    </div>
                )}

                {false && message.approvalRequest && (
                    <ApprovalCard
                        request={message.approvalRequest!}
                        onApprove={() => onApprove?.(message.id, message.approvalRequest!.id)}
                        onDismiss={() => onDismiss?.(message.id, message.approvalRequest!.id)}
                    />
                )}

                {/* Pending clarification requests render as a panel-wide takeover overlay
                    (see MessageThread) instead of inline here — only the resolved
                    "N answer(s)" summary stays in the normal message flow. */}
                {message.clarificationRequest && message.clarificationRequest.status !== 'pending' && (
                    <ClarificationCard
                        request={message.clarificationRequest}
                        onAnswer={(answer, allAnswered) => onClarificationAnswer?.(
                            message.id,
                            message.clarificationRequest!.id,
                            answer.questionIndex,
                            { selectedIndex: answer.selectedIndex, freeText: answer.freeText, skipped: answer.skipped },
                            allAnswered,
                        ) ?? Promise.resolve(true)}
                    />
                )}

                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="w-full mt-2">
                        {message.toolCalls.map(tool => (
                            <ToolCallCard
                                key={tool.id}
                                toolName={tool.toolName}
                                query={String(tool.arguments?.query ?? tool.arguments?.filename ?? tool.arguments?.subject ?? '')}
                                status={tool.isLoading ? 'loading' : 'done'}
                            />
                        ))}
                    </div>
                )}

                {isAssistant && !message.isStreaming && (
                    <MessageFeedback messageId={message.id} conversationId={message.conversationId} content={message.content} />
                )}

                {isAssistant && (
                    <div className="flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                        <span className="text-[11px] text-muted-foreground/60 px-1 mt-1">
                            {format(new Date(message.createdAt), 'h:mm a')}
                        </span>
                        {isLastMessage && !message.isStreaming && !isStreaming && onRegenerate && (
                            <button
                                type="button"
                                onClick={() => onRegenerate(message)}
                                className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground px-1 mt-1"
                                title="Regenerate response"
                            >
                                <RotateCcw className="h-3 w-3" />
                                <span>Regenerate</span>
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
