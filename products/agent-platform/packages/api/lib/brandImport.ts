import { fetchText } from './safeFetch';
import { extractBrandPage, type WebsiteFacts } from './brandPageExtract';
import { markImportFailed, startImport } from './brandRecords';
import type { BrandSource } from './brandSource';

// The whole request stays under the web proxy's 15 s abort: page 7 s + CSS 2 s + ack 3 s.
const PAGE_TIMEOUT_MS = 7000;
const CSS_TIMEOUT_MS = 2000;
const ORCHESTRATOR_ACK_TIMEOUT_MS = 3000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 512 * 1024;

async function readWebsite(url: string): Promise<WebsiteFacts | null> {
  const page = await fetchText(url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES, accept: (t) => t.includes('text/html') });
  if (!page) return null;
  const first = extractBrandPage(page.text, page.finalUrl);
  if (!first.stylesheetUrl) return first;
  const css = await fetchText(first.stylesheetUrl, { timeoutMs: CSS_TIMEOUT_MS, maxBytes: MAX_CSS_BYTES, accept: (t) => t.includes('css') });
  return css ? extractBrandPage(page.text, page.finalUrl, css.text) : first;
}

async function askOrchestrator(body: { tenantId: string; source: BrandSource['type']; handle?: string; facts?: WebsiteFacts }): Promise<boolean> {
  const baseUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error('[brandImport] AGENT_ORCHESTRATOR_URL or INTERNAL_SERVICE_KEY not set');
    return false;
  }
  try {
    const res = await fetch(`${baseUrl}/internal/brand/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ORCHESTRATOR_ACK_TIMEOUT_MS),
    });
    if (res.status !== 202) console.error('[brandImport] orchestrator returned', res.status, { tenantId: body.tenantId });
    return res.status === 202;
  } catch (error) {
    console.error('[brandImport] orchestrator unreachable', { tenantId: body.tenantId, error: (error as Error).message });
    return false;
  }
}

/** Marks the row importing and hands the work to the orchestrator. Never throws. */
export async function runBrandImport(tenantId: string, userId: string, source: BrandSource): Promise<void> {
  const value = source.type === 'website' ? source.url : `@${source.handle}`;
  await startImport(tenantId, userId, { type: source.type, value });
  try {
    if (source.type === 'website') {
      const facts = await readWebsite(source.url);
      if (!facts) return markImportFailed(tenantId, 'website could not be read');
      if (!(await askOrchestrator({ tenantId, source: 'website', facts }))) return markImportFailed(tenantId, 'orchestrator did not accept the import');
      return;
    }
    if (!(await askOrchestrator({ tenantId, source: 'instagram', handle: source.handle }))) {
      return markImportFailed(tenantId, 'orchestrator did not accept the import');
    }
  } catch (error) {
    console.error('[brandImport] failed', { tenantId, error: (error as Error).message });
    await markImportFailed(tenantId, 'import failed');
  }
}
