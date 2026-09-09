'use client';

// This is the canonical shell for "agent needs a decision from you, anchored
// to the bottom of the composer" — rounded-4xl card, numbered option row(s),
// a free-text field with auto-grow/Enter-to-submit/Escape-to-skip, and a
// Skip[ESC]/Submit(arrow) footer. @/components/platform/credits/ApproveCost.tsx
// (the 'card' variant) reuses this exact shell for the credits-approval
// decision. If you're building a new "agent is asking the user something"
// surface, extend one of these two rather than inventing a third visual
// pattern — see MessageThread.tsx for how both get mounted as the same kind
// of bottom-anchored overlay.

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, ChevronRight, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { ClarificationRequest, UploadedFileRef } from './types';
import { AttachmentStrip } from './AttachmentStrip';
import { uploadToS3, MAX_FILES_PER_SELECTION, MAX_ATTACHMENTS_PER_MESSAGE, PendingUpload } from './useFileUpload';
import { toast } from 'sonner';

interface ClarificationCardProps {
    request: ClarificationRequest;
    // Returns true on network success, false on failure. Second argument is
    // `allAnswered` — true only once EVERY question index has been
    // answered/skipped at least once, not merely "this was the last page".
    // Chevron nav lets the user jump straight to the last page and submit out
    // of order, so "last page" alone is not a safe signal that the backend's
    // full answer set is complete.
    onAnswer: (answer: { questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean; files?: { fileId: string; name: string; type: string }[] }, allAnswered: boolean) => Promise<boolean>;
}

