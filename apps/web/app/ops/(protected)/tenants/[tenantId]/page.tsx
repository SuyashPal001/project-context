"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    ArrowLeft, AlertCircle, Users, Bot, MessageSquare, Zap, CircleAlert, RotateCcw,
} from "lucide-react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { OpsTenantDetailResponse } from "@/components/platform/ops/types";

export default function TenantDetailPage() {
    const { tenantId } = useParams<{ tenantId: string }>();
    const router = useRouter();
    const queryClient = useQueryClient();

    const queryKey = ["ops-tenant-detail", tenantId] as const;

    const { data, isLoading, isError } = useQuery<OpsTenantDetailResponse>({
        queryKey,
        queryFn: () => api.get<OpsTenantDetailResponse>(`/api/v1/ops/tenants/${tenantId}`),
    });

    const updateStatusMutation = useMutation({
        mutationFn: (status: string) => api.patch(`/api/v1/ops/tenants/${tenantId}`, { status }),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Tenant status updated"); },
        onError: () => toast.error("Failed to update tenant status"),
    });

    const fmt = (iso: string | null) =>
        iso ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(iso)) : "—";

    const renderOverrideValue = (o: OpsTenantDetailResponse["overrides"][number]) => {
        if (o.unlimited) return "unlimited";
        if (o.valueLimit !== null) return `limit: ${o.valueLimit}`;
        if (o.enabled !== null) return `enabled: ${String(o.enabled)}`;
        return "—";
    };

    const tenant = data?.tenant;
    const members = data?.members ?? [];
    const stats = data?.stats;
    const overrides = data?.overrides ?? [];

    return (
        <div className="space-y-8">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground -ml-2" onClick={() => router.push("/ops/tenants")}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> All Tenants
            </Button>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>Failed to load tenant details.</AlertDescription>
                </Alert>
            )}

            {isLoading ? (
                <div className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-5 w-40" /></div>
            ) : tenant && (
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div className="space-y-2">
                        <div className="flex items-center gap-3 flex-wrap">
                            <h1 className="text-2xl font-bold tracking-tight text-foreground">{tenant.name}</h1>
                            <StatusBadge status={tenant.status} />
                            <StatusBadge status={tenant.type} />
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                            <span className="font-mono">{tenant.slug}</span>
                            <span>·</span>
                            <span>Plan: <span className="text-foreground/75 font-medium">{tenant.plan}</span></span>
                            <span>·</span>
                            <span>Created {fmt(tenant.createdAt)}</span>
                        </div>
                    </div>
                    {tenant.status !== "deleted" && (
                        tenant.status === "active" ? (
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button variant="outline" size="sm" className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10">
                                        <CircleAlert className="mr-1.5 h-4 w-4" /> Suspend
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>Suspend Tenant?</AlertDialogTitle>
                                        <AlertDialogDescription>This will disable access for all users in <strong>{tenant.name}</strong>.</AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => updateStatusMutation.mutate("suspended")} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Suspend</AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        ) : (
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button variant="outline" size="sm" className="border-input">
                                        <RotateCcw className="mr-1.5 h-4 w-4" /> Reactivate
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>Reactivate Tenant?</AlertDialogTitle>
                                        <AlertDialogDescription>This will restore access for all users in <strong>{tenant.name}</strong>.</AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => updateStatusMutation.mutate("active")}>Reactivate</AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        )
                    )}
                </div>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                    { icon: Users,          label: "Members",         value: stats?.memberCount ?? 0 },
                    { icon: Bot,            label: "Active Agents",   value: stats?.activeAgents ?? 0 },
                    { icon: MessageSquare,  label: "Conversations",   value: stats?.totalConversations ?? 0 },
                    { icon: Zap,            label: "Active Overrides",value: overrides.filter(o => o.status === "active").length },
                ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className="rounded-xl border border-border bg-card p-5 space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground font-medium">{label}</p>
                            <Icon className="h-4 w-4 text-muted-foreground/60" />
                        </div>
                        {isLoading
                            ? <Skeleton className="h-7 w-14" />
                            : <p className="text-2xl font-bold tracking-tight text-foreground">{value.toLocaleString()}</p>
                        }
                    </div>
                ))}
            </div>

            {/* Members table */}
            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground/60 uppercase tracking-wider">Members</h2>
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                {["Name", "Email", "Role", "Type", "Status", "Joined"].map(h => (
                                    <TableHead key={h} className="text-muted-foreground text-xs">{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 4 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                                    </TableRow>
                                ))
                                : members.length === 0
                                    ? <TableRow className="border-border"><TableCell colSpan={6} className="py-10 text-center text-muted-foreground/80 text-sm">No members</TableCell></TableRow>
                                    : members.map((m) => (
                                        <TableRow key={m.membershipId} className="border-border hover:bg-secondary/40">
                                            <TableCell className="font-medium text-foreground/90 text-sm">{m.userName ?? <span className="text-muted-foreground/80 italic">—</span>}</TableCell>
                                            <TableCell className="text-muted-foreground text-sm">{m.userEmail ?? <span className="text-muted-foreground/80 italic">agent</span>}</TableCell>
                                            <TableCell>
                                                {m.roleName
                                                    ? <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider border-input text-foreground/60">{m.roleName}</Badge>
                                                    : <span className="text-muted-foreground/80">—</span>}
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className={m.memberType === "agent" ? "text-[10px] border-primary/30 text-primary" : "text-[10px] border-input text-muted-foreground"}>
                                                    {m.memberType}
                                                </Badge>
                                            </TableCell>
                                            <TableCell><StatusBadge status={m.status} /></TableCell>
                                            <TableCell className="text-muted-foreground text-sm">{fmt(m.joinedAt)}</TableCell>
                                        </TableRow>
                                    ))}
                        </TableBody>
                    </Table>
                </div>
            </section>

            {/* Overrides table */}
            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground/60 uppercase tracking-wider">Feature Overrides</h2>
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                {["Feature", "Value", "Reason", "Expires", "Status", "Granted"].map(h => (
                                    <TableHead key={h} className="text-muted-foreground text-xs">{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 3 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                                    </TableRow>
                                ))
                                : overrides.length === 0
                                    ? <TableRow className="border-border"><TableCell colSpan={6} className="py-10 text-center text-muted-foreground/80 text-sm">No overrides</TableCell></TableRow>
                                    : overrides.map((o) => (
                                        <TableRow key={o.id} className="border-border hover:bg-secondary/40">
                                            <TableCell>
                                                <p className="text-foreground/90 text-sm font-medium">{o.featureName}</p>
                                                <p className="text-muted-foreground/80 text-[10px] font-mono uppercase">{o.featureKey}</p>
                                            </TableCell>
                                            <TableCell className="font-mono text-xs text-foreground/60">{renderOverrideValue(o)}</TableCell>
                                            <TableCell className="text-foreground/60 text-sm max-w-[180px] truncate">{o.reason ?? "—"}</TableCell>
                                            <TableCell className="text-muted-foreground text-sm">{fmt(o.expiresAt)}</TableCell>
                                            <TableCell><StatusBadge status={o.status} /></TableCell>
                                            <TableCell className="text-muted-foreground text-sm">{fmt(o.createdAt)}</TableCell>
                                        </TableRow>
                                    ))}
                        </TableBody>
                    </Table>
                </div>
            </section>
        </div>
    );
}
