"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { z } from "zod";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, Blocks } from "lucide-react";
import { toast } from "sonner";

const createIntegrationSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(60),
  provider: z.enum(['slack', 'github', 'jira', 'google_calendar', 'custom_mcp']),
  config: z.string().optional().refine((val) => {
    if (!val || val.trim() === '') return true;
    try {
        JSON.parse(val);
        return true;
    } catch {
        return false;
    }
  }, "Config must be a valid strictly-formatted JSON object string")
});

type FormValues = z.infer<typeof createIntegrationSchema>;

export function CreateIntegrationModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
    const queryClient = useQueryClient();

    const form = useForm<FormValues>({
        resolver: zodResolver(createIntegrationSchema as any),
        defaultValues: {
            name: "",
            provider: "slack",
            config: "{\n  \n}"
        }
    });

    const createMutation = useMutation({
        mutationFn: async (data: FormValues) => {
            const payload = {
                name: data.name,
                provider: data.provider,
                config: data.config && data.config.trim() ? JSON.parse(data.config) : {}
            };
            return api.post('/api/v1/integrations', payload);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['integrations'] });
            toast.success("Integration configured successfully.");
            handleClose();
        },
        onError: (err: any) => {
            toast.error(err.response?.data?.error || "Failed to configure integration.");
        }
    });

    const handleClose = () => {
        onOpenChange(false);
        setTimeout(() => form.reset(), 300);
    };

    const watchProvider = form.watch("provider");

    const onSubmit = (values: FormValues) => {
        createMutation.mutate(values);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800 p-0 overflow-hidden">
                <DialogHeader className="px-6 py-5 border-b border-zinc-800 bg-zinc-900/50">
                    <DialogTitle className="flex items-center gap-2">
                        <Blocks className="w-5 h-5 text-primary" /> Create Integration
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        Attach a verified external SaaS provider or configure custom Model Context Protocol bounds.
                    </DialogDescription>
                </DialogHeader>
                
                <form id="create-integration-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 px-6 py-6">
                    <div className="space-y-2">
                        <Label htmlFor="provider" className="text-zinc-300">Cloud Provider Node</Label>
                        <Controller
                            control={form.control}
                            name="provider"
                            render={({ field }) => (
                                <Select onValueChange={field.onChange} defaultValue={field.value}>
                                    <SelectTrigger className="bg-zinc-900 border-zinc-800 text-zinc-300">
                                        <SelectValue placeholder="Select platform category" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-zinc-900 border-zinc-800">
                                        <SelectItem value="slack">Slack Server</SelectItem>
                                        <SelectItem value="github">GitHub Organization</SelectItem>
                                        <SelectItem value="jira">Jira Instance</SelectItem>
                                        <SelectItem value="google_calendar">Google Calendar</SelectItem>
                                        <SelectItem value="custom_mcp">Generic Custom MCP Server</SelectItem>
                                    </SelectContent>
                                </Select>
                            )}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="name" className="text-zinc-300">Instance Label</Label>
                        <Input 
                            id="name" 
                            placeholder={`e.g. My ${watchProvider.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} Bridge`}
                            {...form.register("name")}
                            className="bg-zinc-900 border-zinc-800 text-zinc-200 placeholder:text-zinc-600"
                        />
                        {form.formState.errors.name && (
                            <p className="text-sm font-medium text-red-500">{form.formState.errors.name.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="config" className="flex items-center gap-2 text-zinc-300">
                                Configuration JSON <span className="text-[10px] text-zinc-500 uppercase tracking-widest bg-zinc-800 px-1.5 py-0.5 rounded-sm">(Optional MCP Config)</span>
                            </Label>
                        </div>
                        <textarea
                            id="config"
                            {...form.register("config")}
                            className="w-full flex min-h-[140px] rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-mono text-zinc-300 shadow-inner placeholder:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                            placeholder='{&#10;  "apiKey": "sk_abc123..."&#10;}'
                        />
                        {form.formState.errors.config && (
                            <p className="text-sm font-medium text-red-500">{form.formState.errors.config.message}</p>
                        )}
                    </div>
                </form>

                <DialogFooter className="px-6 py-4 border-t border-zinc-800 bg-zinc-950">
                    <Button variant="outline" type="button" onClick={handleClose} disabled={createMutation.isPending}>
                        Cancel
                    </Button>
                    <Button type="submit" form="create-integration-form" disabled={createMutation.isPending}>
                        {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Connect Instance
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
