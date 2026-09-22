import { NextResponse, type NextRequest } from 'next/server';
import { verifyVoiceLibrarySession } from './session';
import { CURATED_VOICES, findCuratedVoice } from './curated';

export const runtime = 'nodejs';

interface CartesiaVoice {
    id: string;
    name: string;
    tagline?: string;
    description?: string;
    language?: string;
    gender?: string;
    country?: string;
    accents?: Array<{ locale: string }>;
    preview_file_url?: string | null;
}

export async function GET(request: NextRequest) {
    const session = await verifyVoiceLibrarySession();
    if (session === 'unauthorized') {
        return NextResponse.json({ error: 'Sign in to browse voices.' }, { status: 401 });
    }
    if (session === 'unavailable') return NextResponse.json({ error: 'Could not verify your session.' }, { status: 502 });
    const key = process.env.CARTESIA_API_KEY;
    if (!key) {
        return NextResponse.json({ error: 'Voice library is not configured yet.' }, { status: 503 });
    }

    const language = request.nextUrl.searchParams.get('language') ?? 'en';
    const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
    if (!/^[a-z]{2}(?:[-_][A-Za-z]{2})?$/.test(language) || query.length > 100) {
        return NextResponse.json({ error: 'Invalid voice search.' }, { status: 400 });
    }

    try {
        const results = await Promise.allSettled(CURATED_VOICES.map(async selected => {
            const url = new URL('https://api.cartesia.ai/voices');
            url.searchParams.set('limit', '20');
            url.searchParams.set('language', language);
            url.searchParams.set('q', selected.name);
            url.searchParams.append('expand[]', 'preview_file_url');
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': '2026-08-14' },
                signal: AbortSignal.timeout(10_000),
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Voice lookup failed');
            const payload = await response.json() as { data?: CartesiaVoice[] };
            return payload.data?.find(voice =>
                voice.name.toLowerCase() === selected.name.toLowerCase()
                && voice.tagline?.toLowerCase() === selected.tagline.toLowerCase()
            );
        }));
        if (results.every(result => result.status === 'rejected')) {
            return NextResponse.json({ error: 'Could not load voices right now.' }, { status: 502 });
        }
        const voices = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
        const matching = query ? voices.filter(voice => `${voice.name} ${voice.tagline ?? ''} ${voice.description ?? ''}`.toLowerCase().includes(query.toLowerCase())) : voices;
        return NextResponse.json({
            voices: matching.map(({ id, name, tagline, description, language: voiceLanguage, gender, country, accents, preview_file_url }) => {
                const supportedLocales = accents?.map(accent => accent.locale) ?? (voiceLanguage ? [voiceLanguage] : []);
                const supportsRequestedLanguage = supportedLocales.some(locale => locale.split(/[-_]/)[0] === language);
                return {
                    id, name, tagline, description, language: voiceLanguage, gender, country, supportedLocales,
                    hasPreview: supportsRequestedLanguage
                        || Boolean(preview_file_url || (tagline && findCuratedVoice({ name, tagline })?.previewAsset)),
                };
            }),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
        return NextResponse.json({ error: 'Could not load voices right now.' }, { status: 502 });
    }
}
