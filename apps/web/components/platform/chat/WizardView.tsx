"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { PillType, WizardFields, WizardSpec } from "./wizards/types";
import { summarizeWizard } from "./wizards/summarize";
import { scheduleWizard } from "./wizards/schedule";
import { researchWizard } from "./wizards/research";
import { draftWizard } from "./wizards/draft";

export type { PillType };

interface WizardViewProps {
    pill: PillType;
    onSubmit: (prompt: string) => void;
    onBack: () => void;
    children: React.ReactNode;
}

const WIZARDS: Record<PillType, WizardSpec> = {
    summarize: summarizeWizard,
    schedule: scheduleWizard,
    research: researchWizard,
    draft: draftWizard,
};

export function WizardView({ pill, onSubmit, onBack, children }: WizardViewProps) {
    const [step, setStep] = useState<1 | 2>(1);
    const [fields, setFields] = useState<WizardFields>({});

    const wizard = WIZARDS[pill];
    const StepComponent = step === 1 ? wizard.Step1 : wizard.Step2;
    const advanceOk = wizard.canAdvance(fields);
    const submitOk = wizard.canSubmit(fields);

    const setField = (key: string, value: string) =>
        setFields((prev) => ({ ...prev, [key]: value }));

    const handleSubmit = () => {
        if (!submitOk) return;
        onSubmit(wizard.buildPrompt(fields));
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-6 py-3 shrink-0">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground hover:text-foreground h-8 px-2"
                    onClick={onBack}
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                </Button>
                <span className="text-xs text-muted-foreground">Step {step} of 2</span>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center px-8 py-6">
                <div className="w-full max-w-lg">
                    <h2 className="text-xl font-semibold mb-1">{wizard.title}</h2>
                    <p className="text-sm text-muted-foreground mb-6">{wizard.step1Label}</p>

                    <StepComponent fields={fields} setField={setField} />

                    <div className="flex justify-end mt-6">
                        {step === 1 ? (
                            <Button
                                type="button"
                                className="gap-1.5"
                                disabled={!advanceOk}
                                onClick={() => setStep(2)}
                            >
                                Continue
                                <ArrowRight className="h-4 w-4" />
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                className="gap-1.5"
                                disabled={!submitOk}
                                onClick={handleSubmit}
                            >
                                Send
                                <ArrowRight className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <div className="shrink-0 pt-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                {children}
            </div>
        </div>
    );
}
