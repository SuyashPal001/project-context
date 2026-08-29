/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NotificationRow } from "./NotificationRow";
import type { Notification } from "@/components/platform/notifications/types";

// Regression test for the credit-system whole-branch review's third bypass
// finding: NotificationRow used to render its own enabled "Approve" button
// for a `task.awaiting_approval` notification, wired directly to
// PUT /tasks/:taskId/plan/approve with no estimate and no balance check —
// the only other approve path besides the gated `TaskExecutionCost` card on
// the task detail page (see docs/superpowers/specs/2026-08-28-credit-system-design.md
// and .superpowers/sdd/2026-08-28-credit-system/task-15-report.md). The fix
// removes the inline control entirely: the row is clickable like every
// other notification type and navigates to the task detail page, where the
// gated card is the only place an approval can be committed.

afterEach(() => cleanup());

function makeNotification(overrides: Partial<Notification> = {}): Notification {
    return {
        id: "n-1",
        title: "Plan ready for review",
        body: "Your task's plan is ready.",
        messageType: "task.awaiting_approval",
        read: false,
        readAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        metadata: { taskId: "task-1" },
        ...overrides,
    };
}

describe("NotificationRow — task.awaiting_approval", () => {
    it("renders no Approve button (approval only happens on the task detail page's gated card)", () => {
        render(
            <NotificationRow
                notification={makeNotification()}
                canUpdate={true}
                onClick={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("is clickable and calls onClick with the notification, so approving still requires navigating to the task", () => {
        const onClick = vi.fn();
        const n = makeNotification();
        render(
            <NotificationRow
                notification={n}
                canUpdate={true}
                onClick={onClick}
            />,
        );

        screen.getByTestId("notification-row").click();
        expect(onClick).toHaveBeenCalledWith(n);
    });
});
