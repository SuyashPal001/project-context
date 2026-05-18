'use client'

import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskComment } from '@/types/task'
import { CommentEditor } from '@/components/editor/CommentEditor'
import { formatRelativeTime } from './_sidebarHelpers'
import { AgentCommentBody } from './AgentCommentBody'

interface ThreadTabProps {
    taskId: string
    comments: TaskComment[]
    isPosting: boolean
    onSubmit: (html: string) => void
}

export function ThreadTab({ taskId, comments, isPosting, onSubmit }: ThreadTabProps) {
    return (
        <>
            {comments.length === 0 ? (
                <p className="text-sm text-muted-foreground/40 italic py-4">
                    No messages yet. Be the first to leave a note.
                </p>
            ) : (
                <div className="space-y-4 mb-6">
                    {comments.map(c => (
                        <div
                            key={c.id}
                            className={cn(
                                'flex items-start gap-3',
                                c.authorType === 'agent' && 'pl-3 border-l-2 border-primary/20',
                            )}
                        >
                            {c.authorType === 'agent' ? (
                                <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                                    <Bot className="w-3.5 h-3.5 text-primary" />
                                </div>
                            ) : (
                                <div className="w-7 h-7 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center flex-shrink-0 text-[10px] font-semibold text-foreground">
                                    {(c.authorName ?? 'U').charAt(0).toUpperCase()}
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-medium text-foreground">{c.authorName ?? 'Unknown'}</span>
                                    <span className="text-[10px] text-muted-foreground/50">
                                        {formatRelativeTime(c.createdAt)} ago
                                    </span>
                                </div>
                                <div
                                    className={cn(
                                        'text-sm text-foreground/80 leading-relaxed rounded-lg px-3 py-2',
                                        c.authorType === 'agent'
                                            ? 'bg-primary/5 border border-primary/10'
                                            : 'bg-[#161616] border border-[#1e1e1e]',
                                    )}
                                >
                                    {c.authorType === 'agent' ? (
                                        <AgentCommentBody content={c.content} />
                                    ) : c.contentHtml ? (
                                        <div
                                            className="prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-ul:my-0.5 prose-ol:my-0.5 [&_.mention]:bg-primary/10 [&_.mention]:text-primary [&_.mention]:rounded [&_.mention]:px-1 [&_.mention]:py-0.5 [&_.mention]:text-xs"
                                            dangerouslySetInnerHTML={{ __html: c.contentHtml }}
                                        />
                                    ) : (
                                        <p className="whitespace-pre-wrap">{c.content}</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex items-start gap-3 pt-4 border-t border-[#1e1e1e]">
                <div className="w-7 h-7 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center flex-shrink-0 text-[10px] font-semibold text-foreground mt-6">
                    U
                </div>
                <CommentEditor
                    taskId={taskId}
                    onSubmit={onSubmit}
                    isPending={isPosting}
                />
            </div>
        </>
    )
}
