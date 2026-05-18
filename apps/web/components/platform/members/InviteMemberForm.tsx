"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { can } from "@/lib/permissions";

import { Button } from "@/components/ui/button";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

const inviteSchema = z.object({
    email: z.string().email({ message: "Invalid email address" }),
    roleId: z.string().min(1, { message: "Role is required" }),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

interface Role {
    id: string;
    name: string;
}

export function InviteMemberForm() {
    const { tenantId, permissions = [] } = useTenant();
    const queryClient = useQueryClient();
    const [inlineError, setInlineError] = useState<string | null>(null);

    const canCreateUsers = can(permissions, "members", "create");

    const form = useForm<InviteFormValues>({
        resolver: zodResolver(inviteSchema),
        defaultValues: {
            email: "",
            roleId: "",
        },
    });

    const { data: roles, isLoading: rolesLoading } = useQuery<Role[]>({
        queryKey: ["roles", tenantId],
        queryFn: async () => {
            const res = await api.get<{ roles: Role[] }>("/api/v1/roles");
            return res.roles;
        },
        enabled: canCreateUsers, // only fetch if user can see the form
    });

    const inviteMutation = useMutation({
        mutationFn: (data: InviteFormValues) =>
            api.post("/api/v1/members/invite", data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
            form.reset();
            setInlineError(null);
            toast.success("Invitation sent successfully");
        },
        onError: (error: Error) => {
            setInlineError(error.message || "Failed to invite member");
            toast.error("Failed to send invitation");
        },
    });

    if (!canCreateUsers) {
        return null;
    }

    function onSubmit(data: InviteFormValues) {
        setInlineError(null);
        inviteMutation.mutate(data);
    }

    return (
        <div className="p-6 rounded-md border border-border bg-card">
            <div className="mb-4">
                <h3 className="text-lg font-medium text-foreground">Invite Member</h3>
                <p className="text-sm text-muted-foreground">
                    Send an invitation email to add a new member to this tenant.
                </p>
            </div>

            {inlineError && (
                <Alert variant="destructive" className="mb-4">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{inlineError}</AlertDescription>
                </Alert>
            )}

            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Email Address</FormLabel>
                                <FormControl>
                                    <Input
                                        placeholder="name@example.com"
                                        type="email"
                                        disabled={inviteMutation.isPending}
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="roleId"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Role</FormLabel>
                                <Select
                                    disabled={inviteMutation.isPending || rolesLoading}
                                    onValueChange={field.onChange}
                                    defaultValue={field.value}
                                    value={field.value}
                                >
                                    <FormControl>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select a role" />
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        {roles?.map((role) => (
                                            <SelectItem key={role.id} value={role.id}>
                                                {role.name || role.id}
                                            </SelectItem>
                                        ))}
                                        {(!roles || roles.length === 0) && (
                                            <SelectItem value="admin">Admin (Fallback)</SelectItem>
                                        )}
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    <Button
                        type="submit"
                        className="w-full"
                        disabled={inviteMutation.isPending}
                    >
                        {inviteMutation.isPending ? "Sending..." : "Send Invitation"}
                    </Button>
                </form>
            </Form>
        </div>
    );
}
