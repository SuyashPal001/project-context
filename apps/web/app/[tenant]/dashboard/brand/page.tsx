'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PermissionGate } from '@/components/platform/PermissionGate';
import { BrandEmptyState, FAILED_COPY } from '@/components/platform/brand/BrandEmptyState';
import { BrandForm } from '@/components/platform/brand/BrandForm';
import {
    BRAND_IMAGE_PREFIX, BRAND_QUERY_KEY, getBrand, importBrand, patchBrand, type BrandPatch, type BrandRecord,
} from '@/components/platform/brand/brandApi';
import { storeCreativeImage } from '@/components/platform/chat/creative-library/storeCreativeImage';

const POLL_MS = 2000;

function Shimmer() {
    return (
        <div className="space-y-8 pt-6" aria-busy="true">
            {['Basics', 'Voice', 'Visual identity'].map((title) => (
                <section key={title}>
                    <h2 className="border-b border-border pb-2 text-base font-semibold text-foreground">{title}</h2>
                    {[0, 1, 2].map((i) => <div key={i} className="my-4 h-4 w-2/3 animate-pulse rounded bg-muted" />)}
                </section>
            ))}
        </div>
    );
}

export default function BrandPage() {
    const { tenant } = useParams<{ tenant: string }>();
    const queryClient = useQueryClient();
    const { data: brand, isLoading } = useQuery({
        queryKey: BRAND_QUERY_KEY,
        queryFn: getBrand,
        refetchInterval: (q) => ((q.state.data as BrandRecord | null | undefined)?.importStatus === 'importing' ? POLL_MS : false),
    });
    const setBrand = (b: BrandRecord) => queryClient.setQueryData(BRAND_QUERY_KEY, b);

    const save = useMutation({
        mutationFn: (patch: BrandPatch) => patchBrand(patch),
        onSuccess: setBrand,
        onError: () => toast.error("Couldn't save that. Try again."),
    });
    const startImport = useMutation({
        mutationFn: (value: string) => importBrand(value),
        onSuccess: setBrand,
        onError: () => toast.error(FAILED_COPY),
    });

    const uploadImage = async (slot: 'logo' | 'favicon' | 'mascot', file: File | null) => {
        const key = `${slot}FileId` as const;
        if (!file) return save.mutate({ [key]: null });
        try {
            const stored = await storeCreativeImage(file, BRAND_IMAGE_PREFIX);
            save.mutate({ [key]: stored.fileId });
        } catch {
            toast.error("Couldn't add that image. Try again.");
        }
    };

    const chatHref = `/${tenant}/dashboard/chat?prefill=${encodeURIComponent('Set up my brand')}`;
    const importing = brand?.importStatus === 'importing';
    const hasContent = !!brand && (!!brand.name || brand.toneWords.length > 0 || !!brand.logo);

    return (
        <PermissionGate resource="files" action="read">
            <div className="mx-auto max-w-3xl">
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Brand</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    {importing && brand?.sourceValue
                        ? `Reading ${brand.sourceValue.replace(/^https:\/\//, '').replace(/\/$/, '')}… you can leave this page.`
                        : `How ${brand?.name || 'your brand'} sounds and looks. Every ad Olmo makes follows it.`}
                </p>
                {isLoading ? null
                    : importing && !hasContent ? <Shimmer />
                    : !hasContent ? (
                        <BrandEmptyState chatHref={chatHref} busy={startImport.isPending} failed={brand?.importStatus === 'failed'}
                            onSubmit={(v) => startImport.mutate(v)} />
                    ) : (
                        <>
                            {brand!.importStatus === 'failed' && <p className="pt-4 text-sm text-destructive">{FAILED_COPY}</p>}
                            <BrandForm brand={brand!} onSave={(p) => save.mutate(p)} onUploadImage={uploadImage}
                                onRefresh={() => brand!.sourceValue && startImport.mutate(brand!.sourceValue)}
                                refreshing={importing || startImport.isPending} />
                        </>
                    )}
            </div>
        </PermissionGate>
    );
}
