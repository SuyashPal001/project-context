import { nameProduct } from './productNaming';
import type { ProductRecord } from './productRecords';

/**
 * Names a just-created product in the same request, so naming never depends
 * on the browser sending a follow-up /describe call. When that call never came
 * (tab switched, page left, network drop) the product stayed "Untitled
 * product" / pending forever — seen live 2026-09-27. Never throws: on any error
 * the product is returned as created, and the client's stale-pending retry
 * stays as the safety net.
 */
export async function nameCreatedProduct(tenantId: string, product: ProductRecord): Promise<ProductRecord> {
  if (product.namingStatus !== 'pending') return product;
  try {
    return (await nameProduct(tenantId, product.id)) ?? product;
  } catch (error) {
    console.error('[nameCreatedProduct] naming a new product failed', { tenantId, productId: product.id, error: (error as Error).message });
    return product;
  }
}
