import { Fragment } from "react";
import { cn } from "@/lib/utils";

interface StepperProps {
    step: 1 | 2;
}

const STEPS = [
    { id: 1, label: "Details" },
    { id: 2, label: "Permissions" },
    { id: 3, label: "Created", future: true },
] as const;

export function Stepper({ step }: StepperProps) {
    return (
        <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-4 text-sm font-medium">
                {STEPS.map((s, idx) => {
                    const active = step === s.id;
                    const future = "future" in s && s.future;
                    return (
                        <Fragment key={s.id}>
                            <div
                                className={cn(
                                    "flex items-center gap-2",
                                    active ? "text-primary" : "text-muted-foreground",
                                    future && "opacity-50"
                                )}
                            >
                                <span
                                    className={cn(
                                        "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                                        active
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-muted-foreground/30"
                                    )}
                                >
                                    {s.id}
                                </span>
                                {s.label}
                            </div>
                            {idx < STEPS.length - 1 && (
                                <div className="h-px w-8 bg-muted-foreground/30" />
                            )}
                        </Fragment>
                    );
                })}
            </div>
        </div>
    );
}
