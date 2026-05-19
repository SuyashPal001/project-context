"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { Form } from "@/components/ui/form";

import { apiKeySchema, expiryOptionToISO, type ApiKeyFormValues } from "./_config";
import { Stepper } from "./Stepper";
import { KeyDetailsStep } from "./KeyDetailsStep";
import { PermissionsStep } from "./PermissionsStep";

interface CreateApiKeyFormProps {
    onSuccess: (data: { key: string; name: string; type: string }) => void;
}

export function CreateApiKeyForm({ onSuccess }: CreateApiKeyFormProps) {
    const { tenantId } = useTenant();
    const queryClient = useQueryClient();
    const [step, setStep] = useState<1 | 2>(1);

    const form = useForm<ApiKeyFormValues>({
        resolver: zodResolver(apiKeySchema),
        defaultValues: { name: "", type: "rest", permissions: [], expiryOption: "none" },
    });

    const createMutation = useMutation({
        mutationFn: (values: ApiKeyFormValues) => {
            const payload = {
                name: values.name,
                type: values.type,
                permissions: values.permissions,
                expiresAt: expiryOptionToISO(values.expiryOption),
            };
            return api.post<{ data: { id: string; name: string; type: string; key: string } }>(
                "/api/v1/api-keys",
                payload,
            );
        },
        onSuccess: (response) => {
            const data = response.data;
            queryClient.invalidateQueries({ queryKey: ["api-keys", tenantId] });
            toast.success("API key created successfully");
            form.reset();
            onSuccess({ key: data.key, name: data.name, type: data.type });
        },
        onError: (err) => {
            const msg = err instanceof Error ? err.message : "Failed to create API key";
            toast.error(msg);
        },
    });

    const handleNext = async () => {
        const isValid = await form.trigger(["name", "type", "expiryOption"]);
        if (isValid) setStep(2);
    };

    return (
        <div className="space-y-6">
            <Stepper step={step} />

            <Form {...form}>
                <form onSubmit={form.handleSubmit((values) => createMutation.mutate(values))} className="space-y-4">
                    {step === 1 && <KeyDetailsStep form={form} onNext={handleNext} />}
                    {step === 2 && (
                        <PermissionsStep
                            form={form}
                            isSubmitting={createMutation.isPending}
                            onBack={() => setStep(1)}
                        />
                    )}
                </form>
            </Form>
        </div>
    );
}
