# Account-Wide Credits Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the passive sidebar credit-balance readout into a clickable panel showing usage broken down by type (text/image/video/audio), a percent-consumed indicator, and a Top-up link.

**Architecture:** Add one new read function (`getUsageByType`, bucketing `credit_ledger.jobType`) and one new field-lookup (`getLastGrant`) to `packages/foundation/credits`. Expose both through a new `GET /credits/usage-by-type` route. Add a web hook + `CreditsPanel` component, and turn the existing `CreditBalanceIndicator` into a `Popover` trigger for it.

**Tech Stack:** Drizzle ORM (raw `sql` for aggregation, matching the existing `isUnlimited` pattern), Hono routes, TanStack Query, Radix `Popover` (`@/components/ui/popover`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-04-credit-usage-ui-design.md` (Feature 1: "Account-wide credits panel")

## Global Constraints

- Percent-consumed = `spentMicro / amountMicro` of the tenant's most recent `credit_grants` row (by `createdAt desc`), not a lifetime or period ratio.
- Type bucketing: `image_generation`→Image, `video_generation`→Video, `music_generation`→Audio, everything else (`chat_message`, `agent_task`, `llm_tokens`, `tool_call`, `skill_run`, `null`, any unrecognized value)→Text.
- Top-up button links to `/${tenantSlug}/dashboard/billing` — no new checkout code.
- Unlimited-plan tenants keep the existing static "Unlimited credits" text and never see the panel/ring (matches `CreditBalanceIndicator`'s existing unlimited branch).
- All micro-credit amounts cross the API as strings (existing convention in `/credits/balance` and `/credits/ledger` — never serialize a `bigint` directly).

---

### Task 1: `getUsageByType` and `getLastGrant` in the credits package

**Files:**
- Modify: `packages/foundation/credits/src/read.ts`
- Modify: `packages/foundation/credits/src/index.ts` (already does `export * from './read'` — no change needed, confirm it still covers the new exports)
- Test: `packages/foundation/credits/src/__tests__/read.integration.test.ts`

**Interfaces:**
- Produces: `getUsageByType(tenantId: string): Promise<{ text: bigint; image: bigint; video: bigint; audio: bigint }>` and `getLastGrant(tenantId: string): Promise<{ amountMicro: bigint; spentMicro: bigint; grantType: string } | null>`, both exported from `@serverless-saas/credits`.

- [ ] **Step 1: Write the failing integration tests**

Append to `packages/foundation/credits/src/__tests__/read.integration.test.ts`, inside the existing `describe.skipIf(!TEST_DB)('credits wrappers', ...)` block (add the two new imports to the existing `import { ... } from '../index'` line at the top: `getUsageByType, getLastGrant`):

```ts
  it('buckets ledger debits by job type, defaulting unrecognized/null job types to text', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 10_000_000n, key: 'g:bucket', grantType: 'admin' });
    await spendCredits({ tenantId: TENANT, amountMicro: -1_000_000n, key: 'd:text', kind: 'debit', jobType: 'chat_message' });
    await spendCredits({ tenantId: TENANT, amountMicro: -2_000_000n, key: 'd:image', kind: 'debit', jobType: 'image_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -3_000_000n, key: 'd:video', kind: 'debit', jobType: 'video_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -400_000n, key: 'd:audio', kind: 'debit', jobType: 'music_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -100_000n, key: 'd:unknown', kind: 'debit', jobType: null });

    const usage = await getUsageByType(TENANT);
    expect(usage.text).toBe(1_100_000n); // chat_message (1,000,000) + null (100,000)
    expect(usage.image).toBe(2_000_000n);
    expect(usage.video).toBe(3_000_000n);
    expect(usage.audio).toBe(400_000n);
  });

  it('ignores grant/refund rows — only debits count as spend', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 5_000_000n, key: 'g:ignore-me', grantType: 'admin' });
    const usage = await getUsageByType(TENANT);
    expect(usage.text).toBe(0n);
    expect(usage.image).toBe(0n);
    expect(usage.video).toBe(0n);
    expect(usage.audio).toBe(0n);
  });

  it('reports the most recently created grant, regardless of which grant a debit actually drew from', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 1_000_000n, key: 'g:old', grantType: 'admin' });
    await grantCredits({ tenantId: TENANT, amountMicro: 5_000_000n, key: 'g:new', grantType: 'purchase' });
    await spendCredits({ tenantId: TENANT, amountMicro: -500_000n, key: 'd:against-fifo', kind: 'debit' });

    const lastGrant = await getLastGrant(TENANT);
    expect(lastGrant?.grantType).toBe('purchase');
    expect(lastGrant?.amountMicro).toBe(5_000_000n);
  });

  it('returns null for getLastGrant when the tenant has no grants', async () => {
    const lastGrant = await getLastGrant(TENANT);
    expect(lastGrant).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=<your local test db url> pnpm --filter @serverless-saas/credits test read.integration -- -t "buckets ledger debits"`
Expected: FAIL with `getUsageByType is not defined` / `getUsageByType is not a function` (not yet imported/exported).

- [ ] **Step 3: Implement `getUsageByType` and `getLastGrant`**

In `packages/foundation/credits/src/read.ts`, add below the existing `getLedger` function:

```ts
export interface UsageByType {
  text: bigint;
  image: bigint;
  video: bigint;
  audio: bigint;
}

/** credit_ledger.jobType values that bucket into "text" spend. Anything not
 * listed here and not one of the media job types below also falls into
 * text — a new/unrecognized jobType must never silently disappear from the
 * total. */
const IMAGE_JOB_TYPE = 'image_generation';
const VIDEO_JOB_TYPE = 'video_generation';
const AUDIO_JOB_TYPE = 'music_generation';

export async function getUsageByType(tenantId: string): Promise<UsageByType> {
  const rows = await db.execute(sql`
    select job_type, sum(-amount_micro) as spent
      from credit_ledger
     where tenant_id = ${tenantId} and kind = 'debit'
     group by job_type
  `) as unknown as { job_type: string | null; spent: string | null }[];

  const usage: UsageByType = { text: 0n, image: 0n, video: 0n, audio: 0n };
  for (const row of rows) {
    const spent = BigInt(row.spent ?? '0');
    if (row.job_type === IMAGE_JOB_TYPE) usage.image += spent;
    else if (row.job_type === VIDEO_JOB_TYPE) usage.video += spent;
    else if (row.job_type === AUDIO_JOB_TYPE) usage.audio += spent;
    else usage.text += spent;
  }
  return usage;
}

export interface LastGrantSummary {
  amountMicro: bigint;
  spentMicro: bigint;
  grantType: string;
}

/** The tenant's most recently created grant, regardless of expiry or
 * remaining balance — used only to compute a "percent since last top-up"
 * indicator, not for spend-eligibility (that's getBalance's job). */
export async function getLastGrant(tenantId: string): Promise<LastGrantSummary | null> {
  const [row] = await db.select().from(creditGrants)
    .where(eq(creditGrants.tenantId, tenantId))
    .orderBy(desc(creditGrants.createdAt)).limit(1);
  if (!row) return null;
  return { amountMicro: row.amountMicro, spentMicro: row.spentMicro, grantType: row.grantType };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=<your local test db url> pnpm --filter @serverless-saas/credits test read.integration`
Expected: PASS (all tests in the file, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/credits/src/read.ts packages/foundation/credits/src/__tests__/read.integration.test.ts
git commit -m "feat(credits): add getUsageByType and getLastGrant reads"
```

---

### Task 2: `GET /credits/usage-by-type` route

**Files:**
- Modify: `apps/api/src/routes/credits.ts`
- Test: `apps/api/src/routes/__tests__/credits.test.ts`

**Interfaces:**
- Consumes: `getBalance`, `getUsageByType`, `getLastGrant` from `@serverless-saas/credits` (Task 1's exports).
- Produces: `GET /credits/usage-by-type` → `{ unlimited: true }` or `{ unlimited: false; balanceMicro: string; byType: { text: string; image: string; video: string; audio: string }; totalMicro: string; lastGrant: { amountMicro: string; spentMicro: string; grantType: string } | null }`.

- [ ] **Step 1: Write the failing route tests**

Add `getUsageByType: vi.fn(), getLastGrant: vi.fn(),` to the `vi.mock('@serverless-saas/credits', ...)` factory at the top of `apps/api/src/routes/__tests__/credits.test.ts`, and add `getUsageByType, getLastGrant,` to the `import { ... } from '@serverless-saas/credits'` line and to the `beforeEach` reset block (`vi.mocked(getUsageByType).mockReset(); vi.mocked(getLastGrant).mockReset();`). Then append a new describe block:

```ts
describe('GET /credits/usage-by-type', () => {
    it('serializes the breakdown, total, and last grant as strings', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 5_000_000n, unlimited: false, grants: [] });
        vi.mocked(getUsageByType).mockResolvedValue({ text: 1_000_000n, image: 2_000_000n, video: 1_500_000n, audio: 500_000n });
        vi.mocked(getLastGrant).mockResolvedValue({ amountMicro: 10_000_000n, spentMicro: 5_000_000n, grantType: 'purchase' });

        const app = appWith(readCtx);
        const res = await app.request('/credits/usage-by-type');
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.unlimited).toBe(false);
        expect(body.balanceMicro).toBe('5000000');
        expect(body.byType).toEqual({ text: '1000000', image: '2000000', video: '1500000', audio: '500000' });
        expect(body.totalMicro).toBe('5000000');
        expect(body.lastGrant).toEqual({ amountMicro: '10000000', spentMicro: '5000000', grantType: 'purchase' });
    });

    it('reports unlimited: true with no breakdown for unlimited tenants', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 0n, unlimited: true, grants: [] });

        const app = appWith(readCtx);
        const res = await app.request('/credits/usage-by-type');
        const body = await res.json() as any;

        expect(body).toEqual({ unlimited: true });
        expect(getUsageByType).not.toHaveBeenCalled();
    });

    it('returns lastGrant: null when the tenant has never been granted credits', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 0n, unlimited: false, grants: [] });
        vi.mocked(getUsageByType).mockResolvedValue({ text: 0n, image: 0n, video: 0n, audio: 0n });
        vi.mocked(getLastGrant).mockResolvedValue(null);

        const app = appWith(readCtx);
        const res = await app.request('/credits/usage-by-type');
        const body = await res.json() as any;

        expect(body.lastGrant).toBeNull();
    });

    it('returns 403 without credits:read', async () => {
        const app = appWith(noPermsCtx);
        const res = await app.request('/credits/usage-by-type');
        expect(res.status).toBe(403);
        expect(getUsageByType).not.toHaveBeenCalled();
    });

    it('scopes the lookup to the caller tenant, ignoring a user-supplied tenantId', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 0n, unlimited: false, grants: [] });
        vi.mocked(getUsageByType).mockResolvedValue({ text: 0n, image: 0n, video: 0n, audio: 0n });
        vi.mocked(getLastGrant).mockResolvedValue(null);

        const app = appWith(readCtx);
        await app.request(`/credits/usage-by-type?tenantId=${OTHER_TENANT}`);

        expect(getUsageByType).toHaveBeenCalledWith(TENANT);
        expect(getUsageByType).not.toHaveBeenCalledWith(OTHER_TENANT);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api test credits.test -- -t "usage-by-type"`
Expected: FAIL — route returns 404 (no such path registered yet).

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/credits.ts`, change the import line to add the two new functions:

```ts
import {
    getBalance,
    getLedger,
    getUsageByType,
    getLastGrant,
    resolveRate,
    costMicro,
    grantCredits,
    InsufficientCreditsError,
} from '@serverless-saas/credits';
```

Add the new route, placed after the existing `GET /balance` handler:

```ts
// GET /credits/usage-by-type
creditsRoutes.get('/usage-by-type', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'credits', 'read')) return forbidden(c);

    const balance = await getBalance(tenantId);
    if (balance.unlimited) return c.json({ unlimited: true });

    const usage = await getUsageByType(tenantId);
    const lastGrant = await getLastGrant(tenantId);
    const totalMicro = usage.text + usage.image + usage.video + usage.audio;

    return c.json({
        unlimited: false,
        balanceMicro: String(balance.balanceMicro),
        byType: {
            text: String(usage.text),
            image: String(usage.image),
            video: String(usage.video),
            audio: String(usage.audio),
        },
        totalMicro: String(totalMicro),
        lastGrant: lastGrant ? {
            amountMicro: String(lastGrant.amountMicro),
            spentMicro: String(lastGrant.spentMicro),
            grantType: lastGrant.grantType,
        } : null,
    });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api test credits.test`
Expected: PASS (all tests in the file, including pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/credits.ts apps/api/src/routes/__tests__/credits.test.ts
git commit -m "feat(api): add GET /credits/usage-by-type route"
```

---

### Task 3: Web hook `useCreditUsageByType`

**Files:**
- Modify: `apps/web/lib/hooks/useCredits.ts`

**Interfaces:**
- Consumes: `api.get` from `@/lib/api` (already imported in this file).
- Produces: `CreditUsageByType` type and `useCreditUsageByType(): UseQueryResult<CreditUsageByType>`, both exported from `apps/web/lib/hooks/useCredits.ts`.

- [ ] **Step 1: Add the type and hook**

No test-first step here — this file has no direct unit tests of its own (matches the existing pattern: `useCreditBalance`/`useCreditEstimate` are exercised indirectly through the components that consume them, e.g. `ApproveCost.test.tsx`). Task 4 covers the consuming component's test.

Add to `apps/web/lib/hooks/useCredits.ts`, directly below `useCreditBalance`:

```ts
export interface CreditUsageByType {
    unlimited: boolean;
    balanceMicro?: string;
    byType?: { text: string; image: string; video: string; audio: string };
    totalMicro?: string;
    lastGrant?: { amountMicro: string; spentMicro: string; grantType: string } | null;
}

export function useCreditUsageByType() {
    return useQuery<CreditUsageByType>({
        queryKey: ['credits', 'usage-by-type'],
        queryFn: () => api.get<CreditUsageByType>('/api/v1/credits/usage-by-type'),
        staleTime: 30_000,
    });
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter web type-check`
Expected: PASS, no new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/hooks/useCredits.ts
git commit -m "feat(web): add useCreditUsageByType hook"
```

---

### Task 4: `CreditsPanel` component and clickable `CreditBalanceIndicator`

**Files:**
- Create: `apps/web/components/platform/credits/CreditsPanel.tsx`
- Create: `apps/web/components/platform/credits/CreditBalanceIndicator.test.tsx`
- Modify: `apps/web/components/platform/credits/CreditBalanceIndicator.tsx`

**Interfaces:**
- Consumes: `useCreditUsageByType`, `CreditUsageByType`, `microToCredits` from `apps/web/lib/hooks/useCredits.ts` (Task 3); `Popover`, `PopoverTrigger`, `PopoverContent` from `@/components/ui/popover`.
- Produces: `CreditsPanel` component (no props — reads its own data via the hook), exported from `apps/web/components/platform/credits/CreditsPanel.tsx`.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/components/platform/credits/CreditBalanceIndicator.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { CreditBalanceIndicator } from './CreditBalanceIndicator';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
    api: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

vi.mock('@/app/[tenant]/tenant-provider', () => ({
    useTenant: () => ({ tenantSlug: 'acme' }),
}));

afterEach(() => {
    cleanup();
    apiGetMock.mockReset();
});

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function mockEndpoints(balance: unknown, usageByType: unknown) {
    apiGetMock.mockImplementation((url: string) => {
        if (url.includes('/credits/usage-by-type')) return Promise.resolve(usageByType);
        return Promise.resolve(balance);
    });
}

describe('CreditBalanceIndicator', () => {
    it('renders nothing before the balance loads', () => {
        apiGetMock.mockReturnValue(new Promise(() => {}));
        const { container } = render(<CreditBalanceIndicator />);
        expect(container.firstChild).toBeNull();
    });

    it('shows the balance as a clickable trigger', async () => {
        mockEndpoints({ unlimited: false, balanceMicro: '5000000', grants: [] }, {});
        render(<CreditBalanceIndicator />);
        const trigger = await screen.findByTestId('credit-balance');
        expect(trigger.textContent).toContain('5');
        expect(trigger.tagName).toBe('BUTTON');
    });

    it('opens the credits panel with a type breakdown, total, and percent-consumed on click', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '5000000', grants: [] },
            {
                unlimited: false,
                balanceMicro: '5000000',
                byType: { text: '1000000', image: '2000000', video: '1500000', audio: '500000' },
                totalMicro: '5000000',
                lastGrant: { amountMicro: '10000000', spentMicro: '5000000', grantType: 'purchase' },
            },
        );
        render(<CreditBalanceIndicator />);
        const trigger = await screen.findByTestId('credit-balance');
        await userEvent.click(trigger);

        const panel = await screen.findByTestId('credits-panel');
        expect(panel.textContent).toContain('Text credits');
        expect(panel.textContent).toContain('Image credits');
        expect(panel.textContent).toContain('Video credits');
        expect(panel.textContent).toContain('Audio credits');
        expect(panel.textContent).toContain('Total credits');
        expect(screen.getByTestId('credits-panel-percent').textContent).toContain('50%');
    });

    it('omits the percent-consumed figure when the tenant has no grants yet', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '0', grants: [] },
            {
                unlimited: false,
                balanceMicro: '0',
                byType: { text: '0', image: '0', video: '0', audio: '0' },
                totalMicro: '0',
                lastGrant: null,
            },
        );
        render(<CreditBalanceIndicator />);
        await userEvent.click(await screen.findByTestId('credit-balance'));

        await screen.findByTestId('credits-panel');
        expect(screen.queryByTestId('credits-panel-percent')).toBeNull();
    });

    it('links Top-up credits to the billing page', async () => {
        mockEndpoints(
            { unlimited: false, balanceMicro: '5000000', grants: [] },
            {
                unlimited: false,
                balanceMicro: '5000000',
                byType: { text: '1000000', image: '2000000', video: '1500000', audio: '500000' },
                totalMicro: '5000000',
                lastGrant: null,
            },
        );
        render(<CreditBalanceIndicator />);
        await userEvent.click(await screen.findByTestId('credit-balance'));

        const link = await screen.findByTestId('credits-panel-topup');
        expect(link.getAttribute('href')).toBe('/acme/dashboard/billing');
    });

    it('renders the unlimited state with no clickable trigger', () => {
        mockEndpoints({ unlimited: true }, {});
        render(<CreditBalanceIndicator />);
        expect(screen.getByTestId('credit-balance-unlimited')).not.toBeNull();
        expect(screen.queryByTestId('credit-balance')).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test CreditBalanceIndicator.test`
Expected: FAIL — `credit-balance` element is a `<div>`, not clickable, and `credits-panel` never appears.

- [ ] **Step 3: Create `CreditsPanel.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditUsageByType, microToCredits } from '@/lib/hooks/useCredits';

function Row({ label, credits }: { label: string; credits: number }) {
    return (
        <div className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
    );
}

export function CreditsPanel() {
    const { tenantSlug } = useTenant();
    const { data, isLoading } = useCreditUsageByType();

    if (isLoading || !data) {
        return <div data-testid="credits-panel-loading" className="p-3 text-sm text-muted-foreground">Loading…</div>;
    }

    if (data.unlimited) {
        return <div data-testid="credits-panel-unlimited" className="p-3 text-sm">Unlimited credits</div>;
    }

    const byType = data.byType ?? { text: '0', image: '0', video: '0', audio: '0' };
    const percentConsumed = data.lastGrant && data.lastGrant.amountMicro !== '0'
        ? Math.round((Number(data.lastGrant.spentMicro) / Number(data.lastGrant.amountMicro)) * 100)
        : null;

    return (
        <div data-testid="credits-panel" className="w-64 p-3">
            <p className="text-xs font-semibold text-muted-foreground mb-2">Your Credits</p>

            {percentConsumed !== null && (
                <p data-testid="credits-panel-percent" className="text-lg font-semibold mb-2">{percentConsumed}% consumed</p>
            )}

            <div className="border-t border-border/60">
                <Row label="Text credits" credits={microToCredits(byType.text)} />
                <Row label="Image credits" credits={microToCredits(byType.image)} />
                <Row label="Video credits" credits={microToCredits(byType.video)} />
                <Row label="Audio credits" credits={microToCredits(byType.audio)} />
            </div>

            <div className="border-t border-border/60 pt-1.5 mt-1.5 flex items-center justify-between text-sm font-medium">
                <span>Total credits</span>
                <span className="font-mono">{microToCredits(data.totalMicro).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>

            <Link
                href={`/${tenantSlug}/dashboard/billing`}
                data-testid="credits-panel-topup"
                className="mt-3 block text-center text-sm font-medium rounded-md py-1.5 bg-foreground text-background hover:opacity-90 transition-opacity"
            >
                Top-up credits
            </Link>
        </div>
    );
}
```

- [ ] **Step 4: Modify `CreditBalanceIndicator.tsx` to wrap the metered state in a Popover**

Replace the full contents of `apps/web/components/platform/credits/CreditBalanceIndicator.tsx` with:

```tsx
'use client';

import Link from 'next/link';
import { useTenant } from '@/app/[tenant]/tenant-provider';
import { useCreditBalance, microToCredits } from '@/lib/hooks/useCredits';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CreditsPanel } from './CreditsPanel';

// Sits beside UsageBar in the sidebar — now a click target that opens
// CreditsPanel (breakdown by type + percent-consumed + top-up), not just a
// passive readout. ApproveCost (the estimate-and-approve gate shown inline
// on submit) is unrelated and untouched.
export function CreditBalanceIndicator() {
    const { tenantSlug } = useTenant();
    const { data } = useCreditBalance();

    if (!data) return null;

    // Unlimited tenants are never debited — no figure, no panel, ever.
    if (data.unlimited) {
        return (
            <div className="px-3 py-2 mb-2" data-testid="credit-balance-unlimited">
                <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">Unlimited</span> credits
                </p>
            </div>
        );
    }

    const balanceCredits = microToCredits(data.balanceMicro);
    const isLow = balanceCredits <= 0;

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="w-full text-left px-3 py-2 mb-2 space-y-1 rounded-md hover:bg-muted/50 transition-colors"
                    data-testid="credit-balance"
                >
                    <p className="text-[11px] text-muted-foreground">
                        <span className={cn('font-medium', isLow ? 'text-red-500' : 'text-foreground')}>
                            {balanceCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                        {' credits'}
                    </p>

                    {isLow && (
                        <Link
                            href={`/${tenantSlug}/dashboard/billing`}
                            className="text-[11px] text-red-500 hover:text-red-400 font-medium transition-colors"
                            onClick={(e) => e.stopPropagation()}
                        >
                            Add credits →
                        </Link>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" className="p-0">
                <CreditsPanel />
            </PopoverContent>
        </Popover>
    );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter web test CreditBalanceIndicator.test`
Expected: PASS (all 6 tests)

- [ ] **Step 6: Run the full web test suite to check for regressions**

Run: `pnpm --filter web test`
Expected: PASS — no other test imports `CreditBalanceIndicator` in a way that assumed a `<div>` (confirm via the test run output, not by assumption).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/credits/CreditsPanel.tsx apps/web/components/platform/credits/CreditBalanceIndicator.tsx apps/web/components/platform/credits/CreditBalanceIndicator.test.tsx
git commit -m "feat(web): make credit balance clickable, add breakdown-by-type panel"
```

---

## Self-Review Notes

- **Spec coverage:** data/bucketing (Task 1), API (Task 2), hook (Task 3), UI + ring + top-up link (Task 4) — all of Feature 1's spec sections are covered. Out-of-scope items (session popover, real checkout) have no tasks, matching the spec.
- **Type consistency:** `UsageByType`/`getUsageByType` (Task 1) → route response `byType` (Task 2) → `CreditUsageByType.byType` (Task 3) → `CreditsPanel`'s `byType` destructure (Task 4) all use the same four keys (`text`/`image`/`video`/`audio`) throughout.
- **No placeholders:** every step has real, complete code — no "add tests for the above" or "TBD" left in any task.
