"use client";

import Image from 'next/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Music2, Play, Search, Sparkles, Square, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CREATIVE_TEMPLATES } from './creativeLibraryTemplates';
import { AVATAR_CATEGORIES, CREATIVE_AVATARS, avatarCategory, type AvatarCategory, type CreativeAvatar } from './creativeLibraryAvatars';
import { fetchCreativeVoice } from './creativeVoiceFetch';
import { cn } from '@/lib/utils';
import { ProductsPanel } from './creative-library/ProductsPanel';
import { storeCreativeImage } from './creative-library/storeCreativeImage';
import { TENANT_AVATARS_QUERY_KEY, createTenantAvatar, describeTenantAvatar, listTenantAvatars, tenantAvatarSelection } from './creative-library/avatarsApi';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import type {
    AvatarSelection,
    CreativeBrief,
    CreativeLibraryTab,
    CreativeSelection,
    ProductRecordSelection,
    TemplateSelection,
    VoiceSelection,
} from './creative-library/creativeBriefModel';
import { creativeVoiceArtwork } from './creative-library/creativeVoiceArtwork';

export type { CreativeLibraryTab } from './creative-library/creativeBriefModel';

interface Voice {
    id: string;
    name: string;
    tagline?: string;
    description?: string;
    language?: string;
    gender?: string;
    country?: string;
    supportedLocales: string[];
    hasPreview: boolean;
}

interface VoicePage {
    voices: Voice[];
}

const AVATAR_PREFIX = 'creative-avatars/';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const LANGUAGES = [
    { value: 'en', label: 'English' },
    { value: 'ar', label: 'Arabic' },
    { value: 'zh', label: 'Chinese' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'he', label: 'Hebrew' },
    { value: 'hi', label: 'Hindi' },
    { value: 'it', label: 'Italian' },
    { value: 'ja', label: 'Japanese' },
    { value: 'pt', label: 'Portuguese' },
    { value: 'es', label: 'Spanish' },
    { value: 'ta', label: 'Tamil' },
    { value: 'te', label: 'Telugu' },
    { value: 'th', label: 'Thai' },
] as const;

function LibraryHeader({ title, search, onSearch, placeholder }: {
    title: string; search?: string; onSearch?: (value: string) => void; placeholder?: string;
}) {
    return <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {onSearch && <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={event => onSearch(event.target.value)} placeholder={placeholder} className="h-9 pl-9" aria-label={placeholder} />
        </div>}
    </div>;
}

function TemplatesPanel({ selected, onSelect }: { selected: TemplateSelection | null; onSelect: (selection: TemplateSelection) => void }) {
    const [search, setSearch] = useState('');
    const matches = CREATIVE_TEMPLATES.filter(template => `${template.title} ${template.category} ${template.description}`.toLowerCase().includes(search.toLowerCase()));
    return <div className="space-y-5">
        <LibraryHeader title="Select template" search={search} onSearch={setSearch} placeholder="Search templates" />
        <p className="text-sm text-muted-foreground">Pick a visual starting point, then describe your product and audience.</p>
        {matches.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No templates match your search.</p> :
            <div className="grid grid-cols-2 gap-x-4 gap-y-6">
                {matches.map(template => <button key={template.id} type="button" aria-pressed={selected?.id === template.id} onClick={() => onSelect({ kind: 'template', id: template.id, title: template.title, category: template.category, image: template.image })} aria-label={`Use ${template.title} template`} className="group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className={cn("relative block aspect-[16/10] overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50", selected?.id === template.id ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
                        <Image src={template.image} alt="" fill sizes="(max-width: 640px) 45vw, 320px" className="object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                        {selected?.id === template.id && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
                    </span>
                    <span className="mt-2 block truncate text-sm font-semibold text-foreground">{template.title}</span>
                    <span className="block text-xs text-muted-foreground">{template.category}</span>
                </button>)}
            </div>}
    </div>;
}

