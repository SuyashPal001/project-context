import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), execute: vi.fn(() => Promise.resolve()) }));
vi.mock('../db', () => ({ db: dbMock }));

const publishToQueueMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: publishToQueueMock }));

const resolveUserPermissionsMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/permissions', async () => {
  const actual = await vi.importActual<typeof import('@serverless-saas/permissions')>('@serverless-saas/permissions');
  return { ...actual, resolveUserPermissions: resolveUserPermissionsMock };
});

const acquireMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
vi.mock('@serverless-saas/idempotency', () => ({
  IdempotencyStore: vi.fn().mockImplementation(function StoreMock() {
    return { acquire: acquireMock, complete: completeMock };
  }),
}));

// IdempotencyStore is mocked above and ignores its constructor argument, but
// the route still calls the real getCacheClient() to produce that argument —
// stub it so that call doesn't throw for lack of UPSTASH_REDIS_URL.
vi.mock('@serverless-saas/cache', () => ({ getCacheClient: vi.fn() }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const BODY = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nOpen with the client name.';

function payload(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, userId: USER, agentId: AGENT,
    conversationId: 'conv-1', messageId: 'msg-1',
    name: 'Bid Writer', description: 'Writes bids', body: BODY, ...over,
  };
}

async function post(body: unknown, key = 'test-key') {
  const { internalSkillsRoute } = await import('../routes/internal/skills');
  const app = new Hono();
  app.route('/internal/skills', internalSkillsRoute);
  return app.request('/internal/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': key },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_KEY = 'test-key';
    process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/queue';
    resolveUserPermissionsMock.mockResolvedValue([{ resource: 'skills', action: 'create' }]);
    acquireMock.mockResolvedValue(true);
    // Quota query returns a low count by default.
    dbMock.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) });
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => [{ id: 'row-1', ...data }],
        catch: () => {},
      }),
    }));
  });

  it('rejects a request with the wrong service key', async () => {
    const res = await post(payload(), 'wrong-key');
    expect(res.status).toBe(401);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a user without skills:create', async () => {
    resolveUserPermissionsMock.mockResolvedValue([{ resource: 'skills', action: 'read' }]);
    const res = await post(payload());
    expect(res.status).toBe(403);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a user with no membership in the tenant', async () => {
    resolveUserPermissionsMock.mockResolvedValue(null);
    const res = await post(payload());
    expect(res.status).toBe(403);
  });

  it('creates the skill and enqueues an authored import carrying attachToAgentId', async () => {
    const res = await post(payload());
    expect(res.status).toBe(202);
    const [, message] = publishToQueueMock.mock.calls[0];
    expect(message.type).toBe('skill.import');
    expect(message.source).toEqual({ type: 'authored', body: BODY });
    expect(message.attachToAgentId).toBe(AGENT);
    expect(message.tenantId).toBe(TENANT);
  });

  it('returns 429 once the tenant hits the daily cap', async () => {
    dbMock.select.mockReturnValue({ from: () => ({ where: () => Promise.resolve([{ count: 20 }]) }) });
    const res = await post(payload());
    expect(res.status).toBe(429);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  // A retried tool call must not produce a second skill; the slug's random
  // suffix means no unique constraint would catch it.
  it('refuses a duplicate when the idempotency claim is already held', async () => {
    acquireMock.mockResolvedValue(false);
    const res = await post(payload());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DUPLICATE_REQUEST');
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a body over 64KB', async () => {
    const res = await post(payload({ body: 'x'.repeat(65_537) }));
    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('rejects a payload missing tenantId', async () => {
    const res = await post(payload({ tenantId: undefined }));
    expect(res.status).toBe(400);
  });
});
