"use client";

import { useState, useEffect } from "react";

function IngestionStatusBadge({ status }: { status: string }) {
    const config: Record<string, { label: string; className: string }> = {
        pending:    { label: 'Pending',      className: 'bg-muted/50 text-muted-foreground' },
        processing: { label: 'Processing…',  className: 'bg-amber-500/10 text-amber-400 animate-pulse' },
        done:       { label: '✅ Done',      className: 'bg-green-500/10 text-green-400' },
        failed:     { label: '❌ Failed',    className: 'bg-red-500/10 text-red-400' },
    };
    const cfg = config[status] ?? { label: status, className: 'bg-muted/50 text-muted-foreground' };
    return (
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${cfg.className}`}>
            {cfg.label}
        </span>
    );
}

const PIPELINE_STAGES = ['detectFormat', 'classify', 'extract', 'validate', 'embed'];

export function ProcessingStepsIndicator({ status }: { status: string }) {
    const [currentStep, setCurrentStep] = useState(0);

    useEffect(() => {
        if (status !== 'processing') { setCurrentStep(0); return; }
        setCurrentStep(0);
        const timer = setInterval(() => {
            setCurrentStep(prev => Math.min(prev + 1, PIPELINE_STAGES.length - 1));
        }, 8000);
        return () => clearInterval(timer);
    }, [status]);

    if (status !== 'processing') return <IngestionStatusBadge status={status} />;

    return (
        <div className="flex items-center gap-1">
            {PIPELINE_STAGES.map((stage, idx) => (
                <div
                    key={stage}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                        idx < currentStep ? 'bg-green-500' :
                        idx === currentStep ? 'bg-amber-400 animate-pulse' :
                        'bg-muted'
                    }`}
                    title={stage}
                />
            ))}
            <span className="text-xs text-amber-400 ml-1 font-mono">{PIPELINE_STAGES[currentStep]}</span>
        </div>
    );
}
