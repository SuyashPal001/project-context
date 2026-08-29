/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { TaskMainContent } from './TaskMainContent';
import { TaskSidebar } from './TaskSidebar';
import type { Task, Step } from '@/types/task';

// This is the composition-level test task-15 fix round 2 asked for: a real
// duplicate-approve-path regression (SidebarActions rendering its own
// ungated "Approve Plan" button under the same `status === 'awaiting_approval'`
// condition as PlanReviewPhase's gated card) was invisible to
// PlanReviewPhase.test.tsx because that test renders PlanReviewPhase in
// isolation — it never had a sibling SidebarActions in the same tree to
// collide with.
//
// TaskDetailView itself renders <TaskMainContent> and <TaskSidebar> side by
// side from one shared `taskOperations` object (TaskDetailView.tsx:209-225).
// This test reproduces that same composition directly — the two components
// that actually contain every "approve this plan" affordance — without
// pulling in TaskDetailView's own page-level concerns (useParams-driven
// plan/parent-task lookups, subtask lists, etc.) that are irrelevant to this
// defect and would only add unrelated mocking surface.

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
    api: {
        get: (...args: unknown[]) => apiGetMock(...args),
        post: vi.fn(),
    },
}));

vi.mock('@/app/[tenant]/tenant-provider', () => ({
    useTenant: () => ({ tenantSlug: 'acme', userId: 'user-1', permissions: [] }),
}));

vi.mock('next/navigation', () => ({
    useParams: () => ({ tenant: 'acme', taskId: 'task-1' }),
    useRouter: () => ({ push: vi.fn() }),
}));

// Unrelated to the approve gate — stubbed out the same way other tests in
// this repo stub heavy leaf components (see SkillDetailContent.test.tsx).
// Both are TipTap-based; jsdom lacks the layout APIs TipTap's placeholder
// extension calls on mount (Range.getClientRects / elementFromPoint), which
// crashes real editors regardless of this test's actual subject.
vi.mock('@/components/editor/DescriptionEditor', () => ({
    DescriptionEditor: () => <div data-testid="description-editor-stub" />,
}));
vi.mock('@/components/editor/CommentEditor', () => ({
    CommentEditor: () => <div data-testid="comment-editor-stub" />,
}));

afterEach(() => {
    cleanup();
    apiGetMock.mockReset();
});

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        agentId: 'agent-1',
        assigneeId: null,
        status: 'awaiting_approval',
        priority: 'medium',
        title: 'Ship the thing',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        upvotes: 0,
        downvotes: 0,
        links: [],
        attachmentFileIds: [],
        ...overrides,
    };
}

function makeSteps(n: number): Step[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `step-${i}`,
        stepNumber: i + 1,
        title: `Step ${i + 1}`,
        status: 'pending' as const,
    }));
}

function renderMainAndSidebar(task: Task, steps: Step[]) {
    // One shared object, exactly as TaskDetailView.tsx builds it once and
    // passes the same reference to both children.
    const taskOperations = {
        approvePlan: vi.fn().mockResolvedValue(undefined),
        rejectPlan: vi.fn().mockResolvedValue(undefined),
        generatePlan: vi.fn().mockResolvedValue(undefined),
        sendClarification: vi.fn().mockResolvedValue(undefined),
        markDone: vi.fn().mockResolvedValue(undefined),
        startTask: vi.fn(),
        updateTitle: vi.fn().mockResolvedValue(undefined),
        updateDescription: vi.fn().mockResolvedValue(undefined),
        updateCriteria: vi.fn(),
        addLink: vi.fn(),
        removeLink: vi.fn(),
        removeAttachment: vi.fn(),
        focusLinkInput: vi.fn(),
        focusReferenceInput: vi.fn(),
        triggerAttachFile: vi.fn(),
        deleteTask: vi.fn().mockResolvedValue(undefined),
        saveReferenceText: vi.fn(),
    };

    const editStateMain = { isEditing: false };
    const editStateSidebar = {
        isEditing: false,
        draftStatus: task.status,
        draftPriority: task.priority,
        draftAssigneeKey: 'unassigned',
        setDraftStatus: vi.fn(),
        setDraftPriority: vi.fn(),
        setDraftAssigneeKey: vi.fn(),
    };

    return render(
        <div>
            <TaskMainContent
                task={task}
                steps={steps}
                events={[]}
                taskId={task.id}
                taskOperations={taskOperations}
                editState={editStateMain}
            />
            <TaskSidebar
                task={task}
                steps={steps}
                editState={editStateSidebar}
                assigneeOptions={[]}
                selectedAssignee={null}
                isUploadingAttachment={false}
                attachFileInputRef={{ current: null }}
                newLinkInputRef={{ current: null }}
                referenceTextRef={{ current: null }}
                taskOperations={taskOperations}
            />
        </div>,
    );
}

describe('Plan-approval surface — exactly one approve affordance', () => {
    it('renders exactly one "Approve Plan" control for an awaiting_approval task, in the gated main-content card', async () => {
        apiGetMock.mockImplementation((path: string) => {
            if (path === '/api/v1/agents/agent-1') {
                return Promise.resolve({ llmProvider: { model: 'gemini-2.5-flash' } });
            }
            if (path.startsWith('/api/v1/credits/estimate')) {
                return Promise.resolve({
                    costMicro: '2000000', balanceMicro: '10000000', sufficient: true,
                    rateId: 'r1', rateVersion: 1, unlimited: false,
                });
            }
            // /api/v1/tasks?parentTaskId=... (subtasks) and /api/v1/files
            // (sidebar attachments) — both irrelevant here.
            return Promise.resolve({ data: [] });
        });

        renderMainAndSidebar(makeTask({ status: 'awaiting_approval' }), makeSteps(2));

        // The gated card renders once the estimate resolves.
        await screen.findByTestId('approve-cost');

        const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
        expect(approveButtons).toHaveLength(1);
        // And no separate, unlabelled "Approve Plan" text anywhere either —
        // this is exactly what the deleted SidebarActions button used to render.
        expect(screen.queryByText('Approve Plan')).toBeNull();
    });

    it('renders no approve affordance at all for a task not awaiting approval', () => {
        apiGetMock.mockResolvedValue({ data: [] });
        renderMainAndSidebar(makeTask({ status: 'todo' }), makeSteps(0));

        expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
        expect(screen.queryByTestId('approve-cost')).toBeNull();
    });
});
