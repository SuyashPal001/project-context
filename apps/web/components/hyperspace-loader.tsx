"use client";

import React, { useEffect, useState } from "react";
import { OlmoMark } from "./platform/OlmoMark";
import { HyperspaceSceneBoundary } from "./hyperspace/hyperspace-scene-boundary";

const PLATFORM_NAME = 'AdsPlatform';
// Name fill per sequence step (0-5). Step 4 is where the loader waits on data.
const FILL_BY_STEP = [10, 28, 48, 68, 92, 100];

interface HyperspaceLoaderProps {
    active: boolean;
    isDone?: boolean;
    onComplete?: () => void;
    statusMessage?: string;
    mode?: 'signup' | 'signin';
    visualTheme?: 'light' | 'dark';
}

export function HyperspaceLoader({ active, ...sequenceProps }: HyperspaceLoaderProps) {
    if (!active) return null;
    return <HyperspaceSequence {...sequenceProps} />;
}

function HyperspaceSequence({ isDone, onComplete, statusMessage, mode = 'signin', visualTheme = 'light' }: Omit<HyperspaceLoaderProps, 'active'>) {
    const [step, setStep] = useState(0);

    useEffect(() => {
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
    }, [step, isDone, onComplete]);

    const arrival = step >= 6;
    const isDark = visualTheme === 'dark';
    const arrivalLabel = mode === 'signup' ? 'Account created' : 'Workspace ready';
    // The platform name fills bottom to top as the sequence advances. While
    // step 4 waits on data it creeps slowly toward 92% instead of freezing.
    const progress = FILL_BY_STEP[Math.min(step, FILL_BY_STEP.length - 1)];
    // Capitals only occupy roughly 18%-90% of the line box (descender space
    // below the baseline, ascender slack above), so map progress onto that
    // band — otherwise the first fifth of the fill rises through empty space.
    const fillPercent = progress >= 100 ? 100 : 18 + progress * 0.72;
    const fillDuration = step === 4 ? '8s' : '700ms';
    // leading-none so the text box is just the glyphs and the fill level
    // tracks the letters, not empty line-height above and below them.
    const nameClass = 'font-sans text-[20px] leading-none font-semibold uppercase tracking-[0.3em] whitespace-nowrap';
    const nameColor = isDark ? 'text-[#f1dfd5]' : 'text-[#40342f]';

    return (
        <div className={`fixed inset-0 z-[9999] pointer-events-none flex flex-col items-center justify-center overflow-hidden ${isDark ? 'bg-[#070504] text-[#f3e7df]' : 'bg-[#f6efe8] text-[#29221f]'}`}>
            <div className={`absolute inset-0 z-0 ${isDark ? 'bg-[radial-gradient(ellipse_at_center,rgba(28,20,17,0.98)_0%,rgba(12,8,7,0.96)_46%,rgba(3,2,2,1)_100%)]' : 'bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.96)_0%,rgba(249,241,235,0.88)_42%,rgba(225,202,191,0.72)_100%)]'}`} />
            <div className="absolute inset-0 z-[1]">
                <HyperspaceSceneBoundary arriving={step >= 5} visualTheme={visualTheme} />
            </div>

            <div className={`absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-500 ${arrival ? 'opacity-0' : 'opacity-100'}`}>
                <div className={`absolute left-1/2 top-1/2 h-[22vh] w-[34vw] min-w-[320px] -translate-x-1/2 -translate-y-1/2 ${isDark ? 'bg-[radial-gradient(ellipse_at_center,rgba(12,8,7,0.92)_0%,rgba(12,8,7,0.68)_42%,rgba(12,8,7,0)_74%)]' : 'bg-[radial-gradient(ellipse_at_center,rgba(250,244,239,0.94)_0%,rgba(250,244,239,0.74)_42%,rgba(250,244,239,0)_74%)]'}`} />

                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap">
                    <OlmoMark
                        height={22}
                        centered
                        className={`absolute bottom-[calc(100%+12px)] left-1/2 -translate-x-1/2 opacity-90 ${isDark ? '!text-[#f1dfd5]' : '!text-[#40342f]'}`}
                    />
                    <div className="relative">
                        {/* Unfilled track: the same name, faint. */}
                        <div className={`${nameClass} ${nameColor} opacity-25`}>
                            {PLATFORM_NAME}
                        </div>
                        {/* Filled part: rises from the bottom like liquid in a
                            glass, clipped to the current progress, shimmering. */}
                        <div
                            className="absolute inset-x-0 bottom-0 flex items-end overflow-hidden ease-out"
                            style={{ height: `${fillPercent}%`, transitionProperty: 'height', transitionDuration: fillDuration }}
                            aria-hidden="true"
                        >
                            <div className={`${nameClass} ${nameColor} shimmer-text`}>
                                {PLATFORM_NAME}
                            </div>
                        </div>
                    </div>

                    {/* The filling name is the progress indicator; this line only
                        appears when a caller sets an explicit status. */}
                    {statusMessage && (
                        <div className="absolute top-[calc(100%+14px)] left-1/2 -translate-x-1/2">
                            <p
                                key={statusMessage}
                                className="animate-in fade-in duration-300 font-mono text-[11px] tracking-[0.08em]"
                                style={{ color: isDark ? '#bca9a0' : '#8c7c74' }}
                            >
                                {statusMessage}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className={`absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-700 ${arrival ? `opacity-100 ${isDark ? 'bg-[#070504]/80' : 'bg-[#f6efe8]/70'}` : 'opacity-0 pointer-events-none'}`}>
                <div className={`text-[16px] font-medium tracking-wide transition-all duration-700 ${arrival ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}>
                    {arrivalLabel}
                </div>
            </div>
        </div>
    );
}
