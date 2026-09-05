"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { can } from "@/lib/permissions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Check, ArrowRight } from "lucide-react";

interface Plan {
    id: string;
    name: string;
    price: string;
    description: string;
    features: string[];
}

export const PLANS: Plan[] = [
    {
        id: "free",
        name: "Free",
        price: "$0",
        description: "Perfect for exploring the platform.",
        features: ["Up to 3 team members", "300 credits/mo", "Community Support"],
    },
    {
        id: "starter",
        name: "Creator",
        price: "$20/mo",
        description: "For individuals and small teams producing content.",
        features: ["Up to 10 team members", "3,000 credits/mo", "Email Support"],
    },
    {
        id: "business",
        name: "Studio",
        price: "$60/mo",
        description: "For content teams scaling output.",
        features: ["Up to 50 team members", "9,000 credits/mo", "Priority Support"],
    },
    {
        id: "enterprise",
        name: "Enterprise",
        price: "Custom",
        description: "For large scale organizations.",
        features: ["Unlimited everything", "Dedicated Account Manager", "24/7 Phone Support"],
    },
];

export function PlanSelectorDialog({ currentPlan }: { currentPlan: string }) {
    const { tenantId, permissions = [] } = useTenant();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);

    const canUpdateBilling = can(permissions, "billing", "update");

    const changePlanMutation = useMutation({
        mutationFn: (planId: string) => api.post("/api/v1/billing/subscription", { plan: planId }),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ["subscription", tenantId] });
            queryClient.invalidateQueries({ queryKey: ["entitlements", tenantId] });
            try {
                await fetch("/api/auth/refresh", { method: "POST" });
            } catch {
                // refresh failed — page reload will still re-hydrate from existing token
            }
            window.location.reload();
        },
        onError: (error: Error) => {
            toast.error(error.message || "Failed to update subscription plan");
        },
    });

    if (!canUpdateBilling) return null;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button className="w-full sm:w-auto rounded-full">
                    <ArrowRight className="w-4 h-4 mr-2" />
                    Change Plan
                </Button>
            </DialogTrigger>
            <DialogContent
                className="w-[90vw] overflow-y-auto max-h-[90vh] gap-0 p-0"
                style={{ maxWidth: '64rem' }}
            >
                <DialogHeader className="p-6 pb-4">
                    <DialogTitle className="text-2xl">Upgrade or Downgrade Plan</DialogTitle>
                    <DialogDescription>
                        Select the plan that best fits your needs. Changes take effect immediately.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-6 pt-0">
                    {PLANS.map((plan) => {
                        const isCurrent = currentPlan.toLowerCase() === plan.id;
                        return (
                            <div
                                key={plan.id}
                                className={`bg-card border border-border rounded-lg p-6 flex flex-col relative min-w-0 ${isCurrent ? 'ring-2 ring-primary' : ''}`}
                            >
                                {isCurrent && (
                                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest">
                                        Current
                                    </div>
                                )}
                                <div className="mb-6">
                                    <h3 className="text-xl font-bold mb-3">{plan.name}</h3>
                                    <div className="text-2xl font-black mb-3">{plan.price}</div>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        {plan.description}
                                    </p>
                                </div>

                                <ul className="space-y-3 mb-6 flex-1">
                                    {plan.features.map((feature, i) => (
                                        <li key={i} className="flex items-start gap-2 text-sm">
                                            <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                                            <span className="text-muted-foreground">{feature}</span>
                                        </li>
                                    ))}
                                </ul>

                                <Button
                                    variant={isCurrent ? "outline" : "default"}
                                    disabled={isCurrent || changePlanMutation.isPending}
                                    className="w-full mt-auto"
                                    onClick={() => {
                                        if (!isCurrent) changePlanMutation.mutate(plan.id);
                                    }}
                                >
                                    {changePlanMutation.isPending && !isCurrent
                                        ? "Updating..."
                                        : isCurrent
                                            ? "Current Plan"
                                            : "Select Plan"}
                                </Button>
                            </div>
                        );
                    })}
                </div>
            </DialogContent>
        </Dialog>
    );
}
