"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, AlertCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

import { api, ApiError } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { can } from "@/lib/permissions";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
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
import { MembersList } from "@/components/platform/members/MembersList";
import { PermissionGate } from "@/components/platform/PermissionGate";


const inviteSchema = z.object({
    email: z.string().email({ message: "Invalid email address" }),
    roleId: z.string().min(1, { message: "Role is required" }),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

interface Role {
    id: string;
    name: string;
    isAgentRole?: boolean;
}

interface AuthData {
    permissions: string[];
}

function InviteMemberModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { tenantId } = useTenant();
    const queryClient = useQueryClient();
    const [inlineError, setInlineError] = useState<string | null>(null);
    const params = useParams<{ tenant: string }>();
    const router = useRouter();
    const tenantSlug = params?.tenant;

    const form = useForm<InviteFormValues>({
        resolver: zodResolver(inviteSchema as any),
        defaultValues: {
            email: "",
            roleId: "",
        },
    });

    // Fetch roles and filter out agent roles
    const { data: rolesData, isLoading: rolesLoading } = useQuery<{ roles: Role[] }>({
        queryKey: ["roles", tenantId],
        queryFn: () => api.get<{ roles: Role[] }>("/api/v1/roles"),
    });
    const roles = rolesData?.roles?.filter(role => !role.isAgentRole) ?? [];

    const inviteMutation = useMutation({
        mutationFn: (data: InviteFormValues) =>
            api.post("/api/v1/members/invite", data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
            form.reset();
            setInlineError(null);
            onOpenChange(false);
            toast.success("Invitation sent successfully");
        },
        onError: async (error: any) => {
            let errorData = null;
            if (error instanceof ApiError) {
                errorData = error.data;
            } else if (error.response) {
                errorData = await error.response.json().catch(() => null);
            }

            if (errorData?.code === 'FEATURE_NOT_ENTITLED') {
                toast.error("You've reached your plan's member limit. Upgrade to invite more team members.", {
                    action: {
                        label: "Upgrade",
                        onClick: () => {
                            onOpenChange(false);
                            router.push(`/${tenantSlug}/dashboard/billing`);
                        }
                    }
                });
            } else if (errorData?.code === 'ALREADY_MEMBER') {
                toast.error("This person is already a member of your workspace.");
            } else if (errorData?.code === 'INVITATION_PENDING') {
                toast.error("An invitation has already been sent to this email.");
            } else {
                toast.error(errorData?.error || "Failed to send invitation. Please try again.");
            }
        },
    });

    function onSubmit(data: InviteFormValues) {
        setInlineError(null);
        inviteMutation.mutate(data);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Invite Member</DialogTitle>
                    <DialogDescription>
                        Send an invitation email to add a new member to your workspace.
                    </DialogDescription>
                </DialogHeader>

                {inlineError && (
                    <Alert variant="destructive">
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
                                                    {role.name}
                                                </SelectItem>
                                            ))}
                                            {(!roles || roles.length === 0) && !rolesLoading && (
                                                <SelectItem value="" disabled>
                                                    No roles available
                                                </SelectItem>
                                            )}
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <div className="flex gap-3 justify-end pt-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={inviteMutation.isPending}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={inviteMutation.isPending}
                            >
                                {inviteMutation.isPending ? "Sending..." : "Send Invitation"}
                            </Button>
                        </div>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

export default function MembersPage() {
    const [inviteModalOpen, setInviteModalOpen] = useState(false);

    return (
        <PermissionGate resource="members" action="read">
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Members</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage team members and their roles
                        </p>
                    </div>
                </div>

                <MembersList onInviteClick={() => setInviteModalOpen(true)} />

                <InviteMemberModal
                    open={inviteModalOpen}
                    onOpenChange={setInviteModalOpen}
                />
            </div>
        </PermissionGate>
    );
}

