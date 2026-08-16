'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ClarificationRequest } from './types';

interface ClarificationCardProps {
    request: ClarificationRequest;
    // `isLast` tells the caller this was the final question in the wizard —
    // wire-format answer fields only, so it's passed as a separate argument
    // rather than folded into `answer` (which is forwarded to the backend as-is).
    onAnswer: (answer: { questionIndex: number; selectedIndex?: number; freeText?: string; skipped?: boolean }, isLast: boolean) => void;
}

export function ClarificationCard({ request, onAnswer }: ClarificationCardProps) {
    const [pageIndex, setPageIndex] = useState(0);
    const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, number>>({});
    const [freeTextByQuestion, setFreeTextByQuestion] = useState<Record<number, string>>({});

    if (request.status !== 'pending') {
        return (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1 px-2 bg-muted/30 rounded-lg border border-border/20 w-fit">
                <span>{request.status === 'answered' ? 'Answered' : 'Skipped'}</span>
            </div>
        );
    }

    const total = request.questions.length;
    const question = request.questions[pageIndex];
    const selectedIndex = selectedByQuestion[pageIndex];
    const freeText = freeTextByQuestion[pageIndex] ?? '';
    const isLast = pageIndex === total - 1;

    const commitCurrent = () => {
        const trimmedFreeText = freeText.trim();
        // Send whichever of selectedIndex/freeText are actually present — a user
        // can click an option AND add free text, and both should reach the
        // backend rather than one silently overwriting the other.
        const answer = {
            questionIndex: pageIndex,
            ...(selectedIndex !== undefined ? { selectedIndex } : {}),
            ...(trimmedFreeText ? { freeText: trimmedFreeText } : {}),
        };
        onAnswer(answer, isLast);
        if (!isLast) setPageIndex(p => p + 1);
    };

    const handleSkip = () => {
        onAnswer({ questionIndex: pageIndex, skipped: true }, isLast);
        if (!isLast) setPageIndex(p => p + 1);
    };

    return (
        <div className="rounded-2xl border border-border bg-card overflow-hidden my-3 max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="px-4 py-3 flex items-center justify-between">
                <h4 className="text-sm font-medium">{question.prompt}</h4>
                <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 ml-3">
                    <button
                        type="button"
                        disabled={pageIndex === 0}
                        onClick={() => setPageIndex(p => Math.max(0, p - 1))}
                        className="disabled:opacity-30"
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span>{pageIndex + 1}/{total}</span>
                    <button
                        type="button"
                        disabled={pageIndex === total - 1}
                        onClick={() => setPageIndex(p => Math.min(total - 1, p + 1))}
                        className="disabled:opacity-30"
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <div className="px-4 pb-3 space-y-1.5">
                {question.options.map((opt, i) => (
                    <button
                        key={opt.label}
                        type="button"
                        onClick={() => setSelectedByQuestion(prev => ({ ...prev, [pageIndex]: i }))}
                        className={cn(
                            "w-full text-left rounded-xl px-3 py-2.5 border transition-colors",
                            selectedIndex === i
                                ? "border-primary/40 bg-primary/5"
                                : "border-transparent bg-muted/40 hover:bg-muted/60"
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

            <div className="border-t border-border px-4 py-3 flex items-center gap-2">
                {question.allowFreeText && (
                    <input
                        value={freeText}
                        onChange={(e) => setFreeTextByQuestion(prev => ({ ...prev, [pageIndex]: e.target.value }))}
                        placeholder="No, and tell what to do differently"
                        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                    />
                )}
                <div className="flex items-center gap-2 shrink-0">
                    {question.allowSkip && (
                        <button type="button" onClick={handleSkip} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                            Skip
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={commitCurrent}
                        disabled={selectedIndex === undefined && !freeText.trim()}
                        className="h-8 px-4 rounded-full bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
                    >
                        {isLast ? 'Submit' : 'Continue'}
                    </button>
                </div>
            </div>
        </div>
    );
}
