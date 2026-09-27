import { nameProduct } from './productNaming';
import type { ProductRecord } from './productRecords';

/** Below this there's no point starting: a Gemini describe takes longer. */
const MIN_NAMING_BUDGET_MS = 2_000;

/**
 * Names a just-created product in the same request, so naming never depends
 * on the browser sending a follow-up /describe call. When that call never came
 * (tab switched, page left, network drop) the product stayed "Untitled
 * product" / pending forever — seen live 2026-09-27.
 *
 * Bounded by `budgetMs`: the web proxy aborts a request at 15 s
 * (apps/web/app/api/proxy/[...path]/route.ts) and naming can take up to 20 s.
 * Past the budget the product is returned still pending — never failed — and
 * the client's stale-pending retry finishes it. Never throws.
 */
export async function nameCreatedProduct(tenantId: string, product: ProductRecord, budgetMs: number): Promise<ProductRecord> {
  if (product.namingStatus !== 'pending' || budgetMs < MIN_NAMING_BUDGET_MS) return product;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  try {
    return (await Promise.race([nameProduct(tenantId, product.id), outOfTime])) ?? product;
  } catch (error) {
    console.error('[nameCreatedProduct] naming a new product failed', { tenantId, productId: product.id, error: (error as Error).message });
    return product;
  } finally {
    clearTimeout(timer);
  }
}
