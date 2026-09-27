import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, voiceCatalogue } from '@serverless-saas/database';
import { storageService } from '@serverless-saas/storage';
import { verifyVoiceLibrarySession } from '../session';

export const runtime = 'nodejs';

const SAMPLE_TRANSCRIPTS: Record<string, string> = {
    en: 'Hello! How are you doing today?',
    ar: 'مرحباً! كيف حالك اليوم؟',
    zh: '你好！你今天好吗？',
    fr: 'Bonjour ! Comment allez-vous aujourd’hui ?',
    de: 'Hallo! Wie geht es Ihnen heute?',
    he: 'שלום! מה שלומך היום?',
    hi: 'नमस्ते! आज आप कैसे हैं?',
    it: 'Ciao! Come stai oggi?',
    ja: 'こんにちは！今日はお元気ですか？',
    pt: 'Olá! Como você está hoje?',
    es: '¡Hola! ¿Cómo estás hoy?',
    ta: 'வணக்கம்! இன்று நீங்கள் எப்படி இருக்கிறீர்கள்?',
    te: 'నమస్కారం! ఈ రోజు మీరు ఎలా ఉన్నారు?',
    th: 'สวัสดี! วันนี้คุณสบายดีไหม?',
};
const SAMPLE_CACHE_LIMIT = 128;
const SAMPLE_GENERATION_LIMIT = 16;
const SAMPLE_GENERATION_WINDOW_MS = 60_000;
interface CachedSample { bytes: ArrayBuffer; contentType: string }
const sampleCache = new Map<string, CachedSample>();
const pendingSamples = new Map<string, Promise<CachedSample>>();
let generationWindowStartedAt = 0;
let generationsInWindow = 0;

function sampleResponse(sample: CachedSample): NextResponse {
    return new NextResponse(sample.bytes.slice(0), { headers: {
        'Content-Type': sample.contentType,
        'Cache-Control': 'private, max-age=86400',
        'CDN-Cache-Control': 'public, s-maxage=31536000, stale-while-revalidate=86400',
    } });
}

// (voice, language) -> the audio is always the same fixed transcript synthesized
// with the same voice, so once generated it never needs regenerating.
function generatedPreviewStorageKey(providerId: string, language: string): string {
    return `creative-library/voice-previews/${providerId}/${language}.wav`;
}

function reserveGeneration(): boolean {
    const now = Date.now();
    if (now - generationWindowStartedAt >= SAMPLE_GENERATION_WINDOW_MS) {
        generationWindowStartedAt = now;
        generationsInWindow = 0;
    }
    if (generationsInWindow >= SAMPLE_GENERATION_LIMIT) return false;
    generationsInWindow++;
    return true;
}

function cacheSample(key: string, sample: CachedSample): void {
    if (sampleCache.size >= SAMPLE_CACHE_LIMIT) {
        const oldest = sampleCache.keys().next().value;
        if (oldest) sampleCache.delete(oldest);
    }
    sampleCache.set(key, sample);
}

