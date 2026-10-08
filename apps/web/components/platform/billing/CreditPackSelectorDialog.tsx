"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useCreditPacks } from "@/lib/hooks/useCredits";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Coins } from "lucide-react";

function formatPrice(priceCents: number, currency: string): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
    }).format(priceCents / 100);
}

export function CreditPackSelectorDialog() {
    const { permissions = [] } = useTenant();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const { data, isLoading } = useCreditPacks();

    const canBuyCredits = can(permissions, "billing", "update");

    const topupMutation = useMutation({
        mutationFn: (packKey: string) => api.post("/api/v1/billing/credits/topup", { packKey }),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ["credits"] });
            setOpen(false);
            toast.success("Credits added to your account");
        },
        onError: (error: Error) => {
            toast.error(error.message || "Failed to buy credit pack");
        },
    });

    if (!canBuyCredits) return null;

    const packs = data?.data ?? [];

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button className="w-full sm:w-auto rounded-full" variant="outline">
                    <Coins className="w-4 h-4 mr-2" />
                    Buy Credits
                </Button>
            </DialogTrigger>
            <DialogContent
                className="w-[90vw] overflow-y-auto max-h-[90vh] gap-0 p-0"
                style={{ maxWidth: '48rem' }}
            >
                <DialogHeader className="p-6 pb-4">
                    <DialogTitle className="text-2xl">Buy Credits</DialogTitle>
                    <DialogDescription>
                        Top up your credit balance. Credits are added immediately.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-6 pt-0">
                    {isLoading && Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-48 rounded-lg" />
                    ))}
                    {!isLoading && packs.map((pack) => (
                        <div
                            key={pack.key}
                            className="bg-card border border-border rounded-lg p-6 flex flex-col min-w-0"
                        >
                            <h3 className="text-lg font-bold mb-2">{pack.name}</h3>
                            <div className="text-2xl font-black mb-1">{pack.credits.toLocaleString()} credits</div>
                            <p className="text-sm text-muted-foreground mb-6">
                                {formatPrice(pack.priceCents, pack.currency)}
                            </p>
                            <Button
                                disabled={topupMutation.isPending}
                                className="w-full mt-auto"
                                onClick={() => topupMutation.mutate(pack.key)}
                            >
                                {topupMutation.isPending && topupMutation.variables === pack.key
                                    ? "Adding..."
                                    : "Buy"}
                            </Button>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
