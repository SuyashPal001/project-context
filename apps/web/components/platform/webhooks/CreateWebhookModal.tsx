"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/platform/shared";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const createWebhookSchema = z.object({
  url: z.string().url("Must be a valid URL starting with https:// or http://").min(1, "URL is required"),
  events: z.array(z.string()).min(1, "Select at least one event"),
});

type FormValues = z.infer<typeof createWebhookSchema>;

export function CreateWebhookModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
    const queryClient = useQueryClient();
    const [secret, setSecret] = useState<string | null>(null);

    const { data: eventsData, isLoading: isLoadingEvents } = useQuery({
        queryKey: ['events'],
        queryFn: () => api.get<{ data: Record<string, any[]> }>('/api/v1/events'),
        enabled: open && !secret
    });

    const form = useForm<FormValues>({
        resolver: zodResolver(createWebhookSchema as any),
        defaultValues: {
            url: "",
            events: [],
        }
    });

    const createMutation = useMutation({
        mutationFn: async (data: FormValues) => {
            return api.post<{ data: any, secret: string }>('/api/v1/webhooks', data);
        },
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: ['webhooks'] });
            setSecret(res.secret);
            toast.success("Webhook endpoint deployed successfully.");
        },
        onError: (err: any) => {
            toast.error(err.data?.error || "Failed to create webhook. Verify the payload URL isn't localized or invalid.");
        }
    });

    const handleClose = () => {
        onOpenChange(false);
        setTimeout(() => {
            setSecret(null);
            form.reset();
        }, 300);
    };

    const isAllChecked = form.watch("events").includes("*");

    const onSubmit = (values: FormValues) => {
        createMutation.mutate(values);
    };

    if (secret) {
        return (
            <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
                <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800">
                    <DialogHeader>
                        <DialogTitle>Endpoint Created</DialogTitle>
                        <DialogDescription className="text-amber-500 font-medium">
                            Warning: This securely generated signing secret will only be shown ONCE. Copy it now and store it in your backend variables to verify payload signatures.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-6">
                        <Label>Webhook Secret</Label>
                        <div className="flex items-center mt-2 gap-3 bg-zinc-900 border border-zinc-800 p-3 rounded-md">
                            <code className="text-sm text-zinc-300 font-mono flex-1 break-all select-all">
                                {secret}
                            </code>
                            <CopyButton value={secret} className="shrink-0" />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button onClick={handleClose}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl bg-zinc-950 border-zinc-800 h-[85vh] flex flex-col p-0 overflow-hidden">
                <DialogHeader className="px-6 py-4 border-b border-zinc-800 bg-zinc-950 z-10">
                    <DialogTitle>Add Endpoint</DialogTitle>
                    <DialogDescription>
                        Register a new destination URL to programmatically receive webhook event triggers.
                    </DialogDescription>
                </DialogHeader>
                
                <form id="create-webhook-form" onSubmit={form.handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <Label htmlFor="url">Payload URL</Label>
                            <Input 
                                id="url" 
                                placeholder="https://api.yourdomain.com/webhooks" 
                                {...form.register("url")}
                                className="bg-zinc-900 border-zinc-800"
                            />
                            {form.formState.errors.url && (
                                <p className="text-sm text-red-500 font-medium">{form.formState.errors.url.message}</p>
                            )}
                        </div>
                        
                        <div className="space-y-4">
                            <Label>Events to send</Label>
                            {form.formState.errors.events && (
                                <p className="text-sm text-red-500 font-medium mt-0">{form.formState.errors.events.message}</p>
                            )}
                            
                            <div className="border border-zinc-800 rounded-md bg-zinc-900/50 p-5 space-y-5">
                                <div className="flex items-center space-x-3 pb-5 border-b border-zinc-800">
                                    <Checkbox 
                                        id="all-events"
                                        checked={isAllChecked}
                                        onCheckedChange={(checked) => {
                                            if (checked) {
                                                form.setValue("events", ["*"]);
                                            } else {
                                                form.setValue("events", []);
                                            }
                                        }}
                                        className="border-zinc-500"
                                    />
                                    <Label htmlFor="all-events" className="text-base font-semibold cursor-pointer tracking-tight">
                                        Send me everything (All events)
                                    </Label>
                                </div>
                                
                                {isLoadingEvents ? (
                                    <div className="py-6 flex justify-center">
                                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                    </div>
                                ) : (
                                    <div className="space-y-8 lg:max-h-[300px] pr-2">
                                        {Object.entries(eventsData?.data || {}).map(([category, events]) => (
                                            <div key={category} className="space-y-4">
                                                <h4 className="text-xs tracking-wider uppercase font-semibold text-zinc-500">{category}</h4>
                                                <div className="space-y-3 pl-1">
                                                    {events.map((evt: any) => (
                                                        <div key={evt.event} className="flex flex-start space-x-3 group">
                                                            <Controller
                                                                name="events"
                                                                control={form.control}
                                                                render={({ field }) => (
                                                                    <Checkbox
                                                                        id={`event-${evt.event}`}
                                                                        disabled={isAllChecked}
                                                                        checked={field.value.includes(evt.event)}
                                                                        onCheckedChange={(checked) => {
                                                                            if (checked) {
                                                                                field.onChange([...field.value.filter(v => v !== '*'), evt.event]);
                                                                            } else {
                                                                                field.onChange(field.value.filter((v: string) => v !== evt.event));
                                                                            }
                                                                        }}
                                                                        className="mt-0.5 border-zinc-700 data-[state=checked]:border-primary"
                                                                    />
                                                                )}
                                                            />
                                                            <div className="grid gap-1.5 leading-none cursor-pointer">
                                                                <Label htmlFor={`event-${evt.event}`} className={`font-medium ${isAllChecked ? 'opacity-30' : 'group-hover:text-zinc-200'} transition-colors cursor-pointer`}>
                                                                    {evt.event}
                                                                </Label>
                                                                <p className={`text-xs text-zinc-500 ${isAllChecked ? 'opacity-30' : ''}`}>
                                                                    {evt.description}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </form>

                <DialogFooter className="px-6 py-4 border-t border-zinc-800 bg-zinc-950 shrink-0">
                    <Button variant="outline" type="button" onClick={handleClose} disabled={createMutation.isPending}>
                        Cancel
                    </Button>
                    <Button type="submit" form="create-webhook-form" disabled={createMutation.isPending}>
                        {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Deploy Endpoint
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
