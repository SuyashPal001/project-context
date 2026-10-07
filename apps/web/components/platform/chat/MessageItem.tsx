'use client';

import { useState, useRef } from "react";
import { Terminal, Info, Pencil, Check, X } from "lucide-react";
import { ClarificationRequest, LiveStep, Message, MessageAttachment, MessagePart, PlanResult, ToolCall, CompletedToolCall, UploadRequest } from "./types";
import { useThumbnailUrl } from "@/hooks/useAssetThumbnail";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatMarkdownComponents } from './markdownComponents';
import { ToolCallCard, groupImageToolCalls, extractResultFiles } from "./ToolCallCard";
import { TraceSummary } from "./TraceSummary";
import { withMediaFiles, withoutStepOwned } from "./StepList";
import { LiveTrace } from "./ThinkingIndicator";
import { ApprovalCard } from "./ApprovalCard";
import { ClarificationCard } from "./ClarificationCard";
import { UploadRequestCard } from "./UploadRequestCard";
import { StreamingMessage } from "./StreamingMessage";
import { MessageFeedback } from "./MessageFeedback";
import { PlanCard } from "./PlanCard";
import { ChatArtifactCard } from "../canvas/ChatArtifactCard";
import { GeneratedAssetCard } from "./GeneratedAssetCard";
import { assetTypeForFile } from "@/lib/assetType";
import { TYPE_ICONS, TYPE_STYLES, typeBadge } from "@/components/platform/canvas/assetTypeStyles";
import { FollowUpChips } from "./FollowUpChips";
import { SkillIcon } from "@/components/platform/skills/SkillIcon";
import { CreativeBriefChips } from "./creative-library/CreativeBriefChips";
import { creativeBriefAttachmentIds, parseCreativeBriefPresentation } from "./creative-library/creativeBrief";

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
        // A part of a turn where the Director worked without Olmo writing
        // anything still has its steps and the stills or clip it made
        // (see useChatStream onTurnPause); it was hidden as empty (2026-10-07).
        !!message.completedTrace ||
        (message.attachments ?? []).length > 0 ||
        (message.clarificationRequests ?? []).some(r => r.status !== 'pending') ||
        (!!message.generationConfirmRequest && message.generationConfirmRequest.status !== 'pending') ||
        (message.uploadRequests ?? []).some(r => r.status !== 'pending')
    );
}

/** A row that is only a question card the user has already answered or decided. */
export function isAnsweredQuestionRow(message: Message): boolean {
    if (message.role !== 'assistant' || message.content.trim() || message.completedTrace || (message.attachments ?? []).length > 0) return false;
    const asks = message.clarificationRequests ?? [];
    const uploads = message.uploadRequests ?? [];
    const cost = message.generationConfirmRequest;
    if (asks.length === 0 && uploads.length === 0 && !cost) return false;
    const settled = (s: string) => s === 'answered' || s === 'skipped' || s === 'approved' || s === 'declined';
    return asks.every(r => settled(r.status)) && uploads.every(r => settled(r.status)) && (!cost || settled(cost.status));
}

/** What a settled question row asked: its questions, or what it asked to upload. */
export function askedPrompts(message: Message): string[] {
    return [
        ...(message.clarificationRequests ?? []).filter(r => r.status !== 'pending').flatMap(r => r.questions.map(q => q.prompt)),
        ...(message.uploadRequests ?? []).filter(r => r.status !== 'pending').map(r => r.prompt),
    ].filter(p => p.trim());
}

/**
 * An answered question, kept in the chat as one line, in reply text, under the part
 * that asked it; the user's answer is their own message below. While it
 * waits, the question is on the card at the composer (2026-10-07: hidden
 * outright, a part that only asked read as Olmo saying nothing).
 */
