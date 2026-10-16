'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PermissionGate } from '@/components/platform/PermissionGate';
import { BrandForm } from '@/components/platform/brand/BrandForm';
import {
    BRAND_IMAGE_PREFIX, BRAND_QUERY_KEY, EMPTY_BRAND, getBrand, importBrand, importErrorMessage, patchBrand, type BrandPatch, type BrandRecord,
} from '@/components/platform/brand/brandApi';
import { storeCreativeImage } from '@/components/platform/chat/creative-library/storeCreativeImage';

const POLL_MS = 2000;
const FAILED_COPY = "Couldn't read that. Tell Olmo about your brand instead.";

export default function BrandPage() {
    const { tenant } = useParams<{ tenant: string }>();
    const queryClient = useQueryClient();
    const { data: brand, isLoading, isError, refetch } = useQuery({
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
        onError: (err) => toast.error(importErrorMessage(err, FAILED_COPY)),
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

    return (
        <PermissionGate resource="files" action="read">
            <div className="mx-auto max-w-3xl">
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Brand</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    {importing && brand?.sourceValue
                        ? `Reading ${brand.sourceValue.replace(/^https:\/\//, '').replace(/\/$/, '')}… fields fill in as they're found.`
                        : `How ${brand?.name || 'your brand'} sounds and looks. Every ad Olmo makes follows it.`}
                </p>
                {isLoading ? null
                    : isError ? (
                        <div className="flex flex-col items-center gap-3 py-16 text-center">
                            <p className="text-sm text-muted-foreground">Couldn't load your brand. Try again.</p>
                            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
                        </div>
                    ) : (
                        <BrandForm brand={brand ?? EMPTY_BRAND} onSave={(p) => save.mutate(p)} onUploadImage={uploadImage}
                            onRefresh={() => brand?.sourceValue && startImport.mutate(brand.sourceValue)}
                            refreshing={importing || startImport.isPending}
                            chatHref={chatHref} onImport={(v) => startImport.mutate(v)}
                            importing={importing || startImport.isPending}
                            importFailed={brand?.importStatus === 'failed'} />
                    )}
            </div>
        </PermissionGate>
    );
}