function AvatarCard({ label, name, detail, selected, busy, disabled, onClick, children }: {
    label: string; name: string; detail: string; selected: boolean; busy: boolean; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
    return <button type="button" aria-pressed={selected} disabled={disabled} onClick={() => { if (!selected) onClick(); }} aria-label={label} className="group min-w-0 text-left disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className={cn("relative block aspect-[4/5] overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50", selected ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
            {children}
            {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
            <span className="absolute bottom-2 right-2 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Use avatar'}
            </span>
        </span>
        <span className="mt-2 block truncate text-sm font-semibold text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
    </button>;
}

function AvatarsPanel({ selected, onSelect, onCreateAvatar, createAvatarDisabled }: { selected: AvatarSelection | null; onSelect: (selection: AvatarSelection) => void; onCreateAvatar?: (category: AvatarCategory | null) => void; createAvatarDisabled?: boolean }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const namingAttempted = useRef(new Set<string>());
    const queryClient = useQueryClient();
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<AvatarCategory | null>(null);
    const [uploading, setUploading] = useState<string | null>(null);
    const query = search.toLowerCase();
    const matches = CREATIVE_AVATARS.filter(avatar => (category === null || avatarCategory(avatar) === category)
        && `${avatar.name} ${avatar.role} ${avatar.tone}`.toLowerCase().includes(query));
    // The tenant's own avatars (anything in Drive's Avatars folder); platform
    // presets above stay static. A failed load just shows presets only.
    const { data: ownAvatars = [] } = useQuery({ queryKey: TENANT_AVATARS_QUERY_KEY, queryFn: listTenantAvatars });
    // An own avatar without a category (uploaded, or saved before categories)
    // shows under All only.
    const ownMatches = ownAvatars.filter(avatar => (category === null || avatar.category === category)
        && `${avatar.name} ${avatar.role ?? ''} ${avatar.tone ?? ''}`.toLowerCase().includes(query));

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // An avatar uploaded through Drive (a plain file upload) arrives unnamed,
    // as does one whose inline naming ran out of time. Name each one once per
    // session, one at a time.
    useEffect(() => {
        const pending = ownAvatars.filter(avatar => avatar.namingStatus === 'pending' && !namingAttempted.current.has(avatar.id));
        if (pending.length === 0) return;
        pending.forEach(avatar => namingAttempted.current.add(avatar.id));
        void (async () => {
            for (const avatar of pending) {
                try { await describeTenantAvatar(avatar.id); } catch { /* stays pending; shown by its file name */ }
            }
            void queryClient.invalidateQueries({ queryKey: TENANT_AVATARS_QUERY_KEY });
        })();
    }, [ownAvatars, queryClient]);

    function selectPreset(avatar: CreativeAvatar) {
        onSelect({ kind: 'avatar', ...avatar, attachment: { fileId: avatar.assetId, name: avatar.name, type: 'image/jpeg', size: 0 } });
    }

    async function uploadOwnImage(file: File) {
        if (!IMAGE_TYPES.has(file.type)) { toast.error('Choose a JPG, PNG, or WebP image.'); return; }
        if (file.size > 35 * 1024 * 1024) { toast.error('Presenter images must be under 35 MB.'); return; }
        setUploading('custom');
        try {
            const attachment = await storeCreativeImage(file, AVATAR_PREFIX);
            // Naming is best effort: if it fails the upload still attaches, under the file's own name.
            const avatar = await createTenantAvatar(attachment.fileId).catch(() => null);
            if (mountedRef.current) onSelect(avatar ? tenantAvatarSelection(avatar) : { kind: 'avatar', id: `custom:${attachment.fileId}`, name: file.name, role: 'Uploaded presenter', tone: 'Custom', attachment });
            void queryClient.invalidateQueries({ queryKey: TENANT_AVATARS_QUERY_KEY });
        } catch {
            if (mountedRef.current) toast.error('Could not upload the presenter image. Please try again.');
        } finally {
            if (mountedRef.current) setUploading(null);
        }
    }

    return <div className="space-y-5">
        <LibraryHeader title="Choose presenter" search={search} onSearch={setSearch} placeholder="Search avatars" />
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Original still-image presets. Select one to attach it to your brief; talking video is not available yet.</p>
            <div className="flex items-center gap-2">
                {onCreateAvatar && <Button type="button" variant="outline" size="sm" disabled={uploading !== null || createAvatarDisabled} onClick={() => onCreateAvatar(category)}>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Create with AI
                </Button>}
                <Button type="button" variant="outline" size="sm" disabled={uploading !== null} onClick={() => inputRef.current?.click()}>
                    {uploading === 'custom' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                    Upload your own
                </Button>
            </div>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload presenter image" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadOwnImage(file); event.target.value = ''; }} />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter avatars">
            {([null, ...AVATAR_CATEGORIES] as const).map(value => <Button key={value ?? 'all'} type="button" size="sm" className="rounded-full"
                variant={category === value ? 'outline' : 'ghost'} aria-pressed={category === value} onClick={() => setCategory(value)}>
                {value ?? 'All'}
            </Button>)}
        </div>
        {ownMatches.length > 0 && <section className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">Yours</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                {ownMatches.map(avatar => {
                    const selection = tenantAvatarSelection(avatar);
                    const naming = avatar.namingStatus === 'pending';
                    return <AvatarCard key={avatar.id} label={`Use ${avatar.name} avatar`} name={naming ? 'Naming…' : avatar.name} detail={`${selection.role} · ${selection.tone}`}
                        selected={selected?.id === selection.id} busy={false} disabled={uploading !== null} onClick={() => onSelect(selection)}>
                        <FileThumbnail fileId={avatar.fileId} alt="" anchorTop />
                    </AvatarCard>;
                })}
            </div>
        </section>}
        {matches.length === 0 && ownMatches.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No avatars match your search.</p> :
            matches.length > 0 && <section className="space-y-3">
                {ownMatches.length > 0 && <h3 className="text-sm font-medium text-muted-foreground">Library</h3>}
                <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                    {matches.map(avatar => <AvatarCard key={avatar.id} label={`Use ${avatar.name} avatar`} name={avatar.name} detail={`${avatar.role} · ${avatar.tone}`}
                        selected={selected?.id === avatar.id} busy={uploading === avatar.id} disabled={uploading !== null} onClick={() => selectPreset(avatar)}>
                        <Image src={avatar.image} alt="" fill sizes="(max-width: 640px) 45vw, 220px" className="object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]" />
                    </AvatarCard>)}
                </div>
            </section>}
    </div>;
}

