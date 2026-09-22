import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, voiceCatalogue } from '@serverless-saas/database';
import { verifyVoiceLibrarySession } from '../session';

export const runtime = 'nodejs';

const SAMPLE_TRANSCRIPTS: Record<string, string> = {
    ar: 'مرحباً! كيف حالك اليوم؟',
    zh: '你好！你今天好吗？',
    fr: "Bonjour ! Comment allez-vous aujourd'hui ?",
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

        if (language !== 'en') {
            if (voice.accents?.length && !voice.accents.some(accent => accent.locale.split(/[-_]/)[0] === language)) {
                return NextResponse.json({ error: 'This voice does not support that language.' }, { status: 404 });
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
                return sampleResponse(generated);
            } finally {
                pendingSamples.delete(cacheKey);
            }
        }
        if (!voice.previewFileUrl) {
            if (!voice.localPreviewAsset) return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 404 });
            return NextResponse.redirect(new URL(voice.localPreviewAsset, request.url), {
                headers: { 'Cache-Control': 'private, no-store' },
            });
        }
        const previewUrl = new URL(voice.previewFileUrl);
        if (previewUrl.protocol !== 'https:' || (previewUrl.hostname !== 'cartesia.ai' && !previewUrl.hostname.endsWith('.cartesia.ai'))) {
            return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 502 });
        }
        const preview = await fetch(previewUrl, { headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        const contentType = preview.headers.get('content-type') ?? '';
        const length = Number(preview.headers.get('content-length') ?? 0);
        if (!preview.ok || (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') || length > 10 * 1024 * 1024) {
            return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 502 });
        }
        const bytes = await preview.arrayBuffer();
        if (bytes.byteLength > 10 * 1024 * 1024) return NextResponse.json({ error: 'Voice preview is too large.' }, { status: 502 });
        return new NextResponse(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' } });
    } catch {
        return NextResponse.json({ error: 'Voice preview is unavailable.' }, { status: 502 });
    }
}
