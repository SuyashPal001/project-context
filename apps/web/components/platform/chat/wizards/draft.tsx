"use client";

import { Input } from "@/components/ui/input";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function DraftStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-4 w-full">
            <div>
                <FieldLabel>To (name or email)</FieldLabel>
                <Input
                    value={fields.recipient ?? ""}
                    onChange={(e) => setField("recipient", e.target.value)}
                    placeholder="e.g. Sarah, sarah@example.com"
                    autoFocus
                />
            </div>
            <div>
                <FieldLabel>Subject / what&apos;s it about?</FieldLabel>
                <Input
                    value={fields.subject ?? ""}
                    onChange={(e) => setField("subject", e.target.value)}
                    placeholder="e.g. project update, meeting request..."
                />
            </div>
        </div>
    );
}

function DraftStep2({ fields, setField }: StepProps) {
    const choices = ["Formal", "Friendly", "Brief and direct"];
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>Tone</FieldLabel>
            <div className="flex flex-wrap gap-2">
                {choices.map((c) => (
                    <ChoicePill
                        key={c}
                        label={c}
                        selected={fields.tone === c}
                        onSelect={() => setField("tone", c)}
                    />
                ))}
            </div>
        </div>
    );
}

export const draftWizard: WizardSpec = {
    title: "✍️ Draft an email",
    step1Label: "Who and what",
    Step1: DraftStep1,
    Step2: DraftStep2,
    buildPrompt: (fields) => `Draft a ${fields.tone} email to ${fields.recipient} about: ${fields.subject}.`,
    canAdvance: (fields) =>
        (fields.recipient ?? "").trim().length > 0 && (fields.subject ?? "").trim().length > 0,
    canSubmit: (fields) => !!(fields.recipient && fields.subject && fields.tone),
};