export function AskedLine({ prompts }: { prompts: string[] }) {
    if (prompts.length === 0) return null;
    return (
        <div className="flex flex-col gap-0.5 pl-4 text-[15px] leading-relaxed text-foreground [overflow-wrap:anywhere]" data-testid="asked-line">
            {prompts.map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
        </div>
    );
}

interface MessageItemProps {
    message: Message;
    freshUrls: Record<string, string>;
    isFirstInSequence?: boolean;
    isNewExchange?: boolean;
    /** The user's answer is the next message: answered cards show only their question. */
    answerShownBelow?: boolean;
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
    /** Live step list for the turn still streaming. */
    liveSteps?: LiveStep[];
    liveReasoningText?: string;
    /** See CompletedTrace.afterSeq — live value while this message streams. */
    liveTraceAfterSeq?: number;
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
    answerShownBelow,
    onApprove,
    onDismiss,
    onClarificationAnswer,
    onUploadAnswer,
    creatingPlanId,
    planErrors,
    onCreateInSystem,
    activeToolCalls,
    completedToolCalls,
    liveSteps,
    liveReasoningText,
    liveTraceAfterSeq,
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
    const creativePresentation = isUser ? parseCreativeBriefPresentation(message.content) : null;
    const userContent = creativePresentation?.direction ?? message.content;
    const hiddenCreativeAttachmentIds = creativePresentation ? creativeBriefAttachmentIds(creativePresentation.brief) : new Set<string>();
    // A file the trace above already shows (a show_files of a generated still
    // and its close-up, in that order) is not repeated as an attachment below
    // it, so the full still reads first and the close-up second.
    // A picture shown as a small tile under its step is still the part's
    // output: it also gets its big card after the reply, like a finished
    // piece of work handed over (2026-10-07). Only a file the trace shows as a
    // card of its own is left out here.
    const traceSteps = withMediaFiles(message.completedTrace?.steps, message.completedTrace?.toolCalls ?? []);
    const traceFileIds = new Set(withoutStepOwned(message.completedTrace?.toolCalls ?? [], traceSteps).flatMap(tc => extractResultFiles(tc.toolName, tc.result)).map(f => f.fileId));
    const visibleAttachments = message.attachments?.filter(file => !file.fileId || (!hiddenCreativeAttachmentIds.has(file.fileId) && !traceFileIds.has(file.fileId)));
    // Working files (inputs to a later step this turn) fold behind one row, so
    // the finished result is what the reply shows (see workingFiles.ts).
    const resultAttachments = (visibleAttachments ?? []).filter(file => !file.working);
    // Once the turn has a finished video, the pictures and clips shown along
    // the way fold too.
    const hasFinalVideo = resultAttachments.some(file => file.type.startsWith('video/'));

    const [userExpanded, setUserExpanded] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const editTextareaRef = useRef<HTMLTextAreaElement>(null);
    const USER_TRUNCATE_LEN = 280;
    const isLongUserMessage = isUser && userContent.length > USER_TRUNCATE_LEN;
    const displayedUserContent = isLongUserMessage && !userExpanded
        ? userContent.slice(0, USER_TRUNCATE_LEN) + '…'
        : userContent;

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

    // Where the trace (tool rows / reasoning) sits among the text parts, so text
    // written BEFORE the first tool call renders above it instead of below.
    // See CompletedTrace.afterSeq. Undefined = no split (trace first, as before).
    const traceAnchor = message.isStreaming ? liveTraceAfterSeq : message.completedTrace?.afterSeq;

    const renderPart = (part: MessagePart, i: number) => {
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
    };


    // One card per request ROUND — a turn can ask several times (see
    // Message.clarificationRequests), and each round's card is placed either by
    // the parts list (in arrival order, matched on its own id) or by the legacy
    // fixed slots at the bottom — never both.
    // Pending requests render as a panel-wide takeover overlay (see
    // MessageThread) instead of inline, which is why they're skipped here.
    // Answered, with the answer as the next message: only the question stays,
    // as one line; the full card again read as asking twice (2026-10-07).
    const renderClarificationCard = (request: ClarificationRequest) => request.status === 'pending' ? null : answerShownBelow && (request.status === 'answered' || request.status === 'skipped') ? (
        <AskedLine prompts={request.questions.map(q => q.prompt).filter(p => p.trim())} />
    ) : (
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

                {hasParts && traceAnchor !== undefined && parts!.some(p => p.seq <= traceAnchor) && (
                    <div className="w-full flex flex-col gap-2 min-w-0">
                        {parts!.map((part, i) => (part.seq <= traceAnchor ? renderPart(part, i) : null))}
                    </div>
                )}

                {isAssistant && message.isStreaming && (activeToolCalls?.length || completedToolCalls?.length || liveReasoningText) ? (
                    <LiveTrace
                        isStreaming
                        activeToolCalls={activeToolCalls ?? []}
                        completedToolCalls={completedToolCalls ?? []}
                        steps={liveSteps}
                        reasoningText={liveReasoningText}
                        freshUrls={freshUrls}
                    />
                ) : isAssistant && !message.isStreaming && message.completedTrace && (
                    <TraceSummary
                        foldMedia={hasFinalVideo}
                        made={{
                            pictures: (message.attachments ?? []).filter(f => f.generation && f.type.startsWith('image/')).length,
                            clips: (message.attachments ?? []).filter(f => f.generation && f.type.startsWith('video/')).length,
                        }}
                        steps={message.completedTrace.steps}
                        toolCallCount={message.completedTrace.toolCallCount}
                        partFiles={(message.attachments ?? []).filter(f => f.generation && !f.working && /^(image|video)\//.test(f.type))}
                        elapsedSec={message.completedTrace.elapsedSec}
                        toolCalls={message.completedTrace.toolCalls ?? []}
                        reasoningText={message.completedTrace.reasoningText}
                        reasoningElapsedSec={message.completedTrace.reasoningElapsedSec}
                        freshUrls={freshUrls}
                    />
                )}

                {hasParts ? (
                    <div className="w-full flex flex-col gap-2 min-w-0">
                        {parts!.map((part, i) => (traceAnchor !== undefined && part.seq <= traceAnchor ? null : renderPart(part, i)))}
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
                                onClick={() => { setEditContent(userContent); setIsEditing(true); }}
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

                {creativePresentation && (
                    <div className="mt-2 flex max-w-full justify-end">
                        <CreativeBriefChips brief={creativePresentation.brief} readOnly />
                    </div>
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

                {resultAttachments.length > 0 && (
                    <div className={cn(
                        "flex flex-wrap gap-2 mt-2",
                        isUser ? "justify-end" : "justify-start"
                    )}>
                        {resultAttachments.map((file, index) => (
                            <ResultFileCard key={file.id ?? `att-${index}`} file={file} url={(file.fileId ? freshUrls[file.fileId] : null) || file.previewUrl || null} createdAt={message.createdAt} />
                        ))}
                    </div>
                )}

                {/* Working files (inputs to a later step this turn) stay marked and
                    saved on the message, but are not shown under the reply: the
                    user sees the result here and the work inside "Worked for" (2026-10-07). */}

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

                {/* A decided cost card leaves its question in the chat; the
                    user's Approve / Cancel is the next message. */}
                {message.generationConfirmRequest && message.generationConfirmRequest.status !== 'pending' && !answerShownBelow && (
                    <p className="text-[15px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{/[.?!]$/.test(message.generationConfirmRequest.label.trim()) ? message.generationConfirmRequest.label : `${message.generationConfirmRequest.label.trim()}?`}</p>
                )}

                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="w-full mt-2">
                        {groupImageToolCalls(message.toolCalls).map((group, gi) => (
                            group.length > 1 ? (
                                <div key={gi} className="flex flex-col gap-2">
                                    {group.map(tool => (
                                        <ToolCallCard
                                            key={tool.id}
                                            toolName={tool.toolName}
                                            query={String((tool.toolName === 'skill' ? tool.arguments?.name : undefined) ?? tool.arguments?.query ?? tool.arguments?.filename ?? tool.arguments?.subject ?? tool.arguments?.task ?? '')}
                                            prompt={String(tool.arguments?.prompt ?? '')}
                                            status={tool.isLoading ? 'loading' : 'done'}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <ToolCallCard
                                    key={group[0].id}
                                    toolName={group[0].toolName}
                                    query={String((group[0].toolName === 'skill' ? group[0].arguments?.name : undefined) ?? group[0].arguments?.query ?? group[0].arguments?.filename ?? group[0].arguments?.subject ?? group[0].arguments?.task ?? '')}
                                    prompt={String(group[0].arguments?.prompt ?? '')}
                                    status={group[0].isLoading ? 'loading' : 'done'}
                                />
                            )
                        ))}
                    </div>
                )}

                {isAssistant && !message.isStreaming && hasDisplayedContent && (
                    <MessageFeedback
                        messageId={message.id}
                        conversationId={message.conversationId}
                        content={message.content}
                        citations={message.citations}
                        alwaysVisible={isLastMessage}
                        onRetry={isLastMessage && !isStreaming && onRegenerate ? () => onRegenerate(message) : undefined}
                    />
                )}

                {isAssistant && !message.isStreaming && isLastMessage && message.suggestedFollowUps && message.suggestedFollowUps.length > 0 && onFollowUpSelect && (
                    <FollowUpChips suggestions={message.suggestedFollowUps} onSelect={onFollowUpSelect} />
                )}
        </div>
    );
}

// The reply's own result loads its link through the shared thumbnail loader
// when the thread's bulk refresh has not supplied one (a final video showed
// only a placeholder after reload, 2026-10-06).
function ResultFileCard({ file, url, createdAt }: { file: MessageAttachment; url: string | null; createdAt: string }) {
    const loaded = useThumbnailUrl(file.fileId ?? '', !url && !!file.fileId);
    return <GeneratedAssetCard file={file} url={url ?? loaded ?? null} createdAt={createdAt} />;
}

