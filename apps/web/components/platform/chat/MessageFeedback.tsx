'use client';

import { useState } from "react";
import { ThumbsUp, ThumbsDown, Copy, Check, RotateCcw, FileText } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const FEEDBACK_ISSUE_OPTIONS = [
    'Incorrect information',
    'Incomplete answer',
    'Off topic',
    'Harmful or unsafe content',
    'Other',
] as const;

// One row under a reply: copy · retry · 👍 · 👎 · sources (after beautiful-ui's
// streaming text, 2026-10-07). Retry and sources show only when there are any.
export function MessageFeedback({ messageId, conversationId, content, onRetry, citations, alwaysVisible }: {
    messageId: string;
    conversationId: string;
    content?: string;
    onRetry?: () => void;
    citations?: Array<{ name: string; score: number }>;
    /** The latest reply keeps its row on screen; older ones show it on hover. */
    alwaysVisible?: boolean;
}) {
    const [rating, setRating] = useState<'up' | 'down' | null>(null);
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [issueType, setIssueType] = useState('');
    const [detail, setDetail] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!content) return;
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard permission denied or unavailable — no destructive fallback needed
        }
    };

    const submit = async (r: 'up' | 'down', comment?: string) => {
        setSubmitting(true);
        try {
            await api.post(`/api/v1/conversations/${conversationId}/messages/${messageId}/feedback`, {
                rating: r,
                ...(comment ? { comment } : {}),
            });
            setRating(r);
        } catch (err) {
            // Roll back the optimistic state — the click reacted but nothing saved,
            // so the button shouldn't stay lit as if it had.
            setRating(null);
            const message = err instanceof ApiError
                ? (err.data?.error ?? err.data?.message ?? `Feedback failed (${err.status})`)
                : "Feedback failed to save";
            toast.error(message);
        } finally {
            setSubmitting(false);
        }
    };

    const handleUp = () => {
        if (rating !== null || modalOpen) return;
        setRating('up');
        submit('up');
    };

    const handleDown = () => {
        if (rating !== null || modalOpen) return;
        setModalOpen(true);
    };

    const handleSubmit = () => {
        if (submitting) return;
        const parts = [issueType, detail.trim()].filter(Boolean);
        const comment = parts.join(' | ') || undefined;
        setModalOpen(false);
        setRating('down');
        submit('down', comment);
    };

    const handleCancel = () => {
        setModalOpen(false);
        setIssueType('');
        setDetail('');
    };

    const isRated = rating !== null;

    return (
        <div className="mt-1">
            <div className={cn("flex items-center gap-1 transition-opacity duration-150", !alwaysVisible && !sourcesOpen && "opacity-0 group-hover/msg:opacity-100")}>
                {content && (
                    <button
                        onClick={handleCopy}
                        className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground/50 hover:text-muted-foreground"
                        aria-label={copied ? "Copied" : "Copy message"}
                    >
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                )}
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground/50 hover:text-muted-foreground"
                        aria-label="Retry"
                        title="Retry"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                )}
                <button
                    onClick={handleUp}
                    disabled={isRated || modalOpen || submitting}
                    className={cn(
                        "p-1 rounded hover:bg-muted/50 transition-colors",
                        rating === 'up' ? "text-emerald-500" : "text-muted-foreground/50 hover:text-muted-foreground",
                        (isRated || modalOpen) && "cursor-default"
                    )}
                    aria-label="Thumbs up"
                >
                    <ThumbsUp className={cn("h-3.5 w-3.5", rating === 'up' && "fill-current")} />
                </button>
                <button
                    onClick={handleDown}
                    disabled={isRated || modalOpen || submitting}
                    className={cn(
                        "p-1 rounded hover:bg-muted/50 transition-colors",
                        rating === 'down' ? "text-red-500" : "text-muted-foreground/50 hover:text-muted-foreground",
                        (isRated || modalOpen) && "cursor-default"
                    )}
                    aria-label="Thumbs down"
                >
                    <ThumbsDown className={cn("h-3.5 w-3.5", rating === 'down' && "fill-current")} />
                </button>
                {!!citations?.length && (
                    <button
                        type="button"
                        onClick={() => setSourcesOpen(o => !o)}
                        aria-expanded={sourcesOpen}
                        className="ml-1.5 flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors"
                    >
                        <span className="flex -space-x-1">
                            {citations.slice(0, 3).map((_, i) => (
                                <span key={i} className="flex h-4 w-4 items-center justify-center rounded-full bg-muted ring-2 ring-background">
                                    <FileText className="h-2.5 w-2.5" />
                                </span>
                            ))}
                        </span>
                        <span>{citations.length} source{citations.length === 1 ? '' : 's'}</span>
                    </button>
                )}
            </div>
            {sourcesOpen && !!citations?.length && (
                <ul className="mt-1 flex flex-col gap-1 pl-1">
                    {citations.map((c, i) => (
                        <li key={i} className="flex items-center gap-2 text-[12.5px] text-muted-foreground" title={`Relevance: ${(c.score * 100).toFixed(0)}%`}>
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            <span className="truncate">{c.name}</span>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog open={modalOpen} onOpenChange={(open) => { if (!open) handleCancel(); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Give negative feedback</DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-sm text-muted-foreground">
                                What type of issue do you wish to report? (optional)
                            </label>
                            <select
                                value={issueType}
                                onChange={(e) => setIssueType(e.target.value)}
                                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                                <option value="">Select an issue type</option>
                                {FEEDBACK_ISSUE_OPTIONS.map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-sm text-muted-foreground">
                                Please provide details: (optional)
                            </label>
                            <textarea
                                value={detail}
                                onChange={(e) => setDetail(e.target.value.slice(0, 200))}
                                placeholder="What was unsatisfying about this response?"
                                rows={3}
                                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                        </div>
                    </div>

                    <DialogFooter className="gap-2 sm:gap-0">
                        <button
                            onClick={handleCancel}
                            className="px-4 py-2 text-sm rounded-md border border-border text-foreground hover:bg-muted/50 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={submitting}
                            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors font-medium"
                        >
                            Submit
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
