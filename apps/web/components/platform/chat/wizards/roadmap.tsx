"use client";

import { Input } from "@/components/ui/input";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function RoadmapStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>What product or feature needs a roadmap?</FieldLabel>
            <Input
                value={fields.product ?? ""}
                onChange={(e) => setField("product", e.target.value)}
                placeholder="e.g. Mobile app, API platform, Customer portal..."
                autoFocus
            />
        </div>
    );
}

function RoadmapStep2({ fields, setField }: StepProps) {
    const horizons = ["Next sprint", "Next quarter", "6 months", "Annual"];
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>Planning horizon</FieldLabel>
            <div className="flex flex-wrap gap-2">
                {horizons.map((h) => (
                    <ChoicePill
                        key={h}
                        label={h}
                        selected={fields.horizon === h}
                        onSelect={() => setField("horizon", h)}
                    />
                ))}
            </div>
        </div>
    );
}

export const roadmapWizard: WizardSpec = {
    title: "Build a roadmap",
    step1Label: "What are we planning a roadmap for?",
    Step1: RoadmapStep1,
    Step2: RoadmapStep2,
    buildPrompt: (fields) => {
        const horizon = fields.horizon ? ` for the ${fields.horizon}` : "";
        return `Build a product roadmap${horizon} for: ${fields.product}. Include milestones, priorities, and success metrics.`;
    },
    canAdvance: (fields) => (fields.product ?? "").trim().length > 2,
    canSubmit: (fields) => (fields.product ?? "").trim().length > 2 && !!(fields.horizon),
};
