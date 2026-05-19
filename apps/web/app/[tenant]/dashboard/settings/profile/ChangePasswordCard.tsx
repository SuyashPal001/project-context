"use client";

import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Loader2, LockKeyhole } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const changePasswordSchema = z
    .object({
        currentPassword: z.string().min(1, "Current password is required"),
        newPassword: z.string().min(8, "New password must be at least 8 characters"),
        confirmPassword: z.string().min(1, "Please confirm your new password"),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
    });

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

export function ChangePasswordCard() {
    const { identities } = useTenant();

    const form = useForm<ChangePasswordFormValues>({
        resolver: zodResolver(changePasswordSchema),
        defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    });

    const changePwMutation = useMutation({
        mutationFn: (data: ChangePasswordFormValues) =>
            api.post("/api/v1/auth/change-password", {
                currentPassword: data.currentPassword,
                newPassword: data.newPassword,
            }),
        onSuccess: () => {
            toast.success("Password updated successfully");
            form.reset();
        },
        onError: (error: unknown) => {
            if (error instanceof ApiError) {
                const code = error.data?.code;
                if (code === "WRONG_CURRENT_PASSWORD") {
                    form.setError("currentPassword", { message: "Current password is incorrect" });
                    return;
                }
                if (code === "SOCIAL_ACCOUNT_NO_PASSWORD") {
                    toast.error("Password change is not available for accounts that sign in with Google or SSO.");
                    return;
                }
                if (code === "INVALID_NEW_PASSWORD") {
                    form.setError("newPassword", { message: error.data?.error || "Password does not meet requirements" });
                    return;
                }
            }
            toast.error("Failed to change password. Please try again.");
        },
    });

    let socialProvider: string | null = null;
    if (identities) {
        try {
            const parsed = JSON.parse(identities as string);
            const name = parsed?.[0]?.providerName;
            if (name && name.toLowerCase() !== "cognito") {
                socialProvider = name;
            }
        } catch {
            // parse failure → show the form
        }
    }

    if (socialProvider) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <LockKeyhole className="h-5 w-5" />
                        Change Password
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">
                        You signed in with{" "}
                        <span className="font-medium text-foreground">{socialProvider}</span>.
                        Password management is handled by your provider.
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <Form {...form}>
                <form onSubmit={form.handleSubmit((d) => changePwMutation.mutate(d))}>
                    <CardHeader className="border-b">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <LockKeyhole className="h-5 w-5" />
                            Change Password
                        </CardTitle>
                        <CardDescription>
                            Update your password. Not available for accounts that sign in with Google.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="p-6 space-y-6 max-w-xl">
                        <FormField control={form.control} name="currentPassword" render={({ field }) => (
                            <FormItem>
                                <FormLabel>Current Password</FormLabel>
                                <FormControl>
                                    <Input type="password" placeholder="••••••••" disabled={changePwMutation.isPending} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )} />
                        <FormField control={form.control} name="newPassword" render={({ field }) => (
                            <FormItem>
                                <FormLabel>New Password</FormLabel>
                                <FormControl>
                                    <Input type="password" placeholder="••••••••" disabled={changePwMutation.isPending} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )} />
                        <FormField control={form.control} name="confirmPassword" render={({ field }) => (
                            <FormItem>
                                <FormLabel>Confirm New Password</FormLabel>
                                <FormControl>
                                    <Input type="password" placeholder="••••••••" disabled={changePwMutation.isPending} {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )} />
                    </CardContent>
                    <CardFooter className="border-t border-border px-6 py-4 flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">Keep your password secure.</p>
                        <Button type="submit" disabled={changePwMutation.isPending}>
                            {changePwMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Update Password
                        </Button>
                    </CardFooter>
                </form>
            </Form>
        </Card>
    );
}
