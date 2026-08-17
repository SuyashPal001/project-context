"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Search, AlertCircle, Users,
    ChevronLeft, ChevronRight,
    MoreHorizontal, CircleAlert, RotateCcw,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { StatusBadge } from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { OpsTenantsResponse } from "@/components/platform/ops/types";

const PAGE_SIZE = 20;

export default function TenantsListPage() {
    const router = useRouter();
    const queryClient = useQueryClient();

    const [search, setSearch] = React.useState("");
    const [debouncedSearch, setDebouncedSearch] = React.useState("");
    const [status, setStatus] = React.useState("all");
    const [page, setPage] = React.useState(1);

    React.useEffect(() => {
        const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
        return () => clearTimeout(t);
    }, [search]);

    const queryKey = ["ops-tenants", debouncedSearch, status, page] as const;

    const { data, isLoading, isError, error } = useQuery<OpsTenantsResponse>({
        queryKey,
        queryFn: () => {
            let url = `/api/v1/ops/tenants?page=${page}&pageSize=${PAGE_SIZE}`;
            if (debouncedSearch) url += `&search=${encodeURIComponent(debouncedSearch)}`;
            if (status !== "all") url += `&status=${status}`;
            return api.get<OpsTenantsResponse>(url);
        },
    });

    const updateStatusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: string }) =>
            api.patch(`/api/v1/ops/tenants/${id}`, { status }),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Tenant status updated"); },
        onError: (err) => toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to update tenant status"),
    });

    const tenants = data?.tenants ?? [];
    const totalPages = data?.totalPages ?? 1;

    const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "short" }).format(new Date(iso));

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Tenants</h1>
                <p className="text-muted-foreground text-sm mt-1">All workspaces across the platform.</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 p-4 border border-border rounded-xl bg-card">
                <div className="relative flex-1 min-w-[260px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search by name or slug…" className="pl-9 bg-background border-input" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                    <SelectTrigger className="w-44 bg-background border-input">
                        <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="suspended">Suspended</SelectItem>
                        <SelectItem value="deleted">Deleted</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load tenants list."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && tenants.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground/80 border border-border rounded-xl bg-card">
                    <Users className="h-10 w-10 opacity-40" />
                    <p className="text-sm font-medium">No tenants found.</p>
                </div>
            )}

            {(isLoading || tenants.length > 0) && (
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                <TableHead className="text-foreground/60">Name</TableHead>
                                <TableHead className="text-foreground/60">Slug</TableHead>
                                <TableHead className="text-foreground/60">Type</TableHead>
                                <TableHead className="text-foreground/60">Status</TableHead>
                                <TableHead className="text-foreground/60">Plan</TableHead>
                                <TableHead className="text-foreground/60">Created</TableHead>
                                <TableHead className="w-10" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 8 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 7 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : tenants.map((tenant) => (
                                    <TableRow
                                        key={tenant.id}
                                        className="border-border cursor-pointer hover:bg-secondary/40"
                                        onClick={() => router.push(`/ops/tenants/${tenant.id}`)}
                                    >
                                        <TableCell className="font-medium text-foreground/90">{tenant.name}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{tenant.slug}</TableCell>
                                        <TableCell><StatusBadge status={tenant.type} /></TableCell>
                                        <TableCell><StatusBadge status={tenant.status} /></TableCell>
                                        <TableCell className="text-foreground/60 text-sm">{tenant.plan}</TableCell>
                                        <TableCell className="text-muted-foreground text-sm">{fmt(tenant.createdAt)}</TableCell>
                                        <TableCell onClick={(e) => e.stopPropagation()}>
                                            {tenant.status !== "deleted" && (
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground/90">
                                                            <MoreHorizontal className="h-4 w-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        {tenant.status === "active" ? (
                                                            <AlertDialog>
                                                                <AlertDialogTrigger asChild>
                                                                    <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive">
                                                                        <CircleAlert className="mr-2 h-4 w-4" /> Suspend
                                                                    </DropdownMenuItem>
                                                                </AlertDialogTrigger>
                                                                <AlertDialogContent>
                                                                    <AlertDialogHeader>
                                                                        <AlertDialogTitle>Suspend Tenant?</AlertDialogTitle>
                                                                        <AlertDialogDescription>This will disable access for all users in <strong>{tenant.name}</strong>.</AlertDialogDescription>
                                                                    </AlertDialogHeader>
                                                                    <AlertDialogFooter>
                                                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                                        <AlertDialogAction onClick={() => updateStatusMutation.mutate({ id: tenant.id, status: "suspended" })} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Suspend</AlertDialogAction>
                                                                    </AlertDialogFooter>
                                                                </AlertDialogContent>
                                                            </AlertDialog>
                                                        ) : (
                                                            <AlertDialog>
                                                                <AlertDialogTrigger asChild>
                                                                    <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                                                        <RotateCcw className="mr-2 h-4 w-4" /> Reactivate
                                                                    </DropdownMenuItem>
                                                                </AlertDialogTrigger>
                                                                <AlertDialogContent>
                                                                    <AlertDialogHeader>
                                                                        <AlertDialogTitle>Reactivate Tenant?</AlertDialogTitle>
                                                                        <AlertDialogDescription>This will restore access for all users in <strong>{tenant.name}</strong>.</AlertDialogDescription>
                                                                    </AlertDialogHeader>
                                                                    <AlertDialogFooter>
                                                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                                        <AlertDialogAction onClick={() => updateStatusMutation.mutate({ id: tenant.id, status: "active" })}>Reactivate</AlertDialogAction>
                                                                    </AlertDialogFooter>
                                                                </AlertDialogContent>
                                                            </AlertDialog>
                                                        )}
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {!isLoading && !isError && tenants.length > 0 && (
                <div className="flex items-center justify-between px-1">
                    <p className="text-sm text-muted-foreground">
                        Page <span className="text-foreground/75 font-medium">{page}</span> of <span className="text-foreground/75 font-medium">{totalPages}</span>
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="border-input">
                            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="border-input">
                            Next <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
