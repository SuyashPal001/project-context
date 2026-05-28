"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings } from "lucide-react";
import { ImageUpload } from "@/components/platform/ImageUpload";

const brandingFormSchema = z.object({
    brandName: z.string().max(100).optional().nullable(),
    logoUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
});

type BrandingFormValues = z.infer<typeof brandingFormSchema>;

export default function BrandingPage() {
    const queryClient = useQueryClient();

    const { data: brandingData, isLoading } = useQuery({
        queryKey: ["branding"],
        queryFn: async () => {
            const res = await api.get<{ data: BrandingFormValues }>("/api/v1/branding");
            return res.data;
        },
    });

    const form = useForm<BrandingFormValues>({
        resolver: zodResolver(brandingFormSchema as any),
        defaultValues: {
            brandName: "",
            logoUrl: "",
        },
    });

    useEffect(() => {
        if (brandingData) {
            form.reset({
                brandName: brandingData.brandName || "",
                logoUrl: brandingData.logoUrl || "",
            });
        }
    }, [brandingData, form]);

    const updateBranding = useMutation({
        mutationFn: async (values: BrandingFormValues) => {
            const payload = {
                brandName: values.brandName || null,
                logoUrl: values.logoUrl || null,
            };
            return api.patch("/api/v1/branding", payload);
        },
        onSuccess: () => {
            toast.success("Branding updated successfully");
            queryClient.invalidateQueries({ queryKey: ["branding"] });
        },
        onError: (error: any) => {
            toast.error(error.message || "Failed to update branding");
        },
    });

    function onSubmit(values: BrandingFormValues) {
        updateBranding.mutate(values);
    }

    if (isLoading) {
        return (
            <div className="space-y-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Branding</h1>
                    <p className="text-muted-foreground">Manage your workspace identity and appearance.</p>
                </div>
                <Card>
                    <CardHeader>
                        <Skeleton className="h-6 w-1/4" />
                        <Skeleton className="h-4 w-1/2" />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Branding</h1>
                <p className="text-muted-foreground">Manage your workspace identity and appearance.</p>
            </div>

            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Settings className="h-5 w-5" />
                                Workspace Branding
                            </CardTitle>
                            <CardDescription>
                                Set the name and logo for your workspace.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-8 max-w-2xl">
                            <FormField
                                control={form.control}
                                name="brandName"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Brand Name</FormLabel>
                                        <FormControl>
                                            <Input placeholder="e.g. Acme Corp" {...field} value={field.value || ""} />
                                        </FormControl>
                                        <FormDescription>
                                            The name of your organization or project.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="logoUrl"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Workspace Logo</FormLabel>
                                        <FormControl>
                                            <ImageUpload 
                                                value={field.value || ""} 
                                                onChange={field.onChange}
                                                fallbackText={form.getValues("brandName") || "LB"}
                                            />
                                        </FormControl>
                                        <FormDescription>
                                            Your workspace logo. We recommend a square image.
                                        </FormDescription>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </CardContent>
                        <div className="p-6 pt-0 flex justify-end">
                            <Button type="submit" disabled={updateBranding.isPending}>
                                {updateBranding.isPending ? "Saving..." : "Save changes"}
                            </Button>
                        </div>
                    </Card>
                </form>
            </Form>
        </div>
    );
}
