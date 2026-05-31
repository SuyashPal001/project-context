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
                <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Tenants</h1>
                <p className="text-zinc-500 text-sm mt-1">All workspaces across the platform.</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 p-4 border border-zinc-800 rounded-xl bg-zinc-900">
                <div className="relative flex-1 min-w-[260px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                    <Input placeholder="Search by name or slug…" className="pl-9 bg-zinc-950 border-zinc-700" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                    <SelectTrigger className="w-44 bg-zinc-950 border-zinc-700">
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
                <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-600 border border-zinc-800 rounded-xl bg-zinc-900">
                    <Users className="h-10 w-10 opacity-40" />
                    <p className="text-sm font-medium">No tenants found.</p>
                </div>
            )}

            {(isLoading || tenants.length > 0) && (
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 hover:bg-transparent">
                                <TableHead className="text-zinc-400">Name</TableHead>
                                <TableHead className="text-zinc-400">Slug</TableHead>
                                <TableHead className="text-zinc-400">Type</TableHead>
                                <TableHead className="text-zinc-400">Status</TableHead>
                                <TableHead className="text-zinc-400">Plan</TableHead>
                                <TableHead className="text-zinc-400">Created</TableHead>
                                <TableHead className="w-10" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 8 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800">
                                        {Array.from({ length: 7 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : tenants.map((tenant) => (
                                    <TableRow
                                        key={tenant.id}
                                        className="border-zinc-800 cursor-pointer hover:bg-zinc-800/40"
                                        onClick={() => router.push(`/ops/tenants/${tenant.id}`)}
                                    >
                                        <TableCell className="font-medium text-zinc-200">{tenant.name}</TableCell>
                                        <TableCell className="font-mono text-xs text-zinc-500">{tenant.slug}</TableCell>
                                        <TableCell><StatusBadge status={tenant.type} /></TableCell>
                                        <TableCell><StatusBadge status={tenant.status} /></TableCell>
                                        <TableCell className="text-zinc-400 text-sm">{tenant.plan}</TableCell>
                                        <TableCell className="text-zinc-500 text-sm">{fmt(tenant.createdAt)}</TableCell>
                                        <TableCell onClick={(e) => e.stopPropagation()}>
                                            {tenant.status !== "deleted" && (
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-zinc-500 hover:text-zinc-200">
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
                    <p className="text-sm text-zinc-500">
                        Page <span className="text-zinc-300 font-medium">{page}</span> of <span className="text-zinc-300 font-medium">{totalPages}</span>
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="border-zinc-700">
                            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="border-zinc-700">
                            Next <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
