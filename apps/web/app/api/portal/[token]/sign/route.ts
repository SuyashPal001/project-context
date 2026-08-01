import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/packs/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await req.text(),
    });
    return NextResponse.json(await res.json(), { status: res.status });
}
