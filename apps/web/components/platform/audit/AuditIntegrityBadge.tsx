"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface VerifyResult {
    valid: boolean;
    totalEntries: number;
    firstBrokenAt?: string;
}

export function AuditIntegrityBadge() {
    const { tenantId } = useTenant();
    const [enabled, setEnabled] = useState(false);

    const { data, isFetching, isError } = useQuery<{ data: VerifyResult }>({
        queryKey: ["audit-verify", tenantId],
        queryFn: () => api.get("/api/v1/audit-log/verify"),
        enabled: enabled && !!tenantId,
        staleTime: 60_000,
    });

    const result = data?.data;

    if (!enabled) {
        return (
            <Button variant="outline" size="sm" onClick={() => setEnabled(true)}>
                <ShieldCheck className="h-4 w-4 mr-2"/>
                Verify Chain Integrity
            </Button>
        );
    }

    if (isFetching) {
        return (
            <Button variant="outline" size="sm" disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin"/>
                Verifying...
            </Button>
        );
    }

    if (isError || !result) {
        return <Badge variant="destructive" className="gap-1"><ShieldAlert className="h-3 w-3"/>Verify failed</Badge>;
    }

    if (result.valid) {
        return (
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger>
                        <Badge className="bg-green-500/10 text-green-500 border-green-500/20 gap-1.5 cursor-default">
                            <ShieldCheck className="h-3 w-3"/>
                            Chain valid · {result.totalEntries} entries
                        </Badge>
                    </TooltipTrigger>
                    <TooltipContent>All SHA-256 hashes verified. No tampering detected.</TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger>
                    <Badge variant="destructive" className="gap-1.5 cursor-default">
                        <ShieldAlert className="h-3 w-3"/>
                        Chain broken
                    </Badge>
                </TooltipTrigger>
                <TooltipContent>
                    Tamper detected at entry: {result.firstBrokenAt ?? "unknown"}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
