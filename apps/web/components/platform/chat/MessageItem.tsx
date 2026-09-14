'use client';

import { useState, useRef } from "react";
import { Terminal, Info, RotateCcw, Pencil, Check, X } from "lucide-react";
import { ClarificationRequest, Message, MessagePart, PlanResult, ToolCall, CompletedToolCall, UploadRequest } from "./types";
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
import { UploadRequestCard } from "./UploadRequestCard";
import { StreamingMessage } from "./StreamingMessage";
import { MessageFeedback } from "./MessageFeedback";
import { PlanCard } from "./PlanCard";
import { ChatArtifactCard } from "../canvas/ChatArtifactCard";
import { GeneratedAssetCard } from "./GeneratedAssetCard";
import { CitationStrip } from "./CitationStrip";
import { FollowUpChips } from "./FollowUpChips";
import { SkillIcon } from "@/components/platform/skills/SkillIcon";

// Whether this message renders anything at all — mirrors the same criteria
// MessageItem uses internally (see hasDisplayedContent below), but exported
// so MessageThread can skip empty placeholder messages (approval/
// clarification/generation-confirm) when computing which message is
// "first in sequence" for avatar purposes. Without that, a hidden
// placeholder still eats the first-in-sequence slot and the real reply
// right after it renders a spacer instead of its own avatar.
export function messageHasDisplayedContent(message: Message): boolean {
    const content = message.planResult ? message.planResult.summary : message.content;
    return Boolean(
        content.trim() ||
        message.isStreaming ||
        message.artifactRef ||
        message.planResult ||
        (message.toolCalls && message.toolCalls.length > 0) ||
        (message.clarificationRequests ?? []).some(r => r.status !== 'pending') ||
        (message.uploadRequests ?? []).some(r => r.status !== 'pending')
    );
}

interface MessageItemProps {
    message: Message;
    freshUrls: Record<string, string>;
    isFirstInSequence?: boolean;
    isNewExchange?: boolean;
    onApprove?: (messageId: string, approvalId: string) => void;
    onDismiss?: (messageId: string, approvalId: string) => void;
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean }, allAnswered?: boolean) => void;
    onUploadAnswer?: (messageId: string, uploadId: string, answer: { files: { fileId: string; name: string; type: string }[]; freeText?: string; skipped?: boolean }) => Promise<boolean>;
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
    /** Shown in place of the generic "Assistant" label — e.g. "Producer". */
    agentName?: string | null;
}

