"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ChevronLeft, ChevronDown, ChevronRight, AlertTriangle, CheckCircle, HelpCircle } from "lucide-react";

interface MathInput { key: string; value: number; sourceDoc: string; sourcePage: number; }
interface Finding {
    id: string; ruleId: string; ruleName: string;
    status: "pass" | "fail" | "cannot_evaluate";
    provision: string; narration: string;
    declaredValue: string | null; calculatedValue: string | null;
    math: { expression: string; inputs: MathInput[] } | null;
    trace: unknown;
}
interface PensionCase {
    id: string; caseRef: string; pensionerName: string;
    status: string; assignedRole: string;
    findings: Finding[];
}

const STATUS_BADGE: Record<string, string> = {
    fail:             "bg-red-500/20 text-red-400 border-red-500/30",
    pass:             "bg-green-500/20 text-green-400 border-green-500/30",
    cannot_evaluate:  "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};
const STATUS_ICON = {
    fail: AlertTriangle, pass: CheckCircle, cannot_evaluate: HelpCircle,
};

async function fetchCase(caseId: string): Promise<PensionCase> {
    const res = await fetch(`/api/proxy/api/v1/pension/cases/${caseId}`);
    if (!res.ok) throw new Error("Failed to load case");
    return res.json();
}

async function postAction(caseId: string, body: object) {
    const res = await fetch(`/api/proxy/api/v1/pension/cases/${caseId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Action failed");
    return res.json();
}

function TraceExpander({ trace }: { trace: unknown }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="mt-3">
            <button onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Show full agent trace
            </button>
            {open && (
                <pre className="mt-2 p-3 rounded bg-muted/30 text-xs text-muted-foreground overflow-x-auto max-h-48 font-mono">
                    {JSON.stringify(trace, null, 2)}
                </pre>
            )}
        </div>
    );
}

function ActionModal({ open, onOpenChange, actionType, caseId, findingId, onSuccess }: {
    open: boolean; onOpenChange: (v: boolean) => void;
    actionType: "accept" | "override" | "escalate";
    caseId: string; findingId?: string; onSuccess: () => void;
}) {
    const [rationale, setRationale] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const needsRationale = actionType === "override" || actionType === "escalate";
    const labels = { accept: "Accept Finding", override: "Override Finding", escalate: "Escalate to SAO" };

    async function submit() {
        if (needsRationale && !rationale.trim()) { setError("Rationale is required."); return; }
        setLoading(true); setError("");
        try {
            await postAction(caseId, {
                findingId, action: actionType,
                rationale: rationale.trim() || undefined,
                actorRole: "Dealing Hand",
            });
            setRationale(""); onOpenChange(false); onSuccess();
        } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
        finally { setLoading(false); }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{labels[actionType]}</DialogTitle>
                </DialogHeader>
                {needsRationale && (
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-foreground">
                            Rationale <span className="text-red-400">*</span>
                        </label>
                        <Textarea
                            value={rationale}
                            onChange={e => setRationale(e.target.value)}
                            placeholder={actionType === "escalate" ? "Reason for escalation to SAO…" : "Reason for overriding this finding…"}
                            rows={4}
                        />
                        {error && <p className="text-xs text-red-400">{error}</p>}
                    </div>
                )}
                {!needsRationale && <p className="text-sm text-muted-foreground">Accept this finding and log your decision.</p>}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={submit} disabled={loading}>
                        {loading ? "Submitting…" : labels[actionType]}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default function PensionCaseDetailPage() {
    const params = useParams();
    const router = useRouter();
    const qc = useQueryClient();
    const caseId = params.caseId as string;
    const tenant = params.tenant as string;

    const { data: kase, isLoading, error } = useQuery({
        queryKey: ["pension", "case", caseId],
        queryFn: () => fetchCase(caseId),
    });

    const [modal, setModal] = useState<{ open: boolean; type: "accept" | "override" | "escalate"; findingId?: string }>({
        open: false, type: "accept",
    });

    function openModal(type: "accept" | "override" | "escalate", findingId?: string) {
        setModal({ open: true, type, findingId });
    }

    if (isLoading) return <p className="text-muted-foreground text-sm p-8">Loading case…</p>;
    if (error || !kase) return <p className="text-red-400 text-sm p-8">Failed to load case.</p>;

    const flagged = kase.findings.filter(f => f.status !== "pass");

    return (
        <div className="space-y-6 max-w-4xl">
            {/* Back + header */}
            <div>
                <button onClick={() => router.push(`/${tenant}/dashboard/pension-review`)}
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
                    <ChevronLeft className="w-4 h-4" /> Back to queue
                </button>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{kase.caseRef}</h1>
                <p className="text-muted-foreground mt-1">{kase.pensionerName} · {kase.assignedRole}</p>
            </div>

            {flagged.length === 0 && (
                <Card className="border-green-500/30 bg-green-500/5">
                    <CardContent className="flex items-center gap-3 py-4">
                        <CheckCircle className="w-5 h-5 text-green-400" />
                        <span className="text-green-400 font-medium">All rules passed — case is cleared.</span>
                    </CardContent>
                </Card>
            )}

            {/* Findings */}
            {flagged.map((f) => {
                const Icon = STATUS_ICON[f.status] ?? HelpCircle;
                return (
                    <Card key={f.id} className="border-border bg-card">
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center justify-between text-base">
                                <span className="flex items-center gap-2">
                                    <Icon className="w-4 h-4" />
                                    {f.ruleName}
                                    <span className="text-xs font-mono text-muted-foreground">({f.ruleId})</span>
                                </span>
                                <Badge className={`${STATUS_BADGE[f.status]} border text-xs`}>
                                    {f.status === "cannot_evaluate" ? "Cannot Evaluate" : f.status.charAt(0).toUpperCase() + f.status.slice(1)}
                                </Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {/* Declared vs Calculated */}
                            {f.declaredValue != null && f.calculatedValue != null && (
                                <div className="grid grid-cols-2 gap-4 p-3 rounded-lg bg-muted/20 border border-border/50">
                                    <div>
                                        <p className="text-xs text-muted-foreground mb-1">Declared</p>
                                        <p className="text-lg font-semibold text-red-400">₹{Number(f.declaredValue).toLocaleString('en-IN')}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted-foreground mb-1">Calculated</p>
                                        <p className="text-lg font-semibold text-green-400">₹{Number(f.calculatedValue).toLocaleString('en-IN')}</p>
                                    </div>
                                </div>
                            )}

                            {/* Math attribution */}
                            {f.math && (
                                <div className="p-3 rounded-lg bg-muted/10 border border-border/30 text-sm">
                                    <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">The math</p>
                                    <p className="font-mono text-foreground mb-3">{f.math.expression}</p>
                                    <div className="space-y-1">
                                        {f.math.inputs.map(inp => (
                                            <div key={inp.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                                                <span className="text-foreground font-medium">{inp.key.replace(/_/g, ' ')}:</span>
                                                <span>{inp.value.toLocaleString('en-IN')}</span>
                                                <span>→</span>
                                                <span className="text-blue-400">{inp.sourceDoc}, p.{inp.sourcePage}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Provision + narration */}
                            <div className="space-y-1">
                                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Provision</p>
                                <p className="text-sm text-foreground">{f.provision}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Finding</p>
                                <p className="text-sm text-foreground">{f.narration}</p>
                            </div>

                            {/* Action buttons */}
                            <div className="flex gap-2 pt-2">
                                <Button size="sm" variant="outline"
                                    className="border-green-500/30 text-green-400 hover:bg-green-500/10"
                                    onClick={() => openModal("accept", f.id)}>
                                    Accept
                                </Button>
                                <Button size="sm" variant="outline"
                                    className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                                    onClick={() => openModal("override", f.id)}>
                                    Override
                                </Button>
                                <Button size="sm" variant="outline"
                                    className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                                    onClick={() => openModal("escalate", f.id)}>
                                    Escalate to SAO
                                </Button>
                            </div>

                            {/* Full trace expander */}
                            <TraceExpander trace={f.trace} />
                        </CardContent>
                    </Card>
                );
            })}

            {/* Case-level action (for cleared cases) */}
            {flagged.length === 0 && (
                <div className="flex gap-2">
                    <Button size="sm" variant="outline"
                        className="border-green-500/30 text-green-400 hover:bg-green-500/10"
                        onClick={() => openModal("accept")}>
                        Accept Case
                    </Button>
                </div>
            )}

            <ActionModal
                open={modal.open}
                onOpenChange={v => setModal(m => ({ ...m, open: v }))}
                actionType={modal.type}
                caseId={caseId}
                findingId={modal.findingId}
                onSuccess={() => qc.invalidateQueries({ queryKey: ["pension", "case", caseId] })}
            />
        </div>
    );
}
