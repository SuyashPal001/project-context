"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Member, Role } from "./_types";

interface MutationResponse {
    action?: "suspended" | "invite_resent" | "reactivated";
}

export function useMembersData(tenantId: string) {
    const queryClient = useQueryClient();

    const membersQuery = useQuery<Member[]>({
        queryKey: ["members", tenantId],
        queryFn: async () => {
            const response = await api.get<{ members: Member[] }>("/api/v1/members");
            return response.members;
        },
    });

    const rolesQuery = useQuery<{ roles: Role[] }>({
        queryKey: ["roles", tenantId],
        queryFn: () => api.get<{ roles: Role[] }>("/api/v1/roles"),
    });

    const suspendMutation = useMutation({
        mutationFn: (memberId: string) => api.del<MutationResponse>(`/api/v1/members/${memberId}`),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
            if (data?.action === "suspended") {
                toast.success("Member suspended");
            } else {
                toast.success("Member access updated");
            }
        },
        onError: (err) => {
            if (err instanceof ApiError && err.status === 403 && err.data?.code === "SELF_SUSPEND_FORBIDDEN") {
                toast.error("You cannot suspend your own account.");
            } else {
                toast.error("Failed to suspend member.");
            }
        },
    });

    const reactivateMutation = useMutation({
        mutationFn: (memberId: string) =>
            api.patch<MutationResponse>(`/api/v1/members/${memberId}/status`, { status: "active" }),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
            if (data?.action === "invite_resent") {
                toast.success("Invitation resent successfully");
            } else if (data?.action === "suspended") {
                toast.success("Member suspended");
            } else {
                toast.success("Member reactivated");
            }
        },
    });

    const updateRoleMutation = useMutation({
        mutationFn: ({ memberId, roleId }: { memberId: string; roleId: string }) =>
            api.patch(`/api/v1/members/${memberId}/role`, { roleId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["members", tenantId] });
            toast.success("Role updated");
        },
    });

    return {
        members: membersQuery.data,
        isLoading: membersQuery.isLoading,
        isError: membersQuery.isError,
        error: membersQuery.error,
        roles: rolesQuery.data?.roles ?? [],
        suspendMutation,
        reactivateMutation,
        updateRoleMutation,
    };
}
