import { CalendarDays } from "lucide-react";

// Placeholder until scheduled content generation is built.
export default function PlannerPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Planner</h1>
                <p className="text-muted-foreground mt-2">
                    Plan content for your employees to make on a schedule.
                </p>
            </div>

            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60">
                    <CalendarDays className="h-5 w-5 text-muted-foreground" />
                </span>
                <p className="text-sm font-medium text-foreground">Nothing planned yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                    Soon: have your employees make ads on a schedule — every Monday, daily, or once.
                </p>
            </div>
        </div>
    );
}
