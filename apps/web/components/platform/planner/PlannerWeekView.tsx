"use client";

import { addDays, format, isSameDay, isToday } from "date-fns";
import { AlertTriangle, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, ChannelIcon } from "./ChannelIcon";
import type { PlannerEmployee, PlannerItem } from "./types";

// Week as seven day columns with items stacked by time (the Later/Buffer
// layout), not an hour grid: posts are a few a day, so hours are mostly
// empty space.
export function PlannerWeekView({
    weekStart,
    items,
    employees,
    onPlan,
}: {
    weekStart: Date;
    items: PlannerItem[];
    employees: PlannerEmployee[];
    onPlan?: (day: Date) => void;
}) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const colorOf = (employeeId?: string) => employees.find((e) => e.id === employeeId)?.color;

    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <div className="grid min-w-[840px] grid-cols-7 divide-x divide-border">
                {days.map((day) => {
                    const today = isToday(day);
                    const dayItems = items
                        .filter((item) => isSameDay(new Date(item.scheduledAt), day))
                        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
                    return (
                        <div key={day.toISOString()} className={cn("flex min-h-[420px] flex-col", today && "bg-accent/30")}>
                            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{format(day, "EEE")}</span>
                                <span
                                    className={cn(
                                        "flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-sm font-medium",
                                        today && "bg-foreground text-background",
                                    )}
                                >
                                    {format(day, "d")}
                                </span>
                            </div>

                            <div className="group flex flex-1 flex-col gap-1.5 p-2">
                                {dayItems.map((item) => (
                                    <PlannerItemCard key={item.id} item={item} employeeColor={colorOf(item.employeeId)} />
                                ))}
                                {onPlan && (
                                    <button
                                        type="button"
                                        onClick={() => onPlan(day)}
                                        className="mt-auto flex items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                                    >
                                        <Plus className="h-3 w-3" /> Plan
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PlannerItemCard({ item, employeeColor }: { item: PlannerItem; employeeColor?: string }) {
    const failed = item.status === "failed";
    const prefix = item.kind === "variations" ? "Variations" : item.channel ? CHANNEL_LABEL[item.channel] : "";
    const time = format(new Date(item.scheduledAt), "HH:mm");

    return (
        <div
            className={cn(
                "relative flex gap-2 rounded-md border border-border/60 bg-background py-1.5 pl-2.5 pr-2 text-left",
                failed && "border-destructive/40",
            )}
        >
            {employeeColor && (
                <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full" style={{ backgroundColor: employeeColor }} />
            )}
            <ChannelIcon channel={item.kind === "variations" ? undefined : item.channel} className="mt-0.5" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                    {prefix}: {item.title}
                </p>
                <p className={cn("flex items-center gap-1 text-[11px] text-muted-foreground", failed && "text-destructive")}>
                    {failed && <AlertTriangle className="h-3 w-3 shrink-0" />}
                    <span className="truncate">
                        {time}
                        {item.detail ? ` · ${item.detail}` : ""}
                    </span>
                </p>
            </div>
        </div>
    );
}
