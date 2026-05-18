"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PURPOSES = [
    { value: 'personal', label: 'Personal work' },
    { value: 'team', label: 'Team collaboration' },
    { value: 'client', label: 'Client projects' }
];

export default function OnboardingPage() {
    const router = useRouter();

    const [step, setStep] = useState<1 | 2>(1);
    const [workspaceName, setWorkspaceName] = useState('');
    const [purpose, setPurpose] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isNameValid = workspaceName.trim().length >= 2;

    function handleContinue() {
        if (!isNameValid) return;
        setStep(2);
    }

    function handleBack() {
        setStep(1);
        setError(null);
    }

    async function handleSubmit() {
        setIsLoading(true);
        setError(null);

        try {
            // Create tenant + agent
            const res = await api.post<{ tenantId: string; slug: string }>('/api/v1/onboarding/complete', {
                workspaceName: workspaceName.trim(),
                purpose: purpose || undefined,
            });

            // Clear HTTP session token (so login can start fresh and get tenantId claims)
            await fetch('/api/auth/session', { method: 'DELETE' });

            router.push(`/auth/login?onboarded=true&slug=${res.slug}`);

        } catch (err: any) {
            console.error("Onboarding failed:", err);
            setError(err.message || "Failed to create workspace. Please try again.");
            setIsLoading(false);
        }
    }

    return (
        <div className="relative min-h-screen bg-black text-white flex flex-col items-center justify-center overflow-hidden">
            <StarfieldCanvas speedMode="idle" active={true} />

            <div className="relative z-10 w-full max-w-4xl px-4 flex flex-col items-center justify-center">

                {step === 1 && (
                    <div className="w-full flex flex-col items-center">
                        <div className="text-center w-full mb-10 mt-10 md:mt-16">
                            <p className="text-[11px] md:text-xs font-semibold tracking-[0.2em] text-white/40 uppercase mb-5">
                                Your workspace awaits
                            </p>

                            <div className="relative group max-w-xl mx-auto w-full">
                                <input
                                    type="text"
                                    placeholder="e.g. Acme Corp"
                                    value={workspaceName}
                                    onChange={(e) => setWorkspaceName(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && isNameValid && handleContinue()}
                                    className="w-full bg-transparent border-0 border-b border-white/20 rounded-none text-center text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight h-auto py-3 placeholder:text-white/20 px-0 text-white focus:outline-none focus:border-white/60 transition-colors duration-500"
                                    autoFocus
                                />
                            </div>
                        </div>

                        <div className="w-full max-w-[280px] mt-6">
                            <Button
                                type="button"
                                size="lg"
                                disabled={!isNameValid}
                                onClick={handleContinue}
                                className={cn(
                                    "w-full transition-all duration-500 rounded-full h-14 text-base font-semibold tracking-wide",
                                    isNameValid
                                        ? "bg-white text-black hover:bg-white/90 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] hover:scale-[1.02]"
                                        : "bg-white/5 text-white/40 border border-white/10"
                                )}
                            >
                                Continue →
                            </Button>
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="w-full flex flex-col items-center">
                        <button
                            type="button"
                            onClick={handleBack}
                            disabled={isLoading}
                            className="absolute top-8 left-4 md:left-8 text-white/40 hover:text-white transition-colors text-sm flex items-center gap-2"
                        >
                            ← Back
                        </button>

                        <div className="space-y-6 pt-4 w-full max-w-2xl text-center mb-16 mt-10 md:mt-16">
                            <p className="text-[11px] md:text-xs font-semibold tracking-[0.2em] text-white/40 uppercase mb-5">
                                One last thing
                            </p>
                            <p className="text-3xl md:text-4xl lg:text-5xl font-medium tracking-tight">
                                What will you use it for?
                            </p>
                            <div className="flex flex-wrap justify-center gap-4 pt-4">
                                {PURPOSES.map((p) => (
                                    <button
                                        key={p.value}
                                        type="button"
                                        disabled={isLoading}
                                        onClick={() => setPurpose(p.value)}
                                        className={cn(
                                            "px-5 py-2 text-[13px] font-medium transition-all duration-300 border backdrop-blur-md rounded-full",
                                            purpose === p.value
                                                ? "bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.2)] scale-105"
                                                : "bg-transparent text-white/40 border-white/10 hover:border-white/30 hover:text-white"
                                        )}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {error && (
                            <div className="text-center text-sm text-red-400 bg-red-400/10 py-2 px-4 rounded mb-8">
                                {error}
                            </div>
                        )}

                        <div className="w-full max-w-[280px]">
                            <Button
                                type="button"
                                size="lg"
                                disabled={isLoading}
                                onClick={handleSubmit}
                                className="w-full transition-all duration-500 rounded-full h-14 text-base font-semibold tracking-wide bg-white text-black hover:bg-white/90 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] hover:scale-[1.02]"
                            >
                                {isLoading ? "Creating..." : "Let's go →"}
                            </Button>
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}
