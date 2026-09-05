import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq, gte } from 'drizzle-orm';
import { skills, skillVersions } from '@serverless-saas/agent-schema/skills';
import { slugify } from '../routes/skills';

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
const releaseMock = vi.hoisted(() => vi.fn());
// vi.importActual forces this to actually resolve the real
// @serverless-saas/idempotency package (unlike a bare factory mock, which
// never touches the real module) — so a missing workspace dependency fails
// the test suite here too, not only `pnpm build`.
vi.mock('@serverless-saas/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@serverless-saas/idempotency')>('@serverless-saas/idempotency');
  return {
    ...actual,
    IdempotencyStore: vi.fn().mockImplementation(function StoreMock() {
      return { acquire: acquireMock, complete: completeMock, release: releaseMock };
    }),
  };
});

// IdempotencyStore is mocked above and ignores its constructor argument, but
// the route still calls the real getCacheClient() to produce that argument —
// stub it so that call doesn't throw for lack of UPSTASH_REDIS_URL.
vi.mock('@serverless-saas/cache', () => ({ getCacheClient: vi.fn() }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
/** A well-formed UUID that is not this tenant's agent — passes zod, fails the lookup. */
const FOREIGN_AGENT = '44444444-4444-4444-8444-444444444444';
const BODY = '---\nname: bid-writer\ndescription: Writes bids\n---\n\nOpen with the client name.';
const CONVERSATION_ID = 'conv-1';
const MESSAGE_ID = 'msg-1';
const NAME = 'Bid Writer';
const EXPECTED_KEY = `skill-create:${CONVERSATION_ID}:${MESSAGE_ID}:${slugify(NAME)}`;

// Fixed so the route's `since = now - 24h` and the test's expected `where`
// clause compute the exact same Date instance value.
const NOW = new Date('2026-09-05T12:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function payload(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, userId: USER, agentId: AGENT,
    conversationId: CONVERSATION_ID, messageId: MESSAGE_ID,
    name: NAME, description: 'Writes bids', body: BODY, ...over,
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

// Builds the quota select's mock chain — .from(skills).innerJoin(...).where(...) —
// and returns spies for the join and where calls so a test can assert the
// query is actually scoped to this tenant's authored (chat-created) skills.
// The agent/tenant lookup the route runs before any write. Held in a mutable
// so a test can empty it (simulating another tenant's agent) without having to
// re-queue the whole db.select mock chain.
let agentRows: unknown[] = [];

function mockAgentLookup() {
  const limitSpy = vi.fn(() => Promise.resolve(agentRows));
  const whereSpy = vi.fn(() => ({ limit: limitSpy }));
  const fromSpy = vi.fn(() => ({ where: whereSpy }));
  // Once, not a permanent return: this is the route's *first* select, and the
  // quota query that follows needs the innerJoin chain instead.
  dbMock.select.mockReturnValueOnce({ from: fromSpy });
  return { fromSpy, whereSpy };
}

// Drizzle SQL objects are circular (every column points back at its table), so
// the bound literals are collected by walking queryChunks rather than by
// stringifying. Returns just the parameter values in a comparison predicate.
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundValues(chunk, out);
  } else if ('value' in n) {
    out.push(n.value);
  }
  return out;
}

function mockQuotaQuery(rows: unknown[]) {
  const whereSpy = vi.fn(() => Promise.resolve(rows));
  const innerJoinSpy = vi.fn(() => ({ where: whereSpy }));
  const fromSpy = vi.fn(() => ({ innerJoin: innerJoinSpy }));
  dbMock.select.mockReturnValue({ from: fromSpy });
  return { fromSpy, innerJoinSpy, whereSpy };
}

describe('POST /internal/skills', () => {
  let agentLookup: ReturnType<typeof mockAgentLookup>;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears recorded calls — the mockReturnValueOnce queue
    // survives it, so a test that returns early (401/403/404) would otherwise
    // leak its unconsumed agent-lookup chain into the next test's first select.
    dbMock.select.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.INTERNAL_SERVICE_KEY = 'test-key';
    process.env.SQS_PROCESSING_QUEUE_URL = 'https://sqs.test/queue';
    resolveUserPermissionsMock.mockResolvedValue([{ resource: 'skills', action: 'create' }]);
    acquireMock.mockResolvedValue(true);
    completeMock.mockResolvedValue(undefined);
    releaseMock.mockResolvedValue(undefined);
    // Quota query returns a low count by default.
    mockQuotaQuery([{ count: 0 }]);
    agentRows = [{ id: AGENT }];
    agentLookup = mockAgentLookup();
    dbMock.insert.mockImplementation(() => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => [{ id: 'row-1', ...data }],
        catch: () => {},
      }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('creates the skill, enqueues an authored import carrying attachToAgentId, and completes the idempotency claim', async () => {
    const res = await post(payload());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.skillId).toBeDefined();
    expect(body.data.installId).toBeDefined();

    const [, message] = publishToQueueMock.mock.calls[0];
    expect(message.type).toBe('skill.import');
    expect(message.source).toEqual({ type: 'authored', body: BODY });
    expect(message.attachToAgentId).toBe(AGENT);
    expect(message.tenantId).toBe(TENANT);

    // Success durably marks the message done so a redelivery after the
    // 15-minute processing claim expires still can't create a second skill.
    expect(completeMock).toHaveBeenCalledWith(EXPECTED_KEY);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('still returns 202 with the skill and install ids when the completion write fails', async () => {
    // Every write this request needed has already succeeded by the time
    // complete() runs — a Redis blip there must not turn a finished creation
    // into a 500 whose retry creates a genuine second skill.
    completeMock.mockRejectedValue(new Error('redis blip'));
    const res = await post(payload());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.skillId).toBeDefined();
    expect(body.data.installId).toBeDefined();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('returns 429 once the tenant hits the daily cap, scoped to this tenant\'s authored skills only', async () => {
    const { innerJoinSpy, whereSpy } = mockQuotaQuery([{ count: 20 }]);
    const res = await post(payload());
    expect(res.status).toBe(429);
    expect(publishToQueueMock).not.toHaveBeenCalled();

    // Proves the count can't be satisfied by a naive "every skill this tenant
    // owns" query: it must join skill_versions and require the creation
    // version's source to be 'authored', so a dashboard import spree and a
    // chat session never throttle each other.
    expect(innerJoinSpy).toHaveBeenCalledWith(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, 1)),
    );
    expect(whereSpy).toHaveBeenCalledWith(
      and(
        eq(skills.ownerTenantId, TENANT),
        eq(skillVersions.sourceType, 'authored'),
        gte(skills.createdAt, SINCE),
      ),
    );
  });

  // A retried tool call must not produce a second skill; the slug's random
  // suffix means no unique constraint would catch it.
  it('refuses a duplicate when the idempotency claim is already held', async () => {
    acquireMock.mockResolvedValue(false);
    const res = await post(payload());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DUPLICATE_REQUEST');
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(acquireMock).toHaveBeenCalledWith(EXPECTED_KEY);
  });

  it('releases the idempotency claim when a write after acquisition fails, so a retry is not stuck for the full 15-minute TTL', async () => {
    // The first db.insert call in the route is the skills-row insert.
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(new Error('insert failed')) }),
    }));

    const res = await post(payload());
    expect(res.status).toBe(500);
    expect(publishToQueueMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith(EXPECTED_KEY);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('does not attempt to release a claim it never acquired (quota rejection happens before acquire)', async () => {
    mockQuotaQuery([{ count: 20 }]);
    const res = await post(payload());
    expect(res.status).toBe(429);
    expect(acquireMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('rejects a body over 64KB', async () => {
    const res = await post(payload({ body: 'x'.repeat(65_537) }));
    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  // The cap has to be measured in bytes, not UTF-16 code units. 30,000 emoji is
  // 30,000 "characters" — under a plain .max(65_536) — but 120KB of UTF-8, and
  // three of those would blow SQS's 256KB limit inside createVersionAndEnqueue,
  // throwing after the skills and skill_installs rows had already committed.
  it('rejects a multibyte body that is under the char cap but over 64KB of UTF-8', async () => {
    const body = '🙂'.repeat(30_000);
    expect(body.length).toBeLessThan(65_536);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(65_536);
    const res = await post(payload({ body }));
    expect(res.status).toBe(400);
    expect(publishToQueueMock).not.toHaveBeenCalled();
  });

  it('accepts a multibyte body that fits inside 64KB of UTF-8', async () => {
    const body = '🙂'.repeat(16_000); // 64,000 bytes
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65_536);
    const res = await post(payload({ body }));
    expect(res.status).toBe(202);
  });

  // The cross-tenant hole. agent_skills.agent_id and agent_skills.tenant_id are
  // independent foreign keys, so nothing downstream stops a row that pairs this
  // tenant with another tenant's agent — and fetchAgentSkills would then compose
  // this tenant's text into that agent's system prompt on its owner's next turn.
  describe('agent/tenant binding', () => {
    it('resolves the agent against the calling tenant before any write', async () => {
      await post(payload());
      expect(agentLookup.whereSpy).toHaveBeenCalledTimes(1);
      // Both the agent id and the tenant id must be bound into that one
      // predicate — filtering on the agent id alone is the bug.
      const bound = boundValues(agentLookup.whereSpy.mock.calls[0][0]);
      expect(bound).toContain(AGENT);
      expect(bound).toContain(TENANT);
    });

    it("404s on another tenant's agent and writes nothing", async () => {
      agentRows = [];
      const res = await post(payload({ agentId: FOREIGN_AGENT }));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('AGENT_NOT_FOUND');
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(publishToQueueMock).not.toHaveBeenCalled();
    });

    it('does not consume an idempotency claim when the agent is rejected', async () => {
      agentRows = [];
      const res = await post(payload({ agentId: FOREIGN_AGENT }));
      expect(res.status).toBe(404);
      expect(acquireMock).not.toHaveBeenCalled();
      expect(releaseMock).not.toHaveBeenCalled();
    });
  });

  it('rejects a payload missing tenantId', async () => {
    const res = await post(payload({ tenantId: undefined }));
    expect(res.status).toBe(400);
  });
});
