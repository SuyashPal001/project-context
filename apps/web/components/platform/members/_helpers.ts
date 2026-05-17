import type { Member } from "./_types";

export function getDisplayName(member: Member): string {
    if (member.memberType === "agent") {
        return member.agentName || "Unknown Agent";
    }
    return member.userName || member.userEmail || member.invitedEmail || "Unknown";
}

export function getInitials(member: Member): string {
    if (member.memberType === "agent") {
        const name = member.agentName;
        if (name) return name.substring(0, 2).toUpperCase();
        return "AG";
    }
    if (member.userName) return member.userName.substring(0, 2).toUpperCase();
    const email = member.userEmail || member.invitedEmail;
    if (email) return email.substring(0, 2).toUpperCase();
    return "??";
}

export const statusColors: Record<Member["status"], string> = {
    active: "bg-green-500/10 text-green-500 border-green-500/20",
    invited: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    suspended: "bg-destructive/10 text-destructive border-destructive/20",
};
