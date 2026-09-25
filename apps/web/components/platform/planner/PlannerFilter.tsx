"use client";

import { Check, ChevronDown } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CHANNELS, CHANNEL_LABEL, ChannelIcon } from "./ChannelIcon";
import type { PlannerChannel, PlannerEmployee, PlannerItem } from "./types";

export type ChannelFilter = PlannerChannel | "variations";

export interface PlannerFilterValue {
    employeeId: string | null;
    channel: ChannelFilter | null;
}

export function matchesFilter(item: PlannerItem, filter: PlannerFilterValue): boolean {
    if (filter.employeeId && item.employeeId !== filter.employeeId) return false;
    if (filter.channel === "variations") return item.kind === "variations";
    if (filter.channel && item.channel !== filter.channel) return false;
    return true;
}

function filterLabel(filter: PlannerFilterValue, employees: PlannerEmployee[]): string {
    const parts: string[] = [];
    if (filter.employeeId) parts.push(employees.find((e) => e.id === filter.employeeId)?.name ?? "Employee");
    if (filter.channel) parts.push(filter.channel === "variations" ? "Variations" : CHANNEL_LABEL[filter.channel]);
    return parts.length ? parts.join(" · ") : "All";
}

// One menu, two sections: which employee, and which channel. Rows with no
// items stay visible (greyed) so users see what the Planner can hold.
export function PlannerFilter({
    items,
    employees,
    value,
    onChange,
}: {
    items: PlannerItem[];
    employees: PlannerEmployee[];
    value: PlannerFilterValue;
    onChange: (value: PlannerFilterValue) => void;
}) {
    const isAll = !value.employeeId && !value.channel;
    const rowClass = (count: number) => cn("flex items-center gap-2.5 cursor-pointer", count === 0 && "text-muted-foreground");

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="h-9 px-3 inline-flex items-center gap-2 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent/50 transition-colors"
                >
                    {filterLabel(value, employees)}
                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 p-1.5">
                <DropdownMenuItem onClick={() => onChange({ employeeId: null, channel: null })} className={rowClass(items.length)}>
                    <span className="h-2.5 w-2.5 rounded-full bg-foreground" />
                    <span className="flex-1">All</span>
                    <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
                    <Check className={cn("h-3.5 w-3.5", !isAll && "invisible")} />
                </DropdownMenuItem>

                {employees.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Employees</DropdownMenuLabel>
                        {employees.map((employee) => {
                            const count = items.filter((i) => i.employeeId === employee.id).length;
                            const selected = value.employeeId === employee.id;
                            return (
                                <DropdownMenuItem
                                    key={employee.id}
                                    onClick={() => onChange({ ...value, employeeId: selected ? null : employee.id })}
                                    className={rowClass(count)}
                                >
                                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: employee.color }} />
                                    <span className="flex-1">{employee.name}</span>
                                    <span className="font-mono text-xs text-muted-foreground">{count}</span>
                                    <Check className={cn("h-3.5 w-3.5", !selected && "invisible")} />
                                </DropdownMenuItem>
                            );
                        })}
                    </>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Channels</DropdownMenuLabel>
                {[...CHANNELS, "variations" as const].map((channel) => {
                    const count = channel === "variations"
                        ? items.filter((i) => i.kind === "variations").length
                        : items.filter((i) => i.channel === channel).length;
                    const selected = value.channel === channel;
                    return (
                        <DropdownMenuItem
                            key={channel}
                            onClick={() => onChange({ ...value, channel: selected ? null : channel })}
                            className={rowClass(count)}
                        >
                            <ChannelIcon channel={channel === "variations" ? undefined : channel} className={cn(count === 0 && "opacity-50")} />
                            <span className="flex-1">{channel === "variations" ? "Variations" : CHANNEL_LABEL[channel]}</span>
                            <span className="font-mono text-xs text-muted-foreground">{count}</span>
                            <Check className={cn("h-3.5 w-3.5", !selected && "invisible")} />
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
