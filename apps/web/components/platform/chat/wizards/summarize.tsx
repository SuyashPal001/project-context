"use client";

import { useRef } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChoicePill, FieldLabel } from "./shared";
import type { StepProps, WizardSpec } from "./types";

function SummarizeStep1({ fields, setField }: StepProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            setField("content", (ev.target?.result as string) ?? "");
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    return (
        <div className="space-y-3 w-full">
            <FieldLabel>Paste your document or text here</FieldLabel>
            <Textarea
                value={fields.content ?? ""}
                onChange={(e) => setField("content", e.target.value)}
                placeholder="Paste text here..."
                className="min-h-[180px] resize-none text-sm"
                autoFocus
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>or</span>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-7 px-3 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <Upload className="h-3 w-3" />
                    Upload file
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.csv,.json"
                    className="hidden"
                    onChange={handleFile}
                />
                <span className="text-muted-foreground/60">.txt, .md, .csv, .json</span>
            </div>
        </div>
    );
}

function SummarizeStep2({ fields, setField }: StepProps) {
    const choices = ["Key points", "Brief overview", "Detailed analysis"];
    return (
        <div className="space-y-3 w-full">
            <FieldLabel>What kind of summary?</FieldLabel>
            <div className="flex flex-wrap gap-2">
                {choices.map((c) => (
                    <ChoicePill
                        key={c}
                        label={c}
                        selected={fields.summaryType === c}
                        onSelect={() => setField("summaryType", c)}
                    />
                ))}
            </div>
        </div>
    );
}

export const summarizeWizard: WizardSpec = {
    title: "📄 Summarize a document",
    step1Label: "Paste your text or upload a file",
    Step1: SummarizeStep1,
    Step2: SummarizeStep2,
    buildPrompt: (fields) =>
        `Please summarize the following text. Focus on ${fields.summaryType || "key points"}.\n\n${fields.content}`,
    canAdvance: (fields) => (fields.content ?? "").trim().length > 0,
    canSubmit: (fields) => (fields.content ?? "").trim().length > 0,
};