const VOICE_COUNTRY_LABEL: Record<string, string> = { IN: 'India', US: 'US', GB: 'UK', AU: 'Australia', CA: 'Canada' };
const VOICE_GENDER_LABEL: Record<string, string> = { feminine: 'Female', female: 'Female', masculine: 'Male', male: 'Male' };

// Compact row: play button, name, one line of character. The description often
// repeats the tagline ("Friendly — Friendly, approachable…"), so show one line
// only and keep the full text in the tooltip.
function VoiceCard({ voice, languageLabel, loading, playing, selected, onPreview, onSelect }: { voice: Voice; languageLabel: string; loading: boolean; playing: boolean; selected: boolean; onPreview: () => void; onSelect: () => void }) {
    const artwork = creativeVoiceArtwork(voice.name);
    const meta = [voice.country ? VOICE_COUNTRY_LABEL[voice.country] ?? voice.country : undefined, voice.gender ? VOICE_GENDER_LABEL[voice.gender] ?? voice.gender : undefined].filter(Boolean).join(' · ');
    const summary = voice.description ?? voice.tagline ?? 'Natural voice';
    return <div className={cn("flex items-center gap-3 rounded-lg px-2 py-2 transition-colors", selected ? 'bg-accent ring-1 ring-foreground/20' : 'hover:bg-accent/60')}>
        <button type="button" onClick={onPreview} disabled={!voice.hasPreview || loading} aria-label={`${playing ? 'Stop' : `Preview ${languageLabel} sample of`} ${voice.name}`} className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-foreground transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
            {artwork && <Image src={artwork} alt="" fill sizes="40px" className="object-cover opacity-70" />}
            <span className="relative flex h-full w-full items-center justify-center">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : playing ? <Square className="h-3.5 w-3.5 fill-current" /> : voice.hasPreview ? <Play className="ml-0.5 h-3.5 w-3.5 fill-current" /> : <Music2 className="h-3.5 w-3.5" />}
            </span>
        </button>
        <button type="button" aria-pressed={selected} onClick={onSelect} aria-label={`Use ${voice.name} voice`} title={[voice.tagline, voice.description].filter(Boolean).join(' — ')} className="flex min-w-0 flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
            <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{voice.name}</span>
                {meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>}
            </span>
            <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </button>
        {selected && <Check className="h-4 w-4 shrink-0 text-foreground" aria-hidden />}
    </div>;
}

