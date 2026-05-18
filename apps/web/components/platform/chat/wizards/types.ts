import type { ComponentType } from "react";

export type PillType = "prd" | "roadmap" | "tasks" | "research";

export type WizardFields = Record<string, string>;

export interface StepProps {
    fields: WizardFields;
    setField: (key: string, value: string) => void;
}

export interface WizardSpec {
    title: string;
    step1Label: string;
    Step1: ComponentType<StepProps>;
    Step2: ComponentType<StepProps>;
    buildPrompt: (fields: WizardFields) => string;
    canAdvance: (fields: WizardFields) => boolean;
    canSubmit: (fields: WizardFields) => boolean;
}
