"use client";

import type { UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
    Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { EXPIRY_OPTIONS, type ApiKeyFormValues } from "./_config";

interface KeyDetailsStepProps {
    form: UseFormReturn<ApiKeyFormValues>;
    onNext: () => void;
}

export function KeyDetailsStep({ form, onNext }: KeyDetailsStepProps) {
    return (
        <div className="space-y-6 pt-4">
            <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>Key Name</FormLabel>
                        <FormControl>
                            <Input placeholder="e.g. My Application" {...field} />
                        </FormControl>
                        <FormDescription>A friendly name to identify this key.</FormDescription>
                        <FormMessage />
                    </FormItem>
                )}
            />

            <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                    <FormItem>
                        <FormLabel>Key Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select a key type" />
                                </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                                <SelectItem value="rest">REST API (Standard)</SelectItem>
                                <SelectItem value="mcp">MCP (Model Context Protocol)</SelectItem>
                                <SelectItem value="agent">Agent (Autonomous)</SelectItem>
                            </SelectContent>
                        </Select>
                        <FormMessage />
                    </FormItem>
                )}
            />

            <FormField
                control={form.control}
                name="expiryOption"
                render={({ field }) => (
                    <FormItem className="space-y-3">
                        <FormLabel>Expiration</FormLabel>
                        <FormControl>
                            <RadioGroup
                                onValueChange={field.onChange}
                                defaultValue={field.value}
                                className="grid grid-cols-2 gap-4"
                            >
                                {EXPIRY_OPTIONS.map((opt) => (
                                    <FormItem key={opt.value} className="flex items-center space-x-3 space-y-0">
                                        <FormControl>
                                            <RadioGroupItem value={opt.value} />
                                        </FormControl>
                                        <FormLabel className="font-normal cursor-pointer w-full">
                                            {opt.label}
                                        </FormLabel>
                                    </FormItem>
                                ))}
                            </RadioGroup>
                        </FormControl>
                        <FormMessage />
                    </FormItem>
                )}
            />

            <div className="flex justify-end pt-4">
                <Button type="button" onClick={onNext} className="w-full">
                    Next: Permissions
                </Button>
            </div>
        </div>
    );
}
