import { z } from "zod";

export interface InviteDetails {
    tenantName: string;
    tenantSlug: string;
    roleName: string;
    inviterName: string;
    email: string;
    expiresAt: string;
}

export interface UserProfile {
    email: string;
    name: string;
}

export const createAccountSchema = z.object({
    name: z.string().min(1, { message: "Name is required" }),
    password: z.string().min(8, { message: "Password must be at least 8 characters" }),
    confirmPassword: z.string(),
}).refine(d => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
});

export const verifySchema = z.object({
    code: z.string().length(6, { message: "Verification code must be 6 digits" }),
});

export type CreateAccountSchema = z.infer<typeof createAccountSchema>;
export type VerifySchema = z.infer<typeof verifySchema>;
