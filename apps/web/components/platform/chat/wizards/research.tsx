"use client";

import { Input } from "@/components/ui/input";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function ResearchStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>What would you like to research?</FieldLabel>
            <Input
                value={fields.topic ?? ""}
                onChange={(e) => setField("topic", e.target.value)}
                placeholder="e.g. quantum computing, market trends in SaaS..."
                autoFocus
            />
        </div>
    );
}

function ResearchStep2({ fields, setField }: StepProps) {
    const choices = ["Quick overview", "Deep dive", "Recent news only"];
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>How deep should I go?</FieldLabel>
            <div className="flex flex-wrap gap-2">
                {choices.map((c) => (
                    <ChoicePill
                        key={c}
                        label={c}
                        selected={fields.depth === c}
                        onSelect={() => setField("depth", c)}
                    />
                ))}
            </div>
        </div>
    );
}

export const researchWizard: WizardSpec = {
    title: "Research a topic",
    step1Label: "What would you like to research?",
    Step1: ResearchStep1,
    Step2: ResearchStep2,
    buildPrompt: (fields) => `Research '${fields.topic}' and give me a ${fields.depth || "quick overview"}.`,
    canAdvance: (fields) => (fields.topic ?? "").trim().length > 0,
    canSubmit: (fields) => !!(fields.topic && fields.depth),
};
