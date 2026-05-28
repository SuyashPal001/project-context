"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, AlertCircle, Settings2, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { StatusBadge } from "@/components/platform/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { OpsOverridesResponse, OpsOverride } from "@/components/platform/ops/types";

const PAGE_SIZE = 20;

const overrideSchema = z.object({
    tenantId:  z.string().min(1, "Tenant ID is required"),
    featureId: z.string().min(1, "Feature ID is required"),
    enabled:   z.boolean().optional(),
    valueLimit:z.number().optional(),
    unlimited: z.boolean().optional(),
    reason:    z.string().min(1, "Reason is required"),
    expiresAt: z.string().optional(),
});
type OverrideFormValues = z.infer<typeof overrideSchema>;

export default function FeatureOverridesPage() {
    const queryClient = useQueryClient();
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);
    const [page, setPage] = React.useState(1);

    const queryKey = ["ops-overrides", page] as const;

    const { data, isLoading, isError, error } = useQuery<OpsOverridesResponse>({
        queryKey,
        queryFn: () => api.get<OpsOverridesResponse>(`/api/v1/ops/overrides?page=${page}&pageSize=${PAGE_SIZE}`),
    });

    const form = useForm<OverrideFormValues>({
        resolver: zodResolver(overrideSchema as any),
        defaultValues: { tenantId: "", featureId: "", enabled: false, valueLimit: 0, unlimited: false, reason: "", expiresAt: "" },
    });

    const createMutation = useMutation({
        mutationFn: (v: OverrideFormValues) => api.post("/api/v1/ops/overrides", v),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Override granted"); setIsDialogOpen(false); form.reset(); },
        onError: (err) => toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to grant override"),
    });

    const revokeMutation = useMutation({
        mutationFn: (id: string) => api.post(`/api/v1/ops/overrides/${id}/revoke`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Override revoked"); },
        onError: (err) => toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to revoke override"),
    });

    const overrides = data?.overrides ?? [];
    const totalPages = data?.totalPages ?? 1;

    const fmt = (iso: string | null) =>
        iso ? new Intl.DateTimeFormat("en-US", { dateStyle: "short" }).format(new Date(iso)) : "Never";

    const renderValue = (o: OpsOverride) => {
        if (o.unlimited) return "unlimited";
        if (o.valueLimit !== null) return `limit: ${o.valueLimit}`;
        if (o.enabled !== null) return `enabled: ${o.enabled}`;
        return "—";
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Feature Overrides</h1>
                    <p className="text-zinc-500 text-sm mt-1">Per-tenant feature flags and limit overrides.</p>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button size="sm"><Plus className="mr-2 h-4 w-4" />Grant Override</Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[420px] bg-zinc-900 border-zinc-800">
                        <DialogHeader>
                            <DialogTitle>Grant Feature Override</DialogTitle>
                            <DialogDescription className="text-zinc-500">Apply a custom value or limit to a feature for a single tenant.</DialogDescription>
                        </DialogHeader>
                        <Form {...form}>
                            <form onSubmit={form.handleSubmit((v) => createMutation.mutate(v))} className="space-y-4 pt-2">
                                <FormField control={form.control} name="tenantId" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Tenant ID</FormLabel>
                                        <FormControl><Input placeholder="uuid…" {...field} className="bg-zinc-950 border-zinc-700" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="featureId" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Feature ID</FormLabel>
                                        <FormControl><Input placeholder="uuid…" {...field} className="bg-zinc-950 border-zinc-700" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <div className="grid grid-cols-2 gap-3">
                                    <FormField control={form.control} name="enabled" render={({ field }) => (
                                        <FormItem className="flex items-start gap-3 rounded-lg border border-zinc-800 p-3">
                                            <FormControl><Checkbox checked={field.value ?? false} onCheckedChange={field.onChange} /></FormControl>
                                            <FormLabel className="text-zinc-300 font-normal">Enabled</FormLabel>
                                        </FormItem>
                                    )} />
                                    <FormField control={form.control} name="unlimited" render={({ field }) => (
                                        <FormItem className="flex items-start gap-3 rounded-lg border border-zinc-800 p-3">
                                            <FormControl><Checkbox checked={field.value ?? false} onCheckedChange={field.onChange} /></FormControl>
                                            <FormLabel className="text-zinc-300 font-normal">Unlimited</FormLabel>
                                        </FormItem>
                                    )} />
                                </div>
                                <FormField control={form.control} name="valueLimit" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Value Limit</FormLabel>
                                        <FormControl>
                                            <Input type="number" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))} className="bg-zinc-950 border-zinc-700" />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="reason" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Reason</FormLabel>
                                        <FormControl><Input placeholder="Why is this being granted?" {...field} className="bg-zinc-950 border-zinc-700" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="expiresAt" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Expires At <span className="text-zinc-600">(optional)</span></FormLabel>
                                        <FormControl>
                                            <Input type="datetime-local" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || undefined)} className="bg-zinc-950 border-zinc-700" />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <div className="flex justify-end gap-3 pt-2">
                                    <Button type="button" variant="outline" size="sm" onClick={() => setIsDialogOpen(false)} className="border-zinc-700">Cancel</Button>
                                    <Button type="submit" size="sm" disabled={createMutation.isPending}>
                                        {createMutation.isPending ? "Granting…" : "Grant Override"}
                                    </Button>
                                </div>
                            </form>
                        </Form>
                    </DialogContent>
                </Dialog>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load feature overrides."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && overrides.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-zinc-600 border border-zinc-800 rounded-xl bg-zinc-900">
                    <Settings2 className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No overrides found.</p>
                </div>
            )}

            {(isLoading || overrides.length > 0) && (
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 hover:bg-transparent">
                                {["Tenant", "Feature", "Value", "Reason", "Granted By", "Expires", "Status", ""].map((h, i) => (
                                    <TableHead key={i} className="text-zinc-500 text-xs">{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 6 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800">
                                        {Array.from({ length: 8 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                                    </TableRow>
                                ))
                                : overrides.map((o) => (
                                    <TableRow key={o.id} className="border-zinc-800 hover:bg-zinc-800/30">
                                        <TableCell className="text-zinc-300 text-sm font-medium">{o.tenantName}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider border-zinc-700 text-zinc-400">
                                                {o.featureKey}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-zinc-400">{renderValue(o)}</TableCell>
                                        <TableCell className="text-zinc-500 text-sm max-w-[160px] truncate">{o.reason}</TableCell>
                                        <TableCell className="font-mono text-xs text-zinc-600">{o.grantedBy.substring(0, 8)}</TableCell>
                                        <TableCell className="text-zinc-500 text-sm">{fmt(o.expiresAt)}</TableCell>
                                        <TableCell><StatusBadge status={o.status} /></TableCell>
                                        <TableCell>
                                            {o.status === "active" && (
                                                <AlertDialog>
                                                    <AlertDialogTrigger asChild>
                                                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-zinc-600 hover:text-destructive">
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </AlertDialogTrigger>
                                                    <AlertDialogContent>
                                                        <AlertDialogHeader>
                                                            <AlertDialogTitle>Revoke Override?</AlertDialogTitle>
                                                            <AlertDialogDescription>This will revert the tenant to their plan defaults immediately.</AlertDialogDescription>
                                                        </AlertDialogHeader>
                                                        <AlertDialogFooter>
                                                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                            <AlertDialogAction onClick={() => revokeMutation.mutate(o.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Revoke</AlertDialogAction>
                                                        </AlertDialogFooter>
                                                    </AlertDialogContent>
                                                </AlertDialog>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {!isLoading && !isError && overrides.length > 0 && (
                <div className="flex items-center justify-between px-1">
                    <p className="text-sm text-zinc-500">
                        Page <span className="text-zinc-300 font-medium">{page}</span> of <span className="text-zinc-300 font-medium">{totalPages}</span>
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="border-zinc-700">
                            <ChevronLeft className="mr-1 h-4 w-4" />Previous
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="border-zinc-700">
                            Next<ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
