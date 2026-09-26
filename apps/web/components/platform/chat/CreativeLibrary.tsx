"use client";

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, Music2, Play, Search, Square, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CREATIVE_TEMPLATES } from './creativeLibraryTemplates';
import { CREATIVE_AVATARS, type CreativeAvatar } from './creativeLibraryAvatars';
import { fetchCreativeVoice } from './creativeVoiceFetch';
import { cn } from '@/lib/utils';
import { ProductsPanel } from './creative-library/ProductsPanel';
import { storeCreativeImage } from './creative-library/storeCreativeImage';
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

function AvatarsPanel({ selected, onSelect }: { selected: AvatarSelection | null; onSelect: (selection: AvatarSelection) => void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const [search, setSearch] = useState('');
    const [uploading, setUploading] = useState<string | null>(null);
    const matches = CREATIVE_AVATARS.filter(avatar => `${avatar.name} ${avatar.role} ${avatar.tone}`.toLowerCase().includes(search.toLowerCase()));

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    function selectPreset(avatar: CreativeAvatar) {
        onSelect({ kind: 'avatar', ...avatar, attachment: { fileId: avatar.assetId, name: avatar.name, type: 'image/jpeg', size: 0 } });
    }

    async function uploadOwnImage(file: File) {
        if (!IMAGE_TYPES.has(file.type)) { toast.error('Choose a JPG, PNG, or WebP image.'); return; }
        if (file.size > 35 * 1024 * 1024) { toast.error('Presenter images must be under 35 MB.'); return; }
        setUploading('custom');
        try {
            const attachment = await storeCreativeImage(file, AVATAR_PREFIX);
            if (mountedRef.current) onSelect({ kind: 'avatar', id: `custom:${attachment.fileId}`, name: file.name, role: 'Uploaded presenter', tone: 'Custom', attachment });
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
            <Button type="button" variant="outline" size="sm" disabled={uploading !== null} onClick={() => inputRef.current?.click()}>
                {uploading === 'custom' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                Upload your own
            </Button>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload presenter image" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadOwnImage(file); event.target.value = ''; }} />
        </div>
        {matches.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No avatars match your search.</p> :
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                {matches.map(avatar => <button key={avatar.id} type="button" aria-pressed={selected?.id === avatar.id} disabled={uploading !== null} onClick={() => { if (selected?.id !== avatar.id) selectPreset(avatar); }} aria-label={`Use ${avatar.name} avatar`} className="group min-w-0 text-left disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className={cn("relative block aspect-[4/5] overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50", selected?.id === avatar.id ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
                        <Image src={avatar.image} alt="" fill sizes="(max-width: 640px) 45vw, 220px" className="object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                        {selected?.id === avatar.id && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
                        <span className="absolute bottom-2 right-2 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">
                            {uploading === avatar.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Use avatar'}
                        </span>
                    </span>
                    <span className="mt-2 block truncate text-sm font-semibold text-foreground">{avatar.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{avatar.role} · {avatar.tone}</span>
                </button>)}
            </div>}
    </div>;
}

function VoiceCard({ voice, languageLabel, loading, playing, selected, onPreview, onSelect }: { voice: Voice; languageLabel: string; loading: boolean; playing: boolean; selected: boolean; onPreview: () => void; onSelect: () => void }) {
    return <div className={cn("relative rounded-xl border bg-muted/30 p-3 transition-colors hover:border-foreground/30", selected ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
        <div className="flex min-w-0 gap-3">
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">
                {creativeVoiceArtwork(voice.name) && <Image src={creativeVoiceArtwork(voice.name)!} alt="" fill sizes="96px" className="object-cover" />}
                <button type="button" onClick={onPreview} disabled={!voice.hasPreview || loading} aria-label={`${playing ? 'Stop' : `Preview ${languageLabel} sample of`} ${voice.name}`} className="absolute inset-0 m-auto flex h-9 w-9 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : playing ? <Square className="h-3.5 w-3.5 fill-current" /> : voice.hasPreview ? <Play className="ml-0.5 h-3.5 w-3.5 fill-current" /> : <Music2 className="h-3.5 w-3.5" />}
                </button>
            </div>
            <button type="button" aria-pressed={selected} onClick={onSelect} aria-label={`Use ${voice.name} voice`} className="flex min-w-0 flex-1 flex-col rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="block pr-7 text-sm font-semibold leading-5 text-foreground">{voice.name}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{[voice.tagline, voice.description].filter(Boolean).join(' — ') || [voice.gender, voice.country].filter(Boolean).join(' · ') || 'Natural voice'}</span>
                <span className="mt-auto flex flex-wrap gap-1.5 pt-2">
                    {[languageLabel, voice.gender, voice.country].filter((value): value is string => Boolean(value)).map(value => <span key={value} className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{value}</span>)}
                </span>
            </button>
            {selected && <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
        </div>
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
                    <div className="grid gap-3 sm:grid-cols-2">
                        {voices.map(voice => {
                            const languageLabel = LANGUAGES.find(item => item.value === language)?.label ?? language;
                            return <VoiceCard key={voice.id} voice={voice} languageLabel={languageLabel} loading={loadingId === voice.id} playing={playingId === voice.id} selected={selected?.id === voice.id && selected.language === language} onPreview={() => void togglePreview(voice)} onSelect={() => onSelect({ kind: 'voice', id: voice.id, name: voice.name, tagline: voice.tagline, language, languageLabel })} />;
                        })}
                    </div>}
    </div>;
}

export function CreativeLibrary({ tab, brief, onSelect, onProductNamed }: {
    tab: CreativeLibraryTab;
    brief: CreativeBrief;
    onSelect: (selection: CreativeSelection) => void;
    onProductNamed?: (product: ProductRecordSelection) => void;
}) {
    return <section aria-label={`${tab} library`} className="mt-8 w-full text-left">
        {tab === 'templates' && <TemplatesPanel selected={brief.template} onSelect={onSelect} />}
        {tab === 'products' && <ProductsPanel selected={brief.product} onSelect={onSelect} onProductNamed={onProductNamed} />}
        {tab === 'audio' && <AudioPanel selected={brief.voice} onSelect={onSelect} />}
        {tab === 'avatars' && <AvatarsPanel selected={brief.avatar} onSelect={onSelect} />}
    </section>;
}
