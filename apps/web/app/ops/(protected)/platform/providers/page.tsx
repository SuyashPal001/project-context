"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, AlertCircle, Cpu, ToggleLeft, ToggleRight } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { OpsProvidersResponse, OpsProvider } from "@/components/platform/ops/types";

const PROVIDER_COLORS: Record<OpsProvider["provider"], string> = {
    openai:      "border-green-500/30 text-green-400",
    anthropic:   "border-orange-500/30 text-orange-400",
    mistral:     "border-blue-500/30 text-blue-400",
    openrouter:  "border-violet-500/30 text-violet-400",
    kimi:        "border-cyan-500/30 text-cyan-400",
    vertex:      "border-yellow-500/30 text-yellow-400",
};

const addSchema = z.object({
    provider:        z.enum(["openai", "anthropic", "mistral", "openrouter", "kimi", "vertex"]),
    model:           z.string().min(1, "Model ID is required"),
    displayName:     z.string().optional(),
    openclawModelId: z.string().optional(),
    apiKey:          z.string().min(1, "API key is required"),
    isDefault:       z.boolean().optional().default(false),
});
type AddFormValues = z.infer<typeof addSchema>;

export default function ProvidersPage() {
    const queryClient = useQueryClient();
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);

    const queryKey = ["ops-providers"] as const;

    const { data, isLoading, isError, error } = useQuery<OpsProvidersResponse>({
        queryKey,
        queryFn: () => api.get<OpsProvidersResponse>("/api/v1/ops/providers"),
    });

    const form = useForm<AddFormValues, unknown, AddFormValues>({
        resolver: zodResolver(addSchema as any),
        defaultValues: { provider: "openai", model: "", displayName: "", openclawModelId: "", apiKey: "", isDefault: false },
    });

    const createMutation = useMutation({
        mutationFn: (v: AddFormValues) => api.post("/api/v1/ops/providers", v),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Provider added"); setIsDialogOpen(false); form.reset(); },
        onError: (err) => toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to add provider"),
    });

    const toggleMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: "live" | "coming_soon" }) =>
            api.patch(`/api/v1/ops/providers/${id}`, { status }),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success("Provider status updated"); },
        onError: (err) => toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to update provider"),
    });

    const providers = data?.providers ?? [];

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-zinc-50">LLM Providers</h1>
                    <p className="text-zinc-500 text-sm mt-1">Platform-level model providers available to all agents.</p>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button size="sm"><Plus className="mr-2 h-4 w-4" />Add Provider</Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[440px] bg-zinc-900 border-zinc-800">
                        <DialogHeader>
                            <DialogTitle>Add LLM Provider</DialogTitle>
                            <DialogDescription className="text-zinc-500">Register a new platform-level model provider.</DialogDescription>
                        </DialogHeader>
                        <Form {...form}>
                            <form onSubmit={form.handleSubmit((v) => createMutation.mutate(v))} className="space-y-4 pt-2">
                                <FormField control={form.control} name="provider" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Provider</FormLabel>
                                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                                            <FormControl>
                                                <SelectTrigger className="bg-zinc-950 border-zinc-700">
                                                    <SelectValue />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                {(["openai", "anthropic", "mistral", "openrouter", "kimi", "vertex"] as const).map(p => (
                                                    <SelectItem key={p} value={p}>{p}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="model" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Model ID</FormLabel>
                                        <FormControl><Input placeholder="gpt-4o, claude-sonnet-4-6…" {...field} className="bg-zinc-950 border-zinc-700 font-mono text-sm" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="displayName" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Display Name <span className="text-zinc-600">(optional)</span></FormLabel>
                                        <FormControl><Input placeholder="GPT-4o, Claude Sonnet…" {...field} className="bg-zinc-950 border-zinc-700" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="openclawModelId" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">OpenClaw Model ID <span className="text-zinc-600">(optional)</span></FormLabel>
                                        <FormControl><Input placeholder="openclaw-model-id…" {...field} className="bg-zinc-950 border-zinc-700 font-mono text-sm" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="apiKey" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">API Key</FormLabel>
                                        <FormControl><Input type="password" placeholder="sk-…" {...field} className="bg-zinc-950 border-zinc-700 font-mono text-sm" /></FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <div className="flex justify-end gap-3 pt-2">
                                    <Button type="button" variant="outline" size="sm" onClick={() => setIsDialogOpen(false)} className="border-zinc-700">Cancel</Button>
                                    <Button type="submit" size="sm" disabled={createMutation.isPending}>
                                        {createMutation.isPending ? "Adding…" : "Add Provider"}
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
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load providers."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && providers.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-zinc-600 border border-zinc-800 rounded-xl bg-zinc-900">
                    <Cpu className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No platform providers registered yet.</p>
                </div>
            )}

            {(isLoading || providers.length > 0) && (
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 hover:bg-transparent">
                                <TableHead className="text-zinc-500 text-xs">Name</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Provider</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Model ID</TableHead>
                                <TableHead className="text-zinc-500 text-xs">OpenClaw ID</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Tenants Using</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Status</TableHead>
                                <TableHead className="w-20" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 4 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800">
                                        {Array.from({ length: 7 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                                    </TableRow>
                                ))
                                : providers.map((p) => (
                                    <TableRow key={p.id} className="border-zinc-800 hover:bg-zinc-800/30">
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <p className="text-zinc-200 font-medium text-sm">{p.displayName}</p>
                                                {p.isDefault && <Badge variant="outline" className="text-[9px] border-zinc-700 text-zinc-500 uppercase tracking-wider">default</Badge>}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className={`text-[10px] font-medium ${PROVIDER_COLORS[p.provider]}`}>
                                                {p.provider}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-zinc-400">{p.model}</TableCell>
                                        <TableCell className="font-mono text-xs text-zinc-600">{p.openclawModelId ?? "—"}</TableCell>
                                        <TableCell>
                                            <span className="text-zinc-300 font-medium text-sm">{p.tenantsUsing}</span>
                                            <span className="text-zinc-600 text-xs ml-1">tenants</span>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className={p.status === "live"
                                                ? "text-[10px] border-green-500/30 text-green-400"
                                                : "text-[10px] border-zinc-700 text-zinc-500"}>
                                                {p.status === "live" ? "live" : "disabled"}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <AlertDialog>
                                                <AlertDialogTrigger asChild>
                                                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-zinc-600 hover:text-zinc-200">
                                                        {p.status === "live"
                                                            ? <ToggleRight className="h-4 w-4 text-green-500" />
                                                            : <ToggleLeft className="h-4 w-4" />}
                                                    </Button>
                                                </AlertDialogTrigger>
                                                <AlertDialogContent>
                                                    <AlertDialogHeader>
                                                        <AlertDialogTitle>{p.status === "live" ? "Disable" : "Enable"} Provider?</AlertDialogTitle>
                                                        <AlertDialogDescription>
                                                            {p.status === "live"
                                                                ? `Agents using ${p.displayName} will no longer be able to complete requests.`
                                                                : `${p.displayName} will become available for agent selection.`}
                                                        </AlertDialogDescription>
                                                    </AlertDialogHeader>
                                                    <AlertDialogFooter>
                                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                        <AlertDialogAction
                                                            onClick={() => toggleMutation.mutate({ id: p.id, status: p.status === "live" ? "coming_soon" : "live" })}
                                                            className={p.status === "live" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                                                        >
                                                            {p.status === "live" ? "Disable" : "Enable"}
                                                        </AlertDialogAction>
                                                    </AlertDialogFooter>
                                                </AlertDialogContent>
                                            </AlertDialog>
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}