export async function GET(request: NextRequest) {
    const session = await verifyVoiceLibrarySession();
    if (session === 'unauthorized') return NextResponse.json({ error: 'Sign in to preview voices.' }, { status: 401 });
    if (session === 'unavailable') return NextResponse.json({ error: 'Could not verify your session.' }, { status: 502 });

    const key = process.env.CARTESIA_API_KEY;
    if (!key) return NextResponse.json({ error: 'Voice library is not configured yet.' }, { status: 503 });
    const id = request.nextUrl.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ error: 'Invalid voice.' }, { status: 400 });
    const language = request.nextUrl.searchParams.get('language') ?? 'en';
    if (language !== 'en' && !Object.hasOwn(SAMPLE_TRANSCRIPTS, language)) {
        return NextResponse.json({ error: 'Invalid sample language.' }, { status: 400 });
    }

    try {
        const voice = await db.query.voiceCatalogue.findFirst({ where: eq(voiceCatalogue.providerId, id) });
        if (!voice) return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 404 });

        if (language !== 'en' && voice.accents?.length && !voice.accents.some(accent => accent.locale.split(/[-_]/)[0] === language)) {
            return NextResponse.json({ error: 'This voice does not support that language.' }, { status: 404 });
        }

        // Our own persisted copy of a previously-generated sample — checked first,
        // for every language, before either the Cartesia-hosted preview or a fresh
        // TTS call. This is what turns "call Cartesia on every preview" into
        // "call Cartesia once per (voice, language), ever."
        const existingGeneratedKey = voice.generatedPreviewKeys?.[language];
        if (existingGeneratedKey) {
            try {
                const bytes = await storageService.getLibraryAssetBytes(existingGeneratedKey);
                return new NextResponse(new Uint8Array(bytes), { headers: {
                    'Content-Type': 'audio/wav',
                    'Cache-Control': 'private, max-age=86400',
                    'CDN-Cache-Control': 'public, s-maxage=31536000, stale-while-revalidate=86400',
                } });
            } catch {
                // Object missing/unreadable — fall through and regenerate below,
                // which will also repair generatedPreviewKeys.
            }
        }

        if (language === 'en') {
            // Static clip first, then the bundled local asset; if neither exists (or the static clip
            // fetch fails) fall through to on-demand TTS below so every English voice stays previewable.
            if (voice.previewFileUrl) {
                const previewUrl = new URL(voice.previewFileUrl);
                if (previewUrl.protocol === 'https:' && (previewUrl.hostname === 'cartesia.ai' || previewUrl.hostname.endsWith('.cartesia.ai'))) {
                    const preview = await fetch(previewUrl, { headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
                    const contentType = preview.headers.get('content-type') ?? '';
                    const length = Number(preview.headers.get('content-length') ?? 0);
                    if (preview.ok && (contentType.startsWith('audio/') || contentType === 'application/octet-stream') && length <= 10 * 1024 * 1024) {
                        const bytes = await preview.arrayBuffer();
                        if (bytes.byteLength <= 10 * 1024 * 1024) {
                            return new NextResponse(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' } });
                        }
                    }
                }
            }
            if (voice.localPreviewAsset) {
                // Read the bundled file from disk rather than redirecting to it: a
                // redirect resolves against `request.url`'s host, which is not
                // always what a browser can reach (e.g. a dev server bound to
                // 0.0.0.0 — a wildcard bind address, not a real destination —
                // produced a redirect to https://0.0.0.0:3000/... that every
                // browser refuses to connect to). Serving the bytes directly
                // works the same in every environment.
                try {
                    const bytes = await readFile(path.join(process.cwd(), 'public', voice.localPreviewAsset));
                    return new NextResponse(new Uint8Array(bytes), { headers: {
                        'Content-Type': 'audio/wav',
                        'Cache-Control': 'private, no-store',
                    } });
                } catch {
                    // Bundled file missing on disk — fall through to on-demand
                    // TTS below so the voice stays previewable.
                }
            }
        }
        const cacheKey = `${id}:${language}`;
        const cached = sampleCache.get(cacheKey);
        if (cached) return sampleResponse(cached);
        let pending = pendingSamples.get(cacheKey);
        if (!pending) {
            if (!reserveGeneration()) return NextResponse.json({ error: 'Too many voice previews. Please try again shortly.' }, { status: 429 });
            pending = (async () => {
                const sample = await fetch('https://api.cartesia.ai/tts/bytes', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-03-01', 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model_id: 'sonic-3.5',
                        transcript: SAMPLE_TRANSCRIPTS[language],
                        voice: { mode: 'id', id },
                        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
                        language,
                    }),
                    cache: 'no-store',
                    signal: AbortSignal.timeout(20_000),
                });
                const contentType = sample.headers.get('content-type') ?? '';
                const length = Number(sample.headers.get('content-length') ?? 0);
                if (!sample.ok || !contentType.startsWith('audio/') || length > 10 * 1024 * 1024) throw new Error('Voice preview is unavailable.');
                const bytes = await sample.arrayBuffer();
                if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Voice preview is too large.');
                return { bytes, contentType };
            })();
            pendingSamples.set(cacheKey, pending);
        }
        try {
            const generated = await pending;
            cacheSample(cacheKey, generated);
            // Write-through to S3 + DB so this (voice, language) never has to hit
            // Cartesia again. Only pays this extra latency once ever, per
            // (voice, language) — best-effort: a failure here still lets the
            // user hear the preview they just paid a generation for, it just
            // stays uncached and the next request retries the write-through.
            try {
                const storageKey = generatedPreviewStorageKey(id, language);
                await storageService.putLibraryAsset(storageKey, Buffer.from(generated.bytes), generated.contentType);
                await db.update(voiceCatalogue)
                    .set({ generatedPreviewKeys: { ...(voice.generatedPreviewKeys ?? {}), [language]: storageKey } })
                    .where(eq(voiceCatalogue.providerId, id));
            } catch {
                // Swallow — see comment above.
            }
            return sampleResponse(generated);
        } finally {
            pendingSamples.delete(cacheKey);
        }
    } catch {
        return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 502 });
    }
}
