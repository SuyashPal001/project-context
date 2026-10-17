'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Check, Copy, Image as ImageIcon, Loader2, Plus, RefreshCw, Smile, Sparkles, Type, X,
} from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { cn } from '@/lib/utils';
import {
    COLOR_ROLES, FONT_CHOICES, sourceLine,
    type BrandPatch, type BrandRecord,
} from './brandApi';
import { BRAND_FONT_CARDS, BRAND_FONT_CLASS } from './brandFonts';
import { BrandFillRow } from './BrandFillRow';
import { BrandPreviewCard, BrandPreviewMobileBar } from './BrandPreviewCard';

type ImageSlot = 'logo' | 'favicon' | 'mascot';
type ColorRole = typeof COLOR_ROLES[number];
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
function Section({ title, subtitle, action, wide, children }: { title: string; subtitle: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
    return (
        <section aria-label={title} className={cn('space-y-8', wide ? 'max-w-3xl' : 'max-w-xl')}>
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

/**
 * A soft-filled tile for logo/favicon/mascot: a small framed preview (or a
 * muted placeholder icon), a title + description that says what's missing
 * in plain words, and Upload/Replace + Remove on the right. Replaces the old
 * ImageField label/control/hint row — these three read as choices, not form
 * fields.
 */
function LogoTile({ slot, title, optional, icon: Icon, image, descSet, descUnset, onUpload }: {
    slot: ImageSlot; title: string; optional?: boolean; icon: typeof ImageIcon;
    image: BrandRecord['logo']; descSet: string; descUnset: string; onUpload: Props['onUploadImage'];
}) {
    const input = useRef<HTMLInputElement>(null);
    const set = !!image;
    return (
        <div className="flex flex-wrap items-center gap-4 rounded-xl bg-muted/40 p-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                {image?.url
                    ? <img src={image.url} alt={title} className="h-full w-full object-contain" />
                    : <Icon className="h-5 w-5 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{title}</span>
                    {optional && <span className="rounded-full border border-border px-2 text-xs text-muted-foreground">Optional</span>}
                </div>
                <p className="text-xs text-muted-foreground">{set ? descSet : descUnset}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(slot, f); e.target.value = ''; }} />
                <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => input.current?.click()}>
                    {set ? 'Replace' : 'Upload'}
                </Button>
                {set && <Button type="button" variant="ghost" size="sm" onClick={() => onUpload(slot, null)}>Remove</Button>}
            </div>
        </div>
    );
}

/** `#0a6` -> `#00AA66`, `00A651` -> `#00A651`. Returns null for anything
 * that isn't a valid 3- or 6-digit hex colour. */
function normalizeHex(raw: string): string | null {
    const v = raw.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(v)) return ('#' + v.split('').map((c) => c + c).join('')).toUpperCase();
    if (/^[0-9a-f]{6}$/i.test(v)) return ('#' + v).toUpperCase();
    return null;
}

/**
 * A resting role row (swatch + name + hex + copy) that opens a Figma-style
 * picker card. The picker holds its own draft while open — dragging the
 * saturation/hue area or clicking a "from your brand" swatch only updates
 * that draft and its live preview. The draft commits to `onSave` exactly
 * once: on Enter in the hex field, or when the popover closes (Done, click
 * outside, Esc) — and only when it is a valid, changed colour. An unset
 * role closed without a pick never saves anything (no accidental white).
 */
