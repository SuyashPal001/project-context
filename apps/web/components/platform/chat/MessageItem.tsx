'use client';

import { useState } from "react";
import { Terminal, Info, Image as ImageIcon } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Message, PlanResult } from "./types";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallCard } from "./ToolCallCard";
import { TraceSummary } from "./TraceSummary";
import { ApprovalCard } from "./ApprovalCard";
import { ClarificationCard } from "./ClarificationCard";
import { StreamingMessage } from "./StreamingMessage";
import { MessageFeedback } from "./MessageFeedback";
import { PlanCard } from "./PlanCard";
import { ChatArtifactCard } from "../canvas/ChatArtifactCard";
import { InlineAttachmentCard } from "./InlineAttachmentCard";

interface MessageItemProps {
    message: Message;
    freshUrls: Record<string, string>;
    isFirstInSequence?: boolean;
    isNewExchange?: boolean;
    onApprove?: (messageId: string, approvalId: string) => void;
    onDismiss?: (messageId: string, approvalId: string) => void;
    onClarificationAnswer?: (messageId: string, clarificationId: string, questionIndex: number, answer: { selectedIndex?: number; freeText?: string; skipped?: boolean }, allAnswered?: boolean) => void;
    creatingPlanId: string | null;
    planErrors: Record<string, string>;
    onCreateInSystem: (messageId: string, planResult: PlanResult) => Promise<void>;
}

export function MessageItem({
    message,
    freshUrls,
    isFirstInSequence,
    isNewExchange,
    onApprove,
    onDismiss,
    onClarificationAnswer,
    creatingPlanId,
    planErrors,
    onCreateInSystem,
}: MessageItemProps) {
    const isAssistant = message.role === 'assistant';
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system' || message.role === 'tool';

    const [userExpanded, setUserExpanded] = useState(false);
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
            "flex items-start gap-4 group/msg",
            isUser ? "flex-row-reverse" : "flex-row",
            isNewExchange && "mt-6"
        )}>
            {isAssistant && <AgentOrb size={40} state="idle" />}

            <div className={cn(
                "flex flex-col gap-1 flex-1",
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

                {isAssistant && !message.isStreaming && message.completedTrace && (
                    <TraceSummary
                        elapsedSec={message.completedTrace.elapsedSec}
                        toolCalls={message.completedTrace.toolCalls ?? []}
                        reasoningText={message.completedTrace.reasoningText}
                    />
                )}

                {(markdownContent.trim() || (isAssistant && message.isStreaming)) && (
                    <div
                        className={cn(
                            "text-sm",
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
                                components={{
                                    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                                    ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1">{children}</ul>,
                                    ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1">{children}</ol>,
                                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                                    pre: ({ children }) => <pre className="bg-muted p-4 rounded-lg overflow-x-auto mb-3 text-sm font-mono">{children}</pre>,
                                    code: ({ className, children, ...props }: any) => !className
                                        ? <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
                                        : <code className={className} {...props}>{children}</code>,
                                    h1: ({ children }) => <h1 className="font-semibold mb-2 mt-4 text-lg">{children}</h1>,
                                    h2: ({ children }) => <h2 className="font-semibold mb-2 mt-4 text-base">{children}</h2>,
                                    h3: ({ children }) => <h3 className="font-semibold mb-2 mt-4 text-sm">{children}</h3>,
                                    a: ({ href, children }) => <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                                    blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 italic mb-3">{children}</blockquote>,
                                }}
                            >
                                {markdownContent}
                            </ReactMarkdown>
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
                    <MessageFeedback messageId={message.id} conversationId={message.conversationId} />
                )}

                {isAssistant && (
                    <span className="text-[11px] text-muted-foreground/60 px-1 mt-1">
                        {format(new Date(message.createdAt), 'h:mm a')}
                    </span>
                )}
            </div>
        </div>
    );
}