function AudioPanel({ selected, onSelect }: { selected: VoiceSelection | null; onSelect: (selection: VoiceSelection) => void }) {
    const [language, setLanguage] = useState('en');
    const [search, setSearch] = useState('');
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const playerRef = useRef<HTMLAudioElement | null>(null);
    const previewRequestRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    // Blob URLs for samples already fetched this session — the audio for a
    // given (voice, language) never changes, so a replay just reuses the
    // object URL instead of hitting the network (and, before that, Cartesia)
    // again. Not revoked between plays, only on unmount.
    const audioCacheRef = useRef<Map<string, string>>(new Map());
    const { data, isPending, isError, error, refetch } = useQuery({
        queryKey: ['creative-voices', language],
        queryFn: async (): Promise<VoicePage> => {
            const params = new URLSearchParams({ language });
            const response = await fetchCreativeVoice(`/api/creative/voices?${params}`);
            const body = await response.json();
            if (!response.ok) throw new Error(body.error ?? 'Could not load voices.');
            return body as VoicePage;
        },
        staleTime: 5 * 60 * 1000,
    });
    const voices = (data?.voices ?? []).filter(voice => `${voice.name} ${voice.tagline ?? ''} ${voice.description ?? ''}`.toLowerCase().includes(search.toLowerCase()));

    useEffect(() => () => {
        previewRequestRef.current++;
        abortRef.current?.abort();
        playerRef.current?.pause();
        for (const url of audioCacheRef.current.values()) URL.revokeObjectURL(url);
        audioCacheRef.current.clear();
    }, []);
    function stopPreview() {
        previewRequestRef.current++;
        abortRef.current?.abort();
        playerRef.current?.pause();
        playerRef.current = null;
        setPlayingId(null);
        setLoadingId(null);
    }
    async function togglePreview(voice: Voice) {
        if (playingId === voice.id) { stopPreview(); return; }
        if (!voice.hasPreview || loadingId) return;
        stopPreview();
        const requestId = previewRequestRef.current;
        const cacheKey = `${voice.id}:${language}`;

        function playUrl(url: string) {
            const audio = new Audio(url);
            playerRef.current = audio;
            setLoadingId(null);
            setPlayingId(voice.id);
            audio.onended = stopPreview;
            audio.onerror = () => { stopPreview(); toast.error('Voice preview is unavailable.'); };
            void audio.play();
        }

        const cachedUrl = audioCacheRef.current.get(cacheKey);
        if (cachedUrl) { playUrl(cachedUrl); return; }

        setLoadingId(voice.id);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const params = new URLSearchParams({ id: voice.id, language });
            const response = await fetchCreativeVoice(`/api/creative/voices/preview?${params}`, { signal: controller.signal });
            if (requestId !== previewRequestRef.current) return;
            if (!response.ok) {
                throw new Error(response.status === 429 ? 'Too many previews at once — try again in a moment.' : 'Voice preview is unavailable.');
            }
            const blob = await response.blob();
            if (requestId !== previewRequestRef.current) return;
            const url = URL.createObjectURL(blob);
            audioCacheRef.current.set(cacheKey, url);
            playUrl(url);
        } catch (err) {
            if (requestId === previewRequestRef.current && !(err instanceof DOMException && err.name === 'AbortError')) {
                stopPreview();
                toast.error(err instanceof Error ? err.message : 'Voice preview could not play.');
            }
        }
    }

    return <div className="space-y-5">
        <LibraryHeader title="Handpicked voices" search={search} onSearch={setSearch} placeholder="Search voices" />
        <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Preview each voice in the selected language, then add it to your brief.</p>
            <select value={language} onChange={event => { stopPreview(); setLanguage(event.target.value); }} aria-label="Voice language" className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground">
                {LANGUAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
        </div>
        {isPending ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> :
            isError ? <div className="rounded-xl border border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Voice library is unavailable.'} <Button variant="link" onClick={() => void refetch()}>Retry</Button></div> :
                voices.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">{search ? 'No voices match this search.' : 'No handpicked voices are available in this language yet.'}</p> :
                    <div className="space-y-4">
                        {/* India first: Hinglish creator voices are the main market's default. */}
                        {[
                            { label: 'India', items: voices.filter(voice => voice.country === 'IN') },
                            { label: 'Global', items: voices.filter(voice => voice.country !== 'IN') },
                        ].filter(group => group.items.length > 0).map((group, _, groups) => <section key={group.label}>
                            {groups.length > 1 && <h3 className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h3>}
                            <div className="grid gap-0.5 sm:grid-cols-2 lg:grid-cols-3">
                                {group.items.map(voice => {
                                    const languageLabel = LANGUAGES.find(item => item.value === language)?.label ?? language;
                                    return <VoiceCard key={voice.id} voice={voice} languageLabel={languageLabel} loading={loadingId === voice.id} playing={playingId === voice.id} selected={selected?.id === voice.id && selected.language === language} onPreview={() => void togglePreview(voice)} onSelect={() => onSelect({ kind: 'voice', id: voice.id, name: voice.name, tagline: voice.tagline, language, languageLabel })} />;
                                })}
                            </div>
                        </section>)}
                    </div>}
    </div>;
}

