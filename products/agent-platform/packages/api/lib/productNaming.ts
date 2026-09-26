import { storageService } from '@serverless-saas/storage';
import { applyNamingResult, getProduct, type ProductImage, type ProductRecord } from './productRecords';

// The orchestrator sends the image to the gateway as base64 (~33% larger); 10 MB
// keeps that well under the gateway's 40 MB request cap. Bigger images simply
// fail naming. Checked here from files.size and again on download.
export const MAX_NAMING_IMAGE_BYTES = 10 * 1024 * 1024;
const ORCHESTRATOR_TIMEOUT_MS = 20_000;

/**
 * The API Lambda has no inference-gateway URL, so naming is relayed to the
 * orchestrator (same host as the gateway), like the watchdog's calls.
 * Never throws: any failure returns null and the caller marks naming failed.
 */
export async function describeProductImage(
  tenantId: string, image: ProductImage,
): Promise<{ name: string; description: string | null } | null> {
  const baseUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error('[productNaming] AGENT_ORCHESTRATOR_URL or INTERNAL_SERVICE_KEY not set — skipping naming');
    return null;
  }
  if (image.size > MAX_NAMING_IMAGE_BYTES) {
    console.warn('[productNaming] image over size cap, skipping', { tenantId, fileId: image.fileId, bytes: image.size });
    return null;
  }
  try {
    // A presigned link, not the bytes: base64 in the request body hit the VM
    // proxy's body limit (413) for ordinary 1-2 MB product photos. The
    // orchestrator downloads the image itself and re-checks the size cap.
    const imageUrl = await storageService.getDownloadUrl(tenantId, image.fileId);
    const res = await fetch(`${baseUrl}/internal/products/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify({ tenantId, imageUrl, mimeType: image.type }),
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[productNaming] orchestrator returned', res.status, { tenantId, fileId: image.fileId });
      return null;
    }
    const body = await res.json() as { name?: unknown; description?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return null;
    const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
    return { name: name.slice(0, 120), description };
  } catch (error) {
    console.error('[productNaming] naming failed', { tenantId, fileId: image.fileId, error: (error as Error).message });
    return null;
  }
}

/** Names a pending product from its main image. Returns the fresh record, or null if the product doesn't exist. */
export async function nameProduct(tenantId: string, id: string): Promise<ProductRecord | null> {
  const product = await getProduct(tenantId, id);
  if (!product) return null;
  if (product.namingStatus !== 'pending') return product;
  const main = product.images[0];
  const result = main ? await describeProductImage(tenantId, main) : null;
  await applyNamingResult(tenantId, id, result);
  return getProduct(tenantId, id);
}