export function MessageItem({
    message,
    freshUrls,
    isFirstInSequence,
    isNewExchange,
    onApprove,
    onDismiss,
    onClarificationAnswer,
    onUploadAnswer,
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
    agentName,
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

    // Approval/clarification/generation-confirm-required events each push an
    // empty-content placeholder message into history (see useChatStream's
    // onApprovalRequired / onClarificationRequired / onGenerationConfirmRequired)
    // that never gets real text — ApprovalCard is disabled entirely,
    // ClarificationCard only renders once resolved, and generationConfirmRequest
    // never renders inline at all (its UI is MessageThread's overlay). Without
    // this guard, that empty placeholder still renders its own full "ASSISTANT"
    // label + avatar row with nothing under it, stacked above the real reply
    // (or above ThinkingIndicator's own avatar while the real reply is still
    // streaming) — two avatars for one turn.
    const hasDisplayedContent = messageHasDisplayedContent(message);

    // Ordered arrival-order render (see MessagePart in types.ts). When a turn
    // carries parts, its text/clarification/upload pieces render in the order
    // they were received rather than in the fixed template slots below, which
    // is the only way a clarification answered mid-turn can sit between the
    // text that preceded it and the text that followed. planResult turns
    // render their own summary instead of the streamed text, so they stay on
    // the legacy path (useChatStream's onDone drops their parts).
    const parts: MessagePart[] | undefined = isAssistant && !message.planResult ? message.parts : undefined;
    const hasParts = !!parts && parts.length > 0;

    // One card per request ROUND — a turn can ask several times (see
    // Message.clarificationRequests), and each round's card is placed either by
    // the parts list (in arrival order, matched on its own id) or by the legacy
    // fixed slots at the bottom — never both.
    // Pending requests render as a panel-wide takeover overlay (see
    // MessageThread) instead of inline, which is why they're skipped here.
    const renderClarificationCard = (request: ClarificationRequest) => request.status === 'pending' ? null : (
        <ClarificationCard
            request={request}
            onAnswer={(answer, allAnswered) => onClarificationAnswer?.(
                message.id,
                request.id,
                answer.questionIndex,
                { selectedIndex: answer.selectedIndex, selectedIndices: answer.selectedIndices, freeText: answer.freeText, skipped: answer.skipped },
                allAnswered,
            ) ?? Promise.resolve(true)}
        />
    );

    const renderUploadCard = (request: UploadRequest) => request.status === 'pending' ? null : (
        <UploadRequestCard
            request={request}
            onAnswer={(answer) => onUploadAnswer?.(
                message.id,
                request.id,
                answer,
            ) ?? Promise.resolve(true)}
        />
    );

    // Nothing to show for this row at all — skip it entirely rather than
    // rendering an empty avatar+label block. Only applies to assistant
    // placeholders; a genuinely empty user message can't happen (the
    // composer won't send one).
    if (isAssistant && !hasDisplayedContent) return null;

    return (
        <div id={`message-${message.id}`} className={cn(
            "flex flex-col gap-1 group/msg min-w-0",
            isUser ? "items-end max-w-[75%] ml-auto" : "items-start w-full",
            isNewExchange && "mt-6"
        )}>
                {isFirstInSequence && (
                    <span className="flex items-center gap-2 text-[10px] font-mono tracking-[0.08em] text-muted-foreground/80 uppercase select-none mb-1">
                        <span className="text-xs font-bold text-foreground/90">{isUser ? 'You' : (agentName || 'Assistant')}</span>
                        <span className="normal-case tracking-normal text-muted-foreground/60">
                            {format(new Date(message.createdAt), 'h:mm a')}
                        </span>
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

                {hasParts ? (
                    <div className="w-full flex flex-col gap-2 min-w-0">
                        {parts!.map((part, i) => {
                            if (part.type === 'text') {
                                // The last text part of a still-streaming turn is the
                                // open one — it keeps StreamingMessage's live cursor
                                // and auto-scroll; earlier, closed parts are static.
                                const isOpen = !!message.isStreaming && i === parts!.length - 1;
                                if (!part.text.trim() && !isOpen) return null;
                                return (
                                    <div key={part.seq} className="text-sm relative min-w-0 break-words text-foreground/90 leading-[1.75] w-full">
                                        {isOpen ? (
                                            <StreamingMessage isStreaming content={part.text} />
                                        ) : (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
                                                {part.text}
                                            </ReactMarkdown>
                                        )}
                                    </div>
                                );
                            }
                            // Request parts hold only the id — the request objects live
                            // on the message (that's what the answer handlers mutate),
                            // one entry per round, so each part resolves its OWN round
                            // by id and a part matching no entry renders nothing.
                            if (part.type === 'clarification') {
                                const request = message.clarificationRequests?.find(r => r.id === part.clarificationId);
                                return request
                                    ? <div key={part.seq} className="w-full">{renderClarificationCard(request)}</div>
                                    : null;
                            }
                            if (part.type === 'upload') {
                                const request = message.uploadRequests?.find(r => r.id === part.uploadId);
                                return request
                                    ? <div key={part.seq} className="w-full">{renderUploadCard(request)}</div>
                                    : null;
                            }
                            return null;
                        })}
                    </div>
                ) : isUser && isEditing ? (
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
                                ? "px-4 py-2.5 bg-muted border border-border/50 text-foreground leading-[1.55]"
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

                {message.skillsUsed && message.skillsUsed.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-1.5 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {message.skillsUsed.map(skill => (
                            <div key={skill.id} className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-secondary border border-border text-xs w-fit">
                                <SkillIcon seed={skill.id} className="h-5 w-5 rounded-full shrink-0" />
                                <span className="font-medium text-foreground truncate max-w-[160px]">{skill.name}</span>
                            </div>
                        ))}
                    </div>
                )}

                {message.attachments && message.attachments.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-2 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {message.attachments.map((file, index) => {
                            const url = (file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null;
                            return <GeneratedAssetCard key={file.id ?? `att-${index}`} file={file} url={url} createdAt={message.createdAt} />;
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

                {/* Fixed-slot fallback for messages with no part list (a message
                    reloaded from the server, or one whose parts couldn't be
                    reconciled). When parts exist these same cards are placed by
                    the parts list above, at the point they were received. */}
                {!hasParts && (message.clarificationRequests ?? []).map(request => (
                    <div key={request.id} className="w-full">{renderClarificationCard(request)}</div>
                ))}
                {!hasParts && (message.uploadRequests ?? []).map(request => (
                    <div key={request.id} className="w-full">{renderUploadCard(request)}</div>
                ))}

                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="w-full mt-2">
                        {message.toolCalls.map(tool => (
                            <ToolCallCard
                                key={tool.id}
                                toolName={tool.toolName}
                                query={String(tool.arguments?.query ?? tool.arguments?.filename ?? tool.arguments?.subject ?? tool.arguments?.task ?? '')}
                                status={tool.isLoading ? 'loading' : 'done'}
                            />
                        ))}
                    </div>
                )}

                {isAssistant && !message.isStreaming && hasDisplayedContent && (
                    <MessageFeedback messageId={message.id} conversationId={message.conversationId} content={message.content} />
                )}

                {isAssistant && hasDisplayedContent && isLastMessage && !message.isStreaming && !isStreaming && onRegenerate && (
                    <div className="flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                        <button
                            type="button"
                            onClick={() => onRegenerate(message)}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground px-1 mt-1"
                            title="Regenerate response"
                        >
                            <RotateCcw className="h-3 w-3" />
                            <span>Regenerate</span>
                        </button>
                    </div>
                )}
        </div>
    );
}
