"use client";

import { Suspense, useMemo, useState } from "react";
import { addWeeks, endOfWeek, format, isWithinInterval, startOfWeek } from "date-fns";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PlannerFilter, matchesFilter, type PlannerFilterValue } from "@/components/platform/planner/PlannerFilter";
import { PlannerWeekView } from "@/components/platform/planner/PlannerWeekView";
import { usePlannerItems } from "@/components/platform/planner/usePlannerItems";

export default function PlannerPage() {
    return (
        <Suspense>
            <Planner />
        </Suspense>
    );
}

function weekLabel(start: Date): string {
    const end = endOfWeek(start, { weekStartsOn: 1 });
    if (start.getMonth() === end.getMonth()) return `${format(start, "MMMM d")}–${format(end, "d, yyyy")}`;
    if (start.getFullYear() === end.getFullYear()) return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
    return `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`;
}

function Planner() {
    const { items, employees, isDemo } = usePlannerItems();
    const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
    const [filter, setFilter] = useState<PlannerFilterValue>({ employeeId: null, channel: null });
    const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    const weekItems = items.filter((item) => isWithinInterval(new Date(item.scheduledAt), { start: weekStart, end: weekEnd }));
    const visible = weekItems.filter((item) => matchesFilter(item, filter));

    const planned = weekItems.filter((i) => i.status === "planned").length;
    const channels = new Set(weekItems.map((i) => i.channel).filter(Boolean)).size;
    const variations = weekItems.filter((i) => i.kind === "variations").length;
    const needsAttention = weekItems.filter((i) => i.status === "failed").length;

    const comingSoon = () => toast("Coming soon", { description: "Planning content is being built." });

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Planner</h1>
                    <p className="text-muted-foreground mt-2">Times shown in {timeZone}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={comingSoon}>
                        <Plus className="h-4 w-4 mr-1.5" /> Connect channel
                    </Button>
                    <Button onClick={comingSoon}>
                        <Plus className="h-4 w-4 mr-1.5" /> Plan content
                    </Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="inline-flex items-center rounded-lg border border-border bg-background">
                        <button
                            type="button"
                            aria-label="Previous week"
                            onClick={() => setWeekStart((w) => addWeeks(w, -1))}
                            className="h-9 w-9 inline-flex items-center justify-center hover:bg-accent/50 rounded-l-lg"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
                            className="h-9 px-3 border-x border-border text-sm font-medium hover:bg-accent/50"
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            aria-label="Next week"
                            onClick={() => setWeekStart((w) => addWeeks(w, 1))}
                            className="h-9 w-9 inline-flex items-center justify-center hover:bg-accent/50 rounded-r-lg"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                    <h2 className="text-base font-semibold text-foreground">{weekLabel(weekStart)}</h2>
                </div>
                <PlannerFilter items={weekItems} employees={employees} value={filter} onChange={setFilter} />
            </div>

            {items.length > 0 && (
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span><span className="font-medium text-foreground">{planned}</span> scheduled</span>
                    <span><span className="font-medium text-foreground">{channels}</span> channels</span>
                    <span><span className="font-medium text-foreground">{variations}</span> variations</span>
                    <span className={needsAttention > 0 ? "inline-flex items-center gap-1 text-destructive" : undefined}>
                        {needsAttention > 0 && <AlertTriangle className="h-3.5 w-3.5" />}
                        <span className={needsAttention > 0 ? "font-medium" : "font-medium text-foreground"}>{needsAttention}</span> need attention
                    </span>
                    {isDemo && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Demo data</span>}
                </p>
            )}

            <PlannerWeekView
                weekStart={weekStart}
                items={visible}
                employees={employees}
                onPlan={comingSoon}
                emptyState={items.length === 0 ? (
                    <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-background px-6 py-7 text-center shadow-sm">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60">
                            <CalendarDays className="h-5 w-5 text-muted-foreground" />
                        </span>
                        <p className="text-sm font-medium text-foreground">Nothing planned yet</p>
                        <p className="text-sm text-muted-foreground">
                            Plan posts for your channels, or have an employee make new variations of an ad on a schedule.
                        </p>
                        <Button variant="outline" size="sm" onClick={comingSoon}>
                            <Plus className="h-4 w-4 mr-1.5" /> Plan your first content
                        </Button>
                    </div>
                ) : undefined}
            />
        </div>
    );
}
