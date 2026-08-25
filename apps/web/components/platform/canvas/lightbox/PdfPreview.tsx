'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

// The browser's own native PDF viewer via <iframe>, no rendering library
// needed. `url` is the file's presigned S3 URL — the gallery loads assets
// from persisted messages, not a live File already in memory.
//
// The iframe is handed the URL only after a probe confirms it actually serves
// a PDF. Without that check a failed fetch is invisible: S3 answers with an
// XML error body, the browser renders it as plain text on its own white page,
// and it reads as a styling bug rather than a broken file. (It was one — the
// API Lambda's role was missing s3:GetObject.) The probe can't be a HEAD: a
// presigned URL signs its HTTP method, so HEAD on a GET-signed URL fails on
// signature alone. A ranged GET is unsigned in the same way but reads cheap.
const PROBE_BYTES = 1024;

type ProbeState = 'checking' | 'ok' | 'failed';

function usePdfProbe(url: string): ProbeState {
    const [state, setState] = useState<ProbeState>('checking');

    useEffect(() => {
        let cancelled = false;
        setState('checking');

        fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } })
            .then(async (res) => {
                if (!res.ok) return 'failed' as const;
                // A 200 is not proof: an error page is a successful response
                // carrying the wrong bytes. Every PDF starts with "%PDF".
                const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 4);
                const magic = String.fromCharCode(...head);
                return magic === '%PDF' ? ('ok' as const) : ('failed' as const);
            })
            .catch(() => 'failed' as const)
            .then((result) => { if (!cancelled) setState(result); });

        return () => { cancelled = true; };
    }, [url]);

    return state;
}

export function PdfPreview({ url }: { url: string }) {
    const state = usePdfProbe(url);

    if (state === 'checking') {
        return <p className="text-sm text-muted-foreground">Loading preview…</p>;
    }

    if (state === 'failed') {
        return (
            <div className="text-sm text-muted-foreground text-center max-w-xs space-y-2">
                <p>Couldn&apos;t load this PDF.</p>
                <a href={url} download className="inline-flex items-center gap-1.5 text-shimmer-accent hover:underline">
                    <Download className="h-3.5 w-3.5" />
                    Download to view
                </a>
            </div>
        );
    }

    return (
        <iframe
            src={`${url}#toolbar=0`}
            // Deliberately white, not a token: the iframe's content is the
            // browser's own PDF viewer, cross-origin and beyond our stylesheet.
            // A PDF page is white paper, and a transparent frame over the dark
            // backdrop flashes broken while the viewer loads.
            className="w-full h-full max-w-3xl border-0 rounded-md bg-white shadow-xl"
            title="PDF preview"
        />
    );
}
