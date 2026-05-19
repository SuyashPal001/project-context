"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, User } from "lucide-react";

import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageUpload } from "@/components/platform/ImageUpload";

import { ChangePasswordCard } from "./ChangePasswordCard";
import { DeleteAccountModal } from "./DeleteAccountModal";

const profileSchema = z.object({
    name: z.string().min(1, "Name is required").max(100),
    avatarUrl: z.string().url("Must be a valid URL").or(z.string().length(0)).optional().nullable(),
});

type ProfileFormValues = z.infer<typeof profileSchema>;

interface UserProfile {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
}

export default function ProfileSettingsPage() {
    const { email } = useTenant();
    const queryClient = useQueryClient();
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);

    const { data, isLoading } = useQuery<{ user: UserProfile }>({
        queryKey: ["user-profile"],
        queryFn: () => api.get<{ user: UserProfile }>("/api/v1/users/profile"),
    });

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(profileSchema),
        defaultValues: { name: "", avatarUrl: "" },
    });

    useEffect(() => {
        if (data?.user) {
            form.reset({
                name: data.user.name,
                avatarUrl: data.user.avatarUrl || "",
            });
        }
    }, [data, form]);

    const updateMutation = useMutation({
        mutationFn: (values: ProfileFormValues) =>
            api.patch("/api/v1/users/profile", {
                name: values.name,
                avatarUrl: values.avatarUrl || null,
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["user-profile"] });
            toast.success("Profile updated");
        },
        onError: () => {
            toast.error("Failed to update profile. Please try again.");
        },
    });

    if (isLoading) {
        return (
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Profile Settings</h1>
                    <p className="text-muted-foreground mt-1">Manage your personal account details.</p>
                </div>
                <Card>
                    <CardHeader>
                        <Skeleton className="h-6 w-1/4" />
                        <Skeleton className="h-4 w-1/2" />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Skeleton className="h-20 w-20 rounded-full" />
                        <Skeleton className="h-10 w-full max-w-md" />
                        <Skeleton className="h-10 w-full max-w-md" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    const userEmail = data?.user?.email || email || "";

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Profile Settings</h1>
                <p className="text-muted-foreground mt-1">Manage your personal account details.</p>
            </div>

            <Card>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit((d) => updateMutation.mutate(d))}>
                        <CardHeader className="border-b">
                            <CardTitle className="flex items-center gap-2 text-lg">
                                <User className="h-5 w-5" />
                                Personal Information
                            </CardTitle>
                            <CardDescription>
                                Update your display name and profile photo.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="p-6 space-y-8 max-w-xl">
                            <FormField
                                control={form.control}
                                name="avatarUrl"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Profile Photo</FormLabel>
                                        <FormControl>
                                            <ImageUpload
                                                value={field.value || ""}
                                                onChange={field.onChange}
                                                fallbackText={form.getValues("name") || userEmail}
                                                disabled={updateMutation.isPending}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="name"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Display Name</FormLabel>
                                        <FormControl>
                                            <Input
                                                placeholder="Your name"
                                                disabled={updateMutation.isPending}
                                                {...field}
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <div className="space-y-2">
                                <p className="text-sm font-medium leading-none">Email</p>
                                <Input
                                    value={userEmail}
                                    disabled
                                    className="text-muted-foreground cursor-not-allowed"
                                />
                                <p className="text-xs text-muted-foreground">
                                    Email address cannot be changed.
                                </p>
                            </div>
                        </CardContent>
                        <CardFooter className="border-t border-border px-6 py-4 flex items-center justify-between">
                            <p className="text-sm text-muted-foreground">
                                Please use 32 characters at maximum.
                            </p>
                            <Button type="submit" disabled={updateMutation.isPending}>
                                {updateMutation.isPending && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                )}
                                Save changes
                            </Button>
                        </CardFooter>
                    </form>
                </Form>
            </Card>

            <ChangePasswordCard />

            <Card className="border-destructive/30">
                <CardHeader className="border-b border-destructive/20">
                    <CardTitle className="text-destructive text-lg">Danger Zone</CardTitle>
                    <CardDescription>
                        Irreversible and destructive actions.
                    </CardDescription>
                </CardHeader>
                <CardContent className="p-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between rounded-lg border border-border px-4 py-4 gap-4">
                        <div>
                            <p className="text-sm font-medium">Delete account</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Permanently delete your account and all associated data.
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            onClick={() => setDeleteModalOpen(true)}
                        >
                            Delete account
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <DeleteAccountModal
                open={deleteModalOpen}
                onOpenChange={setDeleteModalOpen}
                userEmail={userEmail}
            />
        </div>
    );
}
