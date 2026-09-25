// Shape of one Planner calendar item. The UI is built against this before the
// backend exists (usePlannerItems returns demo data for now), so wiring later
// only swaps the hook.

export type PlannerChannel = "instagram" | "tiktok" | "youtube" | "linkedin" | "x";

// post: something goes live on a channel.
// variations: an employee makes new versions of an ad before it fatigues.
export type PlannerItemKind = "post" | "variations";

export type PlannerItemStatus = "planned" | "running" | "ready" | "posted" | "failed";

export interface PlannerEmployee {
    id: string;
    name: string;
    color: string;
}

export interface PlannerItem {
    id: string;
    kind: PlannerItemKind;
    title: string;
    scheduledAt: string; // ISO
    channel?: PlannerChannel;
    recurrence?: string; // cron, for repeating items
    status: PlannerItemStatus;
    employeeId?: string;
    detail?: string; // e.g. "3 new" for variations, failure reason for failed
}