export function CreativeLibrary({ tab, brief, onSelect, onProductNamed, onCreateAvatar, createAvatarDisabled }: {
    tab: CreativeLibraryTab;
    brief: CreativeBrief;
    onSelect: (selection: CreativeSelection) => void;
    onProductNamed?: (product: ProductRecordSelection) => void;
    /** Present only where the chat page can send a message through the composer; shows "Create with AI" next to "Upload your own". */
    onCreateAvatar?: (category: AvatarCategory | null) => void;
    /** Disables "Create with AI" while a send is already in flight or the conversation is inactive — avoids double-creating conversations. */
    createAvatarDisabled?: boolean;
}) {
    return <section aria-label={`${tab} library`} className="mt-8 w-full text-left">
        {tab === 'templates' && <TemplatesPanel selected={brief.template} onSelect={onSelect} />}
        {tab === 'products' && <ProductsPanel selected={brief.product} onSelect={onSelect} onProductNamed={onProductNamed} />}
        {tab === 'audio' && <AudioPanel selected={brief.voice} onSelect={onSelect} />}
        {tab === 'avatars' && <AvatarsPanel selected={brief.avatar} onSelect={onSelect} onCreateAvatar={onCreateAvatar} createAvatarDisabled={createAvatarDisabled} />}
    </section>;
}
