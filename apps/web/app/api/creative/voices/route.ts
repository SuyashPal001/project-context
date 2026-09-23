import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@serverless-saas/database';
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
        const rows = await db.query.voiceCatalogue.findMany({ orderBy: (v, { asc }) => [asc(v.name)] });
        if (rows.length === 0) {
            return NextResponse.json({ error: 'Voice library is not configured yet.' }, { status: 503 });
        }
        const matching = query
            ? rows.filter(row => `${row.name} ${row.tagline} ${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
            : rows;
        return NextResponse.json({
            voices: matching.map(row => {
                const supportedLocales = row.accents?.map(accent => accent.locale) ?? (row.language ? [row.language] : []);
                const supportsRequestedLanguage = supportedLocales.some(locale => locale.split(/[-_]/)[0] === language);
                return {
                    id: row.providerId,
                    name: row.name,
                    tagline: row.tagline,
                    description: row.description ?? undefined,
                    language: row.language ?? undefined,
                    gender: row.gender ?? undefined,
                    country: row.country ?? undefined,
                    supportedLocales,
                    hasPreview: supportsRequestedLanguage || Boolean(row.previewFileUrl || row.localPreviewAsset),
                };
            }),
        }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
        return NextResponse.json({ error: 'Could not load voices right now.' }, { status: 502 });
    }
}
