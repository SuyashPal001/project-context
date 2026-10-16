'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BasicsSection, LookSection, VoiceSection } from './BrandForm';
import type { BrandPatch, BrandRecord } from './brandApi';

type ImageSlot = 'logo' | 'favicon' | 'mascot';

interface Props {
    brand: BrandRecord;
    onSave: (patch: BrandPatch) => void;
    onUploadImage: (slot: ImageSlot, file: File | null) => void;
    onFinish: () => void;
}

const STEP_TITLES = ['Basics', 'Voice', 'Look'] as const;
const LAST_STEP = STEP_TITLES.length - 1;

/** Step-by-step manual brand setup for people who skip the website/Instagram
 * import and don't want to talk to Olmo — the same section components the
 * full Brand page uses, one at a time. Step position is local state, not
 * URL: leaving mid-way and coming back lands on the choices again, but every
 * field already saved (on blur, same as the full page) is kept. */
export function BrandSteps({ brand, onSave, onUploadImage, onFinish }: Props) {
    const [step, setStep] = useState(0);
    const advance = () => (step < LAST_STEP ? setStep(step + 1) : onFinish());
    const back = () => setStep((s) => Math.max(0, s - 1));

    return (
        <div className="pb-16 pt-6">
            <p className="text-sm text-muted-foreground">Step {step + 1} of 3 — {STEP_TITLES[step]}</p>
            {step === 0 && <BasicsSection brand={brand} onSave={onSave} />}
            {step === 1 && <VoiceSection brand={brand} onSave={onSave} />}
            {step === 2 && <LookSection brand={brand} onSave={onSave} onUploadImage={onUploadImage} />}
            <div className="flex items-center gap-4 pt-8">
                {step > 0 && <Button variant="outline" onClick={back}>Back</Button>}
                <Button variant="ghost" onClick={advance}>Skip</Button>
                <Button onClick={advance}>{step < LAST_STEP ? 'Next' : 'Done'}</Button>
            </div>
        </div>
    );
}
