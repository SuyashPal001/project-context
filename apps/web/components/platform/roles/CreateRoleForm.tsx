"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
    FormDescription,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const roleSchema = z.object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }),
    description: z.string().optional(),
});

type RoleFormValues = z.infer<typeof roleSchema>;

interface CreateRoleFormProps {
    onSuccess: () => void;
    onUpgradeRequired?: () => void;
}

export function CreateRoleForm({ onSuccess, onUpgradeRequired }: CreateRoleFormProps) {
    const { tenantId } = useTenant();
    const queryClient = useQueryClient();

    const form = useForm<RoleFormValues>({
        resolver: zodResolver(roleSchema as any),
        defaultValues: {
            name: "",
            description: "",
        },
    });

    const createMutation = useMutation({
        mutationFn: (values: RoleFormValues) => {
            // Derive roleId from name: lowercase, replace spaces with hyphens
            const roleId = values.name.toLowerCase().trim().replace(/\s+/g, "-");
            return api.post("/api/v1/roles", { ...values, roleId });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["roles", tenantId] });
            toast.success("Role created successfully");
            form.reset();
            onSuccess();
        },
        onError: (error: Error) => {
            // Check if this is a plan gate error
            if (error instanceof ApiError && error.data?.code === 'FEATURE_NOT_AVAILABLE') {
                if (onUpgradeRequired) {
                    onUpgradeRequired();
                    return;
                }
            }
            toast.error(error.message || "Failed to create role");
        },
    });

    function onSubmit(data: RoleFormValues) {
        createMutation.mutate(data);
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Role Name</FormLabel>
                            <FormControl>
                                <Input placeholder="e.g. Project Manager" {...field} />
                            </FormControl>
                            <FormDescription>
                                A unique name for this role.
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Description</FormLabel>
                            <FormControl>
                                <Textarea
                                    placeholder="Describe what members with this role can do..."
                                    className="resize-none"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <div className="flex justify-end gap-3 pt-4">
                    <Button
                        type="submit"
                        disabled={createMutation.isPending}
                        className="w-full"
                    >
                        {createMutation.isPending ? "Creating..." : "Create Role"}
                    </Button>
                </div>
            </form>
        </Form>
    );
}
