import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchText = vi.fn();
vi.mock('../lib/safeFetch', () => ({ fetchText: (...a: unknown[]) => fetchText(...a) }));

const startImport = vi.fn();
const markImportFailed = vi.fn();
vi.mock('../lib/brandRecords', () => ({
  startImport: (...a: unknown[]) => startImport(...a),
  markImportFailed: (...a: unknown[]) => markImportFailed(...a),
}));

const TENANT = 'tenant-1';
const USER = 'user-1';
const HTML = '<html><head><link rel="stylesheet" href="/styles.css"></head><body><h1>Mamaearth</h1></body></html>';
const CSS = '.btn { color: #FF5733; font-family: "Brand Sans", sans-serif; }';

describe('runBrandImport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.AGENT_ORCHESTRATOR_URL = 'https://orchestrator.example.com';
    process.env.INTERNAL_SERVICE_KEY = 'svc-key-123';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_ORCHESTRATOR_URL;
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  it('website: reads page + stylesheet, hands facts to the orchestrator, succeeds', async () => {
    fetchText
      .mockResolvedValueOnce({ text: HTML, finalUrl: 'https://mamaearth.in/' })
      .mockResolvedValueOnce({ text: CSS, finalUrl: 'https://mamaearth.in/styles.css' });
    fetchMock.mockResolvedValue({ status: 202 });

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'website', url: 'https://mamaearth.in/' });

    expect(startImport).toHaveBeenCalledWith(TENANT, USER, { type: 'website', value: 'https://mamaearth.in/' });
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://orchestrator.example.com/internal/brand/import');
    expect(init.headers['X-Service-Key']).toBe('svc-key-123');
    const body = JSON.parse(init.body);
    expect(body.tenantId).toBe(TENANT);
    expect(body.source).toBe('website');
    expect(body.facts).toBeDefined();
    expect(body.facts.headings).toContain('Mamaearth');
    expect(markImportFailed).not.toHaveBeenCalled();
  });

  it('website unreadable: fetchText returns null → markImportFailed, orchestrator never called', async () => {
    fetchText.mockResolvedValueOnce(null);

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'website', url: 'https://mamaearth.in/' });

    expect(startImport).toHaveBeenCalledWith(TENANT, USER, { type: 'website', value: 'https://mamaearth.in/' });
    expect(markImportFailed).toHaveBeenCalledWith(TENANT, 'website could not be read');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('orchestrator returns non-202 (e.g. 500) → markImportFailed', async () => {
    fetchText.mockResolvedValueOnce({ text: '<html><body>no css</body></html>', finalUrl: 'https://mamaearth.in/' });
    fetchMock.mockResolvedValue({ status: 500 });

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'website', url: 'https://mamaearth.in/' });

    expect(markImportFailed).toHaveBeenCalledWith(TENANT, 'orchestrator did not accept the import');
  });

  it('orchestrator unreachable (fetch rejects) → markImportFailed', async () => {
    fetchText.mockResolvedValueOnce({ text: '<html><body>no css</body></html>', finalUrl: 'https://mamaearth.in/' });
    fetchMock.mockRejectedValue(new Error('network down'));

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'website', url: 'https://mamaearth.in/' });

    expect(markImportFailed).toHaveBeenCalledWith(TENANT, 'orchestrator did not accept the import');
  });

  it('instagram: hands {tenantId, source: instagram, handle} to the orchestrator', async () => {
    fetchMock.mockResolvedValue({ status: 202 });

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'instagram', handle: 'mamaearth.in' });

    expect(startImport).toHaveBeenCalledWith(TENANT, USER, { type: 'instagram', value: '@mamaearth.in' });
    expect(fetchText).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ tenantId: TENANT, source: 'instagram', handle: 'mamaearth.in' });
    expect(markImportFailed).not.toHaveBeenCalled();
  });

  it('unexpected throw inside the try (e.g. fetchText throws synchronously) → markImportFailed(import failed), never throws', async () => {
    fetchText.mockImplementationOnce(() => { throw new Error('boom'); });

    const { runBrandImport } = await import('../lib/brandImport');
    await expect(runBrandImport(TENANT, USER, { type: 'website', url: 'https://mamaearth.in/' })).resolves.toBeUndefined();

    expect(markImportFailed).toHaveBeenCalledWith(TENANT, 'import failed');
  });

  it('missing env vars → markImportFailed', async () => {
    delete process.env.AGENT_ORCHESTRATOR_URL;
    delete process.env.INTERNAL_SERVICE_KEY;

    const { runBrandImport } = await import('../lib/brandImport');
    await runBrandImport(TENANT, USER, { type: 'instagram', handle: 'mamaearth.in' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markImportFailed).toHaveBeenCalledWith(TENANT, 'orchestrator did not accept the import');
  });
});
