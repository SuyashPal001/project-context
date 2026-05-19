"use client";

import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BrandingLockedOverlayProps {
    tenantSlug: string;
}

export function BrandingLockedOverlay({ tenantSlug }: BrandingLockedOverlayProps) {
    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg backdrop-blur-[2px] bg-card/60">
            <LockKeyhole className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm text-center text-muted-foreground">
                Upgrade to Business to customize your agent
            </p>
            <Button size="sm" asChild>
                <Link href={`/${tenantSlug}/dashboard/billing`}>Upgrade</Link>
            </Button>
        </div>
    );
}
