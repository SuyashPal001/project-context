"use client";

import React, { useEffect, useState } from "react";
import { StarfieldCanvas } from "./starfield-canvas";

interface HyperspaceLoaderProps {
    active: boolean;
    isDone?: boolean;
    onComplete?: () => void;
    statusMessage?: string;
    mode?: 'signup' | 'signin';
}

const CHECKPOINTS_SIGNIN = [
    { label: "verifying identity", color: "#6c8fff" },
    { label: "loading workspace", color: "#ff9f43" },
    { label: "waking your agents", color: "#48dbfb" },
    { label: "syncing permissions", color: "#ff6b9d" },
    { label: "destination reached", color: "#a29bfe" },
];

const CHECKPOINTS_SIGNUP = [
    { label: "verifying identity", color: "#6c8fff" },
    { label: "creating workspace", color: "#ff9f43" },
    { label: "provisioning agent", color: "#48dbfb" },
    { label: "almost ready", color: "#ff6b9d" },
    { label: "destination reached", color: "#a29bfe" },
];

export function HyperspaceLoader({ active, isDone, onComplete, statusMessage, mode = 'signin' }: HyperspaceLoaderProps) {
    const checkpoints = mode === 'signup' ? CHECKPOINTS_SIGNUP : CHECKPOINTS_SIGNIN;

    const [step, setStep] = useState(0);

    useEffect(() => {
        if (!active) {
            setStep(0);
            return;
        }

        let timeout: NodeJS.Timeout;

        if (step === 0) timeout = setTimeout(() => setStep(1), 350);
        else if (step === 1) timeout = setTimeout(() => setStep(2), 600);
        else if (step === 2) timeout = setTimeout(() => setStep(3), 700);
        else if (step === 3) timeout = setTimeout(() => setStep(4), 700); 
        else if (step === 4) {
            // Wait here if data is still fetching
            if (isDone !== false) {
                 timeout = setTimeout(() => setStep(5), 700);
            }
        }
        else if (step === 5) timeout = setTimeout(() => setStep(6), 600);
        else if (step === 6) timeout = setTimeout(() => { onComplete?.(); }, 800);

        return () => clearTimeout(timeout);
    }, [active, step, isDone, onComplete]);

    const activeIndex = step === 0 ? -1 : (step <= 5 ? step - 1 : -1);
    const completedIndex = step <= 1 ? -1 : (step <= 6 ? step - 2 : 4);
    const arrival = step >= 6;

    useEffect(() => {
        if (!active) return;
    }, [active]);

    if (!active) return null;

    return (
        <div className="fixed inset-0 z-[9999] pointer-events-none bg-background flex flex-col items-center justify-center overflow-hidden text-foreground">
            <StarfieldCanvas speedMode="warp" active={active} />

            <div className={`relative z-10 flex flex-col items-center justify-center transition-opacity duration-500 delay-100 ${arrival ? 'opacity-0' : 'opacity-100'}`}>
                <div className="absolute -top-32 font-sans tracking-[0.22em] text-[12px] uppercase opacity-40 whitespace-nowrap">
                    Saarthi Workflow
                </div>

                <div className="flex flex-col gap-6 items-start w-[240px]">
                    {checkpoints.map((cp, i) => {
                        const isActive = activeIndex === i;
                        const isCompleted = completedIndex >= i;
                        const isVisible = activeIndex >= i || isCompleted;

                        return (
                            <div key={i} className={`flex items-center gap-4 transition-all duration-300 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
                                <div className="relative w-5 h-5 flex items-center justify-center shrink-0">
                                    {isCompleted ? (
                                        <svg className="w-4 h-4 text-foreground opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                        </svg>
                                    ) : (
                                        <>
                                            <div
                                                className={`w-2 h-2 rounded-full transition-all duration-300`}
                                                style={{ backgroundColor: isActive ? cp.color : 'transparent' }}
                                            />
                                            {isActive && (
                                                <div
                                                    className="absolute inset-0 rounded-full animate-ping opacity-60"
                                                    style={{ backgroundColor: cp.color }}
                                                />
                                            )}
                                        </>
                                    )}
                                </div>
                                <div
                                    className="font-mono text-[12px] tracking-[0.04em] transition-colors duration-300 whitespace-nowrap"
                                    style={{ color: isCompleted ? 'var(--muted-foreground)' : (isActive ? 'var(--foreground)' : 'transparent') }}
                                >
                                    {cp.label}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {statusMessage && !arrival && (
                <div className="absolute bottom-12 left-0 right-0 flex justify-center z-10 pointer-events-none">
                    <p
                        className="font-mono text-[11px] tracking-[0.08em] transition-opacity duration-500"
                        style={{ color: 'var(--muted-foreground)' }}
                    >
                        {statusMessage}
                    </p>
                </div>
            )}

            <div className={`absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-700 ${arrival ? 'opacity-100 bg-background/60' : 'opacity-0 pointer-events-none'}`}>
                <div className={`text-[16px] font-medium tracking-wide transition-all duration-700 ${arrival ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
                    Workspace ready
                </div>
            </div>
        </div>
    );
}
