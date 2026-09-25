"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { addDays, setHours, setMinutes, startOfWeek } from "date-fns";
import type { PlannerChannel, PlannerEmployee, PlannerItem, PlannerItemKind, PlannerItemStatus } from "./types";

// No backend yet: real users get an empty Planner, and `?demo=1` shows
// sample data for judging the design. Wiring replaces this hook only.
export function usePlannerItems(): { items: PlannerItem[]; employees: PlannerEmployee[]; isDemo: boolean } {
    const searchParams = useSearchParams();
    const isDemo = searchParams?.get("demo") === "1";
    return useMemo(
        () => (isDemo ? { ...buildDemoData(new Date()), isDemo } : { items: [], employees: [], isDemo }),
        [isDemo],
    );
}

const DEMO_EMPLOYEES: PlannerEmployee[] = [
    { id: "director", name: "Director", color: "#c2410c" },
    { id: "producer", name: "Producer", color: "#2563eb" },
    { id: "disco", name: "Disco", color: "#ca8a04" },
];

type DemoRow = [dayOffset: number, hour: number, minute: number, kind: PlannerItemKind, title: string, channel: PlannerChannel | undefined, employeeId: string, status?: PlannerItemStatus, detail?: string];

// Offsets are days from the Monday of the current week, spanning the
// previous, current and next weeks so paging has something to show.
const DEMO_ROWS: DemoRow[] = [
    [-7, 10, 30, "post", "Founder story", "linkedin", "director", "posted"],
    [-6, 11, 15, "post", "Product teaser", "youtube", "director", "posted"],
    [-4, 18, 0, "post", "Unboxing hook", "tiktok", "disco", "posted"],
    [-3, 10, 0, "variations", "New hook", undefined, "producer", "ready", "3 new"],
    [0, 10, 30, "post", "Feature post", "linkedin", "director", "posted"],
    [0, 14, 0, "post", "Demo cut", "youtube", "director", "posted"],
    [1, 11, 15, "post", "Product teaser", "youtube", "director", "posted"],
    [2, 9, 0, "post", "Launch thread", "x", "disco", "posted"],
    [3, 10, 0, "variations", "Rotate creative", undefined, "producer", "ready", "4 new"],
    [3, 18, 0, "post", "Unboxing hook", "tiktok", "disco", "planned"],
    [4, 11, 0, "post", "Benefits carousel", "instagram", "director", "planned"],
    [5, 17, 30, "post", "Trend remix", "tiktok", "disco", "failed", "Channel disconnected"],
    [5, 19, 0, "post", "Weekend reel", "instagram", "director", "planned"],
    [7, 10, 20, "post", "Launch recap", "linkedin", "director", "planned"],
    [8, 16, 15, "post", "How-it-works", "instagram", "director", "planned"],
    [9, 10, 0, "variations", "Hook variations", undefined, "producer", "planned", "3 new"],
    [10, 18, 30, "post", "Trending audio", "tiktok", "disco", "planned"],
    [11, 12, 0, "post", "Unboxing short", "youtube", "director", "planned"],
];

function buildDemoData(now: Date): { items: PlannerItem[]; employees: PlannerEmployee[] } {
    const monday = startOfWeek(now, { weekStartsOn: 1 });
    const items = DEMO_ROWS.map(([offset, hour, minute, kind, title, channel, employeeId, status, detail], i): PlannerItem => ({
        id: `demo-${i}`,
        kind,
        title,
        channel,
        employeeId,
        status: status ?? "planned",
        detail,
        scheduledAt: setMinutes(setHours(addDays(monday, offset), hour), minute).toISOString(),
    }));
    return { items, employees: DEMO_EMPLOYEES };
}
