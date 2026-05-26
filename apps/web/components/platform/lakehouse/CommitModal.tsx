"use client";

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2 } from "lucide-react";
import type { PensionRecord } from "./LakehouseTable";

interface Props {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    records: PensionRecord[];
    onSuccess: (newVersion: number) => void;
}

export function CommitModal({ open, onOpenChange, records, onSuccess }: Props) {
    const [pensionId, setPensionId] = useState("");
    const [newAmount, setNewAmount] = useState("");
    const [label, setLabel] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const reset = () => {
        setPensionId("");
        setNewAmount("");
        setLabel("");
        setError(null);
        setDone(false);
    };

    const handleClose = () => {
        if (loading) return;
        onOpenChange(false);
        setTimeout(reset, 300);
    };

    const handleSubmit = async () => {
        if (!pensionId || !newAmount || !label) {
            setError("All fields are required.");
            return;
        }
        const amount = parseFloat(newAmount.replace(/[^0-9.]/g, ""));
        if (isNaN(amount) || amount <= 0) {
            setError("Enter a valid positive amount.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const res = await fetch("/api/proxy/api/v1/lakehouse/correct", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    pension_id: pensionId,
                    new_amount: amount,
                    label,
                    description: `Correction applied via Saarthi AI portal`,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? "Correction failed");
            }

            const { version } = await res.json();
            setDone(true);
            onSuccess(version);
        } catch (err: any) {
            setError(err.message ?? "An error occurred");
        } finally {
            setLoading(false);
        }
    };

    if (done) {
        return (
            <Dialog open={open} onOpenChange={handleClose}>
                <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800 flex flex-col items-center p-8">
                    <div className="h-16 w-16 bg-amber-500/10 rounded-full flex items-center justify-center mb-4">
                        <CheckCircle2 className="h-8 w-8 text-amber-400" />
                    </div>
                    <DialogTitle className="text-xl font-semibold">Correction Committed</DialogTitle>
                    <DialogDescription className="text-center mt-2 mb-6 text-zinc-400">
                        New snapshot created. Use the time-travel selector to compare before and after.
                    </DialogDescription>
                    <Button onClick={handleClose} className="w-full">View Snapshots</Button>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800">
                <DialogHeader>
                    <DialogTitle>Commit Correction</DialogTitle>
                    <DialogDescription>
                        Correct a pension amount. This creates a new immutable snapshot — the original is preserved for time-travel.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <Label className="text-zinc-400 text-xs uppercase tracking-wide">Pension ID</Label>
                        <select
                            value={pensionId}
                            onChange={(e) => setPensionId(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                        >
                            <option value="">Select pension ID…</option>
                            {records.map((r) => (
                                <option key={r.pension_id} value={r.pension_id}>
                                    {r.pension_id} — {r.pensioner_name} ({r.status})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-zinc-400 text-xs uppercase tracking-wide">Corrected Amount (₹)</Label>
                        <Input
                            value={newAmount}
                            onChange={(e) => setNewAmount(e.target.value)}
                            placeholder="e.g. 21200"
                            className="bg-zinc-900 border-zinc-800 font-mono text-sm"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label className="text-zinc-400 text-xs uppercase tracking-wide">Snapshot Label</Label>
                        <Input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="e.g. Pay commission revision Apr 2026"
                            className="bg-zinc-900 border-zinc-800 text-sm"
                        />
                    </div>

                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
                            <p className="text-sm text-red-400">{error}</p>
                        </div>
                    )}
                </div>

                <DialogFooter className="border-t border-zinc-800/50 pt-4">
                    <Button variant="outline" onClick={handleClose} disabled={loading}>Cancel</Button>
                    <Button onClick={handleSubmit} disabled={loading || !pensionId || !newAmount || !label}>
                        {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Committing…</> : "Commit Correction"}
                    </Button>
                </DialogFooter>
            </Dialog>
        </Dialog>
    );
}
