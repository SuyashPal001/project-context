"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Agent } from "./types";
import { Loader2 } from "lucide-react";
import { generateDefaultAvatar } from "./avatar-builder/generateDefaultAvatar";

const formSchema = z.object({
    name: z.string().min(2, {
        message: "Name must be at least 2 characters.",
    }),
    type: z.enum(["ops", "support", "billing", "custom"]),
});

interface CreateAgentFormProps {
    onSuccess: (data: { agent: Agent; apiKey: string }) => void;
}

export function CreateAgentForm({ onSuccess }: CreateAgentFormProps) {
    const queryClient = useQueryClient();

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema as any),
        defaultValues: {
            name: "",
            type: "ops",
        },
    });

    const createAgentMutation = useMutation({
        mutationFn: (values: z.infer<typeof formSchema>) =>
            api.post<{ data: { agent: Agent; apiKey: string } }>("/api/v1/agents", values),
        onSuccess: (response) => {
            queryClient.invalidateQueries({ queryKey: ["agents"] });
            // Fire-and-forget: a new agent has no persona at creation time (this
            // form doesn't offer one), so it always qualifies for a generated
            // default. Don't block the "agent created" flow on this — re-invalidate
            // once it lands so any mounted agent list picks up the new avatar.
            generateDefaultAvatar(response.data.agent.id, response.data.agent.name)
                .then(() => queryClient.invalidateQueries({ queryKey: ["agents"] }))
                .catch((err) => console.error("Failed to generate default avatar:", err));
            onSuccess(response.data);
        },
        onError: (err: any) => {
            if (err instanceof ApiError && err.status === 403 && err.data?.code === 'AGENT_LIMIT_REACHED') {
                toast.error(`Agent limit reached. Your plan allows ${err.data.limit} agent${err.data.limit === 1 ? '' : 's'} (${err.data.used} active).`);
            } else if (err instanceof ApiError && err.status === 403) {
                toast.error('You do not have permission to create agents.');
            } else {
                toast.error('Failed to create agent.');
            }
        },
    });

    function onSubmit(values: z.infer<typeof formSchema>) {
        createAgentMutation.mutate(values);
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl>
                                <Input placeholder="Support Bot" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Type</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select an agent type" />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    <SelectItem value="ops">Ops</SelectItem>
                                    <SelectItem value="support">Support</SelectItem>
                                    <SelectItem value="billing">Billing</SelectItem>
                                    <SelectItem value="custom">Custom</SelectItem>
                                </SelectContent>
                            </Select>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <Button type="submit" className="w-full" disabled={createAgentMutation.isPending}>
                    {createAgentMutation.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Create Agent
                </Button>
            </form>
        </Form>
    );
}
