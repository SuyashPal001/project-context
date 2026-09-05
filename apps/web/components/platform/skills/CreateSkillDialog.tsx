"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { generateSkill, SkillGenerationError } from "./generateSkill";
import { createSkillFromBody } from "./actions";

interface CreateSkillDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}

const BRIEF_PLACEHOLDER =
    "What should this skill teach the agent? e.g. How to write our RFP responses — always open with the client name and tender reference, lead with delivery track record, and never quote a price without a caveat.";

export function CreateSkillDialog({ open, onOpenChange, onCreated }: CreateSkillDialogProps) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [brief, setBrief] = useState("");
    const [draft, setDraft] = useState("");
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showFeedback, setShowFeedback] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [generateCount, setGenerateCount] = useState(0);
    // The draft is appended to from a stream callback that fires many times per
    // second; a ref accumulates it so each delta isn't a full React render of a
    // growing string.
    const draftRef = useRef("");

    const reset = () => {
        setName(""); setDescription(""); setBrief(""); setDraft("");
        setError(null); setShowFeedback(false); setFeedback(""); setGenerateCount(0);
        draftRef.current = "";
    };

    const runGeneration = async (revision: boolean) => {
        if (!name.trim() || !brief.trim()) { setError("Name and brief are required"); return; }
        const previousDraft = revision ? draftRef.current : undefined;
        setGenerating(true);
        setError(null);
        draftRef.current = "";
        setDraft("");
        try {
            const full = await generateSkill(
                {
                    name: name.trim(),
                    description: description.trim() || undefined,
                    brief: brief.trim(),
                    previousDraft,
                    feedback: revision && feedback.trim() ? feedback.trim() : undefined,
                },
                {
                    onDelta: (text) => {
                        draftRef.current += text;
                        setDraft(draftRef.current);
                    },
                },
            );
            draftRef.current = full;
            setDraft(full);
            setGenerateCount((n) => n + 1);
            setShowFeedback(false);
            setFeedback("");
        } catch (err) {
            setError(err instanceof SkillGenerationError ? err.message : "Generation failed. Try again.");
        } finally {
            setGenerating(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            await createSkillFromBody(name.trim(), description.trim(), draftRef.current);
            toast.success("Skill created — it'll be ready in a moment.");
            reset();
            onOpenChange(false);
            onCreated();
        } catch {
            setError("Couldn't save the skill. Try again.");
        } finally {
            setSaving(false);
        }
    };

    const hasDraft = draft.length > 0;

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Create a skill</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <Input placeholder="Skill name" value={name} onChange={(e) => setName(e.target.value)} disabled={generating} />
                    <Input placeholder="One-line description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} disabled={generating} />
                    <Textarea
                        placeholder={BRIEF_PLACEHOLDER}
                        value={brief}
                        onChange={(e) => setBrief(e.target.value)}
                        disabled={generating}
                        className="min-h-[120px]"
                    />

                    {hasDraft && (
                        <pre className="max-h-[320px] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono">
                            {draft}
                        </pre>
                    )}

                    {showFeedback && (
                        <Input
                            placeholder="What should change?"
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            disabled={generating}
                        />
                    )}

                    {error && <p className="text-xs text-destructive">{error}</p>}

                    {/* Only mention the charge once the user has generated more than
                        once — on the common path it's a fraction of a credit and the
                        warning would cost more attention than the spend. */}
                    {generateCount > 1 && (
                        <p className="text-xs text-muted-foreground">Each attempt uses a small number of credits.</p>
                    )}

                    <div className="flex gap-2">
                        {!hasDraft ? (
                            <Button onClick={() => runGeneration(false)} disabled={generating} className="w-full">
                                {generating ? "Generating…" : "Generate"}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant="outline"
                                    disabled={generating || saving}
                                    onClick={() => (showFeedback ? runGeneration(true) : setShowFeedback(true))}
                                >
                                    Regenerate
                                </Button>
                                <Button onClick={handleSave} disabled={generating || saving} className="flex-1">
                                    {saving ? "Saving…" : "Save skill"}
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
