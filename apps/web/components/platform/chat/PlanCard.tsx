'use client';

import { AlertTriangle, BarChart3, CheckSquare, Clock, Loader2, ListTodo } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PlanResult, PrdMilestone } from './types';

interface PlanCardProps {
    data: PlanResult;
    onCreateInSystem: () => Promise<void>;
    isCreating: boolean;
    errorMessage?: string;
}

const PRIORITY_CLASSES: Record<string, string> = {
    low:    'bg-muted/50 text-muted-foreground border-border',
    medium: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    high:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
    urgent: 'bg-red-500/10 text-red-500 border-red-500/20',
};

function milestoneHours(m: PrdMilestone): number {
    return (m.tasks ?? []).reduce((sum, t) => sum + (t.estimatedHours ?? 0), 0);
}

function MilestoneRow({ milestone, index }: { milestone: PrdMilestone; index: number }) {
    const hours = milestoneHours(milestone);
    return (
        <div className="flex items-start gap-3 py-2.5 border-b border-border/40 last:border-0">
            <span className="text-[11px] font-mono text-muted-foreground w-5 shrink-0 pt-0.5">
                {String(index + 1).padStart(2, '0')}
            </span>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground leading-snug truncate">
                    {milestone.title}
                </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <Badge
                    variant="outline"
                    className={cn(
                        'text-[10px] uppercase tracking-wider font-bold',
                        PRIORITY_CLASSES[milestone.priority] ?? PRIORITY_CLASSES.medium
                    )}
                >
                    {milestone.priority}
                </Badge>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <ListTodo className="h-3 w-3" />
                    {(milestone.tasks ?? []).length}
                </span>
                {hours > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {hours}h
                    </span>
                )}
            </div>
        </div>
    );
}

export function PlanCard({ data, onCreateInSystem, isCreating, errorMessage }: PlanCardProps) {
    const { prdData, dodPassed } = data;
    const { plan, milestones = [], risks = [] } = prdData;

    const totalTasks = milestones.reduce((sum, m) => sum + m.tasks.length, 0);
    const totalHours = prdData.totalEstimatedHours
        ?? milestones.reduce((sum, m) => sum + milestoneHours(m), 0);

    return (
        <div className="border border-border rounded-xl overflow-hidden bg-card shadow-lg my-4 max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300">

            {/* DoD warning banner */}
            {!dodPassed && (
                <div className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500/10 border-b border-yellow-500/20">
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
                    <p className="text-[11px] text-yellow-500 font-medium">
                        Document quality checks did not fully pass
                    </p>
                </div>
            )}

            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-foreground leading-snug">
                            {plan.title}
                        </h4>
                        <p className="text-[12px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                            {plan.description}
                        </p>
                    </div>
                    <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider font-bold bg-primary/10 text-primary border-primary/20 shrink-0"
                    >
                        PRD Plan
                    </Badge>
                </div>
            </div>

            {/* Milestones */}
            <div className="px-4 py-3">
                {milestones.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground py-2">No milestones extracted.</p>
                ) : (
                    <div>
                        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-bold mb-2">
                            Milestones
                        </p>
                        {milestones.map((m, i) => (
                            <MilestoneRow key={i} milestone={m} index={i} />
                        ))}
                    </div>
                )}
            </div>

            {/* Risks */}
            {risks.length > 0 && (
                <div className="px-4 pb-3">
                    <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-bold mb-2">
                        Risks
                    </p>
                    <div className="space-y-1">
                        {risks.map((risk, i) => (
                            <div key={i} className="flex items-start gap-2 text-[12px] text-muted-foreground">
                                <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0 mt-0.5" />
                                <span>{risk}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Footer */}
            <div className="px-4 py-3 border-t border-border bg-muted/10">
                {/* Summary stats */}
                <div className="flex items-center gap-4 mb-3">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <BarChart3 className="h-3.5 w-3.5" />
                        {milestones.length} milestone{milestones.length !== 1 ? 's' : ''}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <CheckSquare className="h-3.5 w-3.5" />
                        {totalTasks} task{totalTasks !== 1 ? 's' : ''}
                    </span>
                    {totalHours > 0 && (
                        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Clock className="h-3.5 w-3.5" />
                            {totalHours}h estimated
                        </span>
                    )}
                </div>

                {/* Action */}
                <div className="flex items-center justify-end">
                    <Button
                        size="sm"
                        className="h-8 text-xs font-medium shadow-sm"
                        disabled={isCreating}
                        onClick={onCreateInSystem}
                    >
                        {isCreating ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                                Creating…
                            </>
                        ) : (
                            'Create in System'
                        )}
                    </Button>
                </div>

                {errorMessage && (
                    <p className="text-[11px] text-red-500 mt-2 text-right">{errorMessage}</p>
                )}
            </div>
        </div>
    );
}
