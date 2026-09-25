/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PlannerWeekView } from "./PlannerWeekView";
import { matchesFilter } from "./PlannerFilter";
import type { PlannerItem } from "./types";

afterEach(cleanup);

const monday = new Date(2026, 8, 21); // Mon 21 Sep 2026, local time

const items: PlannerItem[] = [
    { id: "a", kind: "post", title: "Weekend reel", channel: "instagram", employeeId: "director", status: "planned", scheduledAt: new Date(2026, 8, 26, 19, 0).toISOString() },
    { id: "b", kind: "post", title: "Launch thread", channel: "x", employeeId: "disco", status: "planned", scheduledAt: new Date(2026, 8, 26, 9, 0).toISOString() },
    { id: "c", kind: "variations", title: "New hook", employeeId: "producer", status: "ready", detail: "3 new", scheduledAt: new Date(2026, 8, 22, 10, 0).toISOString() },
    { id: "d", kind: "post", title: "Trend remix", channel: "tiktok", employeeId: "disco", status: "failed", detail: "Channel disconnected", scheduledAt: new Date(2026, 8, 24, 17, 30).toISOString() },
];

describe("PlannerWeekView", () => {
    it("puts each item in its day column, sorted by time", () => {
        render(<PlannerWeekView weekStart={monday} items={items} employees={[]} />);
        const saturday = screen.getByText("26").closest("div.flex.min-h-\\[420px\\]") as HTMLElement;
        const titles = within(saturday).getAllByText(/: /).map((el) => el.textContent);
        expect(titles).toEqual(["X: Launch thread", "Instagram: Weekend reel"]);
    });

    it("labels variations and shows failure detail", () => {
        render(<PlannerWeekView weekStart={monday} items={items} employees={[]} />);
        expect(screen.getByText("Variations: New hook")).toBeTruthy();
        expect(screen.getByText(/17:30 · Channel disconnected/)).toBeTruthy();
    });
});

describe("matchesFilter", () => {
    it("filters by employee, channel and variations", () => {
        const pick = (f: Parameters<typeof matchesFilter>[1]) => items.filter((i) => matchesFilter(i, f)).map((i) => i.id);
        expect(pick({ employeeId: null, channel: null })).toEqual(["a", "b", "c", "d"]);
        expect(pick({ employeeId: "disco", channel: null })).toEqual(["b", "d"]);
        expect(pick({ employeeId: null, channel: "variations" })).toEqual(["c"]);
        expect(pick({ employeeId: "disco", channel: "tiktok" })).toEqual(["d"]);
    });
});
