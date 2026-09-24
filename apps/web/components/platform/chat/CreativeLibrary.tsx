"use client";

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Music2, Play, Search, Square, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { Attachment } from '@/types/agent-events';
import type { FileRecord } from '@/components/platform/files/types';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { CREATIVE_TEMPLATES } from './creativeLibraryTemplates';
import { CREATIVE_AVATARS, type CreativeAvatar } from './creativeLibraryAvatars';
import { fetchCreativeVoice } from './creativeVoiceFetch';
import { cn } from '@/lib/utils';
import { ProductImportCard } from './creative-library/ProductImportCard';
import type {
    AvatarSelection,
    CreativeBrief,
    CreativeLibraryTab,
    CreativeSelection,
    ImportedProductData,
    ProductSelection,
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

const PRODUCT_PREFIX = 'creative-products/';
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

async function storeCreativeImage(file: File, prefix: string): Promise<Attachment> {
    const key = `${prefix}${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const { data: upload } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename: file.name, contentType: file.type, key, size: file.size,
    });
    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error('Image upload failed.');
    await api.post(`/api/v1/files/${upload.fileId}/confirm`, { size: file.size });
    return { fileId: upload.fileId, name: file.name, type: file.type, size: file.size };
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

function ProductsPanel({ selected, onSelect }: { selected: ProductSelection | null; onSelect: (selection: ProductSelection) => void }) {
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const [url, setUrl] = useState('');
    const [search, setSearch] = useState('');
    const [uploading, setUploading] = useState(false);
    const [importingLink, setImportingLink] = useState(false);
    const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
        queryKey: ['creative-products'],
        initialPageParam: 0,
        queryFn: ({ pageParam }) => api.get<{ data: FileRecord[] }>(`/api/v1/files?prefix=${encodeURIComponent(PRODUCT_PREFIX)}&limit=50&offset=${pageParam}`),
        getNextPageParam: (last, pages) => last.data.length === 50 ? pages.length * 50 : undefined,
    });
    const products = (data?.pages.flatMap(page => page.data) ?? []).filter(file => file.key.startsWith(PRODUCT_PREFIX) && IMAGE_TYPES.has(file.contentType));
    const matches = products.filter(file => file.filename.toLowerCase().includes(search.toLowerCase()));
    const showArtwork = !isPending && !isError && products.length === 0 && !search;

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    async function uploadImage(file: File) {
        if (!IMAGE_TYPES.has(file.type)) { toast.error('Choose a JPG, PNG, or WebP image.'); return; }
        if (file.size > 35 * 1024 * 1024) { toast.error('Product images must be under 35 MB.'); return; }
        setUploading(true);
        try {
            const attachment = await storeCreativeImage(file, PRODUCT_PREFIX);
            await queryClient.invalidateQueries({ queryKey: ['creative-products'] });
            if (mountedRef.current) {
                onSelect({ kind: 'product-image', id: attachment.fileId, name: file.name, attachment });
                toast.success('Product image selected.');
            }
        } catch {
            if (mountedRef.current) toast.error('Could not upload the product image. Please try again.');
        } finally {
            if (mountedRef.current) setUploading(false);
        }
    }

    async function addLink() {
        if (importingLink) return;
        let parsed: URL;
        try {
            parsed = new URL(url.trim());
            if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
        } catch {
            toast.error('Enter a valid product URL beginning with https://');
            return;
        }

        // Re-submitting the URL that's already the current, successfully-imported
        // selection would otherwise re-download the same images again. A URL
        // whose previous import failed (no `imported`) is intentionally NOT
        // skipped here — it must be retryable.
        if (selected?.kind === 'product-url' && selected.url === parsed.href && selected.imported) {
            setUrl('');
            return;
        }

        setImportingLink(true);
        try {
            const response = await api.post<{ data: ImportedProductData }>('/api/v1/products/import', { url: parsed.href });
            onSelect({
                kind: 'product-url',
                id: parsed.href,
                name: response.data.title || parsed.hostname,
                url: parsed.href,
                imported: {
                    ...response.data,
                    selectedImageId: response.data.images[0]?.fileId ?? null,
                },
            });
        } catch {
            toast.error('Could not read that product page — added the link only.');
            onSelect({ kind: 'product-url', id: parsed.href, name: parsed.hostname, url: parsed.href });
        } finally {
            setImportingLink(false);
            setUrl('');
        }
    }

    return <div className="space-y-5">
        <LibraryHeader title="Products" search={search} onSearch={setSearch} placeholder="Search product images" />
        {showArtwork && <p className="text-sm text-muted-foreground">Start with your own product. Add its page link or upload a photo.</p>}
        <div className={showArtwork ? 'grid gap-5 sm:grid-cols-2' : 'flex flex-col gap-4 sm:flex-row sm:items-start'}>
            <div className={showArtwork ? 'min-w-0 space-y-3' : 'min-w-0 flex-1 space-y-2'}>
                {showArtwork && <>
                    <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border bg-muted">
                        <Image src="/creative/products/add-link.jpg" alt="" fill sizes="(max-width: 640px) 90vw, 320px" className="object-cover" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">Add a product link</h3>
                </>}
                <form onSubmit={event => { event.preventDefault(); addLink(); }} className="flex gap-2">
                    <Input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="Paste a product page link" aria-label="Product page link" className="h-10 min-w-0" />
                    <Button type="submit" disabled={!url.trim() || importingLink} className="shrink-0">
                        {importingLink ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Add link
                    </Button>
                </form>
                <p className="text-xs text-muted-foreground">We&apos;ll try to pull the product name, description and images from the page.</p>
                {selected?.kind === 'product-url' && selected.imported && (
                    <ProductImportCard selection={selected} onChange={(next) => onSelect(next)} />
                )}
            </div>
            <div className={showArtwork ? 'min-w-0 space-y-3' : 'shrink-0 space-y-2'}>
                {showArtwork && <>
                    <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border bg-muted">
                        <Image src="/creative/products/upload-photo.jpg" alt="" fill sizes="(max-width: 640px) 90vw, 320px" className="object-cover" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">Upload a product photo</h3>
                </>}
                <Button type="button" variant="outline" size={showArtwork ? 'default' : 'sm'} disabled={uploading} onClick={() => inputRef.current?.click()}>
                    {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                    {uploading ? 'Uploading…' : 'Upload image'}
                </Button>
                {showArtwork && <p className="text-xs text-muted-foreground">Use a clear image of the product you want to feature.</p>}
                <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload product image" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ''; }} />
            </div>
        </div>
        {isPending ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> :
            isError ? <div className="py-10 text-center text-sm text-muted-foreground">Could not load product images. <Button variant="link" onClick={() => void refetch()}>Retry</Button></div> :
                matches.length === 0 ? search && <p className="py-10 text-center text-sm text-muted-foreground">No product images match your search.</p> :
                    <div className="space-y-4">
                        <h3 className="text-sm font-medium text-muted-foreground">Your product images</h3>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                            {matches.map(file => <button key={file.id} type="button" aria-pressed={selected?.kind === 'product-image' && selected.id === file.id} onClick={() => onSelect({ kind: 'product-image', id: file.id, name: file.filename, attachment: { fileId: file.id, name: file.filename, type: file.contentType, size: file.size } })} aria-label={`Use ${file.filename} product image`} className="group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                <div className={cn("relative aspect-square overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50", selected?.kind === 'product-image' && selected.id === file.id ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
                                    <FileThumbnail fileId={file.id} alt={file.filename} />
                                    {selected?.kind === 'product-image' && selected.id === file.id && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
                                    <span className="absolute bottom-2 right-2 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm">Use image</span>
                                </div>
                                <span className="mt-2 block truncate text-sm font-semibold text-foreground" title={file.filename}>{file.filename}</span>
                            </button>)}
                        </div>
                    </div>}
        {hasNextPage && <div className="flex justify-center"><Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Load more images'}</Button></div>}
    </div>;
}

function VoiceCard({ voice, languageLabel, playing, selected, onPreview, onSelect }: { voice: Voice; languageLabel: string; playing: boolean; selected: boolean; onPreview: () => void; onSelect: () => void }) {
    return <div className={cn("relative rounded-xl border bg-muted/30 p-3 transition-colors hover:border-foreground/30", selected ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
        <div className="flex min-w-0 gap-3">
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">
                {creativeVoiceArtwork(voice.name) && <Image src={creativeVoiceArtwork(voice.name)!} alt="" fill sizes="96px" className="object-cover" />}
                <button type="button" onClick={onPreview} disabled={!voice.hasPreview} aria-label={`${playing ? 'Stop' : `Preview ${languageLabel} sample of`} ${voice.name}`} className="absolute inset-0 m-auto flex h-9 w-9 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
                    {playing ? <Square className="h-3.5 w-3.5 fill-current" /> : voice.hasPreview ? <Play className="ml-0.5 h-3.5 w-3.5 fill-current" /> : <Music2 className="h-3.5 w-3.5" />}
                </button>
            </div>
            <button type="button" aria-pressed={selected} onClick={onSelect} aria-label={`Use ${voice.name} voice`} className="flex min-w-0 flex-1 flex-col rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="block pr-7 text-sm font-semibold leading-5 text-foreground">{voice.name}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{voice.tagline || voice.description || [voice.gender, voice.country].filter(Boolean).join(' · ') || 'Natural voice'}</span>
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
    const playerRef = useRef<HTMLAudioElement | null>(null);
    const playerUrlRef = useRef<string | null>(null);
    const previewRequestRef = useRef(0);
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
        playerRef.current?.pause();
        if (playerUrlRef.current) URL.revokeObjectURL(playerUrlRef.current);
    }, []);
    function stopPreview() {
        previewRequestRef.current++;
        playerRef.current?.pause();
        playerRef.current = null;
        if (playerUrlRef.current) URL.revokeObjectURL(playerUrlRef.current);
        playerUrlRef.current = null;
        setPlayingId(null);
    }
    async function togglePreview(voice: Voice) {
        if (playingId === voice.id) { stopPreview(); return; }
        if (!voice.hasPreview) return;
        stopPreview();
        const requestId = previewRequestRef.current;
        setPlayingId(voice.id);
        try {
            const params = new URLSearchParams({ id: voice.id, language });
            const response = await fetchCreativeVoice(`/api/creative/voices/preview?${params}`);
            if (!response.ok) throw new Error('Voice preview is unavailable.');
            const blob = await response.blob();
            if (requestId !== previewRequestRef.current) return;
            const url = URL.createObjectURL(blob);
            playerUrlRef.current = url;
            const audio = new Audio(url);
            playerRef.current = audio;
            audio.onended = stopPreview;
            audio.onerror = () => { stopPreview(); toast.error('Voice preview is unavailable.'); };
            await audio.play();
        } catch {
            if (requestId === previewRequestRef.current) {
                stopPreview();
                toast.error('Voice preview could not play.');
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
                            return <VoiceCard key={voice.id} voice={voice} languageLabel={languageLabel} playing={playingId === voice.id} selected={selected?.id === voice.id && selected.language === language} onPreview={() => void togglePreview(voice)} onSelect={() => onSelect({ kind: 'voice', id: voice.id, name: voice.name, tagline: voice.tagline, language, languageLabel })} />;
                        })}
                    </div>}
    </div>;
}

export function CreativeLibrary({ tab, brief, onSelect }: { tab: CreativeLibraryTab; brief: CreativeBrief; onSelect: (selection: CreativeSelection) => void }) {
    return <section aria-label={`${tab} library`} className="mt-8 w-full text-left">
        {tab === 'templates' && <TemplatesPanel selected={brief.template} onSelect={onSelect} />}
        {tab === 'products' && <ProductsPanel selected={brief.product} onSelect={onSelect} />}
        {tab === 'audio' && <AudioPanel selected={brief.voice} onSelect={onSelect} />}
        {tab === 'avatars' && <AvatarsPanel selected={brief.avatar} onSelect={onSelect} />}
    </section>;
}
