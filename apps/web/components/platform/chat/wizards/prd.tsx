"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function PrdStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>What feature or product are you building?</FieldLabel>
            <Input
                value={fields.feature ?? ""}
                onChange={(e) => setField("feature", e.target.value)}
                placeholder="e.g. User onboarding flow, Analytics dashboard..."
                autoFocus
            />
        </div>
    );
}

function PrdStep2({ fields, setField }: StepProps) {
    const audiences = ["B2B SaaS", "Consumer app", "Internal tool", "Mobile app"];
    return (
        <div className="space-y-4 w-full">
            <div className="space-y-2">
                <FieldLabel>Briefly describe the problem it solves (optional)</FieldLabel>
                <Textarea
                    value={fields.context ?? ""}
                    onChange={(e) => setField("context", e.target.value)}
                    placeholder="e.g. Users drop off during sign-up because the flow is too long..."
                    className="min-h-[80px] resize-none text-sm"
                />
            </div>
            <div className="space-y-2">
                <FieldLabel>Target audience</FieldLabel>
                <div className="flex flex-wrap gap-2">
                    {audiences.map((a) => (
                        <ChoicePill
                            key={a}
                            label={a}
                            selected={fields.audience === a}
                            onSelect={() => setField("audience", a)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

export const prdWizard: WizardSpec = {
    title: "📄 Write a PRD",
    step1Label: "What are we building a PRD for?",
    Step1: PrdStep1,
    Step2: PrdStep2,
    buildPrompt: (fields) => {
        const context = fields.context?.trim() ? ` Context: ${fields.context.trim()}.` : "";
        const audience = fields.audience ? ` Target audience: ${fields.audience}.` : "";
        return `Write a comprehensive Product Requirements Document (PRD) for: ${fields.feature}.${context}${audience}`;
    },
    canAdvance: (fields) => (fields.feature ?? "").trim().length > 2,
    canSubmit: (fields) => (fields.feature ?? "").trim().length > 2,
};
