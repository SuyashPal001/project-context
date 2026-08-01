'use client';

import { Check } from 'lucide-react';
import type { Readiness } from './_types';

export function ReadinessChecklist({ readiness }: { readiness: Readiness }) {
    return (
        <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Checklist — {readiness.complete} of {readiness.total} complete
                </span>
                <span className="text-sm font-semibold text-amber-500">{readiness.pct}%</span>
            </div>
            <ul className="space-y-2">
                {readiness.checks.map((check) => (
                    <li
                        key={check.key}
                        className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-2.5"
                    >
                        <span
                            className={
                                check.complete
                                    ? 'flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500'
                                    : 'h-5 w-5 rounded-full border border-border'
                            }
                        >
                            {check.complete ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className={check.complete ? 'text-sm' : 'text-sm text-muted-foreground'}>
                            {check.label}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