export function ClarificationCard({ request, onAnswer }: ClarificationCardProps) {
    const [pageIndex, setPageIndex] = useState(0);
    const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, number>>({});
    const [freeTextByQuestion, setFreeTextByQuestion] = useState<Record<number, string>>({});
    // Which question indices have actually been submitted (via Continue/Submit
    // or Skip) at least once — independent of `pageIndex`, since free chevron
    // navigation means "on the last page" doesn't imply "every question has
    // been answered".
    const [answeredIndices, setAnsweredIndices] = useState<Set<number>>(new Set());
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [filesByQuestion, setFilesByQuestion] = useState<Record<number, UploadedFileRef[]>>(
        () => Object.fromEntries(Object.entries(request.answers ?? {}).map(([index, answer]) => [index, answer.files ?? []])),
    );
    const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const busyRef = useRef(false);
    const files = filesByQuestion[pageIndex] ?? [];
    const busy = isSubmitting || pendingUpload !== null;

    const addFiles = async (incoming: File[]) => {
        if (busyRef.current || !incoming.length) return;
        if (incoming.length > MAX_FILES_PER_SELECTION || files.length + incoming.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            toast.error(`Attach up to ${MAX_FILES_PER_SELECTION} files at once and ${MAX_ATTACHMENTS_PER_MESSAGE} per answer.`);
            return;
        }
        busyRef.current = true;
        try {
            for (const file of incoming) {
                const maxMB = file.type.startsWith('video/') ? 200 : 35;
                if (file.size > maxMB * 1024 * 1024) {
                    toast.error(`${file.name} is too large. Maximum size is ${maxMB}MB.`);
                    continue;
                }
                setPendingUpload({ name: file.name, type: file.type });
                try {
                    const type = file.type || 'application/octet-stream';
                    const fileId = await uploadToS3(file, file.name, type, file.size);
                    setFilesByQuestion(prev => ({ ...prev, [pageIndex]: [...(prev[pageIndex] ?? []), { fileId, name: file.name, type }] }));
                } catch {
                    toast.error(`Failed to upload ${file.name}. Please try again.`);
                }
            }
        } finally {
            setPendingUpload(null);
            busyRef.current = false;
        }
    };

    // Restore partial progress from server-persisted answers after a page reload.
    // Runs once on mount only — not on every answer update — so it only applies
    // to the reload case, not the live submission case.
    useEffect(() => {
        const entries = Object.entries(request.answers ?? {});
        if (entries.length === 0) return;
        const newSelected: Record<number, number> = {};
        const newFreeText: Record<number, string> = {};
        const newAnswered = new Set<number>();
        for (const [qiStr, a] of entries) {
            const qi = Number(qiStr);
            newAnswered.add(qi);
            if (a.selectedIndex !== undefined) newSelected[qi] = a.selectedIndex;
            if (a.freeText) newFreeText[qi] = a.freeText;
        }
        setSelectedByQuestion(newSelected);
        setFreeTextByQuestion(newFreeText);
        setAnsweredIndices(newAnswered);
        const firstUnanswered = request.questions.findIndex((_, i) => !newAnswered.has(i));
        if (firstUnanswered >= 0) setPageIndex(firstUnanswered);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-grow the free-text field to fit its content (up to a cap) instead of
    // staying a fixed single line that scrolls its text off-screen horizontally.
    const freeTextRef = useRef<HTMLTextAreaElement>(null);
    const currentFreeText = freeTextByQuestion[pageIndex] ?? '';
    useEffect(() => {
        if (freeTextRef.current) {
            freeTextRef.current.style.height = 'inherit';
            freeTextRef.current.style.height = `${Math.min(freeTextRef.current.scrollHeight, 160)}px`;
        }
    }, [currentFreeText]);

    if (request.status !== 'pending') {
        const total = request.questions.length;
        const answers = request.answers ?? {};
        return (
            <div className="flex w-full justify-center my-5">
                <div className="w-full max-w-3xl flex flex-col gap-4 rounded-4xl border border-border/60 bg-card shadow-elevated p-[14px]">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                            <path d="M9.5 9a2.5 2.5 0 0 1 4.83-.92c-.28.7-.77 1.1-1.33 1.5-.62.44-1 .8-1 1.67" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <circle cx="12" cy="16.25" r="0.75" fill="currentColor" />
                        </svg>
                        <span>{request.status === 'expired' ? 'Expired — the assistant moved on' : `${total} answer${total === 1 ? '' : 's'}`}</span>
                    </div>
                    <div className="border-t border-border/40" />
                    <div className="flex flex-col gap-4">
                        {request.questions.map((q, i) => {
                            const a = answers[i];
                            const answerText = a?.skipped || !a
                                ? 'Skipped'
                                : a.selectedIndex !== undefined
                                    ? q.options[a.selectedIndex]?.label ?? 'Skipped'
                                    : a.freeText || 'Skipped';
                            return (
                                <div key={i} className="flex flex-col gap-1.5">
                                    <div className="text-sm font-medium">{q.prompt}</div>
                                    <div className="text-sm text-muted-foreground">{a?.files?.length && answerText === 'Skipped' && !a.skipped ? 'Files attached' : answerText}</div>
                                    {!!a?.files?.length && <AttachmentStrip attachments={a.files} pendingUpload={null} onRemove={() => {}} readOnly />}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    }

    const total = request.questions.length;
    const question = request.questions[pageIndex];
    const selectedIndex = selectedByQuestion[pageIndex];
    const freeText = currentFreeText;
    const isLast = pageIndex === total - 1;

    // Check whether accepting `pageIndex` would complete the full
    // set. Computed synchronously (not from the setState updater) since the
    // caller needs the "is this submission the completing one" answer
    // immediately, before the async state update flushes.
    const wouldCompleteAnswers = () => {
        const next = new Set(answeredIndices);
        next.add(pageIndex);
        return next.size >= total;
    };

    const commitCurrent = async () => {
        if (busyRef.current || (selectedIndex === undefined && !freeText.trim() && !files.length)) return;
        const trimmedFreeText = freeText.trim();
        // Send whichever of selectedIndex/freeText are actually present — a user
        // can click an option AND add free text, and both should reach the
        // backend rather than one silently overwriting the other.
        const answer = {
            questionIndex: pageIndex,
            ...(files.length ? { files } : {}),
            ...(selectedIndex !== undefined ? { selectedIndex } : {}),
            ...(trimmedFreeText ? { freeText: trimmedFreeText } : {}),
        };
        const allAnswered = wouldCompleteAnswers();
        busyRef.current = true;
        setIsSubmitting(true);
        let ok = false;
        try { ok = await onAnswer(answer, allAnswered); }
        finally { setIsSubmitting(false); busyRef.current = false; }
        if (ok) setAnsweredIndices(prev => new Set([...prev, pageIndex]));
        // Only advance on network success — if the POST failed, the toast is
        // already shown by the caller and the user stays on this question to retry.
        if (ok && !isLast) setPageIndex(p => p + 1);
    };

    const handleSkip = async () => {
        if (busyRef.current || files.length) return;
        const allAnswered = wouldCompleteAnswers();
        busyRef.current = true;
        setIsSubmitting(true);
        let ok = false;
        try { ok = await onAnswer({ questionIndex: pageIndex, skipped: true }, allAnswered); }
        finally { setIsSubmitting(false); busyRef.current = false; }
        if (ok) setAnsweredIndices(prev => new Set([...prev, pageIndex]));
        if (ok && !isLast) setPageIndex(p => p + 1);
    };

    return (
        <div className="flex w-full justify-center my-5">
            <div className="w-full max-w-3xl flex flex-col gap-4 rounded-4xl border border-border/60 bg-card shadow-elevated p-[14px] animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">{question.prompt}</h4>
                    {total > 1 && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 ml-3">
                            <button
                                type="button"
                                aria-label="Previous question"
                                disabled={busy || pageIndex === 0}
                                onClick={() => setPageIndex(p => Math.max(0, p - 1))}
                                className="disabled:opacity-30"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <span>{pageIndex + 1}/{total}</span>
                            <button
                                type="button"
                                aria-label="Next question"
                                disabled={busy || pageIndex === total - 1}
                                onClick={() => setPageIndex(p => Math.min(total - 1, p + 1))}
                                className="disabled:opacity-30"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-1.5">
                    {question.options.map((opt, i) => (
                        <button
                            key={opt.label}
                            type="button"
                            onClick={() => setSelectedByQuestion(prev => ({ ...prev, [pageIndex]: i }))}
                            className={cn(
                                "w-full text-left rounded-xl px-3 py-2.5 border transition-colors",
                                // bg-muted and bg-card are the same literal color in dark mode
                                // (see globals.css) — bg-muted/* over bg-card is invisible at any
                                // opacity. bg-accent is this codebase's actual "neutral hover/active"
                                // token and is a genuinely different lightness value.
                                selectedIndex === i
                                    ? "border-primary/40 bg-primary/5"
                                    : i === 0 && selectedIndex === undefined
                                        ? "border-transparent bg-accent/60 hover:bg-accent"
                                        : "border-transparent hover:bg-accent"
                            )}
                        >
                            <div className="text-sm font-medium">{i + 1}. {opt.label}</div>
                            {opt.rationale && (
                                <div className="text-xs text-muted-foreground mt-0.5">{opt.rationale}</div>
                            )}
                        </button>
                    ))}
                    {question.allowSkip && (
                        <div className="text-sm text-muted-foreground px-3 py-1">
                            {question.options.length + 1}. Something else
                        </div>
                    )}
                </div>

                <AttachmentStrip attachments={files} pendingUpload={pendingUpload} onRemove={(fileId) => {
                    if (!busy) setFilesByQuestion(prev => ({ ...prev, [pageIndex]: files.filter(file => file.fileId !== fileId) }));
                }} />
                <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="Attach files to answer" disabled={busy}
                    onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
                <div className="border-t border-border/40 pt-4 flex items-end gap-2">
                    <button type="button" aria-label="Attach files" title="Attach images or files" disabled={busy}
                        onClick={() => fileInputRef.current?.click()}
                        className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
                        <Paperclip className="h-4 w-4" />
                    </button>
                    {/* Always rendered regardless of question.allowFreeText — the agent's tool
                        call can restrict this per-question, but a fixed option set can never
                        fully anticipate intent. A user should never be stuck picking the closest
                        wrong option or Skip with no way to say what they actually meant. */}
                    <Textarea
                        ref={freeTextRef}
                        disabled={busy}
                        onPaste={(event) => {
                            if (event.clipboardData.files.length) {
                                event.preventDefault();
                                void addFiles(Array.from(event.clipboardData.files));
                            }
                        }}
                        value={freeText}
                        onChange={(e) => setFreeTextByQuestion(prev => ({ ...prev, [pageIndex]: e.target.value }))}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (!busy && (selectedIndex !== undefined || freeText.trim() || files.length)) commitCurrent();
                                return;
                            }
                            // Escape-to-skip only applies while the field reads as the
                            // "Skip [ESC]" affordance shown below — once the user has
                            // typed something, Escape shouldn't discard it silently.
                            if (e.key === 'Escape' && question.allowSkip && !freeText.trim() && !files.length && !busy) {
                                e.preventDefault();
                                handleSkip();
                            }
                        }}
                        placeholder="Type an answer or attach files"
                        rows={1}
                        // dark:bg-input/30 on the base Textarea isn't a plain `bg-*` utility —
                        // it's scoped to the dark: variant, so an unscoped bg-transparent here
                        // doesn't get merged/deduped against it and the grey pill still shows
                        // through in dark mode. Overriding the same scoped utility clears it.
                        className="flex-1 min-h-0 max-h-[160px] py-1.5 px-0 resize-none border-0 bg-transparent dark:bg-transparent rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm shadow-none placeholder:text-muted-foreground/60"
                    />
                    <div className="flex items-center gap-2 shrink-0 pb-1.5">
                        {question.allowSkip && !freeText.trim() && !files.length && !busy && (
                            <button type="button" onClick={handleSkip} disabled={isSubmitting} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40">
                                <span>Skip</span>
                                <kbd className="text-[10px] leading-none px-1.5 py-1 rounded bg-accent text-muted-foreground/70 font-mono">ESC</kbd>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={commitCurrent}
                            disabled={(selectedIndex === undefined && !freeText.trim() && !files.length) || busy}
                            className={cn(
                                "bg-primary text-primary-foreground disabled:opacity-40 flex items-center justify-center",
                                freeText.trim()
                                    ? "h-8 w-8 rounded-full shrink-0"
                                    : "h-8 px-4 rounded-full text-xs font-medium"
                            )}
                        >
                            {freeText.trim() ? <ArrowUp className="h-4 w-4" /> : (isLast ? 'Submit' : 'Continue')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
