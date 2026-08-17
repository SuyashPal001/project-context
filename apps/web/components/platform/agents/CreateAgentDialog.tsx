"use client";

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { CreateAgentForm } from "./CreateAgentForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Agent } from "./types";

interface CreateAgentDialogProps {
    children?: React.ReactNode;
}

export function CreateAgentDialog({ children }: CreateAgentDialogProps) {
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<1 | 2>(1);
    const [createdAgentData, setCreatedAgentData] = useState<{ agent: Agent; apiKey: string } | null>(null);
    const [showKey, setShowKey] = useState(false);

    const handleSuccess = (data: { agent: Agent; apiKey: string }) => {
        setCreatedAgentData(data);
        setStep(2);
    };

    const handleClose = () => {
        setOpen(false);
        // Reset state after dialog animation might finish
        setTimeout(() => {
            setStep(1);
            setCreatedAgentData(null);
            setShowKey(false);
        }, 300);
    };

    const copyToClipboard = async () => {
        if (createdAgentData?.apiKey) {
            await navigator.clipboard.writeText(createdAgentData.apiKey);
            toast.success("API key copied to clipboard");
        }
    };

    return (
        <Dialog open={open} onOpenChange={(val) => {
            if (!val) handleClose();
            else setOpen(val);
        }}>
            <DialogTrigger asChild>
                {children}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
                {step === 1 ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Add New Employee</DialogTitle>
                            <DialogDescription>
                                Add a new autonomous employee to your workspace.
                            </DialogDescription>
                        </DialogHeader>
                        <CreateAgentForm onSuccess={handleSuccess} />
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle>Employee Added Successfully</DialogTitle>
                            <DialogDescription>
                                Your new employee has been added. Please copy the API key below.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <Label htmlFor="apiKey">API Key</Label>
                                <div className="relative flex gap-2">
                                    <Input
                                        id="apiKey"
                                        type={showKey ? "text" : "password"}
                                        value={createdAgentData?.apiKey || ""}
                                        readOnly
                                        className="font-mono pr-20"
                                    />
                                    <div className="absolute right-12 top-0 h-full flex items-center pr-2">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => setShowKey(!showKey)}
                                        >
                                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        className="shrink-0"
                                        onClick={copyToClipboard}
                                    >
                                        <Copy className="h-4 w-4" />
                                    </Button>
                                </div>
                                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-amber-500 text-xs">
                                    <AlertTriangle className="h-4 w-4 shrink-0" />
                                    <p>
                                        This key will never be shown again. Copy it now.
                                    </p>
                                </div>
                            </div>
                            <div className="flex justify-end gap-2">
                                <Button onClick={handleClose}>Done</Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
