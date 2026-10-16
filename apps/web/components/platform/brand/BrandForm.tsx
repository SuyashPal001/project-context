'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Circle, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { cn } from '@/lib/utils';
import {
    COLOR_ROLES, FONT_CHOICES, sourceLine,
    type BrandPatch, type BrandRecord,
} from './brandApi';
import { BrandFillRow } from './BrandFillRow';

type ImageSlot = 'logo' | 'favicon' | 'mascot';
interface Props {
    brand: BrandRecord;
    onSave: (patch: BrandPatch) => void;
    onRefresh: () => void;
    onUploadImage: (slot: ImageSlot, file: File | null) => void;
    refreshing: boolean;
    chatHref: string;
    onImport: (value: string) => void;
    importing: boolean;
    importFailed: boolean;
}

const toLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

// One field, laid out like the profile settings page: label, control, hint underneath.
function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
    return (
        <div className="grid gap-2">
            <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
            <div className="min-w-0">{children}</div>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

// The tab already names the section, so only its one-line description shows here.
// Fields sit in one even column, the same width and spacing as the profile page.
function Section({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section aria-label={title} className="max-w-xl space-y-8">
            <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">{subtitle}</p>
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

/** Same blur-to-save-on-change contract as TextField, with a datalist of
 * suggestions. A plain `defaultValue` Input went stale after Refresh/import
 * replaced `brand.headlineFont` out from under it — this re-syncs the draft
 * whenever the prop changes, exactly like TextField does. */
function FontField({ id, value, onSave }: { id: string; value: string; onSave: (v: string) => void }) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const blur = () => { const v = draft.trim(); if (v !== value.trim()) onSave(v); };
    return (
        <>
            <Input id={id} list={`${id}-list`} value={draft} aria-label="Font"
                onChange={(e) => setDraft(e.target.value)} onBlur={blur} />
            <datalist id={`${id}-list`}>{FONT_CHOICES.map((f) => <option key={f} value={f} />)}</datalist>
        </>
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

/**
 * `<input type="color">` fires React's `onChange` — bound to the native
 * `input` event — once per drag tick while the OS colour picker is open. A
 * PATCH per tick would hammer the API, so `onChange` only updates the local
 * draft (what the swatch + hex label show live); saving happens on the
 * native `change` event (picker closed, colour committed) or on blur,
 * wired directly via `addEventListener` since React's `onChange` prop can't
 * distinguish `input` from `change`. A ref tracks the last value actually
 * saved so change-then-blur for the same colour never double-PATCHes.
 */
// What an unset swatch shows. Never saved on its own: a focus-and-leave on an
// unset colour reports this value, and must not save white.
const SWATCH_PLACEHOLDER = '#FFFFFF';

function ColorSwatch({ role, value, onSave }: { role: string; value: string | undefined; onSave: (hex: string) => void }) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const inputRef = useRef<HTMLInputElement>(null);
    const lastSavedRef = useRef(value);
    useEffect(() => { lastSavedRef.current = value; }, [value]);

    const commit = (hex: string) => {
        const upper = hex.toUpperCase();
        if (upper !== (lastSavedRef.current ?? '').toUpperCase()) {
            lastSavedRef.current = upper;
            onSave(upper);
        }
    };

    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        const onNativeChange = (e: Event) => commit((e.target as HTMLInputElement).value);
        el.addEventListener('change', onNativeChange);
        return () => el.removeEventListener('change', onNativeChange);
    }, []);

    return (
        <label className="flex items-center gap-2 text-xs">
            <input ref={inputRef} type="color" aria-label={`${role} colour`} value={draft ?? SWATCH_PLACEHOLDER}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                // Blur saves only a colour the user actually picked (the draft), never
                // the placeholder an unset swatch displays.
                onBlur={() => { if (draft && draft.toUpperCase() !== SWATCH_PLACEHOLDER) commit(draft); }}
                className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent p-0" />
            <span className="capitalize text-foreground">{role}</span>
            <span className="text-muted-foreground">{draft ?? 'Not set'}</span>
        </label>
    );
}

type SectionProps = { brand: BrandRecord; onSave: (patch: BrandPatch) => void };

export function BasicsSection({ brand, onSave }: SectionProps) {
    return (
        <Section title="Basics" subtitle="What your brand is at a glance.">
            <TextField id="brand-name" label="Brand name" hint="The name your audience knows you by." value={brand.name ?? ''} onSave={(v) => onSave({ name: v || null })} />
            <TextField id="brand-one-liner" label="One-liner" hint="What you make, in one plain sentence." value={brand.oneLiner ?? ''} onSave={(v) => onSave({ oneLiner: v || null })} />
            <TextField id="brand-audience" label="Audience" hint="Who it's for, in plain words." value={brand.audience ?? ''} multiline onSave={(v) => onSave({ audience: v || null })} />
        </Section>
    );
}

export function VoiceSection({ brand, onSave }: SectionProps) {
    return (
        <Section title="Voice" subtitle="How you sound. Every caption and script follows it.">
            <Row label="Tone words" hint="3 to 5 words for how you sound.">
                <ToneWords words={brand.toneWords} onSave={(toneWords) => onSave({ toneWords })} />
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
    );
}

export function LookSection({ brand, onSave, onUploadImage }: SectionProps & {
    onUploadImage: Props['onUploadImage'];
}) {
    return (
        <Section title="Visual identity" subtitle="The colours, type and marks Olmo puts in every image.">
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
                <FontField id="brand-font" value={brand.headlineFont ?? ''} onSave={(v) => onSave({ headlineFont: v || null })} />
            </Row>
        </Section>
    );
}

type TabKey = 'basics' | 'voice' | 'look';
// Replaces the old "Olmo needs three things…" readiness line — each tab
// carries its own tick, computed the same way the line used to read
// `brand.missing`, just scoped to what that tab holds.
const FORM_TABS: ReadonlyArray<{ key: TabKey; label: string; done: (b: BrandRecord) => boolean }> = [
    { key: 'basics', label: 'Basics', done: (b) => !!b.name?.trim() && !!b.audience?.trim() },
    { key: 'voice', label: 'Voice', done: (b) => b.toneWords.length > 0 },
    { key: 'look', label: 'Look', done: (b) => !!b.logo || Object.keys(b.colors).length > 0 },
];

export function BrandForm({ brand, onSave, onRefresh, onUploadImage, refreshing, chatHref, onImport, importing, importFailed }: Props) {
    const source = sourceLine(brand);
    const [tab, setTab] = useState<TabKey>('basics');
    return (
        <div className="space-y-6 pb-16">
            <BrandFillRow brand={brand} chatHref={chatHref} onSubmit={onImport} busy={importing} failed={importFailed} />

            {/* Same pill switcher as the Skills page (Mine / Explore). */}
            <div role="tablist" className="flex w-fit gap-1 rounded-full bg-muted p-1">
                {FORM_TABS.map((t) => {
                    const done = t.done(brand);
                    const active = tab === t.key;
                    return (
                        <button key={t.key} type="button" role="tab" aria-selected={active}
                            data-testid={`tab-${t.key}`} data-done={String(done)} onClick={() => setTab(t.key)}
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                                active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                            )}>
                            {done ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                            {t.label}
                        </button>
                    );
                })}
            </div>

            <div role="tabpanel">
                {tab === 'basics' && <BasicsSection brand={brand} onSave={onSave} />}
                {tab === 'voice' && <VoiceSection brand={brand} onSave={onSave} />}
                {tab === 'look' && <LookSection brand={brand} onSave={onSave} onUploadImage={onUploadImage} />}
            </div>

            {source && (
                <div className="flex items-center gap-2 pt-6 text-xs text-muted-foreground">
                    <span>{source}</span>
                    <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
                        {refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
                    </Button>
                </div>
            )}
        </div>
    );
}
