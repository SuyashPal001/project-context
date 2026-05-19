"use client";

import { Badge } from "@/components/ui/badge";
import type { AgentRun } from "@/components/platform/agents/types";

export function RunDetailExpanded({ run }: { run: AgentRun }) {
    const uniqueTools = Array.from(new Set(run.stepsCompleted.map(s => s.toolName)));

    return (
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                    Steps Completed
                </p>
                <div className="space-y-3">
                    {run.stepsCompleted.length > 0 ? (
                        run.stepsCompleted.map((step, idx) => (
                            <div key={idx} className="flex flex-col gap-1 border-l-2 border-primary/20 pl-3 pb-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold">{step.toolName}</span>
                                    <Badge variant="secondary" className="text-[9px] h-4 px-1">{step.status}</Badge>
                                </div>
                                <span className="text-[10px] text-muted-foreground">Step {step.stepOrder}</span>
                            </div>
                        ))
                    ) : (
                        <p className="text-xs text-muted-foreground italic">No steps recorded</p>
                    )}
                </div>
            </div>

            <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                    Tools Called ({uniqueTools.length})
                </p>
                <div className="flex flex-wrap gap-2">
                    {uniqueTools.length > 0 ? (
                        uniqueTools.map((tool, idx) => (
                            <Badge key={idx} variant="outline" className="bg-background text-[10px]">
                                {tool}
                            </Badge>
                        ))
                    ) : (
                        <span className="text-xs text-muted-foreground italic">No tools used</span>
                    )}
                </div>
            </div>

            <div className="space-y-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                    Actions Taken
                </p>
                <div className="space-y-3">
                    {run.actionsTaken.length > 0 ? (
                        run.actionsTaken.map((action, idx) => (
                            <div key={idx} className="space-y-1">
                                <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    <span className="text-xs font-medium">{action.action}</span>
                                </div>
                                <p className="text-[10px] text-muted-foreground pl-3.5">{action.description}</p>
                            </div>
                        ))
                    ) : (
                        <p className="text-xs text-muted-foreground italic">No actions found</p>
                    )}
                </div>
            </div>

            <div className="space-y-6">
                <div className="space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                        Human Approval
                    </p>
                    <div>
                        {run.humanApproved === true ? (
                            <Badge className="bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/10">Approved</Badge>
                        ) : run.humanApproved === false ? (
                            <Badge variant="destructive">Rejected</Badge>
                        ) : (
                            <Badge variant="secondary">Not Required</Badge>
                        )}
                    </div>
                </div>

                {run.insights && (
                    <div className="space-y-3">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                            Insights
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed bg-primary/5 p-3 rounded-md border border-primary/10">
                            {run.insights}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