function ColorField({ role, value, otherColors, onSave, onClear, onDraftChange }: {
    role: string; value: string | undefined;
    otherColors: Array<{ role: string; hex: string }>;
    onSave: (hex: string) => void;
    onClear: () => void;
    /** Fires with the in-progress pick (drag or a fully-typed hex) while the
     * picker is open, and with null once it closes — lets the preview track
     * the live pick without the draft ever being saved early. */
    onDraftChange: (hex: string | null) => void;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value ?? '');
    const [hexText, setHexText] = useState(value ? value.slice(1) : '');
    // The last value actually sent to onSave this session, so an Enter-commit
    // followed by a close-commit for the same colour never double-saves.
    const savedRef = useRef(value);

    const commit = (hex: string) => {
        if (!/^#[0-9A-F]{6}$/.test(hex)) return;
        if (hex === (savedRef.current ?? '').toUpperCase()) return;
        savedRef.current = hex;
        onSave(hex);
    };

    const handleOpenChange = (next: boolean) => {
        if (next) {
            setDraft(value ?? '');
            setHexText(value ? value.slice(1) : '');
            savedRef.current = value;
        } else {
            commit(draft);
            onDraftChange(null);
        }
        setOpen(next);
    };

    const pickFromPicker = (hex: string) => {
        const upper = hex.toUpperCase();
        setDraft(upper);
        setHexText(upper.slice(1));
        onDraftChange(upper);
    };

    // Updates the live draft (and the preview) as soon as what's typed is a
    // complete, valid hex — but never saves. Enter (commitHexText) is the
    // only thing in this field that commits.
    const handleHexTextChange = (raw: string) => {
        const upper = raw.toUpperCase();
        setHexText(upper);
        const normalized = normalizeHex(upper);
        if (normalized) {
            setDraft(normalized);
            onDraftChange(normalized);
        }
    };

    const commitHexText = () => {
        const normalized = normalizeHex(hexText);
        if (!normalized) return;
        commit(normalized);
    };

    const copy = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!value) return;
        void navigator.clipboard.writeText(value);
        toast.success(`Copied ${value}`);
    };

    return (
        <div className="flex min-w-0 items-center gap-2">
            <Popover open={open} onOpenChange={handleOpenChange}>
                <PopoverTrigger asChild>
                    <button type="button" aria-label={`Edit ${role} colour`}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20">
                        <span
                            className={cn(
                                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border',
                                !value && 'border-2 border-dashed',
                            )}
                            style={value ? { backgroundColor: value } : undefined}>
                            {!value && <Plus className="h-4 w-4 text-muted-foreground" />}
                        </span>
                        <span className="min-w-0">
                            <span className="block text-sm font-medium capitalize text-foreground">{role}</span>
                            <span className={cn('block text-xs text-muted-foreground', value && 'font-mono uppercase')}>
                                {value ?? 'Olmo picks'}
                            </span>
                        </span>
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" collisionPadding={16} className="w-72 space-y-4 rounded-2xl p-4">
                    <div className="brand-color-picker">
                        <HexColorPicker color={draft || '#FFFFFF'} onChange={pickFromPicker} />
                    </div>
                    <div className="flex h-12 items-center gap-2 rounded-xl border border-border px-3">
                        <span className="h-6 w-6 shrink-0 rounded-md border border-border/60"
                            style={{ backgroundColor: draft || undefined }} />
                        <span className="text-muted-foreground">#</span>
                        <input value={hexText} aria-label={`${role} hex value`} maxLength={6}
                            onChange={(e) => handleHexTextChange(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitHexText(); } }}
                            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-base uppercase text-foreground outline-none" />
                    </div>
                    {otherColors.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-xs text-muted-foreground">From your brand</p>
                            <div className="flex flex-wrap gap-2">
                                {otherColors.map((c) => (
                                    <button key={c.role} type="button" aria-label={`Use ${c.role} colour`}
                                        className="h-6 w-6 shrink-0 rounded-md border border-border" style={{ backgroundColor: c.hex }}
                                        onClick={() => pickFromPicker(c.hex)} />
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                        {value ? (
                            <Button type="button" variant="ghost" size="sm"
                                onClick={() => { setOpen(false); onDraftChange(null); onClear(); }}>
                                Clear
                            </Button>
                        ) : <span />}
                        <Button size="sm" onClick={() => handleOpenChange(false)}>Done</Button>
                    </div>
                </PopoverContent>
            </Popover>
            {value && (
                <button type="button" aria-label={`Copy ${role} hex`} onClick={copy}
                    className="shrink-0 text-muted-foreground hover:text-foreground">
                    <Copy className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
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

type PaletteColors = Record<ColorRole, string>;
interface Palette { name: string; colors: PaletteColors }

// Seven curated palettes. Each strip shows primary/secondary/accent/text/
// background; `muted` still saves with the rest, it's just not in the strip.
const PALETTES: ReadonlyArray<Palette> = [
    { name: 'Electric', colors: { primary: '#D4F74B', secondary: '#111827', accent: '#7C3AED', text: '#111827', background: '#F7FAF0', muted: '#6B7280' } },
    { name: 'Ocean', colors: { primary: '#2F6F8F', secondary: '#23495A', accent: '#E8A33D', text: '#111827', background: '#EEF6FD', muted: '#6B7280' } },
    { name: 'Sunset', colors: { primary: '#EA7A35', secondary: '#CF3D7A', accent: '#F2CE4A', text: '#1F2937', background: '#FFF7EC', muted: '#6B7280' } },
    { name: 'Forest', colors: { primary: '#3A7D44', secondary: '#254D32', accent: '#E2B53A', text: '#1A1A1A', background: '#F7FBEF', muted: '#6B7280' } },
    { name: 'Berry', colors: { primary: '#B4285A', secondary: '#6D28D9', accent: '#E879B0', text: '#1E1B4B', background: '#FBEFF4', muted: '#6B7280' } },
    { name: 'Mono', colors: { primary: '#111827', secondary: '#374151', accent: '#9CA3AF', text: '#111827', background: '#FFFFFF', muted: '#6B7280' } },
];
const PALETTE_STRIP_ROLES: ReadonlyArray<ColorRole> = ['primary', 'secondary', 'accent', 'text', 'background'];
const NO_COLORS: Partial<Record<ColorRole, null>> = Object.fromEntries(COLOR_ROLES.map((r) => [r, null]));

const isPaletteSelected = (brand: BrandRecord, palette: Palette) =>
    COLOR_ROLES.every((r) => brand.colors[r] === palette.colors[r]);
const noColorsSet = (brand: BrandRecord) => COLOR_ROLES.every((r) => !brand.colors[r]);

/** Palette tiles: "Olmo picks" (clears all six) + the seven presets (set all six in one PATCH). */
function PaletteGrid({ brand, onSave }: SectionProps) {
    const olmoSelected = noColorsSet(brand);
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button type="button" aria-pressed={olmoSelected} onClick={() => onSave({ colors: NO_COLORS })}
                className={cn('rounded-xl p-2 text-left hover:bg-muted/40', olmoSelected && 'ring-2 ring-primary')}>
                <div className="flex h-10 items-center justify-center rounded-lg bg-muted/60">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="mt-1.5 text-sm text-foreground">Olmo picks</p>
            </button>
            {PALETTES.map((palette) => {
                const selected = isPaletteSelected(brand, palette);
                return (
                    <button key={palette.name} type="button" aria-pressed={selected} onClick={() => onSave({ colors: { ...palette.colors } })}
                        className={cn('rounded-xl p-2 text-left hover:bg-muted/40', selected && 'ring-2 ring-primary')}>
                        <div className="flex h-10 overflow-hidden rounded-lg">
                            {PALETTE_STRIP_ROLES.map((role) => (
                                <span key={role} className="flex-1" style={{ backgroundColor: palette.colors[role] }} />
                            ))}
                        </div>
                        <p className="mt-1.5 text-sm text-foreground">{palette.name}</p>
                    </button>
                );
            })}
        </div>
    );
}

/** Font cards: "Olmo picks" + the six curated fonts (each shown in its own
 * typeface) + "Other font", which reveals the same controlled text input
 * FontField always used, so a typed family name still saves on blur. */
function FontCards({ brand, onSave }: SectionProps) {
    const { headlineFont } = brand;
    const isCurated = !!headlineFont && headlineFont in BRAND_FONT_CLASS;
    const isOtherSaved = !!headlineFont && !isCurated;
    // "Other font" reveals an input on click even before anything is typed —
    // that open state is local, synced from the saved record (a custom font
    // from import/Refresh should open it too), not written back until blur.
    const [otherOpen, setOtherOpen] = useState(isOtherSaved);
    useEffect(() => setOtherOpen(isOtherSaved), [isOtherSaved]);

    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button type="button" aria-pressed={!headlineFont} onClick={() => onSave({ headlineFont: null })}
                className={cn('rounded-xl bg-muted/40 p-4 text-left hover:bg-muted/60', !headlineFont && 'ring-2 ring-primary')}>
                <Sparkles className="h-5 w-5 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium text-foreground">Olmo picks</p>
                <p className="text-xs text-muted-foreground">Olmo chooses for you</p>
            </button>
            {BRAND_FONT_CARDS.map(({ name, subtitle }) => (
                <button key={name} type="button" aria-pressed={headlineFont === name} onClick={() => onSave({ headlineFont: name })}
                    className={cn('rounded-xl bg-muted/40 p-4 text-left hover:bg-muted/60', headlineFont === name && 'ring-2 ring-primary')}>
                    <p className={cn('text-3xl text-foreground', BRAND_FONT_CLASS[name])}>Aa</p>
                    <p className="mt-2 text-sm font-medium text-foreground">{name}</p>
                    <p className="text-xs text-muted-foreground">{subtitle}</p>
                </button>
            ))}
            <button type="button" aria-pressed={isOtherSaved || otherOpen} onClick={() => setOtherOpen(true)}
                className={cn('rounded-xl bg-muted/40 p-4 text-left hover:bg-muted/60', (isOtherSaved || otherOpen) && 'ring-2 ring-primary')}>
                <Type className="h-5 w-5 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium text-foreground">Other font</p>
                <p className="text-xs text-muted-foreground">Any font you like</p>
            </button>
            {otherOpen && (
                <div className="col-span-2 sm:col-span-4">
                    <FontField id="brand-font-other" value={headlineFont ?? ''} onSave={(v) => onSave({ headlineFont: v || null })} />
                </div>
            )}
        </div>
    );
}

export function LookSection({ brand, onSave, onUploadImage }: SectionProps & {
    onUploadImage: Props['onUploadImage'];
}) {
    // The role being dragged/typed in its still-open picker — lifted here so
    // the pinned preview card can track the live pick without any of the
    // ColorFields having to know the preview exists.
    const [draftColor, setDraftColor] = useState<{ role: ColorRole; hex: string } | null>(null);

    return (
        <Section title="Visual identity" subtitle="The colours, type and marks Olmo puts in every image." wide>
            <div className="lg:hidden">
                <BrandPreviewMobileBar brand={brand} draftColor={draftColor} />
            </div>

            <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1 space-y-8">
                    <div className="space-y-3">
                        <p className="text-sm font-medium text-foreground">Logo and mascot</p>
                        <LogoTile slot="logo" title="Logo" icon={ImageIcon} image={brand.logo} onUpload={onUploadImage}
                            descSet="On every end card." descUnset="No logo yet. Add one, or go without." />
                        <LogoTile slot="favicon" title="Favicon" icon={ImageIcon} image={brand.favicon} onUpload={onUploadImage}
                            descSet="Used where a small icon fits." descUnset="Optional. Picked up from your site when you fill it in." />
                        <LogoTile slot="mascot" title="Mascot" optional icon={Smile} image={brand.mascot} onUpload={onUploadImage}
                            descSet="Olmo can feature it in ads." descUnset="Upload one if your brand has a character." />
                    </div>

                    <div className="space-y-4">
                        <div>
                            <p className="text-sm font-medium text-foreground">Colours</p>
                            <p className="text-xs text-muted-foreground">Pick a palette, set your own, or leave it to Olmo.</p>
                        </div>
                        <PaletteGrid brand={brand} onSave={onSave} />
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {COLOR_ROLES.map((role) => (
                                <ColorField key={role} role={role} value={brand.colors[role]}
                                    otherColors={COLOR_ROLES
                                        .filter((r) => r !== role && brand.colors[r])
                                        .map((r) => ({ role: r, hex: brand.colors[r]! }))}
                                    onSave={(hex) => onSave({ colors: { ...brand.colors, [role]: hex } })}
                                    onClear={() => onSave({ colors: { ...brand.colors, [role]: null } })}
                                    onDraftChange={(hex) => setDraftColor(hex ? { role, hex } : null)} />
                            ))}
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <p className="text-sm font-medium text-foreground">Typography</p>
                            <p className="text-xs text-muted-foreground">Pick your brand font, or let Olmo choose.</p>
                        </div>
                        <FontCards brand={brand} onSave={onSave} />
                    </div>
                </div>

                <div className="hidden shrink-0 lg:sticky lg:top-6 lg:block lg:self-start">
                    <BrandPreviewCard brand={brand} draftColor={draftColor} />
                </div>
            </div>
        </Section>
    );
}

type TabKey = 'basics' | 'voice' | 'look';
// Replaces the old "Olmo needs three things…" readiness line — each tab
// carries its own tick, computed the same way the line used to read
// `brand.missing`, just scoped to what that tab holds.
const FORM_TABS: ReadonlyArray<{ key: TabKey; label: string; done: (b: BrandRecord) => boolean }> = [
    { key: 'basics', label: 'Identity', done: (b) => !!b.name?.trim() && !!b.audience?.trim() },
    { key: 'voice', label: 'Voice', done: (b) => b.toneWords.length > 0 },
    { key: 'look', label: 'Visuals', done: (b) => !!b.logo || Object.keys(b.colors).length > 0 },
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
                            {done && <Check className="h-3.5 w-3.5" />}
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
