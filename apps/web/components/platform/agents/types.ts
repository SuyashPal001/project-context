"use client";

import * as z from "zod";
import type { PersonaSummary } from "@/components/platform/personas/types";
import type { AvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";

export const agentSchema = z.object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }),
    type: z.enum(["ops", "support", "billing", "custom", "product_manager", "analyst", "project_manager", "tech_lead", "architect"]),
    model: z.string().optional(),
});

export type AgentFormValues = z.infer<typeof agentSchema>;

export type AgentType = "ops" | "support" | "billing" | "custom" | "product_manager" | "analyst" | "project_manager" | "tech_lead" | "architect";
export type AgentStatus = "active" | "paused" | "retired";

export interface Agent {
    id: string;
    tenantId: string;
    name: string;
    type: AgentType;
    status: AgentStatus;
    model: string | null;
    llmProviderId: string | null;
    isInternal: boolean;
    isDefault: boolean;
    description: string | null;
    persona: PersonaSummary | null;
    createdAt: string;
}

export interface AgentsResponse {
    data: Agent[];
}

export interface AgentDetail extends Agent {
    createdBy: string;
    createdByName: string | null;
    description: string | null;
    avatarUrl: string | null;
    avatarParams: AvatarParams | null;
}

export interface Workflow {
    id: string;
    name: string;
    status: "active" | "inactive";
    lastRunAt?: string;
    runCount: number;
}

export interface WorkflowsResponse {
    workflows: Workflow[];
}

export interface StepCompleted {
    stepOrder: number;
    toolName: string;
    status: string;
}

export interface ActionTaken {
    action: string;
    resource: string;
    description: string;
}

export type RunStatus = 'completed' | 'running' | 'failed' | 'awaiting_approval';

export interface AgentRun {
    id: string;
    trigger: string;
    status: RunStatus;
    startedAt: string;
    completedAt: string | null;
    stepsCompleted: StepCompleted[];
    actionsTaken: ActionTaken[];
    insights?: string;
    humanApproved: boolean | null;
}

export interface AgentRunsResponse {
    runs: AgentRun[];
    total: number;
    page: number;
    totalPages: number;
}
