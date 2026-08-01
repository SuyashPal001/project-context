import { notFound } from 'next/navigation';
import { SignOffForm } from './SignOffForm';

interface PortalItem {
    title: string;
    description: string | null;
    statusLabel: string | null;
    categoryLabel: string | null;
    url: string | null;
}

interface PortalSection {
    kind: string;
    title: string;
    subtitle: string | null;
    eyebrow: string | null;
    items: PortalItem[];
}

interface PortalPack {
    title: string;
    scopeSummary: string | null;
    deliveryDate: string | null;
    status: string;
    signedAt: string | null;
    signedByName: string | null;
    sections: PortalSection[];
}

function safeHref(url: string | null): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;

    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/packs/${token}`, { cache: 'no-store' });
    if (!res.ok) notFound();
    const pack: PortalPack = (await res.json()).data;

    return (
        <div className="min-h-screen bg-background px-6 py-12">
            <div className="mx-auto max-w-3xl">
                <h1 className="text-3xl font-bold">{pack.title}</h1>
                {pack.scopeSummary ? <p className="mt-2 text-muted-foreground">{pack.scopeSummary}</p> : null}

                {pack.sections.map((section) => (
                    <section key={section.kind} className="mt-12">
                        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{section.eyebrow}</p>
                        <h2 className="mt-2 text-2xl font-bold">{section.subtitle ?? section.title}</h2>
                        <div className="mt-6 space-y-3">
                            {section.items.map((item, i) => (
                                <div key={`${section.kind}-${i}`} className="rounded-xl border border-border bg-card px-5 py-4">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{item.title}</span>
                                        {item.statusLabel ? (
                                            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{item.statusLabel}</span>
                                        ) : null}
                                        {item.categoryLabel ? (
                                            <span className="ml-auto rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{item.categoryLabel}</span>
                                        ) : null}
                                    </div>
                                    {item.description ? <p className="mt-1 text-sm text-muted-foreground">{item.description}</p> : null}
                                    {(() => {
                                        const href = safeHref(item.url);
                                        return href ? (
                                            <a href={href} className="mt-2 inline-block text-sm text-amber-500 underline" rel="noreferrer noopener" target="_blank">
                                                Open
                                            </a>
                                        ) : null;
                                    })()}
                                </div>
                            ))}
                        </div>
                    </section>
                ))}

                <div className="mt-12">
                    <SignOffForm token={token} signedByName={pack.signedByName} />
                </div>
            </div>
        </div>
    );
}
