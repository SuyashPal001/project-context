'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Circle, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
    BRAND_REGIONS, COLOR_ROLES, EMOJI_POLICIES, FONT_CHOICES, sourceLine,
    type BrandPatch, type BrandRecord,
} from './brandApi';

type ImageSlot = 'logo' | 'favicon' | 'mascot';
interface Props {
    brand: BrandRecord;
    onSave: (patch: BrandPatch) => void;
    onRefresh: () => void;
    onUploadImage: (slot: ImageSlot, file: File | null) => void;
    refreshing: boolean;
}

const toLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

// A row: label + hint on the left, control on the right, hairline divider below. No boxes.
function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
    return (
        <div className="grid gap-2 border-b border-border/60 py-4 last:border-b-0 sm:grid-cols-[200px_1fr] sm:gap-6">
            <div>
                <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
                {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
            </div>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

function Section({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="pt-8">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-2">
                <div>
                    <h2 className="text-base font-semibold text-foreground">{title}</h2>
                    <p className="text-xs text-muted-foreground">{subtitle}</p>
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

/** Text input that saves on blur, only when the value changed. */
function TextField({ id, label, hint, value, multiline, placeholder, onSave }: {
    id: string; label: string; hint?: string; value: string; multiline?: boolean; placeholder?: string; onSave: (v: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const blur = () => { if (draft.trim() !== value.trim()) onSave(draft.trim()); };
    const common = { id, value: draft, placeholder, onBlur: blur, 'aria-label': label };
    return (
        <Row label={label} hint={hint} htmlFor={id}>
            {multiline
                ? <Textarea {...common} rows={4} onChange={(e) => setDraft(e.target.value)} />
                : <Input {...common} onChange={(e) => setDraft(e.target.value)} />}
        </Row>
    );
}

function Chips<T extends string>({ options, value, onPick }: { options: ReadonlyArray<{ value: T; label: string }>; value: string; onPick: (v: T) => void }) {
    return (
        <div className="flex flex-wrap gap-2">
            {options.map((o) => (
                <button key={o.value} type="button" onClick={() => o.value !== value && onPick(o.value)}
                    className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                        o.value === value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function ToneWords({ words, onSave }: { words: string[]; onSave: (w: string[]) => void }) {
    const [draft, setDraft] = useState('');
    const add = () => {
        const w = draft.trim();
        if (w && !words.includes(w) && words.length < 5) onSave([...words, w]);
        setDraft('');
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            {words.map((w) => (
                <span key={w} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground">
                    {w}
                    <button type="button" aria-label={`Remove ${w}`} onClick={() => onSave(words.filter((x) => x !== w))}><X className="h-3 w-3" /></button>
                </span>
            ))}
            {words.length < 5 && (
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    placeholder="+ add" aria-label="Add tone word" className="h-7 w-28 text-xs" />
            )}
        </div>
    );
}

function ImageField({ slot, label, image, onUpload }: { slot: ImageSlot; label: string; image: BrandRecord['logo']; onUpload: Props['onUploadImage'] }) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <Row label={label}>
            <div className="flex items-center gap-3 text-sm">
                {image?.url
                    ? <img src={image.url} alt={label} className="h-10 w-10 rounded object-contain" />
                    : <span className="text-muted-foreground">Not set</span>}
                <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(slot, f); e.target.value = ''; }} />
                <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => input.current?.click()}>
                    <ImagePlus className="h-3.5 w-3.5" />{image ? 'Replace' : 'Upload'}
                </button>
                {image && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onUpload(slot, null)}>Remove</button>}
            </div>
        </Row>
    );
}

function ColorSwatch({ role, value, onSave }: { role: string; value: string | undefined; onSave: (hex: string) => void }) {
    return (
        <label className="flex items-center gap-2 text-xs">
            <input type="color" aria-label={`${role} colour`} value={value ?? '#FFFFFF'}
                onChange={(e) => onSave(e.target.value.toUpperCase())}
                className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent p-0" />
            <span className="capitalize text-foreground">{role}</span>
            <span className="text-muted-foreground">{value ?? 'Not set'}</span>
        </label>
    );
}

export function BrandForm({ brand, onSave, onRefresh, onUploadImage, refreshing }: Props) {
    const name = brand.name?.trim() || 'your brand';
    const ready = [
        { key: 'name', label: 'Name' }, { key: 'audience', label: 'Audience' }, { key: 'voice', label: 'Voice' },
    ] as const;
    const source = sourceLine(brand);
    return (
        <div className="pb-16">
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>Olmo needs three things to write like {name}:</span>
                {ready.map((r) => {
                    const done = !brand.missing.includes(r.key);
                    return (
                        <span key={r.key} data-testid={`ready-${r.key}`} data-done={String(done)}
                            className={cn('inline-flex items-center gap-1', done ? 'text-primary' : 'text-muted-foreground')}>
                            {done ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}{r.label}
                        </span>
                    );
                })}
            </div>

            <Section title="Basics" subtitle="What your brand is at a glance.">
                <TextField id="brand-name" label="Brand name" hint="The name your audience knows you by." value={brand.name ?? ''} onSave={(v) => onSave({ name: v || null })} />
                <TextField id="brand-one-liner" label="One-liner" hint="What you make, in one plain sentence." value={brand.oneLiner ?? ''} onSave={(v) => onSave({ oneLiner: v || null })} />
                <TextField id="brand-audience" label="Audience" hint="Who it's for, in plain words." value={brand.audience ?? ''} multiline onSave={(v) => onSave({ audience: v || null })} />
                <Row label="Region" hint="Local currency, festivals and language.">
                    <Chips options={BRAND_REGIONS} value={brand.region} onPick={(region) => onSave({ region })} />
                </Row>
            </Section>

            <Section title="Voice" subtitle="How you sound. Every caption and script follows it.">
                <Row label="Tone words" hint="3 to 5 words for how you sound.">
                    <ToneWords words={brand.toneWords} onSave={(toneWords) => onSave({ toneWords })} />
                </Row>
                <Row label="Emoji">
                    <Chips options={EMOJI_POLICIES} value={brand.emojiPolicy} onPick={(emojiPolicy) => onSave({ emojiPolicy })} />
                </Row>
                <TextField id="brand-signature" label="Signature phrases" hint="One per line. Phrases you own." multiline
                    value={brand.signaturePhrases.join('\n')} onSave={(v) => onSave({ signaturePhrases: toLines(v) })} />
                <TextField id="brand-banned" label="Banned phrases" hint="One per line. Words your brand never uses." multiline
                    placeholder={'GAME-CHANGER\nliterally'} value={brand.bannedPhrases.join('\n')} onSave={(v) => onSave({ bannedPhrases: toLines(v) })} />
                <TextField id="brand-ctas" label="CTAs" hint="One per line. How you ask people to act." multiline
                    value={brand.ctaExamples.join('\n')} onSave={(v) => onSave({ ctaExamples: toLines(v) })} />
                <TextField id="brand-notes" label="Voice notes" hint="Anything else. Markdown works." multiline
                    value={brand.voiceNotes ?? ''} onSave={(v) => onSave({ voiceNotes: v || null })} />
            </Section>

            <Section title="Visual identity" subtitle="The colours, type and marks Olmo puts in every image."
                action={brand.sourceValue && brand.sourceType !== 'chat' ? (
                    <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
                        {refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
                    </Button>
                ) : undefined}>
                <ImageField slot="logo" label="Logo" image={brand.logo} onUpload={onUploadImage} />
                <ImageField slot="favicon" label="Favicon" image={brand.favicon} onUpload={onUploadImage} />
                <ImageField slot="mascot" label="Mascot" image={brand.mascot} onUpload={onUploadImage} />
                <Row label="Colours">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {COLOR_ROLES.map((role) => (
                            <ColorSwatch key={role} role={role} value={brand.colors[role]}
                                onSave={(hex) => onSave({ colors: { ...brand.colors, [role]: hex } })} />
                        ))}
                    </div>
                </Row>
                <Row label="Font" htmlFor="brand-font">
                    <Input id="brand-font" list="brand-fonts" defaultValue={brand.headlineFont ?? ''} aria-label="Font"
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (brand.headlineFont ?? '')) onSave({ headlineFont: v || null }); }} />
                    <datalist id="brand-fonts">{FONT_CHOICES.map((f) => <option key={f} value={f} />)}</datalist>
                </Row>
            </Section>

            {source && <p className="pt-6 text-xs text-muted-foreground">{source}</p>}
        </div>
    );
}
