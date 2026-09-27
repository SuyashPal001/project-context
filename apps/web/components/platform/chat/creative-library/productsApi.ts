import { api } from '@/lib/api';
import type { Attachment } from '@/types/agent-events';
import type { ProductNamingStatus, ProductRecordSelection } from './creativeBriefModel';

export interface ProductRecord {
    id: string;
    name: string;
    description: string | null;
    price: string | null;
    sourceUrl: string | null;
    namingStatus: ProductNamingStatus;
    images: Attachment[];
    createdAt: string;
}

export const PRODUCTS_PAGE_SIZE = 50;

export function listProducts(q: string, offset: number) {
    const params = new URLSearchParams({ limit: String(PRODUCTS_PAGE_SIZE), offset: String(offset) });
    if (q.trim()) params.set('q', q.trim());
    return api.get<{ data: ProductRecord[] }>(`/api/v1/products?${params.toString()}`);
}

export async function createProductFromFiles(fileIds: string[]): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>('/api/v1/products', { fileIds })).data;
}

export async function importProductFromUrl(url: string): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>('/api/v1/products/import', { url })).data;
}

export async function describeProduct(id: string): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>(`/api/v1/products/${id}/describe`)).data;
}

export async function renameProduct(id: string, name: string): Promise<ProductRecord> {
    return (await api.patch<{ data: ProductRecord }>(`/api/v1/products/${id}`, { name })).data;
}

export async function deleteProduct(id: string): Promise<void> {
    await api.del(`/api/v1/products/${id}`);
}

export async function listProductImageFileIds(): Promise<string[]> {
    return (await api.get<{ data: string[] }>('/api/v1/products/image-file-ids')).data;
}

// Rename and describe responses (unlike listProducts) don't pass through
// dropImageless, so images can be empty. Returning null instead of a
// selection with an undefined `attachment` keeps callers from building a
// brief entry with no image to show.
export function productSelection(product: ProductRecord): ProductRecordSelection | null {
    const attachment = product.images[0];
    if (!attachment) return null;
    return {
        kind: 'product', id: product.id, name: product.name, description: product.description,
        price: product.price, sourceUrl: product.sourceUrl, namingStatus: product.namingStatus,
        attachment,
    };
}
