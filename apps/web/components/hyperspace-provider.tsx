"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";
import { useTheme } from "next-themes";
import { HyperspaceLoader } from "./hyperspace-loader";

interface HyperspaceContextType {
    startHyperspace: (mode?: 'signup' | 'signin') => void;
    finishHyperspace: () => void;
    setHyperspaceStatus: (message: string) => void;
}

const HyperspaceContext = createContext<HyperspaceContextType | null>(null);

export function useHyperspace() {
    const ctx = useContext(HyperspaceContext);
    if (!ctx) throw new Error("useHyperspace must be used within HyperspaceProvider");
    return ctx;
}

export function HyperspaceProvider({ children }: { children: ReactNode }) {
    const { resolvedTheme } = useTheme();
    const [active, setActive] = useState(false);
    const [mode, setMode] = useState<'signup' | 'signin'>('signin');
    const [isDone, setIsDone] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');

    const startHyperspace = (newMode: 'signup' | 'signin' = 'signin') => {
        setMode(newMode);
        setActive(true);
        setIsDone(false);
        setStatusMessage('');
    };

    const finishHyperspace = () => {
        setIsDone(true);
    };

    const setHyperspaceStatus = (message: string) => {
        setStatusMessage(message);
    };

    const handleComplete = () => {
        // Animation sequence has fully finished, hide it.
        setActive(false);
        setStatusMessage('');
    };

    return (
        <HyperspaceContext.Provider value={{ startHyperspace, finishHyperspace, setHyperspaceStatus }}>
            {children}
            {/* The loader sits globally above everything */}
            <HyperspaceLoader
                active={active}
                mode={mode}
                isDone={isDone}
                onComplete={handleComplete}
                statusMessage={statusMessage}
                visualTheme={resolvedTheme === 'dark' ? 'dark' : 'light'}
            />
        </HyperspaceContext.Provider>
    );
}
