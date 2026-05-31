"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, AlertCircle, Users, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import type { OpsTeamResponse } from "@/components/platform/ops/types";

const addMemberSchema = z.object({
    name:     z.string().min(1, "Name is required"),
    email:    z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
});
type AddMemberFormValues = z.infer<typeof addMemberSchema>;

const QUERY_KEY = ["ops-team"] as const;

function fmtDate(iso: string) {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(iso));
}

export default function OpsTeamPage() {
    const queryClient = useQueryClient();
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);

    const { data, isLoading, isError, error } = useQuery<OpsTeamResponse>({
        queryKey: QUERY_KEY,
        queryFn: () => api.get<OpsTeamResponse>("/api/v1/ops/team"),
    });

    const { data: me } = useQuery<{ userId: string }>({
        queryKey: ["ops-me"],
        queryFn: () => api.get<{ userId: string }>("/api/v1/auth/me"),
    });

    const form = useForm<AddMemberFormValues>({
        resolver: zodResolver(addMemberSchema as any),
        defaultValues: { name: "", email: "", password: "" },
    });

    const addMutation = useMutation({
        mutationFn: (v: AddMemberFormValues) => api.post("/api/v1/ops/team", v),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            toast.success("Team member added");
            setIsDialogOpen(false);
            form.reset();
        },
        onError: (err) => {
            toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to add team member");
        },
    });

    const removeMutation = useMutation({
        mutationFn: (userId: string) => api.del(`/api/v1/ops/team/${userId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            toast.success("Team member removed");
        },
        onError: (err) => {
            toast.error(err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : "Failed to remove team member");
        },
    });

    const team = data?.team ?? [];
    const currentUserId = me?.userId;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Ops Team</h1>
                    <p className="text-zinc-500 text-sm mt-1">Platform administrators with Mission Control access.</p>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button size="sm">
                            <Plus className="mr-2 h-4 w-4" />Add Team Member
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[400px] bg-zinc-900 border-zinc-800">
                        <DialogHeader>
                            <DialogTitle>Add Team Member</DialogTitle>
                            <DialogDescription className="text-zinc-500">
                                Create a new platform administrator account.
                            </DialogDescription>
                        </DialogHeader>
                        <Form {...form}>
                            <form onSubmit={form.handleSubmit((v) => addMutation.mutate(v))} className="space-y-4 pt-2">
                                <FormField control={form.control} name="name" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Name</FormLabel>
                                        <FormControl>
                                            <Input placeholder="Ada Lovelace" {...field} className="bg-zinc-950 border-zinc-700" />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="email" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Email</FormLabel>
                                        <FormControl>
                                            <Input type="email" placeholder="ada@example.com" {...field} className="bg-zinc-950 border-zinc-700" />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <FormField control={form.control} name="password" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-zinc-300">Password</FormLabel>
                                        <FormControl>
                                            <Input type="password" placeholder="••••••••" {...field} className="bg-zinc-950 border-zinc-700" />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                                <div className="flex justify-end gap-3 pt-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setIsDialogOpen(false)}
                                        className="border-zinc-700"
                                    >
                                        Cancel
                                    </Button>
                                    <Button type="submit" size="sm" disabled={addMutation.isPending}>
                                        {addMutation.isPending ? "Creating…" : "Add Member"}
                                    </Button>
                                </div>
                            </form>
                        </Form>
                    </DialogContent>
                </Dialog>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load team members."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && team.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-zinc-600 border border-zinc-800 rounded-xl bg-zinc-900">
                    <Users className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No team members yet.</p>
                </div>
            )}

            {(isLoading || team.length > 0) && (
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 hover:bg-transparent">
                                {["Name", "Email", "Added", ""].map((h, i) => (
                                    <TableHead key={i} className="text-zinc-500 text-xs">{h}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 4 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800">
                                        {Array.from({ length: 4 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : team.map((member) => (
                                    <TableRow key={member.id} className="border-zinc-800 hover:bg-zinc-800/30">
                                        <TableCell className="text-zinc-200 text-sm font-medium">{member.name}</TableCell>
                                        <TableCell className="text-zinc-400 text-sm font-mono">{member.email}</TableCell>
                                        <TableCell className="text-zinc-500 text-sm">{fmtDate(member.createdAt)}</TableCell>
                                        <TableCell>
                                            {member.id !== currentUserId && (
                                                <AlertDialog>
                                                    <AlertDialogTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 w-8 p-0 text-zinc-600 hover:text-destructive"
                                                            disabled={removeMutation.isPending}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </AlertDialogTrigger>
                                                    <AlertDialogContent>
                                                        <AlertDialogHeader>
                                                            <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
                                                            <AlertDialogDescription>
                                                                Remove {member.name} from Mission Control? They will lose ops portal access immediately.
                                                            </AlertDialogDescription>
                                                        </AlertDialogHeader>
                                                        <AlertDialogFooter>
                                                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                            <AlertDialogAction
                                                                onClick={() => removeMutation.mutate(member.id)}
                                                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                                            >
                                                                Remove
                                                            </AlertDialogAction>
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
        </div>
    );
}
