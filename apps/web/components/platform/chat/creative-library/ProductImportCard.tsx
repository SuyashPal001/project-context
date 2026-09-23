import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { cn } from '@/lib/utils';
import type { ProductUrlSelection } from './creativeBriefModel';

export function ProductImportCard({ selection, onChange }: {
    selection: ProductUrlSelection;
    onChange: (next: ProductUrlSelection) => void;
}) {
    const imported = selection.imported;
    if (!imported) return null;

    function patch(fields: Partial<NonNullable<ProductUrlSelection['imported']>>) {
        onChange({ ...selection, imported: { ...imported!, ...fields } });
    }

    return <div className="space-y-3 rounded-xl border border-border bg-background/70 p-3">
        <Input
            aria-label="Product title"
            value={imported.title ?? ''}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder="Product title"
        />
        <Textarea
            aria-label="Product description"
            value={imported.description ?? ''}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder="Product description"
            rows={2}
        />
        <Input
            aria-label="Product price"
            value={imported.price ?? ''}
            onChange={(event) => patch({ price: event.target.value })}
            placeholder="Price"
        />
        {imported.images.length > 0 && <div className="flex flex-wrap gap-2">
            {imported.images.map((image) => <button
                key={image.fileId}
                type="button"
                aria-label={`Use this image: ${image.name}`}
                onClick={() => patch({ selectedImageId: image.fileId })}
                className={cn(
                    'relative h-16 w-16 overflow-hidden rounded-lg border',
                    imported.selectedImageId === image.fileId ? 'border-foreground ring-2 ring-foreground/20' : 'border-border',
                )}
            >
                <FileThumbnail fileId={image.fileId} alt={image.name} />
            </button>)}
        </div>}
    </div>;
}
