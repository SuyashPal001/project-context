"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, UserPlus } from "lucide-react";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { canUpdate } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PermissionGate } from "@/components/platform/PermissionGate";

import type { Member } from "./_types";
import { getDisplayName, getInitials } from "./_helpers";
import { useMembersData } from "./useMembersData";
import { ChangeRoleDialog } from "./ChangeRoleDialog";
import { MemberStatusCell } from "./MemberStatusCell";
import { MemberActionsCell } from "./MemberActionsCell";

export function MembersList({ onInviteClick }: { onInviteClick?: () => void }) {
    const { tenantId, userId, permissions = [] } = useTenant();
    const [activeTab, setActiveTab] = useState<"humans" | "agents">("humans");

    const {
        members, isLoading, isError, error, roles,
        suspendMutation, reactivateMutation, updateRoleMutation,
    } = useMembersData(tenantId);

    const canUpdateUsers = canUpdate(permissions, "members");

    if (isLoading) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    if (isError) {
        return (
            <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                    {error instanceof Error ? error.message : "Failed to load members."}
                </AlertDescription>
            </Alert>
        );
    }

    if (!members) return null;

    const humanMembers = members.filter(m => m.memberType === "human");
    const agentMembers = members.filter(m => m.memberType === "agent");
    const displayedMembers = activeTab === "humans" ? humanMembers : agentMembers;
    const actionsPending = suspendMutation.isPending || reactivateMutation.isPending;

    return (
        <Tabs defaultValue="humans" value={activeTab} onValueChange={(v) => setActiveTab(v as "humans" | "agents")} className="space-y-4">
            <div className="flex items-center justify-between mb-6">
                <TabsList className="bg-transparent h-auto p-0 gap-2">
                    <TabsTrigger
                        className="rounded-full px-4 py-1.5 text-sm font-medium border border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:border-foreground data-[state=active]:shadow-none"
                        value="humans"
                    >
                        Team Members ({humanMembers.length})
                    </TabsTrigger>
                    <TabsTrigger
                        className="rounded-full px-4 py-1.5 text-sm font-medium border border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:border-foreground data-[state=active]:shadow-none"
                        value="agents"
                    >
                        Agents ({agentMembers.length})
                    </TabsTrigger>
                </TabsList>
                <div className="flex items-center">
                    {activeTab === "humans" && onInviteClick && (
                        <PermissionGate resource="members" action="create" fallback={null}>
                            <Button onClick={onInviteClick} size="sm">
                                <UserPlus className="w-4 h-4 mr-2" />
                                Invite Member
                            </Button>
                        </PermissionGate>
                    )}
                    {activeTab === "agents" && (
                        <Link href={`/${tenantId}/dashboard/agents`}>
                            <Button variant="outline" size="sm">Manage Agents</Button>
                        </Link>
                    )}
                </div>
            </div>

            <TabsContent value={activeTab} className="m-0 border-none p-0 outline-none">
                {displayedMembers.length === 0 ? (
                    <div className="text-center py-10 bg-muted/20 rounded-md border border-dashed border-border mt-4">
                        <p className="text-muted-foreground">No {activeTab === "humans" ? "team members" : "agents"} found.</p>
                    </div>
                ) : (
                    <div className="rounded-md border border-border bg-card">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Member</TableHead>
                                    <TableHead>Role</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Joined</TableHead>
                                    {canUpdateUsers && <TableHead className="text-right">Actions</TableHead>}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {displayedMembers.map((member) => (
                                    <MemberRow
                                        key={member.id}
                                        member={member}
                                        roles={roles}
                                        currentUserId={userId}
                                        canUpdateUsers={canUpdateUsers}
                                        isUpdatingRole={updateRoleMutation.isPending}
                                        isReactivating={reactivateMutation.isPending}
                                        actionsPending={actionsPending}
                                        onChangeRole={(roleId) => updateRoleMutation.mutate({ memberId: member.id, roleId })}
                                        onSuspend={suspendMutation.mutate}
                                        onReactivate={reactivateMutation.mutate}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </TabsContent>
        </Tabs>
    );
}

interface MemberRowProps {
    member: Member;
    roles: { id: string; name: string }[];
    currentUserId: string | undefined;
    canUpdateUsers: boolean;
    isUpdatingRole: boolean;
    isReactivating: boolean;
    actionsPending: boolean;
    onChangeRole: (roleId: string) => void;
    onSuspend: (memberId: string) => void;
    onReactivate: (memberId: string) => void;
}

function MemberRow({
    member, roles, currentUserId, canUpdateUsers,
    isUpdatingRole, isReactivating, actionsPending,
    onChangeRole, onSuspend, onReactivate,
}: MemberRowProps) {
    return (
        <TableRow>
            <TableCell>
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center border border-border shrink-0">
                        <span className="text-xs font-bold text-accent-foreground">{getInitials(member)}</span>
                    </div>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{getDisplayName(member)}</span>
                            {member.memberType === "agent" && (
                                <Badge
                                    variant="outline"
                                    className="text-[10px] px-1.5 py-0 bg-purple-500/10 text-purple-400 border-purple-500/20"
                                >
                                    agent
                                </Badge>
                            )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                            {member.memberType === "agent"
                                ? member.agentType ?? ""
                                : member.userEmail ?? member.invitedEmail ?? ""}
                        </span>
                    </div>
                </div>
            </TableCell>
            <TableCell>
                {member.memberType === "human" && member.status === "active" ? (
                    <ChangeRoleDialog
                        member={member}
                        roles={roles}
                        isPending={isUpdatingRole}
                        onSubmit={onChangeRole}
                    />
                ) : (
                    <Badge variant="outline" className="text-xs">
                        {member.roleName || member.roleId || "No Role"}
                    </Badge>
                )}
            </TableCell>
            <TableCell>
                <MemberStatusCell
                    member={member}
                    isReactivating={isReactivating}
                    onReactivate={onReactivate}
                />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
                {member.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : "—"}
            </TableCell>
            {canUpdateUsers && (
                <TableCell className="text-right">
                    {member.userId !== currentUserId && (
                        <MemberActionsCell
                            member={member}
                            isPending={actionsPending}
                            onSuspend={onSuspend}
                            onReactivate={onReactivate}
                        />
                    )}
                </TableCell>
            )}
        </TableRow>
    );
}
