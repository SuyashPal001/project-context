"use client";

import { Input } from "@/components/ui/input";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function ScheduleStep1({ fields, setField }: StepProps) {
    return (
        <div className="space-y-4 w-full">
            <div>
                <FieldLabel>Meeting title</FieldLabel>
                <Input
                    value={fields.title ?? ""}
                    onChange={(e) => setField("title", e.target.value)}
                    placeholder="e.g. Weekly sync"
                    autoFocus
                />
            </div>
            <div>
                <FieldLabel>Invite (email addresses, comma separated)</FieldLabel>
                <Input
                    value={fields.invitees ?? ""}
                    onChange={(e) => setField("invitees", e.target.value)}
                    placeholder="alice@example.com, bob@example.com"
                />
            </div>
        </div>
    );
}

function ScheduleStep2({ fields, setField }: StepProps) {
    const durations = ["30 min", "1 hour", "2 hours"];
    return (
        <div className="space-y-4 w-full">
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <FieldLabel>Date</FieldLabel>
                    <Input
                        value={fields.date ?? ""}
                        onChange={(e) => setField("date", e.target.value)}
                        placeholder="e.g. tomorrow, Dec 20"
                        autoFocus
                    />
                </div>
                <div>
                    <FieldLabel>Time</FieldLabel>
                    <Input
                        value={fields.time ?? ""}
                        onChange={(e) => setField("time", e.target.value)}
                        placeholder="e.g. 3pm, 15:00"
                    />
                </div>
            </div>
            <div>
                <FieldLabel>Duration</FieldLabel>
                <div className="flex flex-wrap gap-2">
                    {durations.map((d) => (
                        <ChoicePill
                            key={d}
                            label={d}
                            selected={fields.duration === d}
                            onSelect={() => setField("duration", d)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

export const scheduleWizard: WizardSpec = {
    title: "📅 Schedule a meeting",
    step1Label: "Meeting details",
    Step1: ScheduleStep1,
    Step2: ScheduleStep2,
    buildPrompt: (fields) =>
        `Schedule a meeting titled '${fields.title}' with ${fields.invitees || "no additional invitees"} on ${fields.date} at ${fields.time} for ${fields.duration}. Send calendar invites.`,
    canAdvance: (fields) => (fields.title ?? "").trim().length > 0,
    canSubmit: (fields) => !!(fields.title && fields.date && fields.time && fields.duration),
};
