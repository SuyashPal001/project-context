import * as z from "zod";

export const PERMISSION_RESOURCES = [
    { resource: 'members',          actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'roles',            actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'invitations',      actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'api_keys',         actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'agents',           actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'agent_workflows',  actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'agent_runs',       actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'billing',          actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'subscriptions',    actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'invoices',         actions: ['read'] },
    { resource: 'audit_log',        actions: ['read'] },
    { resource: 'notifications',    actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'tenants',          actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'entitlements',     actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'webhooks',         actions: ['create', 'read', 'update', 'delete'] },
] as const;

export const PERMISSION_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export type PermissionAction = typeof PERMISSION_ACTIONS[number];

export const EXPIRY_OPTIONS = [
    { label: "7 days", value: "7d" },
    { label: "30 days", value: "30d" },
    { label: "60 days", value: "60d" },
    { label: "90 days", value: "90d" },
    { label: "1 year", value: "1y" },
    { label: "No expiration", value: "none" },
];

export const apiKeySchema = z.object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }),
    type: z.enum(["rest", "mcp", "agent"]),
    permissions: z.array(z.string()),
    expiryOption: z.string(),
});

export type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

export function expiryOptionToISO(option: string): string | null {
    if (option === "none") return null;
    const date = new Date();
    switch (option) {
        case "7d":  date.setDate(date.getDate() + 7); break;
        case "30d": date.setDate(date.getDate() + 30); break;
        case "60d": date.setDate(date.getDate() + 60); break;
        case "90d": date.setDate(date.getDate() + 90); break;
        case "1y":  date.setFullYear(date.getFullYear() + 1); break;
        default: return null;
    }
    return date.toISOString();
}
