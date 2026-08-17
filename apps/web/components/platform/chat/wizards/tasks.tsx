"use client";

import { Input } from "@/components/ui/input";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function TasksStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>What feature or milestone needs to be broken down?</FieldLabel>
            <Input
                value={fields.feature ?? ""}
                onChange={(e) => setField("feature", e.target.value)}
                placeholder="e.g. Authentication system, Payment integration..."
                autoFocus
            />
        </div>
    );
}

function TasksStep2({ fields, setField }: StepProps) {
    const teams = ["Full-stack", "Frontend only", "Backend only", "Mobile"];
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>Which team will work on this?</FieldLabel>
            <div className="flex flex-wrap gap-2">
                {teams.map((t) => (
                    <ChoicePill
                        key={t}
                        label={t}
                        selected={fields.team === t}
                        onSelect={() => setField("team", t)}
                    />
                ))}
            </div>
        </div>
    );
}

export const tasksWizard: WizardSpec = {
    title: "Break into tasks",
    step1Label: "What needs to be broken down into tasks?",
    Step1: TasksStep1,
    Step2: TasksStep2,
    buildPrompt: (fields) => {
        const team = fields.team ? ` for a ${fields.team} team` : "";
        return `Break down the following feature into development tasks${team}: ${fields.feature}. Include acceptance criteria, priority, and estimated hours for each task.`;
    },
    canAdvance: (fields) => (fields.feature ?? "").trim().length > 2,
    canSubmit: (fields) => (fields.feature ?? "").trim().length > 2 && !!(fields.team),
};
