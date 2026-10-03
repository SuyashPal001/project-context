import { NextResponse, type NextRequest } from 'next/server';
import { db, offeredVoiceProvider, voiceProviderOf } from '@serverless-saas/database';
import { verifyVoiceLibrarySession } from './session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
    const session = await verifyVoiceLibrarySession();
    if (session === 'unauthorized') {
        return NextResponse.json({ error: 'Sign in to browse voices.' }, { status: 401 });
    }
    if (session === 'unavailable') return NextResponse.json({ error: 'Could not verify your session.' }, { status: 502 });

    const language = request.nextUrl.searchParams.get('language') ?? 'en';
    const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
    if (!/^[a-z]{2}(?:[-_][A-Za-z]{2})?$/.test(language) || query.length > 100) {
        return NextResponse.json({ error: 'Invalid voice search.' }, { status: 400 });
    }

    try {
        // VOICE_PROVIDER picks which engine's voices are offered (default gemini).
        const provider = offeredVoiceProvider();
        const rows = (await db.query.voiceCatalogue.findMany({ orderBy: (v, { asc }) => [asc(v.name)] }))
            .filter(row => voiceProviderOf(row.providerId) === provider);
        if (rows.length === 0) {
            return NextResponse.json({ error: 'Voice library is not configured yet.' }, { status: 503 });
        }
        const matching = query
            ? rows.filter(row => `${row.name} ${row.tagline} ${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
            : rows;
        return NextResponse.json({
            voices: matching.map(row => {
                const supportedLocales = row.accents?.map(accent => accent.locale) ?? (row.language ? [row.language] : []);
                return {
                    id: row.providerId,
                    name: row.name,
                    tagline: row.tagline,
                    description: row.description ?? undefined,
                    language: row.language ?? undefined,
                    gender: row.gender ?? undefined,
                    country: row.country ?? undefined,
                    supportedLocales,
                    // `accents` is native-sound metadata, not a hard limit — the
                    // preview route synthesizes any voice in any language this
                    // route offers (see preview/route.ts), so every voice is
                    // previewable regardless of which one is selected.
                    hasPreview: true,
                };
            }),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
        return NextResponse.json({ error: 'Could not load voices right now.' }, { status: 502 });
    }
}
